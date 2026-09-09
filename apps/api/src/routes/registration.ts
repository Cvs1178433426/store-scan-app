import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { registerCheckSchema, registerResendSchema, registerStartSchema } from "@continuixai/shared";
import { prisma } from "../lib/prisma.js";
import { TwilioVerifyProvider } from "../lib/twilioVerifyProvider.js";
import { verifyHuman } from "../lib/turnstile.js";
import { PrismaVerificationPolicyStore, VerificationLockedError, VerificationPolicy } from "../lib/verificationPolicy.js";
import { PrismaRegistrationRepository, RegistrationService } from "../lib/registrationService.js";
import { clearChallengeCookie, readChallengeCookie, setChallengeCookie } from "../lib/mfaChallengeCookie.js";
import { setMediaCookie } from "../lib/mediaAuth.js";
import { maskPhone, normalizeUsPhone } from "../lib/phone.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when SMS MFA is enabled.`);
  return value;
}

function safeDimension(kind: string, value: string): string {
  return `${kind}:${createHmac("sha256", required("RATE_LIMIT_HMAC_KEY")).update(value).digest("hex")}`;
}

function registrationPolicy(): VerificationPolicy {
  const provider = new TwilioVerifyProvider({
    accountSid: required("TWILIO_ACCOUNT_SID"),
    apiKeySid: required("TWILIO_API_KEY_SID"),
    apiKeySecret: required("TWILIO_API_KEY_SECRET"),
    serviceSid: required("TWILIO_VERIFY_SERVICE_SID"),
  });
  return new VerificationPolicy(new PrismaVerificationPolicyStore(), provider);
}

function registrationService(): RegistrationService {
  return new RegistrationService(new PrismaRegistrationRepository(), registrationPolicy());
}

type RegistrationChallenge = {
  userId: string | null;
  providerRef: string | null;
  phoneLookupHash: string | null;
  phonePrefixHash: string | null;
  accountRateLimitHash: string | null;
  destinationVersion: number | null;
  tokenVersionAtIssue: number | null;
  expiresAt: Date;
  consumedAt: Date | null;
  invalidatedAt: Date | null;
};

type ActiveRegistrationChallenge = RegistrationChallenge & {
  providerRef: string;
  phoneLookupHash: string;
  phonePrefixHash: string;
  accountRateLimitHash: string;
  destinationVersion: number;
};

async function registrationChallenge(challengeId: string): Promise<ActiveRegistrationChallenge | null> {
  const rows = await prisma.$queryRaw<RegistrationChallenge[]>`
    SELECT "userId", "providerRef", "phoneLookupHash", "phonePrefixHash", "accountRateLimitHash",
      "destinationVersion", "tokenVersionAtIssue", "expiresAt", "consumedAt", "invalidatedAt"
    FROM "MfaChallenge" WHERE "id" = ${challengeId} AND "purpose" = 'REGISTRATION' AND "method" = 'SMS' LIMIT 1
  `;
  const challenge = rows[0];
  if (!challenge || challenge.consumedAt || challenge.invalidatedAt || challenge.expiresAt <= new Date()
    || !challenge.providerRef
    || !challenge.phoneLookupHash || !challenge.phonePrefixHash || !challenge.accountRateLimitHash
    || challenge.destinationVersion === null) return null;
  return challenge as ActiveRegistrationChallenge;
}

export async function registrationRoutes(app: FastifyInstance) {
  app.post("/register/start", { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } }, async (request, reply) => {
    if (process.env.SMS_MFA_ENABLED !== "true") return reply.code(404).send({ error: "not found" });
    const startedAt = Date.now();
    const parsed = registerStartSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const human = await verifyHuman(parsed.data.turnstileToken, request.ip, {
      secret: required("TURNSTILE_SECRET_KEY"),
      expectedHostname: required("TURNSTILE_EXPECTED_HOSTNAME"),
    });
    if (!human) return reply.code(400).send({ error: "Verification could not be completed. Please try again." });

    try {
      const passwordHash = await bcrypt.hash(parsed.data.password, 10);
      const result = await registrationService().start({
        name: parsed.data.name,
        email: parsed.data.email,
        phone: parsed.data.phone,
        passwordHash,
        consentVersion: parsed.data.consentVersion,
        dimensions: [safeDimension("ip", request.ip), safeDimension("email", parsed.data.email)],
      });
      setChallengeCookie(reply, result.challengeId);
      const minimumMs = 350 + Math.floor(Math.random() * 100);
      const remaining = minimumMs - (Date.now() - startedAt);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      return reply.code(202).send({ status: "verification_pending", maskedDestination: maskPhone(normalizeUsPhone(parsed.data.phone)) });
    } catch (error) {
      if (error instanceof VerificationLockedError) {
        reply.header("Retry-After", String(error.retryAfter));
        return reply.code(429).send({ error: error.message });
      }
      request.log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "registration verification start failed");
      return reply.code(503).send({ error: "Verification is temporarily unavailable. Please try again." });
    }
  });

  app.post("/register/check", async (request, reply) => {
    if (process.env.SMS_MFA_ENABLED !== "true") return reply.code(404).send({ error: "not found" });
    const parsed = registerCheckSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const challengeId = readChallengeCookie(request);
    if (!challengeId) return reply.code(401).send({ error: "Verification session expired. Start again." });
    const challenge = await registrationChallenge(challengeId);
    if (!challenge) return reply.code(401).send({ error: "Verification session expired. Start again." });
    try {
      if (challenge.providerRef === "decoy") {
        await registrationPolicy().rejectDecoySmsChallenge({
          challengeId, userId: challenge.userId, purpose: "REGISTRATION",
          destinationHash: challenge.phoneLookupHash, destinationVersion: challenge.destinationVersion,
          tokenVersionAtIssue: challenge.tokenVersionAtIssue ?? null,
        });
        return reply.code(401).send({ error: "That verification code is not correct or has expired." });
      }
      if (!challenge.userId) {
        await registrationPolicy().checkChallenge({
          challengeId, userId: null, purpose: "REGISTRATION", method: "SMS", destination: "",
          destinationHash: challenge.phoneLookupHash, destinationVersion: challenge.destinationVersion,
          tokenVersionAtIssue: challenge.tokenVersionAtIssue ?? null, code: parsed.data.code,
        });
        return reply.code(401).send({ error: "That verification code is not correct or has expired." });
      }
      const { user, backupCodes } = await registrationService().approve({ challengeId, userId: challenge.userId, code: parsed.data.code });
      clearChallengeCookie(reply);
      const token = app.jwt.sign({ sub: user.id, role: user.role, tv: user.tokenVersion, amr: "SMS" }, { expiresIn: "7d" });
      setMediaCookie(app, reply, user.id, user.tokenVersion);
      return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role, mfaEnabled: true }, backupCodes };
    } catch (error) {
      if (error instanceof VerificationLockedError) {
        reply.header("Retry-After", String(error.retryAfter));
        return reply.code(429).send({ error: error.message });
      }
      return reply.code(401).send({ error: "That verification code is not correct or has expired." });
    }
  });

  app.post("/register/resend", async (request, reply) => {
    if (process.env.SMS_MFA_ENABLED !== "true") return reply.code(404).send({ error: "not found" });
    const parsed = registerResendSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const previousChallengeId = readChallengeCookie(request);
    if (!previousChallengeId) return reply.code(401).send({ error: "Verification session expired. Start again." });
    const challenge = await registrationChallenge(previousChallengeId);
    if (!challenge) return reply.code(401).send({ error: "Verification session expired. Start again." });
    try {
      let result: { challengeId: string } | null = null;
      if (challenge.userId === null) {
        const replacement = await registrationPolicy().queueSmsResend({
          previousChallengeId, userId: null, purpose: "REGISTRATION", method: "SMS", destination: "",
          destinationHash: challenge.phoneLookupHash, destinationVersion: challenge.destinationVersion,
          tokenVersionAtIssue: null,
          dimensions: [
            safeDimension("ip", request.ip),
            `phone-prefix:${challenge.phonePrefixHash}`,
            `account:${challenge.accountRateLimitHash}`,
          ],
        });
        result = { challengeId: replacement.id };
      } else if (challenge.userId) {
        result = await registrationService().resend(challenge.userId, previousChallengeId, [safeDimension("ip", request.ip)]);
      }
      if (!result) return reply.code(401).send({ error: "Verification session expired. Start again." });
      setChallengeCookie(reply, result.challengeId);
      return reply.code(202).send({ status: "verification_pending", maskedDestination: "your phone" });
    } catch (error) {
      if (error instanceof VerificationLockedError) {
        reply.header("Retry-After", String(error.retryAfter));
        return reply.code(429).send({ error: error.message });
      }
      return reply.code(503).send({ error: "Verification is temporarily unavailable. Please try again." });
    }
  });
}
