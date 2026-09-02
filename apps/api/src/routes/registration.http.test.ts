import Fastify from "fastify";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatched: true,
  start: vi.fn(),
  approve: vi.fn(),
  resend: vi.fn(),
  rejectDecoySmsChallenge: vi.fn(),
  resendDecoySmsChallenge: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock("../lib/turnstile.js", () => ({ verifyHuman: vi.fn(async () => true) }));
vi.mock("../lib/registrationService.js", () => ({
  PrismaRegistrationRepository: class {},
  RegistrationService: class {
    start = mocks.start;
    approve = mocks.approve;
    resend = mocks.resend;
  },
}));
vi.mock("../lib/verificationPolicy.js", () => ({
  PrismaVerificationPolicyStore: class {},
  VerificationLockedError: class extends Error {
    constructor(readonly retryAfter = 900, message = "Too many verification attempts. Please try again in 15 minutes.") { super(message); }
  },
  VerificationPolicy: class {
    rejectDecoySmsChallenge = mocks.rejectDecoySmsChallenge;
    resendDecoySmsChallenge = mocks.resendDecoySmsChallenge;
  },
}));
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    user: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    organizationMembership: { updateMany: vi.fn() },
    $queryRaw: mocks.queryRaw,
  },
}));

import { registrationRoutes } from "./registration.js";
import { authRoutes } from "./auth.js";
import { VerificationLockedError } from "../lib/verificationPolicy.js";

const payload = {
  name: "Mitchell Kobran",
  email: "Mitchell.Kobran@ContinuiXAi.com",
  phone: "(631) 742-3355",
  password: "StrongPass1!",
  smsConsent: true,
  consentVersion: "2026-09-01",
  turnstileToken: "human-token",
};

describe("SMS registration HTTP route", () => {
  beforeEach(() => {
    process.env.SMS_MFA_ENABLED = "true";
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_API_KEY_SID = "SK123";
    process.env.TWILIO_API_KEY_SECRET = "secret";
    process.env.TWILIO_VERIFY_SERVICE_SID = "VA123";
    process.env.TURNSTILE_SECRET_KEY = "secret";
    process.env.TURNSTILE_EXPECTED_HOSTNAME = "localhost";
    process.env.RATE_LIMIT_HMAC_KEY = "rate-secret";
    process.env.PHONE_ENCRYPTION_KEYS = `1:${"11".repeat(32)}`;
    process.env.PHONE_LOOKUP_HMAC_KEYS = `1:${"22".repeat(32)}`;
    mocks.start.mockReset();
    mocks.approve.mockReset();
    mocks.resend.mockReset();
    mocks.rejectDecoySmsChallenge.mockReset();
    mocks.resendDecoySmsChallenge.mockReset();
    mocks.queryRaw.mockReset();
    mocks.rejectDecoySmsChallenge.mockResolvedValue({ approved: false });
    mocks.resendDecoySmsChallenge.mockResolvedValue({ id: "replacement-decoy" });
  });

  afterEach(() => { delete process.env.SMS_MFA_ENABLED; });

  async function app() {
    const server = Fastify({ logger: false });
    await server.register(cookie);
    await server.register(jwt, { secret: "test-secret" });
    await server.register(registrationRoutes, { prefix: "/api/auth" });
    await server.ready();
    return server;
  }

  it("returns the same generic body and secure cookie shape for created and conflict paths", async () => {
    const server = await app();
    mocks.start.mockResolvedValueOnce({ dispatched: true, challengeId: "real-challenge" });
    const created = await server.inject({ method: "POST", url: "/api/auth/register/start", payload });
    mocks.start.mockResolvedValueOnce({ dispatched: false, challengeId: "decoy-challenge" });
    const conflict = await server.inject({ method: "POST", url: "/api/auth/register/start", payload });
    expect(created.statusCode).toBe(202);
    expect(conflict.statusCode).toBe(202);
    expect(conflict.json()).toEqual(created.json());
    for (const response of [created, conflict]) {
      expect(response.headers["set-cookie"]).toContain("continuixai_mfa_challenge=");
      expect(response.headers["set-cookie"]).toContain("HttpOnly");
      expect(response.headers["set-cookie"]).toContain("Secure");
      expect(response.headers["set-cookie"]).toContain("SameSite=Strict");
    }
    expect(conflict.headers["set-cookie"]).toContain("continuixai_mfa_challenge=decoy-challenge");
    await server.close();
  });

  it("keeps conflict checks and resends on the durable registration decoy", async () => {
    const decoy = {
      userId: null, providerRef: "decoy", phoneLookupHash: "phone-hash", destinationVersion: 1,
    };
    mocks.queryRaw.mockResolvedValueOnce([decoy]);
    const server = await app();
    const checked = await server.inject({
      method: "POST", url: "/api/auth/register/check",
      headers: { cookie: "continuixai_mfa_challenge=decoy-challenge" }, payload: { code: "123456" },
    });
    expect(checked.statusCode).toBe(401);
    expect(checked.json()).toEqual({ error: "That verification code is not correct or has expired." });
    expect(mocks.rejectDecoySmsChallenge).toHaveBeenCalledWith(expect.objectContaining({
      challengeId: "decoy-challenge", userId: null, purpose: "REGISTRATION",
    }));

    mocks.queryRaw.mockResolvedValueOnce([decoy]);
    const resent = await server.inject({
      method: "POST", url: "/api/auth/register/resend",
      headers: { cookie: "continuixai_mfa_challenge=decoy-challenge" }, payload: {},
    });
    expect(resent.statusCode).toBe(202);
    expect(resent.json()).toEqual({ status: "verification_pending", maskedDestination: "your phone" });
    expect(mocks.resendDecoySmsChallenge).toHaveBeenCalledWith(expect.objectContaining({
      previousChallengeId: "decoy-challenge", userId: null, purpose: "REGISTRATION",
    }));
    expect(resent.headers["set-cookie"]).toContain("continuixai_mfa_challenge=replacement-decoy");
    await server.close();
  });

  it("returns the shared generic 429 for a denied registration SMS budget", async () => {
    mocks.start.mockRejectedValue(new VerificationLockedError(30, "Too many verification requests. Please try again later."));
    const server = await app();

    const response = await server.inject({ method: "POST", url: "/api/auth/register/start", payload });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("30");
    expect(response.json()).toEqual({ error: "Too many verification requests. Please try again later." });
    await server.close();
  });

  it("does not expose the route while the rollout flag is disabled", async () => {
    process.env.SMS_MFA_ENABLED = "false";
    const server = await app();
    const response = await server.inject({ method: "POST", url: "/api/auth/register/start", payload });
    expect(response.statusCode).toBe(404);
    expect(mocks.start).not.toHaveBeenCalled();
    await server.close();
  });

  it("binds registration session and media credentials to the activated user's token version", async () => {
    mocks.queryRaw.mockResolvedValue([{ userId: "user-1" }]);
    mocks.approve.mockResolvedValue({
      id: "user-1",
      name: "Mitchell Kobran",
      email: "mitchell.kobran@continuixai.com",
      role: "GENERAL",
      tokenVersion: 9,
    });
    const server = await app();

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/register/check",
      headers: { cookie: "continuixai_mfa_challenge=challenge-1" },
      payload: { code: "123456" },
    });

    expect(response.statusCode).toBe(200);
    expect(server.jwt.verify(response.json().token)).toMatchObject({ sub: "user-1", tv: 9, amr: "SMS" });
    const mediaToken = String(response.headers["set-cookie"]).match(/continuixai_media=([^;,]+)/)?.[1];
    expect(mediaToken).toBeDefined();
    expect(server.jwt.verify(mediaToken!)).toMatchObject({ sub: "user-1", purpose: "media", tv: 9 });
    await server.close();
  });

  it("retires legacy active-account creation paths while SMS MFA is enabled", async () => {
    const server = Fastify({ logger: false });
    server.decorate("authenticate", async () => {});
    server.decorate("requireAdmin", async () => {});
    await server.register(authRoutes, { prefix: "/api/auth" });
    await server.ready();
    const legacy = await server.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Mitchell", email: "mitchell@continuixai.com", password: "StrongPass1!", recoveryPin: "123456" } });
    const bootstrap = await server.inject({ method: "POST", url: "/api/auth/bootstrap/admin", payload: { name: "Mitchell", email: "mitchell@continuixai.com", password: "StrongPass1!" } });
    expect(legacy.statusCode).toBe(410);
    expect(bootstrap.statusCode).toBe(410);
    const userIdRecovery = await server.inject({ method: "POST", url: "/api/auth/recover/user-id", payload: { email: "mitchell@continuixai.com", recoveryPin: "123456" } });
    const passwordRecovery = await server.inject({ method: "POST", url: "/api/auth/recover/password", payload: { identifier: "mitchell@continuixai.com", recoveryPin: "123456", newPassword: "AnotherPass1!" } });
    const adminReset = await server.inject({ method: "POST", url: "/api/auth/users/user-1/reset-mfa" });
    expect(userIdRecovery.statusCode).toBe(404);
    expect(passwordRecovery.statusCode).toBe(404);
    expect(adminReset.statusCode).toBe(403);
    await server.close();
  });
});
