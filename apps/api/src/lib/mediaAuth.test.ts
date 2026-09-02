import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const accessState = vi.hoisted(() => vi.fn());
const originalNodeEnv = process.env.NODE_ENV;
const originalMediaAuthDisabled = process.env.MEDIA_AUTH_DISABLED;
const originalSmsMfaEnabled = process.env.SMS_MFA_ENABLED;
const originalSmsMigrationDeadline = process.env.SMS_MFA_MIGRATION_DEADLINE;

vi.mock("./prisma.js", () => ({
  prisma: {
    user: { findUnique: accessState },
  },
}));

import { MEDIA_COOKIE_NAME, requireMediaAccess, signMediaToken } from "./mediaAuth.js";
import { getAuthoritativeAccessState } from "./tokenVersion.js";

describe("media authorization", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    delete process.env.MEDIA_AUTH_DISABLED;
    process.env.SMS_MFA_ENABLED = "false";
    delete process.env.SMS_MFA_MIGRATION_DEADLINE;
    accessState.mockReset();
    accessState.mockResolvedValue({ tokenVersion: 7, isActive: true, accountStatus: "ACTIVE", phoneVerifiedAt: null });

    app = Fastify({ logger: false });
    await app.register(cookie);
    await app.register(jwt, { secret: "test-secret" });
    app.get("/media", async (request, reply) => {
      if (!await requireMediaAccess(app, request, reply)) return reply;
      return { ok: true };
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalMediaAuthDisabled === undefined) delete process.env.MEDIA_AUTH_DISABLED;
    else process.env.MEDIA_AUTH_DISABLED = originalMediaAuthDisabled;
    if (originalSmsMfaEnabled === undefined) delete process.env.SMS_MFA_ENABLED;
    else process.env.SMS_MFA_ENABLED = originalSmsMfaEnabled;
    if (originalSmsMigrationDeadline === undefined) delete process.env.SMS_MFA_MIGRATION_DEADLINE;
    else process.env.SMS_MFA_MIGRATION_DEADLINE = originalSmsMigrationDeadline;
  });

  function malformedToken(payload: Record<string, unknown>): string {
    return app.jwt.sign(payload as { sub: string; purpose?: string; tv?: number });
  }

  async function authorizeCookie(token: string) {
    const response = await app.inject({
      method: "GET",
      url: "/media",
      headers: { cookie: `${MEDIA_COOKIE_NAME}=${token}` },
    });
    return { statusCode: response.statusCode, body: response.json() };
  }

  async function authorizeBearer(token: string) {
    const response = await app.inject({
      method: "GET",
      url: "/media",
      headers: { authorization: `Bearer ${token}` },
    });
    return { statusCode: response.statusCode, body: response.json() };
  }

  it("embeds the current token version in a media credential", () => {
    const token = signMediaToken(app, "user-1", 7);
    expect(app.jwt.verify(token)).toMatchObject({ sub: "user-1", purpose: "media", tv: 7 });
  });

  it("does not bypass authorization in production when the legacy disable flag is set", async () => {
    process.env.NODE_ENV = "production";
    process.env.MEDIA_AUTH_DISABLED = "true";

    const response = await app.inject({ method: "GET", url: "/media" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized" });
  });

  it("uses an uncached authoritative-state query with only access-control fields", async () => {
    await expect(getAuthoritativeAccessState("user-1")).resolves.toEqual({
      tokenVersion: 7,
      isActive: true,
      accountStatus: "ACTIVE",
      phoneVerifiedAt: null,
    });
    expect(accessState).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { tokenVersion: true, isActive: true, accountStatus: true, phoneVerifiedAt: true },
    });
  });

  it("accepts a current active media cookie", async () => {
    expect(await authorizeCookie(signMediaToken(app, "user-1", 7))).toEqual({ statusCode: 200, body: { ok: true } });
  });

  it("rejects protected media for an unenrolled user after the SMS migration deadline", async () => {
    process.env.SMS_MFA_ENABLED = "true";
    process.env.SMS_MFA_MIGRATION_DEADLINE = "2020-01-01T00:00:00.000Z";

    await expect(authorizeCookie(signMediaToken(app, "user-1", 7)))
      .resolves.toEqual({ statusCode: 401, body: { error: "unauthorized" } });
  });

  it("accepts a current active normal bearer JWT", async () => {
    const token = app.jwt.sign({ sub: "user-1", role: "GENERAL", tv: 7 });
    expect(await authorizeBearer(token)).toEqual({ statusCode: 200, body: { ok: true } });
  });

  it("accepts a current active media bearer token", async () => {
    expect(await authorizeBearer(signMediaToken(app, "user-1", 7))).toEqual({ statusCode: 200, body: { ok: true } });
  });

  it.each([
    { label: "stale version", state: { tokenVersion: 8, isActive: true, accountStatus: "ACTIVE" } },
    { label: "disabled account", state: { tokenVersion: 7, isActive: true, accountStatus: "DISABLED" } },
    { label: "inactive account", state: { tokenVersion: 7, isActive: false, accountStatus: "ACTIVE" } },
    { label: "missing user", state: null },
  ])("rejects $label through every media credential path with the exact generic response", async ({ state }) => {
    accessState.mockResolvedValue(state);
    const mediaToken = signMediaToken(app, "user-1", 7);
    const normalToken = app.jwt.sign({ sub: "user-1", role: "GENERAL", tv: 7 });
    await expect(authorizeCookie(mediaToken)).resolves.toEqual({ statusCode: 401, body: { error: "unauthorized" } });
    await expect(authorizeBearer(mediaToken)).resolves.toEqual({ statusCode: 401, body: { error: "unauthorized" } });
    await expect(authorizeBearer(normalToken)).resolves.toEqual({ statusCode: 401, body: { error: "unauthorized" } });
  });

  it.each(["mfa-login", "backup"])("rejects a %s-purpose credential with the exact generic response", async (purpose) => {
    const token = app.jwt.sign({ sub: "user-1", purpose, tv: 7 });
    await expect(authorizeCookie(token)).resolves.toEqual({ statusCode: 401, body: { error: "unauthorized" } });
    await expect(authorizeBearer(token)).resolves.toEqual({ statusCode: 401, body: { error: "unauthorized" } });
  });

  it.each([
    { label: "missing", token: () => malformedToken({ sub: "user-1", purpose: "media" }) },
    { label: "non-numeric", token: () => malformedToken({ sub: "user-1", purpose: "media", tv: "7" }) },
  ])("rejects a media credential with a $label token version", async ({ token }) => {
    expect(await authorizeCookie(token())).toEqual({ statusCode: 401, body: { error: "unauthorized" } });
  });

  it("rejects a media credential without a subject", async () => {
    const token = malformedToken({ purpose: "media", tv: 7 });
    expect(await authorizeCookie(token)).toEqual({ statusCode: 401, body: { error: "unauthorized" } });
  });
});
