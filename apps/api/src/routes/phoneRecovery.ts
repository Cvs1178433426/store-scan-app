import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { clearPhoneRecoveryCookie, readPhoneRecoveryCookie, setPhoneRecoveryCookie } from "../lib/mfaChallengeCookie.js";
import { PrismaPhoneRecoveryRepository } from "../lib/phoneRecoveryRepository.js";
import {
  PhoneRecoveryLockedError,
  PhoneRecoveryService,
  PhoneRecoveryUnavailableError,
} from "../lib/phoneRecoveryService.js";
import { createRecoveryEmailProvider } from "../lib/recoveryEmailProvider.js";
import { TwilioVerifyProvider } from "../lib/twilioVerifyProvider.js";
import { PrismaVerificationPolicyStore, VerificationPolicy } from "../lib/verificationPolicy.js";
import { createSecurityNotificationProvider } from "../lib/securityNotificationProvider.js";

type RecoveryService = Pick<PhoneRecoveryService,
  "initiate" | "adminStatus" | "startEmailProof" | "checkEmailCode" | "startPhoneProof" | "resend"
  | "checkPhoneCodeAndComplete" | "cancel" | "resume">;
type PhoneRecoveryRouteOptions = {
  service?: RecoveryService;
  rateLimitKey?: string;
  settlePublicStart?: (startedAt: number) => Promise<void>;
};

const RECENT_AUTH_SECONDS = 10 * 60;

function recentIndependentMfa(user: { iat?: unknown; amr?: unknown }, nowSeconds = Math.floor(Date.now() / 1_000)): boolean {
  return typeof user.iat === "number" && user.iat <= nowSeconds && nowSeconds - user.iat <= RECENT_AUTH_SECONDS
    && ["SMS", "TOTP", "RECOVERY_CODE"].includes(String(user.amr ?? ""));
}

function accountHash(key: string, email: string): string {
  return createHmac("sha256", key).update(`phone-recovery-account:${email.trim().toLowerCase()}`).digest("hex");
}

async function settlePublicStartTiming(startedAt: number): Promise<void> {
  const minimumMs = 350 + Math.floor(Math.random() * 100);
  const remaining = minimumMs - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when SMS MFA is enabled.`);
  return value;
}

function createService(): PhoneRecoveryService {
  const provider = new TwilioVerifyProvider({
    accountSid: required("TWILIO_ACCOUNT_SID"),
    apiKeySid: required("TWILIO_API_KEY_SID"),
    apiKeySecret: required("TWILIO_API_KEY_SECRET"),
    serviceSid: required("TWILIO_VERIFY_SERVICE_SID"),
  });
  return new PhoneRecoveryService(
    new PrismaPhoneRecoveryRepository(),
    createRecoveryEmailProvider(),
    {
      smsPolicy: new VerificationPolicy(new PrismaVerificationPolicyStore(), provider),
      notificationProvider: createSecurityNotificationProvider(process.env),
    },
  );
}

export async function phoneRecoveryRoutes(app: FastifyInstance, options: PhoneRecoveryRouteOptions = {}) {
  const service = options.service ?? (process.env.SMS_MFA_ENABLED === "true"
    ? createService()
    : null);
  const rateLimitKey = options.rateLimitKey ?? process.env.RATE_LIMIT_HMAC_KEY?.trim() ?? "";
  const settlePublicStart = options.settlePublicStart ?? settlePublicStartTiming;

  app.post("/users/:id/phone-recovery", {
    preHandler: [app.authenticate, app.requireAdmin],
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
  }, async (request, reply) => {
    if (!service) return reply.code(404).send({ error: "not found" });
    const user = request.user as typeof request.user & { iat?: number };
    if (!recentIndependentMfa(user)) return reply.code(403).send({ error: "Sign in again with MFA before starting phone recovery." });
    const { id } = request.params as { id: string };
    try {
      const result = await service.initiate({ actorUserId: request.user.sub, targetUserId: id });
      return reply.code(201).send({ ...result, expiresAt: result.expiresAt.toISOString() });
    } catch {
      return reply.code(409).send({ error: "Phone recovery could not be started." });
    }
  });

  app.get("/users/:id/phone-recovery", {
    preHandler: [app.authenticate, app.requireAdmin],
    config: { rateLimit: { max: 30, timeWindow: "15 minutes" } },
  }, async (request, reply) => {
    if (!service) return reply.code(404).send({ error: "not found" });
    const user = request.user as typeof request.user & { iat?: number };
    if (!recentIndependentMfa(user)) return reply.code(403).send({ error: "Sign in again with MFA before viewing phone recovery." });
    const { id } = request.params as { id: string };
    const result = await service.adminStatus({ targetUserId: id });
    return reply.send({
      cases: result.cases.map((candidate) => ({
        ...candidate,
        startedAt: candidate.startedAt.toISOString(),
        expiresAt: candidate.expiresAt.toISOString(),
      })),
      events: result.events.map((event) => ({ ...event, occurredAt: event.occurredAt.toISOString() })),
    });
  });

  app.delete("/users/:id/phone-recovery/:caseId", {
    preHandler: [app.authenticate, app.requireAdmin],
    config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
  }, async (request, reply) => {
    if (!service) return reply.code(404).send({ error: "not found" });
    const user = request.user as typeof request.user & { iat?: number };
    if (!recentIndependentMfa(user)) return reply.code(403).send({ error: "Sign in again with MFA before cancelling phone recovery." });
    const { caseId } = request.params as { id: string; caseId: string };
    const cancelled = await service.cancel({ caseId, actorUserId: request.user.sub });
    return cancelled ? reply.code(204).send() : reply.code(404).send({ error: "Phone recovery was not found." });
  });

  app.post("/phone-recovery/start", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    if (!service || rateLimitKey.length < 32) return reply.code(404).send({ error: "not found" });
    const startedAt = Date.now();
    const body = (request.body ?? {}) as Record<string, unknown>;
    const email = typeof body.email === "string" ? body.email.slice(0, 320) : "";
    const employeeNumber = typeof body.employeeNumber === "string" ? body.employeeNumber.slice(0, 64) : "";
    const caseReference = typeof body.caseReference === "string" ? body.caseReference.slice(0, 128) : "";
    let statusCode = 202;
    let responseBody: { status: "verification_pending" } | { error: string } = { status: "verification_pending" };
    try {
      const result = await service.startEmailProof({
        email, employeeNumber, caseReference, accountHash: accountHash(rateLimitKey, email),
      });
      setPhoneRecoveryCookie(reply, result.challengeId);
    } catch (error) {
      if (error instanceof PhoneRecoveryLockedError) {
        reply.header("retry-after", String(error.retryAfterSeconds));
        statusCode = 429;
        responseBody = { error: "Too many attempts. Try again later." };
      } else {
        const decoyChallengeId = createHmac("sha256", rateLimitKey).update(`decoy:${Date.now()}:${request.ip}`).digest("hex").slice(0, 36);
        setPhoneRecoveryCookie(reply, decoyChallengeId);
      }
    }
    await settlePublicStart(startedAt);
    return reply.code(statusCode).send(responseBody);
  });

  app.get("/phone-recovery/status", async (request, reply) => {
    if (!service) return reply.code(404).send({ error: "not found" });
    const challengeId = readPhoneRecoveryCookie(request);
    if (!challengeId) return reply.code(401).send({ error: "Recovery session expired." });
    try {
      return reply.send(await service.resume({ challengeId }));
    } catch {
      clearPhoneRecoveryCookie(reply);
      return reply.code(401).send({ error: "Recovery session expired." });
    }
  });

  app.post("/phone-recovery/email/check", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    if (!service) return reply.code(404).send({ error: "not found" });
    const challengeId = readPhoneRecoveryCookie(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const code = typeof body.code === "string" ? body.code : "";
    if (!challengeId) return reply.code(400).send({ error: "Recovery verification could not be completed." });
    try {
      const result = await service.checkEmailCode({ challengeId, code });
      return reply.send({ status: result.status });
    } catch (error) {
      if (error instanceof PhoneRecoveryLockedError) {
        clearPhoneRecoveryCookie(reply);
        reply.header("retry-after", String(error.retryAfterSeconds));
        return reply.code(429).send({ error: "Too many attempts. Try again later." });
      }
      if (error instanceof PhoneRecoveryUnavailableError) {
        return reply.code(400).send({ error: "Recovery verification could not be completed." });
      }
      return reply.code(503).send({ error: "Recovery verification is temporarily unavailable." });
    }
  });

  app.post("/phone-recovery/phone/start", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    if (!service) return reply.code(404).send({ error: "not found" });
    const emailChallengeId = readPhoneRecoveryCookie(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!emailChallengeId) return reply.code(400).send({ error: "Recovery verification could not be completed." });
    try {
      const result = await service.startPhoneProof({
        emailChallengeId,
        phone: typeof body.phone === "string" ? body.phone.slice(0, 64) : "",
        smsConsent: body.smsConsent === true,
        consentVersion: typeof body.consentVersion === "string" ? body.consentVersion.slice(0, 64) : "",
        turnstileToken: typeof body.turnstileToken === "string" ? body.turnstileToken.slice(0, 4096) : "",
        ip: request.ip,
      });
      setPhoneRecoveryCookie(reply, result.challengeId);
      return reply.code(202).send({ status: result.status });
    } catch (error) {
      if (error instanceof PhoneRecoveryLockedError) {
        clearPhoneRecoveryCookie(reply);
        reply.header("retry-after", String(error.retryAfterSeconds));
        return reply.code(429).send({ error: "Too many attempts. Try again later." });
      }
      if (error instanceof PhoneRecoveryUnavailableError) {
        return reply.code(400).send({ error: "Recovery verification could not be completed." });
      }
      return reply.code(503).send({ error: "Recovery verification is temporarily unavailable." });
    }
  });

  app.post("/phone-recovery/resend", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    if (!service) return reply.code(404).send({ error: "not found" });
    const challengeId = readPhoneRecoveryCookie(request);
    if (!challengeId) return reply.code(401).send({ error: "Recovery session expired." });
    const startedAt = Date.now();
    try {
      const result = await service.resend({ challengeId, ip: request.ip });
      setPhoneRecoveryCookie(reply, result.challengeId);
      await settlePublicStart(startedAt);
      return reply.code(202).send(result.stage === "sms"
        ? { status: result.status, maskedDestination: result.maskedDestination }
        : { status: result.status });
    } catch (error) {
      if (error instanceof PhoneRecoveryLockedError) {
        reply.header("retry-after", String(error.retryAfterSeconds));
        return reply.code(429).send({ error: "Too many attempts. Try again later." });
      }
      if (error instanceof PhoneRecoveryUnavailableError) {
        clearPhoneRecoveryCookie(reply);
        return reply.code(401).send({ error: "Recovery session expired." });
      }
      return reply.code(503).send({ error: "Recovery verification is temporarily unavailable." });
    }
  });

  app.post("/phone-recovery/phone/check", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    if (!service) return reply.code(404).send({ error: "not found" });
    const smsChallengeId = readPhoneRecoveryCookie(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!smsChallengeId) return reply.code(400).send({ error: "Recovery verification could not be completed." });
    try {
      const result = await service.checkPhoneCodeAndComplete({
        smsChallengeId,
        code: typeof body.code === "string" ? body.code.slice(0, 32) : "",
      });
      clearPhoneRecoveryCookie(reply);
      return reply.send(result);
    } catch (error) {
      if (error instanceof PhoneRecoveryLockedError) {
        clearPhoneRecoveryCookie(reply);
        reply.header("retry-after", String(error.retryAfterSeconds));
        return reply.code(429).send({ error: "Too many attempts. Try again later." });
      }
      if (error instanceof PhoneRecoveryUnavailableError) {
        return reply.code(400).send({ error: "Recovery verification could not be completed." });
      }
      return reply.code(503).send({ error: "Recovery verification is temporarily unavailable." });
    }
  });
}
