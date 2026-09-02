import type { FastifyInstance } from "fastify";
import { createHmac, randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { prisma } from "../lib/prisma.js";
import { clearMediaCookie, setMediaCookie } from "../lib/mediaAuth.js";
import { clearChallengeCookie, readChallengeCookie, setChallengeCookie } from "../lib/mfaChallengeCookie.js";
import { decryptPhone, encryptPhone, hashPhone, maskPhone, normalizeUsPhone } from "../lib/phone.js";
import { verifyHuman } from "../lib/turnstile.js";
import { invalidateTokenVersionCache } from "../lib/tokenVersion.js";
import {
  FactorRemovalCommittedResultError,
  FactorRemovalService,
  FactorRemovalVerificationRejectedError,
  PrismaFactorRemovalRepository,
  type FactorRemovalResult,
  type FactorRemovalUser,
} from "../lib/factorRemovalService.js";
import {
  createSecurityNotificationProvider,
  SecurityNotificationConfigurationError,
  type SecurityNotificationProvider,
} from "../lib/securityNotificationProvider.js";
import { TwilioVerifyProvider } from "../lib/twilioVerifyProvider.js";
import { PrismaVerificationPolicyStore, VerificationLockedError, VerificationPolicy, VerificationRejectedError } from "../lib/verificationPolicy.js";
import { VerificationAmbiguousError } from "../lib/verificationProvider.js";
import {
  consumeBackupCode,
  decryptSecret,
  encryptSecret,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCodes,
  otpauthUri,
  verifyTotp,
} from "../lib/mfa.js";

const JWT_EXPIRES_IN = "7d";
const RECENT_AUTH_SECONDS = 10 * 60;
type UserRole = "ADMIN" | "GENERAL";
type Challenge = { sub: string; role?: UserRole; tv?: number; purpose?: string };

export function isRecentAuthentication(issuedAt: unknown, nowSeconds = Math.floor(Date.now() / 1_000)): boolean {
  return typeof issuedAt === "number" && issuedAt <= nowSeconds && nowSeconds - issuedAt <= RECENT_AUTH_SECONDS;
}

async function settleEnrollmentTiming(startedAt: number): Promise<void> {
  const minimumMs = 350 + Math.floor(Math.random() * 100);
  const remaining = minimumMs - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when SMS MFA is enabled.`);
  return value;
}

function smsVerificationPolicy(): VerificationPolicy {
  return new VerificationPolicy(
    new PrismaVerificationPolicyStore(),
    new TwilioVerifyProvider({
      accountSid: required("TWILIO_ACCOUNT_SID"),
      apiKeySid: required("TWILIO_API_KEY_SID"),
      apiKeySecret: required("TWILIO_API_KEY_SECRET"),
      serviceSid: required("TWILIO_VERIFY_SERVICE_SID"),
    }),
  );
}

function factorBinding(method: "TOTP" | "RECOVERY_CODE", userId: string): string {
  return createHmac("sha256", required("RATE_LIMIT_HMAC_KEY")).update(`${method}:${userId}`).digest("hex");
}

function factorRemovalDimension(kind: "account" | "ip", value: string): string {
  const hash = createHmac("sha256", required("RATE_LIMIT_HMAC_KEY")).update(value).digest("hex");
  return `${kind}:${hash}`;
}

function factorRemovalService(notificationProvider: SecurityNotificationProvider): FactorRemovalService {
  return new FactorRemovalService(
    new PrismaFactorRemovalRepository(),
    smsVerificationPolicy(),
    notificationProvider,
  );
}

function removableTotpUser(user: FactorRemovalUser & { phoneLast4?: string | null }): user is FactorRemovalUser & { phoneLast4: string } {
  return user.accountStatus === "ACTIVE"
    && user.isActive
    && user.mfaEnabled
    && Boolean(user.mfaSecretEncrypted)
    && Boolean(user.phoneEncrypted)
    && user.phoneEncryptionKeyVersion !== null
    && Boolean(user.phoneLookupHash)
    && Number.isInteger(user.phoneVersion)
    && user.phoneVersion > 0
    && Boolean(user.phoneVerifiedAt)
    && /^\d{4}$/.test(user.phoneLast4 ?? "");
}

function sendCommittedFactorRemoval(reply: Parameters<typeof clearChallengeCookie>[0], result: FactorRemovalResult) {
  clearChallengeCookie(reply);
  clearMediaCookie(reply);
  if (result.notification === "failed") {
    return reply.send({
      removed: true,
      notification: "failed",
      warning: "Authenticator removed, but the security text could not be sent.",
    });
  }
  return reply.send(result);
}

function readChallenge(app: FastifyInstance, token: string): Challenge | null {
  try {
    return app.jwt.verify<Challenge>(token);
  } catch {
    return null;
  }
}

async function loadChallengeUser(app: FastifyInstance, token: string, purpose: "mfa-setup" | "mfa-login") {
  const challenge = readChallenge(app, token);
  if (!challenge || challenge.purpose !== purpose || typeof challenge.tv !== "number") return null;
  const user = await prisma.user.findUnique({ where: { id: challenge.sub } });
  if (!user || !user.isActive || user.tokenVersion !== challenge.tv) return null;
  return user;
}

function issueSession(app: FastifyInstance, user: { id: string; role: UserRole; tokenVersion: number }, amr: "SMS" | "TOTP" | "RECOVERY_CODE") {
  return app.jwt.sign({ sub: user.id, role: user.role, tv: user.tokenVersion, amr }, { expiresIn: JWT_EXPIRES_IN });
}

function sessionResponse(app: FastifyInstance, reply: Parameters<typeof setMediaCookie>[1], user: { id: string; name: string; email: string; employeeNumber: string | null; role: UserRole; tokenVersion: number; mfaEnabled?: boolean }, amr: "SMS" | "TOTP" | "RECOVERY_CODE") {
  const token = issueSession(app, user, amr);
  setMediaCookie(app, reply, user.id, user.tokenVersion);
  return { token, user: { id: user.id, name: user.name, email: user.email, employeeNumber: user.employeeNumber, role: user.role, mfaEnabled: Boolean(user.mfaEnabled) } };
}

export async function mfaRoutes(app: FastifyInstance) {
  app.post("/mfa/phone/enroll/start", { preHandler: [app.authenticate], config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const startedAt = Date.now();
    if (process.env.SMS_MFA_ENABLED !== "true") return reply.code(404).send({ error: "not found" });
    if (!isRecentAuthentication((request.user as typeof request.user & { iat?: number }).iat)
      || !["TOTP", "RECOVERY_CODE"].includes(request.user.amr ?? "")) {
      return reply.code(403).send({ error: "Sign in again before adding a phone number." });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const phone = typeof body.phone === "string" ? body.phone : "";
    const consentVersion = typeof body.consentVersion === "string" ? body.consentVersion.trim() : "";
    const turnstileToken = typeof body.turnstileToken === "string" ? body.turnstileToken : "";
    if (!phone || body.smsConsent !== true || !consentVersion || !turnstileToken) {
      return reply.code(400).send({ error: "Complete every phone-enrollment field." });
    }
    const human = await verifyHuman(turnstileToken, request.ip, {
      secret: required("TURNSTILE_SECRET_KEY"),
      expectedHostname: required("TURNSTILE_EXPECTED_HOSTNAME"),
      expectedAction: "sms_phone_enrollment",
    });
    if (!human) return reply.code(400).send({ error: "Verification could not be completed. Please try again." });

    const user = await prisma.user.findUnique({ where: { id: request.user.sub } });
    const enrollmentUser = user as typeof user & {
      accountStatus?: string; phoneVerifiedAt?: Date | null; phoneVersion?: number; mfaEnabled: boolean;
    };
    if (!enrollmentUser || !enrollmentUser.isActive || enrollmentUser.accountStatus !== "ACTIVE"
      || enrollmentUser.phoneVerifiedAt || !enrollmentUser.mfaEnabled || !enrollmentUser.mfaSecretEncrypted) {
      return reply.code(403).send({ error: "Phone self-enrollment is not available for this account." });
    }

    let destination: string;
    try { destination = normalizeUsPhone(phone); }
    catch { return reply.code(400).send({ error: "Enter a valid United States mobile number." }); }
    const destinationHash = hashPhone(destination);
    const conflict = await prisma.user.findUnique({ where: { phoneLookupHash: destinationHash }, select: { id: true } });
    const protectedPhone = encryptPhone(destination);
    const phoneLookupKeyVersion = Number((process.env.PHONE_LOOKUP_HMAC_KEYS ?? "").split(",")[0]?.split(":")[0]);
    const phoneVersion = (enrollmentUser.phoneVersion ?? 0) + 1;
    try {
      if (conflict && conflict.id !== enrollmentUser.id) {
        const decoy = await smsVerificationPolicy().startDecoySmsChallenge({
          userId: enrollmentUser.id, purpose: "PHONE_CHANGE", method: "SMS", destination,
          destinationHash, destinationVersion: phoneVersion,
          dimensions: [
            factorRemovalDimension("account", enrollmentUser.email.trim().toLowerCase()),
            factorRemovalDimension("ip", request.ip),
          ],
        });
        setChallengeCookie(reply, decoy.id);
        await settleEnrollmentTiming(startedAt);
        return reply.code(202).send({ status: "verification_pending", maskedDestination: maskPhone(destination) });
      }
      try {
        await prisma.user.update({ where: { id: enrollmentUser.id }, data: {
          phoneEncrypted: protectedPhone.ciphertext,
          phoneEncryptionKeyVersion: protectedPhone.keyVersion,
          phoneLookupHash: destinationHash,
          phoneLookupKeyVersion,
          phoneLast4: destination.slice(-4),
          phoneVersion,
          phoneVerifiedAt: null,
          phoneConsentAt: new Date(),
          phoneConsentVersion: consentVersion,
          phoneConsentSource: "legacy_self_enrollment",
        } });
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "P2002")) throw error;
        const decoy = await smsVerificationPolicy().startDecoySmsChallenge({
          userId: enrollmentUser.id, purpose: "PHONE_CHANGE", method: "SMS", destination,
          destinationHash, destinationVersion: phoneVersion,
          dimensions: [
            factorRemovalDimension("account", enrollmentUser.email.trim().toLowerCase()),
            factorRemovalDimension("ip", request.ip),
          ],
        });
        setChallengeCookie(reply, decoy.id);
        await settleEnrollmentTiming(startedAt);
        return reply.code(202).send({ status: "verification_pending", maskedDestination: maskPhone(destination) });
      }
      const challenge = await smsVerificationPolicy().startChallenge({
        userId: enrollmentUser.id,
        purpose: "PHONE_CHANGE",
        method: "SMS",
        destination,
        destinationHash,
        destinationVersion: phoneVersion,
        dimensions: [
          factorRemovalDimension("account", enrollmentUser.email.trim().toLowerCase()),
          factorRemovalDimension("ip", request.ip),
        ],
      });
      setChallengeCookie(reply, challenge.id);
      await settleEnrollmentTiming(startedAt);
      return reply.code(202).send({ status: "verification_pending", maskedDestination: maskPhone(destination) });
    } catch (error) {
      if (error instanceof VerificationLockedError) {
        reply.header("Retry-After", String(error.retryAfter));
        return reply.code(429).send({ error: error.message });
      }
      request.log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "phone enrollment verification start failed");
      return reply.code(503).send({ error: "Verification is temporarily unavailable. Please try again." });
    }
  });

  app.post("/mfa/phone/enroll/check", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    if (process.env.SMS_MFA_ENABLED !== "true") return reply.code(404).send({ error: "not found" });
    const genericVerificationError = { error: "That verification code is not correct or has expired." };
    const { code } = (request.body ?? {}) as { code?: string };
    if (!code || !/^\d{6}$/.test(code)) return reply.code(400).send({ error: "A 6-digit verification code is required." });
    const challengeId = readChallengeCookie(request);
    if (!challengeId) return reply.code(401).send(genericVerificationError);
    const challenges = await prisma.$queryRaw<Array<{
      userId: string | null; purpose: string; method: string; providerRef: string | null;
      phoneLookupHash: string | null; destinationVersion: number | null;
    }>>`
      SELECT "userId", "purpose", "method", "providerRef", "phoneLookupHash", "destinationVersion"
      FROM "MfaChallenge" WHERE "id" = ${challengeId} LIMIT 1
    `;
    const challenge = challenges[0];
    if (!challenge?.userId || challenge.purpose !== "PHONE_CHANGE" || challenge.method !== "SMS") {
      return reply.code(401).send(genericVerificationError);
    }
    if (challenge.providerRef === "decoy" && challenge.phoneLookupHash && challenge.destinationVersion !== null) {
      try {
        await smsVerificationPolicy().rejectDecoySmsChallenge({
          challengeId, userId: challenge.userId, purpose: "PHONE_CHANGE",
          destinationHash: challenge.phoneLookupHash, destinationVersion: challenge.destinationVersion,
        });
      } catch (error) {
        if (error instanceof VerificationLockedError) {
          reply.header("Retry-After", String(error.retryAfter));
          return reply.code(429).send({ error: error.message });
        }
      }
      return reply.code(401).send(genericVerificationError);
    }
    const user = await prisma.user.findUnique({ where: { id: challenge.userId } });
    const enrollmentUser = user as (typeof user & {
      accountStatus?: string; phoneEncrypted?: string | null; phoneEncryptionKeyVersion?: number | null;
      phoneLookupHash?: string | null; phoneVersion?: number; phoneVerifiedAt?: Date | null;
    }) | null;
    if (!enrollmentUser || !enrollmentUser.isActive || enrollmentUser.accountStatus !== "ACTIVE"
      || !enrollmentUser.phoneEncrypted || enrollmentUser.phoneEncryptionKeyVersion == null
      || !enrollmentUser.phoneLookupHash || !enrollmentUser.phoneVersion || enrollmentUser.phoneVerifiedAt) {
      return reply.code(401).send(genericVerificationError);
    }
    try {
      const correlationId = randomUUID();
      let backupCodes: string[] | null = null;
      const destination = decryptPhone(enrollmentUser.phoneEncrypted, enrollmentUser.phoneEncryptionKeyVersion);
      const result = await smsVerificationPolicy().completeChallenge({
        challengeId,
        userId: enrollmentUser.id,
        method: "SMS",
        destination,
        destinationHash: enrollmentUser.phoneLookupHash,
        destinationVersion: enrollmentUser.phoneVersion,
        code,
      }, (boundChallengeId, approvedAt) => prisma.$transaction(async (tx) => {
        const consumed = await tx.$executeRaw`
          UPDATE "MfaChallenge" SET "consumedAt" = ${approvedAt}
          WHERE "id" = ${boundChallengeId} AND "userId" = ${enrollmentUser.id}
            AND "purpose" = 'PHONE_CHANGE' AND "method" = 'SMS'
            AND "consumedAt" IS NULL AND "invalidatedAt" IS NULL AND "expiresAt" > ${approvedAt}
        `;
        if (consumed !== 1) throw new Error("Verification challenge is invalid.");
        const generatedBackupCodes = generateBackupCodes();
        const backupCodeHashes = await hashBackupCodes(generatedBackupCodes);
        const updated = await tx.user.updateMany({
          where: {
            id: enrollmentUser.id,
            accountStatus: "ACTIVE",
            isActive: true,
            phoneLookupHash: enrollmentUser.phoneLookupHash,
            phoneVersion: enrollmentUser.phoneVersion,
            phoneVerifiedAt: null,
          },
          data: {
            phoneVerifiedAt: approvedAt,
            mfaBackupCodeHashes: backupCodeHashes,
            recoveryPinHash: null,
            tokenVersion: { increment: 1 },
          },
        });
        if (updated.count !== 1) throw new Error("Phone enrollment is no longer current.");
        await tx.securityAuditEvent.create({ data: {
          eventType: "phone_enrollment",
          outcome: "approved",
          method: "SMS",
          actorUserId: enrollmentUser.id,
          targetUserId: enrollmentUser.id,
          safeReasonCode: "legacy_self_enrollment",
          correlationId,
        } });
        const active = await tx.user.findUnique({ where: { id: enrollmentUser.id } });
        if (!active) throw new Error("Enrolled user not found.");
        backupCodes = generatedBackupCodes;
        return active;
      }));
      if (!result.approved || !result.value || !backupCodes) return reply.code(401).send(genericVerificationError);
      invalidateTokenVersionCache(enrollmentUser.id);
      clearChallengeCookie(reply);
      return { ...sessionResponse(app, reply, result.value, "SMS"), backupCodes };
    } catch (error) {
      if (error instanceof VerificationLockedError) {
        reply.header("Retry-After", String(error.retryAfter));
        return reply.code(429).send({ error: error.message });
      }
      if (error instanceof VerificationAmbiguousError) {
        clearChallengeCookie(reply);
        return reply.code(409).send({
          error: "Verification could not be confirmed. Start again for a new code.",
          code: "fresh_challenge_required",
        });
      }
      request.log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "phone enrollment confirmation failed");
      return reply.code(401).send(genericVerificationError);
    }
  });

  app.post("/mfa/resend", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    if (process.env.SMS_MFA_ENABLED !== "true") return reply.code(404).send({ error: "not found" });
    const challengeId = readChallengeCookie(request);
    const genericError = { error: "Verification session expired. Start again." };
    if (!challengeId) return reply.code(401).send(genericError);
    const rows = await prisma.$queryRaw<Array<{
      userId: string | null; purpose: string; method: string; providerRef: string | null;
      phoneLookupHash: string | null; destinationVersion: number | null;
    }>>`
      SELECT "userId", "purpose", "method", "providerRef", "phoneLookupHash", "destinationVersion"
      FROM "MfaChallenge" WHERE "id" = ${challengeId} LIMIT 1
    `;
    const challenge = rows[0];
    if (!challenge?.userId || challenge.method !== "SMS" || !["LOGIN", "PHONE_CHANGE"].includes(challenge.purpose)) {
      return reply.code(401).send(genericError);
    }
    const user = await prisma.user.findUnique({ where: { id: challenge.userId } });
    const smsUser = user as (typeof user & {
      accountStatus?: string; phoneEncrypted?: string | null; phoneEncryptionKeyVersion?: number | null;
      phoneLookupHash?: string | null; phoneVersion?: number; phoneLast4?: string | null; phoneVerifiedAt?: Date | null;
    }) | null;
    const expectedVerified = challenge.purpose === "LOGIN";
    if (!smsUser || !smsUser.isActive || smsUser.accountStatus !== "ACTIVE") {
      return reply.code(401).send(genericError);
    }
    try {
      if (challenge.providerRef === "decoy" && challenge.phoneLookupHash && challenge.destinationVersion !== null) {
        const replacement = await smsVerificationPolicy().resendDecoySmsChallenge({
          previousChallengeId: challengeId, userId: smsUser.id, purpose: "PHONE_CHANGE", method: "SMS",
          destination: "", destinationHash: challenge.phoneLookupHash, destinationVersion: challenge.destinationVersion,
          dimensions: [
            factorRemovalDimension("account", smsUser.email.trim().toLowerCase()),
            factorRemovalDimension("ip", request.ip),
          ],
        });
        setChallengeCookie(reply, replacement.id);
        return { method: "SMS", maskedDestination: "your phone" };
      }
      if (!smsUser.phoneEncrypted || smsUser.phoneEncryptionKeyVersion == null || !smsUser.phoneLookupHash
        || !smsUser.phoneVersion || !smsUser.phoneLast4 || Boolean(smsUser.phoneVerifiedAt) !== expectedVerified) {
        return reply.code(401).send(genericError);
      }
      const destination = decryptPhone(smsUser.phoneEncrypted, smsUser.phoneEncryptionKeyVersion);
      const replacement = await smsVerificationPolicy().resendChallenge({
        previousChallengeId: challengeId,
        userId: smsUser.id,
        purpose: challenge.purpose as "LOGIN" | "PHONE_CHANGE",
        method: "SMS",
        destination,
        destinationHash: smsUser.phoneLookupHash,
        destinationVersion: smsUser.phoneVersion,
        dimensions: [
          factorRemovalDimension("account", smsUser.email.trim().toLowerCase()),
          factorRemovalDimension("ip", request.ip),
        ],
      });
      setChallengeCookie(reply, replacement.id);
      return { method: "SMS", maskedDestination: "your phone" };
    } catch (error) {
      if (error instanceof VerificationLockedError) {
        reply.header("Retry-After", String(error.retryAfter));
        return reply.code(429).send({ error: error.message });
      }
      if (error instanceof VerificationRejectedError) return reply.code(401).send(genericError);
      request.log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "verification resend failed");
      return reply.code(503).send({ error: "Verification is temporarily unavailable. Please try again." });
    }
  });

  app.post("/mfa/totp/enroll", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (process.env.SMS_MFA_ENABLED !== "true") return reply.code(404).send({ error: "not found" });
    const { code } = (request.body ?? {}) as { code?: string };
    const user = await prisma.user.findUnique({ where: { id: request.user.sub } });
    const smsUser = user as (typeof user & { accountStatus?: string; phoneVerifiedAt?: Date | null }) | null;
    if (!smsUser || !smsUser.isActive || smsUser.accountStatus !== "ACTIVE" || !smsUser.phoneVerifiedAt) {
      return reply.code(403).send({ error: "A verified SMS account is required." });
    }
    if (smsUser.mfaEnabled) return reply.code(409).send({ error: "Authenticator backup is already enrolled." });

    if (code !== undefined) {
      if (!/^\d{6}$/.test(code) || !smsUser.mfaSecretEncrypted) {
        return reply.code(400).send({ error: "A 6-digit verification code is required." });
      }
      let valid = false;
      try { valid = verifyTotp(decryptSecret(smsUser.mfaSecretEncrypted), code); } catch { /* invalid staged factor */ }
      if (!valid) return reply.code(401).send({ error: "That verification code is not correct." });
      await prisma.user.update({ where: { id: smsUser.id }, data: { mfaEnabled: true } });
      return { enrolled: true };
    }

    const secret = generateTotpSecret();
    await prisma.user.update({
      where: { id: smsUser.id },
      data: { mfaSecretEncrypted: encryptSecret(secret), mfaEnabled: false },
    });
    const account = smsUser.employeeNumber || smsUser.email;
    const qrDataUrl = await QRCode.toDataURL(otpauthUri(secret, account), { width: 240, margin: 1 });
    return { qrDataUrl, manualKey: secret, account };
  });

  app.post("/mfa/totp/remove", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (process.env.SMS_MFA_ENABLED !== "true") return reply.code(404).send({ error: "not found" });
    const { code } = (request.body ?? {}) as { code?: string };
    const genericVerificationError = { error: "That verification code is not correct or has expired." };

    if (code === undefined) {
      let notificationProvider: SecurityNotificationProvider;
      try {
        notificationProvider = createSecurityNotificationProvider(process.env);
      } catch (error) {
        if (error instanceof SecurityNotificationConfigurationError) {
          return reply.code(503).send({
            error: "Security notifications are temporarily unavailable. Factor removal was not started.",
          });
        }
        throw error;
      }
      const user = await prisma.user.findUnique({ where: { id: request.user.sub } });
      const smsUser = user as (typeof user & { phoneLast4?: string | null }) | null;
      if (!smsUser || !removableTotpUser(smsUser)) {
        return reply.code(403).send({ error: "TOTP removal is not available for this account." });
      }
      try {
        const challenge = await factorRemovalService(notificationProvider).startTotpRemoval(smsUser, [
          factorRemovalDimension("account", smsUser.email.trim().toLowerCase()),
          factorRemovalDimension("ip", request.ip),
        ]);
        setChallengeCookie(reply, challenge.id);
        return reply.code(202).send({
          status: "verification_pending",
          method: "SMS",
          maskedDestination: `(***) ***-${smsUser.phoneLast4}`,
        });
      } catch (error) {
        if (error instanceof VerificationLockedError) {
          reply.header("Retry-After", String(error.retryAfter));
          return reply.code(429).send({ error: error.message });
        }
        request.log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "factor removal verification start failed");
        return reply.code(503).send({ error: "Verification is temporarily unavailable. Please try again." });
      }
    }

    if (!/^\d{6}$/.test(code)) return reply.code(401).send(genericVerificationError);
    const challengeId = readChallengeCookie(request);
    if (!challengeId) return reply.code(401).send(genericVerificationError);
    const rows = await prisma.$queryRaw<Array<{ userId: string | null; purpose: string; method: string }>>`
      SELECT "userId", "purpose", "method" FROM "MfaChallenge" WHERE "id" = ${challengeId} LIMIT 1
    `;
    const challenge = rows[0];
    if (challenge?.userId !== request.user.sub || challenge.purpose !== "FACTOR_REMOVAL" || challenge.method !== "SMS") {
      return reply.code(401).send(genericVerificationError);
    }
    const user = await prisma.user.findUnique({ where: { id: request.user.sub } });
    const smsUser = user as (typeof user & { phoneLast4?: string | null }) | null;
    if (!smsUser || !removableTotpUser(smsUser)) return reply.code(401).send(genericVerificationError);

    let notificationProvider: SecurityNotificationProvider;
    try {
      notificationProvider = createSecurityNotificationProvider(process.env);
    } catch (error) {
      if (error instanceof SecurityNotificationConfigurationError) {
        return reply.code(503).send({
          error: "Security notifications are temporarily unavailable. Factor removal was not started.",
        });
      }
      throw error;
    }

    try {
      const result = await factorRemovalService(notificationProvider).confirmTotpRemoval(smsUser, challengeId, code);
      return sendCommittedFactorRemoval(reply, result);
    } catch (error) {
      if (error instanceof FactorRemovalCommittedResultError) {
        request.log.error({ errorType: error.name }, "factor removal post-commit processing failed");
        return sendCommittedFactorRemoval(reply, error.result);
      }
      if (error instanceof VerificationLockedError) {
        reply.header("Retry-After", String(error.retryAfter));
        return reply.code(429).send({ error: error.message });
      }
      if (error instanceof FactorRemovalVerificationRejectedError) {
        return reply.code(401).send(genericVerificationError);
      }
      request.log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "factor removal confirmation failed");
      return reply.code(503).send({ error: "Verification is temporarily unavailable. Please try again." });
    }
  });

  app.post("/mfa/method", async (request, reply) => {
    if (process.env.SMS_MFA_ENABLED !== "true") return reply.code(404).send({ error: "not found" });
    const { method } = (request.body ?? {}) as { method?: string };
    if (method !== "TOTP" && method !== "RECOVERY_CODE") return reply.code(400).send({ error: "Select an available backup method." });
    const challengeId = readChallengeCookie(request);
    if (!challengeId) return reply.code(401).send({ error: "Verification session expired. Sign in again." });
    const rows = await prisma.$queryRaw<Array<{ userId: string | null; purpose: string; method: string }>>`
      SELECT "userId", "purpose", "method" FROM "MfaChallenge" WHERE "id" = ${challengeId} LIMIT 1
    `;
    const challenge = rows[0];
    if (!challenge?.userId || challenge.purpose !== "LOGIN" || challenge.method === method) return reply.code(401).send({ error: "Verification session expired. Sign in again." });
    const user = await prisma.user.findUnique({ where: { id: challenge.userId } });
    if (!user || !user.isActive || (method === "TOTP" ? !user.mfaEnabled || !user.mfaSecretEncrypted : !Array.isArray(user.mfaBackupCodeHashes) || user.mfaBackupCodeHashes.length === 0)) {
      return reply.code(400).send({ error: "That backup method is not available." });
    }
    try {
      const replacement = await smsVerificationPolicy().switchChallengeMethod({
        challengeId,
        userId: user.id,
        purpose: "LOGIN",
        method,
        destinationHash: factorBinding(method, user.id),
        destinationVersion: user.tokenVersion,
      });
      setChallengeCookie(reply, replacement.id);
      return { method };
    } catch {
      return reply.code(401).send({ error: "Verification session expired. Sign in again." });
    }
  });

  app.post("/mfa/check", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    if (process.env.SMS_MFA_ENABLED !== "true") return reply.code(404).send({ error: "not found" });
    const { code } = (request.body ?? {}) as { code?: string };
    if (!code || typeof code !== "string") return reply.code(400).send({ error: "A verification code is required." });
    const challengeId = readChallengeCookie(request);
    if (!challengeId) return reply.code(401).send({ error: "Verification session expired. Sign in again." });
    const rows = await prisma.$queryRaw<Array<{ userId: string | null; purpose: string; method: string }>>`
      SELECT "userId", "purpose", "method" FROM "MfaChallenge" WHERE "id" = ${challengeId} LIMIT 1
    `;
    const challenge = rows[0];
    if (!challenge?.userId || challenge.purpose !== "LOGIN" || !["SMS", "TOTP", "RECOVERY_CODE"].includes(challenge.method)) {
      return reply.code(401).send({ error: "Verification session expired. Sign in again." });
    }
    const user = await prisma.user.findUnique({ where: { id: challenge.userId } });
    const smsUser = user as (typeof user & {
      accountStatus?: string; phoneEncrypted?: string | null; phoneEncryptionKeyVersion?: number | null;
      phoneLookupHash?: string | null; phoneVersion?: number;
    }) | null;
    if (!smsUser || !smsUser.isActive || smsUser.accountStatus !== "ACTIVE") {
      return reply.code(401).send({ error: "Verification session expired. Sign in again." });
    }
    try {
      if (challenge.method === "TOTP") {
        if (!/^\d{6}$/.test(code) || !smsUser.mfaSecretEncrypted) return reply.code(400).send({ error: "A 6-digit verification code is required." });
        const result = await smsVerificationPolicy().completeLocalChallenge({
          challengeId, userId: smsUser.id, purpose: "LOGIN", method: "TOTP",
          destinationHash: factorBinding("TOTP", smsUser.id), destinationVersion: smsUser.tokenVersion,
        }, async (boundChallengeId, approvedAt) => {
          let valid = false;
          try { valid = verifyTotp(decryptSecret(smsUser.mfaSecretEncrypted!), code); } catch { /* invalid encrypted factor */ }
          if (!valid) return "incorrect" as const;
          const consumed = await prisma.$executeRaw`
            UPDATE "MfaChallenge" SET "consumedAt" = ${approvedAt}
            WHERE "id" = ${boundChallengeId} AND "consumedAt" IS NULL AND "invalidatedAt" IS NULL AND "expiresAt" > ${approvedAt}
          `;
          return consumed === 1 ? "approved" as const : "conflict" as const;
        });
        if (!result.approved) return reply.code(401).send({ error: "That verification code is not correct." });
        clearChallengeCookie(reply);
        return { ...sessionResponse(app, reply, smsUser, "TOTP"), phoneEnrollmentRequired: !smsUser.phoneVerifiedAt };
      }
      if (challenge.method === "RECOVERY_CODE") {
        const result = await smsVerificationPolicy().completeLocalChallenge({
          challengeId, userId: smsUser.id, purpose: "LOGIN", method: "RECOVERY_CODE",
          destinationHash: factorBinding("RECOVERY_CODE", smsUser.id), destinationVersion: smsUser.tokenVersion,
        }, async (boundChallengeId, approvedAt) => prisma.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<Array<{ mfaBackupCodeHashes: unknown }>>`
            SELECT "mfaBackupCodeHashes" FROM "User" WHERE "id" = ${smsUser.id} FOR UPDATE
          `;
          const hashes = Array.isArray(locked[0]?.mfaBackupCodeHashes) ? locked[0].mfaBackupCodeHashes.filter((value): value is string => typeof value === "string") : [];
          const backup = await consumeBackupCode(code, hashes);
          if (!backup.valid) return "incorrect" as const;
          const consumed = await tx.$executeRaw`
            UPDATE "MfaChallenge" SET "consumedAt" = ${approvedAt}
            WHERE "id" = ${boundChallengeId} AND "consumedAt" IS NULL AND "invalidatedAt" IS NULL AND "expiresAt" > ${approvedAt}
          `;
          if (consumed !== 1) return "conflict" as const;
          await tx.user.update({ where: { id: smsUser.id }, data: { mfaBackupCodeHashes: backup.remaining } });
          return "approved" as const;
        }));
        if (!result.approved) return reply.code(401).send({ error: "That verification code is not correct." });
        clearChallengeCookie(reply);
        return sessionResponse(app, reply, smsUser, "RECOVERY_CODE");
      }
      if (!/^\d{6}$/.test(code) || !smsUser.phoneEncrypted || smsUser.phoneEncryptionKeyVersion == null || !smsUser.phoneLookupHash) {
        return reply.code(400).send({ error: "A 6-digit verification code is required." });
      }
      const result = await smsVerificationPolicy().checkChallenge({
        challengeId,
        userId: smsUser.id,
        method: "SMS",
        destination: decryptPhone(smsUser.phoneEncrypted, smsUser.phoneEncryptionKeyVersion),
        destinationHash: smsUser.phoneLookupHash,
        destinationVersion: smsUser.phoneVersion ?? 1,
        code,
      });
      if (!result.approved) return reply.code(401).send({ error: "That verification code is not correct." });
      clearChallengeCookie(reply);
      return sessionResponse(app, reply, smsUser, "SMS");
    } catch (error) {
      if (error instanceof VerificationLockedError) {
        reply.header("Retry-After", String(error.retryAfter));
        return reply.code(429).send({ error: error.message });
      }
      return reply.code(401).send({ error: "That verification code is not correct or has expired." });
    }
  });

  app.post("/mfa/setup", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const { challengeToken } = (request.body ?? {}) as { challengeToken?: string };
    if (!challengeToken) return reply.code(400).send({ error: "MFA setup token is required." });
    const user = await loadChallengeUser(app, challengeToken, "mfa-setup");
    if (!user) return reply.code(401).send({ error: "MFA setup session expired. Sign in again." });

    let secret: string;
    if (user.mfaSecretEncrypted) {
      try { secret = decryptSecret(user.mfaSecretEncrypted); } catch { secret = generateTotpSecret(); }
    } else {
      secret = generateTotpSecret();
    }
    await prisma.user.update({ where: { id: user.id }, data: { mfaSecretEncrypted: encryptSecret(secret), mfaEnabled: false } });
    const uri = otpauthUri(secret, user.employeeNumber || user.email);
    const qrDataUrl = await QRCode.toDataURL(uri, { width: 240, margin: 1 });
    return { qrDataUrl, secret, account: user.employeeNumber || user.email };
  });

  app.post("/mfa/confirm", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const { challengeToken, code } = (request.body ?? {}) as { challengeToken?: string; code?: string };
    if (!challengeToken || !code) return reply.code(400).send({ error: "MFA setup token and 6-digit code are required." });
    const user = await loadChallengeUser(app, challengeToken, "mfa-setup");
    if (!user || !user.mfaSecretEncrypted) return reply.code(401).send({ error: "MFA setup session expired. Sign in again." });

    let secret: string;
    try { secret = decryptSecret(user.mfaSecretEncrypted); } catch { return reply.code(400).send({ error: "MFA setup must be restarted." }); }
    if (!verifyTotp(secret, code)) return reply.code(401).send({ error: "That verification code is not correct." });

    const backupCodes = generateBackupCodes();
    const hashes = await hashBackupCodes(backupCodes);
    const updated = await prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: true, mfaBackupCodeHashes: hashes } });
    return { ...sessionResponse(app, reply, updated, "TOTP"), backupCodes };
  });

  app.post("/mfa/verify", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    if (process.env.SMS_MFA_ENABLED === "true") return reply.code(410).send({ error: "Use a method-bound MFA challenge." });
    const { challengeToken, code } = (request.body ?? {}) as { challengeToken?: string; code?: string };
    if (!challengeToken || !code) return reply.code(400).send({ error: "MFA challenge and verification code are required." });
    const user = await loadChallengeUser(app, challengeToken, "mfa-login");
    if (!user || !user.mfaEnabled || !user.mfaSecretEncrypted) return reply.code(401).send({ error: "MFA verification session expired. Sign in again." });

    let totpValid = false;
    try { totpValid = verifyTotp(decryptSecret(user.mfaSecretEncrypted), code); } catch { /* invalid encrypted secret */ }
    if (totpValid) return sessionResponse(app, reply, user, "TOTP");

    const hashes = Array.isArray(user.mfaBackupCodeHashes) ? user.mfaBackupCodeHashes.filter((v): v is string => typeof v === "string") : [];
    const backup = await consumeBackupCode(code, hashes);
    if (!backup.valid) return reply.code(401).send({ error: "That verification code is not correct." });

    await prisma.user.update({ where: { id: user.id }, data: { mfaBackupCodeHashes: backup.remaining } });
    return sessionResponse(app, reply, user, "RECOVERY_CODE");
  });
}
