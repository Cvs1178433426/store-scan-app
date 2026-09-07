import type { FastifyInstance } from "fastify";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import {
  createUserSchema,
  loginSchema,
  passwordRecoveryCompleteSchema,
  passwordRecoveryStartSchema,
  updateProfileSchema,
} from "@continuixai/shared";
import { prisma } from "../lib/prisma.js";
import { t } from "../lib/i18n.js";
import { bumpTokenVersion, invalidateTokenVersionCache } from "../lib/tokenVersion.js";
import { clearMediaCookie } from "../lib/mediaAuth.js";
import { decryptPhone } from "../lib/phone.js";
import { clearChallengeCookie, setChallengeCookie } from "../lib/mfaChallengeCookie.js";
import { TwilioVerifyProvider } from "../lib/twilioVerifyProvider.js";
import { PrismaVerificationPolicyStore, VerificationLockedError, VerificationPolicy } from "../lib/verificationPolicy.js";
import { PasswordRecoveryRejectedError, PasswordRecoveryService, PrismaPasswordRecoveryRepository } from "../lib/passwordRecoveryService.js";
import { verificationPhonePrefixHash } from "../lib/verificationRateLimit.js";
import { VerificationProviderError } from "../lib/verificationProvider.js";
import { isSmsEnrollmentRequired } from "../lib/smsMigration.js";

const LOGIN_DECOY_PASSWORD_HASH = "$2b$10$wL9vX9fQe9O4vBLcL20RHuJQXaKf6M5kh3AD0XnVqmj3tO3IhpY7K";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when SMS MFA is enabled.`);
  return value;
}

function loginDimension(kind: string, value: string): string {
  return `${kind}:${createHmac("sha256", required("RATE_LIMIT_HMAC_KEY")).update(value).digest("hex")}`;
}

function localFactorBinding(method: "TOTP" | "RECOVERY_CODE", userId: string): string {
  return createHmac("sha256", required("RATE_LIMIT_HMAC_KEY")).update(`${method}:${userId}`).digest("hex");
}

function loginVerificationPolicy(): VerificationPolicy {
  const provider = new TwilioVerifyProvider({
    accountSid: required("TWILIO_ACCOUNT_SID"),
    apiKeySid: required("TWILIO_API_KEY_SID"),
    apiKeySecret: required("TWILIO_API_KEY_SECRET"),
    serviceSid: required("TWILIO_VERIFY_SERVICE_SID"),
  });
  return new VerificationPolicy(new PrismaVerificationPolicyStore(), provider);
}

function localLoginVerificationPolicy(): VerificationPolicy {
  const unavailableProvider = {
    async start(): Promise<never> { throw new VerificationProviderError(); },
    async check(): Promise<never> { throw new VerificationProviderError(); },
  };
  return new VerificationPolicy(new PrismaVerificationPolicyStore(), unavailableProvider);
}

function passwordRecoveryService(): PasswordRecoveryService {
  return new PasswordRecoveryService(new PrismaPasswordRecoveryRepository(), loginVerificationPolicy());
}

function newEmployeeNumber(): string {
  return `EMP-${randomBytes(5).toString("hex").toUpperCase()}`;
}

async function createEmployeeNumber(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = newEmployeeNumber();
    const exists = await prisma.user.findUnique({ where: { employeeNumber: candidate }, select: { id: true } });
    if (!exists) return candidate;
  }
  throw new Error("Unable to allocate a unique employee number.");
}

export async function authRoutes(app: FastifyInstance) {
  app.get("/bootstrap/status", async () => {
    const userCount = await prisma.user.count();
    return { needsBootstrap: userCount === 0 };
  });

  app.post("/bootstrap/admin", async (_request, reply) => {
    return reply.code(410).send({ error: "Verified registration is required." });
  });

  app.post("/register", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (_request, reply) => {
    return reply.code(410).send({ error: "Use SMS-verified registration." });
  });

  app.post("/login", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const identifier = (parsed.data.identifier ?? parsed.data.email ?? "").trim();
    const user = await prisma.user.findFirst({ where: { OR: [{ email: identifier.toLowerCase() }, { employeeNumber: identifier.toUpperCase() }] } });
    const passwordHash = user?.isActive ? user.passwordHash : LOGIN_DECOY_PASSWORD_HASH;
    const valid = await bcrypt.compare(parsed.data.password, passwordHash);
    if (!user || !user.isActive || !valid) return reply.code(401).send({ error: t("invalidCredentials", request.locale) });

    const smsUser = user as typeof user & {
      accountStatus?: string;
      phoneEncrypted?: string | null;
      phoneEncryptionKeyVersion?: number | null;
      phoneLookupHash?: string | null;
      phoneVersion?: number;
      phoneLast4?: string | null;
      phoneVerifiedAt?: Date | null;
    };
    if (process.env.SMS_MFA_ENABLED === "true") {
      if (smsUser.accountStatus !== "ACTIVE") {
        return reply.code(403).send({ error: "This account is not available for sign-in." });
      }
      if (!smsUser.phoneEncrypted || smsUser.phoneEncryptionKeyVersion == null || !smsUser.phoneLookupHash || !smsUser.phoneVerifiedAt || !smsUser.phoneLast4) {
        if (user.mfaEnabled && user.mfaSecretEncrypted) {
          const challenge = await loginVerificationPolicy().startLocalChallenge({
            userId: user.id,
            purpose: "LOGIN",
            method: "TOTP",
            destinationHash: localFactorBinding("TOTP", user.id),
            destinationVersion: user.tokenVersion,
            tokenVersionAtIssue: user.tokenVersion,
          });
          setChallengeCookie(reply, challenge.id);
          return { mfaRequired: true, method: "TOTP", phoneEnrollmentRequired: true };
        }
        return reply.code(403).send({
          error: "This account needs security support before phone enrollment can continue.",
          code: "security_support_required",
        });
      }
      try {
        const destination = decryptPhone(smsUser.phoneEncrypted, smsUser.phoneEncryptionKeyVersion);
        const challenge = await loginVerificationPolicy().startChallenge({
          userId: user.id,
          purpose: "LOGIN",
          method: "SMS",
          destination,
          destinationHash: smsUser.phoneLookupHash,
          destinationVersion: smsUser.phoneVersion ?? 1,
          tokenVersionAtIssue: user.tokenVersion,
          dimensions: [
            loginDimension("account", user.email.trim().toLowerCase()),
            loginDimension("ip", request.ip),
            `phone-prefix:${verificationPhonePrefixHash(destination)}`,
          ],
        });
        setChallengeCookie(reply, challenge.id);
        return {
          mfaRequired: true,
          method: "SMS",
          maskedDestination: `(***) ***-${smsUser.phoneLast4}`,
          user: { id: user.id, name: user.name, email: user.email, employeeNumber: user.employeeNumber, role: user.role },
        };
      } catch (error) {
        if (error instanceof VerificationLockedError) {
          reply.header("Retry-After", String(error.retryAfter));
          return reply.code(429).send({ error: error.message });
        }
        request.log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "login verification start failed");
        const hasTotp = user.mfaEnabled && Boolean(user.mfaSecretEncrypted);
        const hasRecoveryCode = Array.isArray(user.mfaBackupCodeHashes)
          && user.mfaBackupCodeHashes.some((value) => typeof value === "string");
        if (hasTotp || hasRecoveryCode) {
          const method = hasTotp ? "TOTP" as const : "RECOVERY_CODE" as const;
          try {
            const challenge = await localLoginVerificationPolicy().startLocalChallenge({
              userId: user.id,
              purpose: "LOGIN",
              method,
              destinationHash: localFactorBinding(method, user.id),
              destinationVersion: user.tokenVersion,
              tokenVersionAtIssue: user.tokenVersion,
            });
            setChallengeCookie(reply, challenge.id);
            return {
              mfaRequired: true,
              method,
              smsUnavailable: true,
              user: { id: user.id, name: user.name, email: user.email, employeeNumber: user.employeeNumber, role: user.role },
            };
          } catch (fallbackError) {
            request.log.error({ errorType: fallbackError instanceof Error ? fallbackError.name : "unknown" }, "backup verification start failed");
          }
        }
        return reply.code(503).send({ error: "Verification is temporarily unavailable. Please try again." });
      }
    }

    if (smsUser.phoneVerifiedAt) {
      const hasTotp = user.mfaEnabled && Boolean(user.mfaSecretEncrypted);
      const hasRecoveryCode = Array.isArray(user.mfaBackupCodeHashes)
        && user.mfaBackupCodeHashes.some((value) => typeof value === "string");
      if (hasTotp || hasRecoveryCode) {
        const method = hasTotp ? "TOTP" as const : "RECOVERY_CODE" as const;
        try {
          const challenge = await localLoginVerificationPolicy().startLocalChallenge({
            userId: user.id,
            purpose: "LOGIN",
            method,
            destinationHash: localFactorBinding(method, user.id),
            destinationVersion: user.tokenVersion,
            tokenVersionAtIssue: user.tokenVersion,
          });
          setChallengeCookie(reply, challenge.id);
          return {
            mfaRequired: true,
            method,
            user: { id: user.id, name: user.name, email: user.email, employeeNumber: user.employeeNumber, role: user.role },
          };
        } catch {
          return reply.code(503).send({
            error: "Backup verification is temporarily unavailable. Please try again.",
            code: "backup_verification_unavailable",
          });
        }
      }
      return reply.code(503).send({
        error: "SMS verification is temporarily unavailable. Use an existing backup factor or contact support.",
        code: "sms_verification_unavailable",
      });
    }

    const purpose = user.mfaEnabled ? "mfa-login" : "mfa-setup";
    const challengeToken = app.jwt.sign({ sub: user.id, role: user.role, tv: user.tokenVersion, purpose }, { expiresIn: "10m" });
    return {
      mfaRequired: true,
      enrollmentRequired: !user.mfaEnabled,
      challengeToken,
      user: { id: user.id, name: user.name, email: user.email, employeeNumber: user.employeeNumber, role: user.role },
    };
  });

  app.post("/password-recovery/start", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    if (process.env.SMS_MFA_ENABLED !== "true") return reply.code(404).send({ error: "not found" });
    const parsed = passwordRecoveryStartSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const previousChallengeId = request.cookies.continuixai_mfa_challenge;
      const result = await passwordRecoveryService().beginPasswordRecovery(parsed.data.email, {
        method: parsed.data.method,
        previousChallengeId,
        dimensions: [loginDimension("password-recovery-ip", request.ip)],
      });
      setChallengeCookie(reply, result.challengeId ?? randomUUID());
      return reply.code(202).send({ ok: true });
    } catch (error) {
      if (error instanceof VerificationLockedError) {
        reply.header("Retry-After", String(error.retryAfter));
        return reply.code(429).send({ error: error.message });
      }
      request.log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "password recovery start failed");
      setChallengeCookie(reply, randomUUID());
      return reply.code(202).send({ ok: true });
    }
  });

  app.post("/password-recovery/complete", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    if (process.env.SMS_MFA_ENABLED !== "true") return reply.code(404).send({ error: "not found" });
    const parsed = passwordRecoveryCompleteSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const challengeId = request.cookies.continuixai_mfa_challenge;
    if (!challengeId) return reply.code(401).send({ error: "That verification code is not correct or has expired." });
    try {
      await passwordRecoveryService().completePasswordRecovery(challengeId, parsed.data.code, parsed.data.newPassword);
      clearChallengeCookie(reply);
      return { ok: true };
    } catch (error) {
      if (error instanceof VerificationLockedError) {
        reply.header("Retry-After", String(error.retryAfter));
        return reply.code(429).send({ error: error.message });
      }
      if (error instanceof VerificationProviderError) {
        request.log.error({ errorType: error.name }, "password recovery completion failed");
        return reply.code(503).send({ error: "Verification is temporarily unavailable. Please try again." });
      }
      if (error instanceof PasswordRecoveryRejectedError) {
        return reply.code(401).send({ error: "That verification code is not correct or has expired." });
      }
      request.log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "password recovery completion failed");
      return reply.code(401).send({ error: "That verification code is not correct or has expired." });
    }
  });

  app.post("/logout", { preHandler: [app.authenticate] }, async (_request, reply) => {
    clearMediaCookie(reply);
    return reply.code(204).send();
  });

  app.post("/logout-all", { preHandler: [app.authenticate] }, async (request, reply) => {
    await bumpTokenVersion(request.user.sub);
    clearMediaCookie(reply);
    return reply.code(204).send();
  });

  app.get("/me", { preHandler: [app.authenticate] }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.user.sub } });
    if (!user || !user.isActive) return reply.code(401).send({ error: "unauthorized" });
    const taskManager = user.role === "ADMIN" || Boolean(await prisma.organizationMembership.findFirst({
      where: { userId: user.id, isActive: true, role: { in: ["OWNER", "ADMIN", "MANAGER"] } },
      select: { id: true },
    }));
    return {
      id: user.id, name: user.name, email: user.email, employeeNumber: user.employeeNumber,
      role: user.role, jobTitle: user.jobTitle, taskManager, mfaEnabled: user.mfaEnabled,
      phoneVerified: Boolean(user.phoneVerifiedAt),
      phoneLast4: user.phoneVerifiedAt ? user.phoneLast4 : null,
      phoneEnrollmentRequired: isSmsEnrollmentRequired(user.phoneVerifiedAt),
    };
  });

  app.post("/users", { preHandler: [app.authenticate, app.requireAdmin] }, async (request, reply) => {
    if (process.env.SMS_MFA_ENABLED === "true") {
      return reply.code(403).send({
        error: "New employees must register and verify their own phone number.",
        code: "self_registration_required",
      });
    }
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { name, email, password, role } = parsed.data;
    const [passwordHash, employeeNumber] = await Promise.all([bcrypt.hash(password, 10), createEmployeeNumber()]);
    const user = await prisma.user.create({ data: { name, email, employeeNumber, passwordHash, role } });
    return reply.code(201).send({ id: user.id, name: user.name, email: user.email, employeeNumber: user.employeeNumber, role: user.role, isActive: user.isActive });
  });

  app.get("/users", { preHandler: [app.authenticate, app.requireAdmin] }, async () => {
    const users = await prisma.user.findMany({
      select: {
        id: true, name: true, email: true, employeeNumber: true, role: true,
        jobTitle: true, isActive: true, mfaEnabled: true, phoneVerifiedAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
    return users.map(({ phoneVerifiedAt, ...user }) => ({ ...user, phoneVerified: Boolean(phoneVerifiedAt) }));
  });

  app.delete("/users/:id", { preHandler: [app.authenticate, app.requireAdmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (id === request.user.sub) return reply.code(400).send({ error: t("cannotDeleteSelf", request.locale) });
    const target = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!target) return reply.code(404).send({ error: t("userNotFound", request.locale) });
    await prisma.user.update({
      where: { id },
      data: { accountStatus: "DISABLED", isActive: false, tokenVersion: { increment: 1 } },
    });
    await prisma.organizationMembership.updateMany({ where: { userId: id }, data: { isActive: false } });
    invalidateTokenVersionCache(id);
    return reply.code(204).send();
  });

  app.post("/users/:id/reset-mfa", { preHandler: [app.authenticate, app.requireAdmin] }, async (_request, reply) => {
    return reply.code(403).send({ error: "Administrators cannot replace user authentication factors." });
  });

  app.patch("/profile", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = updateProfileSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const userId = request.user.sub;
    const { name, email, currentPassword, newPassword } = parsed.data;
    if (email !== undefined) {
      return reply.code(403).send({
        error: "Registered email changes require a separately verified security workflow.",
        code: "verified_email_change_required",
      });
    }
    const updateData: Record<string, unknown> = {};
    if (name) updateData.name = name;
    if (newPassword) {
      if (!currentPassword) return reply.code(400).send({ error: t("currentPasswordRequired", request.locale) });
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return reply.code(404).send({ error: t("userNotFound", request.locale) });
      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) return reply.code(400).send({ error: t("incorrectCurrentPassword", request.locale) });
      updateData.passwordHash = await bcrypt.hash(newPassword, 10);
    }
    const user = await prisma.user.update({ where: { id: userId }, data: updateData });
    if (newPassword) { await bumpTokenVersion(userId); clearMediaCookie(reply); } else invalidateTokenVersionCache(userId);
    return { id: user.id, name: user.name, email: user.email, employeeNumber: user.employeeNumber, role: user.role, jobTitle: user.jobTitle, mfaEnabled: user.mfaEnabled };
  });
}
