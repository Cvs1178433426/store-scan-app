import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: undefined as FastifyInstance | undefined,
  fastifyOptions: undefined as Parameters<typeof import("fastify").default>[0] | undefined,
  findUnique: vi.fn(),
  listen: vi.fn(async () => ""),
}));
const originalEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  JWT_SECRET: process.env.JWT_SECRET,
  SMS_MFA_ENABLED: process.env.SMS_MFA_ENABLED,
  SMS_MFA_MIGRATION_DEADLINE: process.env.SMS_MFA_MIGRATION_DEADLINE,
  ENABLE_LEGACY_INVENTORY_FEATURES: process.env.ENABLE_LEGACY_INVENTORY_FEATURES,
  TRUST_PROXY: process.env.TRUST_PROXY,
  BUILD_SHA: process.env.BUILD_SHA,
};

vi.mock("fastify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fastify")>();
  return {
    ...actual,
    default: (...args: Parameters<typeof actual.default>) => {
      mocks.fastifyOptions = args[0];
      const app = actual.default(...args);
      app.log.level = "silent";
      app.listen = mocks.listen as typeof app.listen;
      mocks.app = app;
      return app;
    },
  };
});

vi.mock("./lib/prisma.js", () => ({
  prisma: {
    user: { findUnique: mocks.findUnique },
  },
}));

function app(): FastifyInstance {
  if (!mocks.app) throw new Error("central Fastify app was not created");
  return mocks.app;
}

function malformedToken(payload: Record<string, unknown>): string {
  return app().jwt.sign(payload as { sub: string; purpose?: string; tv?: number });
}

async function authorize(token: string) {
  const response = await app().inject({
    method: "POST",
    url: "/api/auth/logout",
    headers: { authorization: `Bearer ${token}` },
  });
  return { statusCode: response.statusCode, body: response.body ? response.json() : undefined };
}

describe("central session authentication", () => {
  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = "central-auth-test-secret";
    process.env.SMS_MFA_ENABLED = "false";
    process.env.ENABLE_LEGACY_INVENTORY_FEATURES = "false";
    process.env.TRUST_PROXY = "true";
    process.env.BUILD_SHA = "candidate-sha-123";

    const { buildApp } = await import("./index.js");
    await buildApp();
    await app().ready();
  });

  beforeEach(() => {
    process.env.SMS_MFA_ENABLED = "false";
    delete process.env.SMS_MFA_MIGRATION_DEADLINE;
    mocks.findUnique.mockReset();
    mocks.findUnique.mockResolvedValue({ tokenVersion: 7, isActive: true, accountStatus: "ACTIVE", phoneVerifiedAt: null });
  });

  afterAll(async () => {
    await app().close();
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("builds the production app without opening a network listener", () => {
    expect(mocks.listen).not.toHaveBeenCalled();
  });

  it("trusts only private ingress proxies when proxy headers are enabled", () => {
    expect(mocks.fastifyOptions?.trustProxy).toBe("loopback, linklocal, uniquelocal");
  });

  it("exposes the exact API build marker used for acceptance", async () => {
    const response = await app().inject({ method: "GET", url: "/api/health/version" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sha: "candidate-sha-123" });
  });

  it("accepts a current active normal session", async () => {
    const token = app().jwt.sign({ sub: "current-user", role: "GENERAL", tv: 7 });
    await expect(authorize(token)).resolves.toEqual({ statusCode: 204, body: undefined });
  });

  it("limits an unverified legacy session to phone enrollment after the migration deadline", async () => {
    process.env.SMS_MFA_ENABLED = "true";
    process.env.SMS_MFA_MIGRATION_DEADLINE = "2020-01-01T00:00:00.000Z";
    const token = app().jwt.sign({ sub: "legacy-user", role: "GENERAL", tv: 7, amr: "TOTP" });

    const response = await app().inject({
      method: "PATCH",
      url: "/api/auth/profile",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Should not update" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "Verify a mobile number to continue.",
      code: "sms_enrollment_required",
    });
  });

  it("keeps logout available to an unverified legacy session after the migration deadline", async () => {
    process.env.SMS_MFA_ENABLED = "true";
    process.env.SMS_MFA_MIGRATION_DEADLINE = "2020-01-01T00:00:00.000Z";
    const token = app().jwt.sign({ sub: "legacy-user", role: "GENERAL", tv: 7, amr: "TOTP" });

    await expect(authorize(token)).resolves.toEqual({ statusCode: 204, body: undefined });
  });

  it("rejects a stale session with the exact generic response", async () => {
    mocks.findUnique.mockResolvedValue({ tokenVersion: 8, isActive: true, accountStatus: "ACTIVE" });
    const token = app().jwt.sign({ sub: "stale-user", role: "GENERAL", tv: 7 });
    await expect(authorize(token)).resolves.toEqual({ statusCode: 401, body: { error: "unauthorized" } });
  });

  it.each([
    { label: "disabled", userId: "disabled-user", state: { tokenVersion: 7, isActive: true, accountStatus: "DISABLED" } },
    { label: "inactive", userId: "inactive-user", state: { tokenVersion: 7, isActive: false, accountStatus: "ACTIVE" } },
  ])("rejects a $label session with the exact generic response", async ({ userId, state }) => {
    mocks.findUnique.mockResolvedValue(state);
    const token = app().jwt.sign({ sub: userId, role: "GENERAL", tv: 7 });
    await expect(authorize(token)).resolves.toEqual({ statusCode: 401, body: { error: "unauthorized" } });
  });

  it("rejects a session for a missing user with the exact generic response", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const token = app().jwt.sign({ sub: "missing-user", role: "GENERAL", tv: 7 });
    await expect(authorize(token)).resolves.toEqual({ statusCode: 401, body: { error: "unauthorized" } });
  });

  it.each([
    { label: "missing", token: () => malformedToken({ sub: "missing-tv-user", role: "GENERAL" }) },
    { label: "malformed", token: () => malformedToken({ sub: "malformed-tv-user", role: "GENERAL", tv: "7" }) },
  ])("rejects a session with a $label token version with the exact generic response", async ({ token }) => {
    await expect(authorize(token())).resolves.toEqual({ statusCode: 401, body: { error: "unauthorized" } });
  });

  it.each(["media", "mfa-login", "backup"])("rejects a %s-purpose JWT with the exact generic response", async (purpose) => {
    const token = app().jwt.sign({ sub: `${purpose}-user`, role: "GENERAL", tv: 7, purpose });
    await expect(authorize(token)).resolves.toEqual({ statusCode: 401, body: { error: "unauthorized" } });
  });
});
