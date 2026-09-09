import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  complete: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../lib/passwordRecoveryService.js", () => ({
  PasswordRecoveryService: class {
    beginPasswordRecovery = mocks.begin;
    completePasswordRecovery = mocks.complete;
  },
  PrismaPasswordRecoveryRepository: class {},
  PasswordRecoveryRejectedError: class extends Error {},
}));
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    user: { count: vi.fn(), create: vi.fn(), findFirst: vi.fn(), findUnique: mocks.findUnique, update: mocks.update },
    organizationMembership: { updateMany: vi.fn() },
  },
}));
vi.mock("../lib/twilioVerifyProvider.js", () => ({ TwilioVerifyProvider: class {} }));
vi.mock("../lib/verificationPolicy.js", () => ({
  PrismaVerificationPolicyStore: class {},
  VerificationLockedError: class extends Error {
    constructor(readonly retryAfter = 900, message = "Too many verification attempts. Please try again in 15 minutes.") { super(message); }
  },
  VerificationPolicy: class {},
}));
vi.mock("../lib/tokenVersion.js", () => ({ bumpTokenVersion: vi.fn(), invalidateTokenVersionCache: vi.fn() }));

import { authRoutes } from "./auth.js";
import { PasswordRecoveryRejectedError } from "../lib/passwordRecoveryService.js";
import { VerificationLockedError } from "../lib/verificationPolicy.js";
import { VerificationProviderError } from "../lib/verificationProvider.js";

describe("password recovery HTTP routes", () => {
  beforeEach(() => {
    process.env.SMS_MFA_ENABLED = "true";
    process.env.RATE_LIMIT_HMAC_KEY = "rate-secret";
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_API_KEY_SID = "SK123";
    process.env.TWILIO_API_KEY_SECRET = "secret";
    process.env.TWILIO_VERIFY_SERVICE_SID = "VA123";
    mocks.begin.mockReset();
    mocks.complete.mockReset();
    mocks.findUnique.mockReset();
    mocks.update.mockReset();
  });

  async function app() {
    const server = Fastify({ logger: false });
    server.decorate("authenticate", async (request: { user?: unknown }) => {
      request.user = { sub: "admin-1", role: "ADMIN", tv: 3 };
    });
    server.decorate("requireAdmin", async () => {});
    await server.register(cookie);
    await server.register(authRoutes, { prefix: "/api/auth" });
    await server.ready();
    return server;
  }

  it("returns the same public start response for known and unknown email addresses", async () => {
    mocks.begin.mockResolvedValueOnce({ challengeId: "challenge-1" }).mockResolvedValueOnce({});
    const server = await app();

    const known = await server.inject({ method: "POST", url: "/api/auth/password-recovery/start", payload: { email: "known@company.test" } });
    const unknown = await server.inject({ method: "POST", url: "/api/auth/password-recovery/start", payload: { email: "missing@company.test" } });

    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.json()).toEqual(unknown.json());
    for (const response of [known, unknown]) {
      expect(response.headers["set-cookie"]).toContain("continuixai_mfa_challenge=");
      expect(response.headers["set-cookie"]).toContain("HttpOnly");
      expect(response.headers["set-cookie"]).toContain("Secure");
      expect(response.headers["set-cookie"]).toContain("SameSite=Strict");
    }
    expect(mocks.begin).toHaveBeenCalledWith("known@company.test", expect.objectContaining({ dimensions: expect.any(Array) }));
    await server.close();
  });

  it("keeps the public start response indistinguishable when provider delivery fails for a known account", async () => {
    mocks.begin.mockRejectedValue(new VerificationProviderError());
    const server = await app();

    const providerFailure = await server.inject({ method: "POST", url: "/api/auth/password-recovery/start", payload: { email: "known@company.test" } });
    mocks.begin.mockResolvedValue({});
    const unknown = await server.inject({ method: "POST", url: "/api/auth/password-recovery/start", payload: { email: "missing@company.test" } });

    expect(providerFailure.statusCode).toBe(202);
    expect(providerFailure.json()).toEqual(unknown.json());
    for (const response of [providerFailure, unknown]) {
      expect(response.headers["set-cookie"]).toContain("continuixai_mfa_challenge=");
      expect(response.headers["set-cookie"]).toContain("HttpOnly");
      expect(response.headers["set-cookie"]).toContain("Secure");
      expect(response.headers["set-cookie"]).toContain("SameSite=Strict");
    }
    await server.close();
  });

  it("returns the shared generic 429 when the pre-lookup recovery budget is denied", async () => {
    mocks.begin.mockRejectedValue(new VerificationLockedError(30, "Too many verification requests. Please try again later."));
    const server = await app();

    const response = await server.inject({ method: "POST", url: "/api/auth/password-recovery/start", payload: { email: "known@company.test" } });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("30");
    expect(response.json()).toEqual({ error: "Too many verification requests. Please try again later." });
    await server.close();
  });

  it("does not expose Recovery PIN recovery endpoints regardless of the rollout flag", async () => {
    process.env.SMS_MFA_ENABLED = "false";
    const server = await app();

    const userId = await server.inject({ method: "POST", url: "/api/auth/recover/user-id", payload: { email: "known@company.test", recoveryPin: "123456" } });
    const password = await server.inject({ method: "POST", url: "/api/auth/recover/password", payload: { identifier: "known@company.test", recoveryPin: "123456", newPassword: "AnotherPass1!" } });

    expect(userId.statusCode).toBe(404);
    expect(password.statusCode).toBe(404);
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    await server.close();
  });

  it("does not expose an administrator password-reset bypass or temporary secret", async () => {
    mocks.findUnique.mockResolvedValue({ id: "user-2", email: "other@company.test", name: "Other User" });
    const server = await app();

    const response = await server.inject({ method: "POST", url: "/api/auth/users/user-2/reset-password" });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("temporaryPassword");
    expect(mocks.update).not.toHaveBeenCalled();
    await server.close();
  });

  it("completes only the cookie-bound challenge without issuing a session", async () => {
    mocks.complete.mockResolvedValue(undefined);
    const server = await app();

    const response = await server.inject({
      method: "POST", url: "/api/auth/password-recovery/complete",
      headers: { cookie: "continuixai_mfa_challenge=challenge-1" },
      payload: { code: "123456", newPassword: "AnotherPass1!" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(response.json()).not.toHaveProperty("token");
    expect(mocks.complete).toHaveBeenCalledWith("challenge-1", "123456", "AnotherPass1!");
    expect(String(response.headers["set-cookie"])).toContain("continuixai_mfa_challenge=;");
    await server.close();
  });

  it("returns the existing 15-minute lock response without clearing the challenge", async () => {
    mocks.complete.mockRejectedValue(new VerificationLockedError());
    const server = await app();

    const response = await server.inject({
      method: "POST", url: "/api/auth/password-recovery/complete",
      headers: { cookie: "continuixai_mfa_challenge=challenge-1" },
      payload: { code: "123456", newPassword: "AnotherPass1!" },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("900");
    expect(response.json()).toEqual({ error: "Too many verification attempts. Please try again in 15 minutes." });
    expect(response.headers["set-cookie"]).toBeUndefined();
    await server.close();
  });

  it("rejects an invalid or expired factor without changing a password", async () => {
    mocks.complete.mockRejectedValue(new PasswordRecoveryRejectedError());
    const server = await app();

    const response = await server.inject({
      method: "POST", url: "/api/auth/password-recovery/complete",
      headers: { cookie: "continuixai_mfa_challenge=challenge-1" },
      payload: { code: "123456", newPassword: "AnotherPass1!" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "That verification code is not correct or has expired." });
    await server.close();
  });
});
