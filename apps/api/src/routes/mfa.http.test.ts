import Fastify from "fastify";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const mocks = vi.hoisted(() => ({
  startChallenge: vi.fn(),
  startLocalChallenge: vi.fn(),
  resendChallenge: vi.fn(),
  startDecoySmsChallenge: vi.fn(),
  resendDecoySmsChallenge: vi.fn(),
  rejectDecoySmsChallenge: vi.fn(),
  checkChallenge: vi.fn(),
  completeChallenge: vi.fn(),
  switchChallengeMethod: vi.fn(),
  completeLocalChallenge: vi.fn(),
  findFirst: vi.fn(),
  aliasFindFirst: vi.fn(),
  aliasDeleteMany: vi.fn(),
  aliasCreateMany: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  queryRaw: vi.fn(),
  startTotpRemoval: vi.fn(),
  confirmTotpRemoval: vi.fn(),
  verifyHuman: vi.fn(),
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("bcryptjs", () => ({ default: { compare: vi.fn(async () => true), hash: vi.fn() } }));
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    user: {
      findFirst: mocks.findFirst,
      count: vi.fn(),
      findUnique: mocks.findUnique,
      findMany: mocks.findMany,
      update: mocks.update,
      create: mocks.create,
    },
    phoneLookupAlias: {
      findFirst: mocks.aliasFindFirst,
      deleteMany: mocks.aliasDeleteMany,
      createMany: mocks.aliasCreateMany,
    },
    organizationMembership: { updateMany: mocks.updateMany },
    $queryRaw: mocks.queryRaw,
    $executeRaw: mocks.executeRaw,
    $transaction: mocks.transaction,
  },
}));
vi.mock("../lib/turnstile.js", () => ({ verifyHuman: mocks.verifyHuman }));
vi.mock("../lib/twilioVerifyProvider.js", () => ({ TwilioVerifyProvider: class {} }));
vi.mock("../lib/factorRemovalService.js", () => ({
  PrismaFactorRemovalRepository: class {},
  FactorRemovalVerificationRejectedError: class extends Error {},
  FactorRemovalCommittedResultError: class extends Error {
    constructor(readonly result: { removed: true; notification: "accepted" | "failed" }) { super(); }
  },
  FactorRemovalService: class {
    startTotpRemoval = mocks.startTotpRemoval;
    confirmTotpRemoval = mocks.confirmTotpRemoval;
  },
}));
vi.mock("../lib/verificationPolicy.js", () => ({
  PrismaVerificationPolicyStore: class {},
  VerificationLockedError: class extends Error {
    constructor(readonly retryAfter = 900, message = "Too many verification attempts. Please try again in 15 minutes.") { super(message); }
  },
  VerificationPolicy: class {
    startChallenge = mocks.startChallenge;
    startLocalChallenge = mocks.startLocalChallenge;
    resendChallenge = mocks.resendChallenge;
    startDecoySmsChallenge = mocks.startDecoySmsChallenge;
    resendDecoySmsChallenge = mocks.resendDecoySmsChallenge;
    rejectDecoySmsChallenge = mocks.rejectDecoySmsChallenge;
    checkChallenge = mocks.checkChallenge;
    completeChallenge = mocks.completeChallenge;
    switchChallengeMethod = mocks.switchChallengeMethod;
    completeLocalChallenge = mocks.completeLocalChallenge;
  },
}));
vi.mock("../lib/phone.js", () => ({
  decryptPhone: vi.fn(() => "+16317423355"),
  normalizeUsPhone: vi.fn(() => "+16317423355"),
  encryptPhone: vi.fn(() => ({ ciphertext: "staged-encrypted-phone", keyVersion: 1 })),
  hashPhone: vi.fn(() => "staged-phone-hash"),
  hashPhoneCandidates: vi.fn(() => [
    { version: 2, hash: "staged-phone-hash" },
    { version: 1, hash: "old-phone-hash" },
  ]),
  maskPhone: vi.fn(() => "(***) ***-3355"),
}));

import { authRoutes } from "./auth.js";
import { isRecentAuthentication, mfaRoutes } from "./mfa.js";
import { encryptSecret } from "../lib/mfa.js";
import { FactorRemovalCommittedResultError, FactorRemovalVerificationRejectedError } from "../lib/factorRemovalService.js";
import { VerificationAmbiguousError, VerificationProviderError } from "../lib/verificationProvider.js";
import { VerificationLockedError } from "../lib/verificationPolicy.js";
import { isCurrentActiveAccess } from "../lib/tokenVersion.js";

function currentTotp(secret: string, now = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret) bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(value % 1_000_000).padStart(6, "0");
}

describe("SMS-first MFA HTTP routes", () => {
  beforeEach(() => {
    process.env.SMS_MFA_ENABLED = "true";
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_API_KEY_SID = "SK123";
    process.env.TWILIO_API_KEY_SECRET = "secret";
    process.env.TWILIO_VERIFY_SERVICE_SID = "VA123";
    process.env.TWILIO_NOTIFICATION_API_KEY_SID = "SK456";
    process.env.TWILIO_NOTIFICATION_API_KEY_SECRET = "notify-secret";
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG123";
    process.env.TURNSTILE_SECRET_KEY = "turnstile-secret";
    process.env.TURNSTILE_EXPECTED_HOSTNAME = "localhost";
    process.env.RATE_LIMIT_HMAC_KEY = "rate-secret";
    mocks.startChallenge.mockReset();
    mocks.startLocalChallenge.mockReset();
    mocks.resendChallenge.mockReset();
    mocks.startDecoySmsChallenge.mockReset();
    mocks.resendDecoySmsChallenge.mockReset();
    mocks.rejectDecoySmsChallenge.mockReset();
    mocks.checkChallenge.mockReset();
    mocks.completeChallenge.mockReset();
    mocks.switchChallengeMethod.mockReset();
    mocks.completeLocalChallenge.mockReset();
    mocks.findFirst.mockReset();
    mocks.aliasFindFirst.mockReset();
    mocks.aliasDeleteMany.mockReset();
    mocks.aliasCreateMany.mockReset();
    mocks.findUnique.mockReset();
    mocks.findMany.mockReset();
    mocks.create.mockReset();
    mocks.update.mockReset();
    mocks.updateMany.mockReset();
    mocks.queryRaw.mockReset();
    mocks.startTotpRemoval.mockReset();
    mocks.confirmTotpRemoval.mockReset();
    mocks.verifyHuman.mockReset();
    mocks.transaction.mockReset();
    mocks.executeRaw.mockReset();
    mocks.auditCreate.mockReset();
    vi.mocked(bcrypt.compare).mockReset();
    vi.mocked(bcrypt.compare).mockResolvedValue(true);
    mocks.transaction.mockImplementation(async (operation: (tx: unknown) => unknown) => operation({
      user: { update: mocks.update },
      phoneLookupAlias: { deleteMany: mocks.aliasDeleteMany, createMany: mocks.aliasCreateMany },
      securityAuditEvent: { create: mocks.auditCreate },
      $executeRaw: mocks.executeRaw,
    }));
    mocks.verifyHuman.mockResolvedValue(true);
    mocks.startDecoySmsChallenge.mockResolvedValue({ id: "decoy-challenge", expiresAt: new Date(Date.now() + 600_000) });
    mocks.resendDecoySmsChallenge.mockResolvedValue({ id: "replacement-decoy", expiresAt: new Date(Date.now() + 600_000) });
    mocks.rejectDecoySmsChallenge.mockResolvedValue({ approved: false });
  });

  async function app(authenticatedUser: Record<string, unknown> = {
    sub: "user-1", role: "ADMIN", tv: 3, iat: Math.floor(Date.now() / 1_000), amr: "TOTP",
  }) {
    const server = Fastify({ logger: false });
    server.decorate("authenticate", async (request: { user: unknown }) => {
      request.user = authenticatedUser;
    });
    server.decorate("requireAdmin", async () => {});
    await server.register(cookie);
    await server.register(jwt, { secret: "test-secret" });
    await server.register(authRoutes, { prefix: "/api/auth" });
    await server.register(mfaRoutes, { prefix: "/api/auth" });
    await server.ready();
    return server;
  }

  it.each([
    ["unknown", null],
    ["inactive", { id: "user-1", passwordHash: "stored-hash", isActive: false }],
  ])("performs one password comparison for an %s login", async (_label, user) => {
    mocks.findFirst.mockResolvedValue(user);
    const server = await app();

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { identifier: "missing@example.com", password: "StrongPass1!" },
    });

    expect(response.statusCode).toBe(401);
    expect(bcrypt.compare).toHaveBeenCalledOnce();
    expect(bcrypt.compare).toHaveBeenCalledWith("StrongPass1!", expect.stringMatching(/^\$2b\$10\$/));
    await server.close();
  });

  it("starts SMS login in a secure cookie without returning a session or challenge token", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "user-1",
      name: "Mitchell Kobran",
      email: "mitchell.kobran@continuixai.com",
      employeeNumber: "EMP-1",
      passwordHash: "hash",
      role: "ADMIN",
      tokenVersion: 3,
      isActive: true,
      accountStatus: "ACTIVE",
      phoneEncrypted: "encrypted-phone",
      phoneEncryptionKeyVersion: 1,
      phoneLookupHash: "phone-hash",
      phoneLookupKeyVersion: 1,
      phoneVersion: 2,
      phoneLast4: "3355",
      phoneVerifiedAt: new Date(),
      mfaEnabled: true,
    });
    mocks.startChallenge.mockResolvedValue({ id: "challenge-1", expiresAt: new Date(Date.now() + 600_000) });
    const server = await app();

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { identifier: "Mitchell.Kobran@ContinuiXAi.com", password: "StrongPass1!" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ mfaRequired: true, method: "SMS", maskedDestination: "(***) ***-3355" });
    expect(response.json()).not.toHaveProperty("token");
    expect(response.json()).not.toHaveProperty("challengeToken");
    expect(response.headers["set-cookie"]).toContain("continuixai_mfa_challenge=challenge-1");
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("Secure");
    expect(response.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(mocks.startChallenge).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      purpose: "LOGIN",
      method: "SMS",
      destination: "+16317423355",
      destinationHash: "phone-hash",
      destinationVersion: 2,
      dimensions: expect.arrayContaining([
        `account:${createHmac("sha256", "rate-secret").update("mitchell.kobran@continuixai.com").digest("hex")}`,
      ]),
    }));
    await server.close();
  });

  it("does not let an administrator create an active unverified account while SMS MFA is enabled", async () => {
    const server = await app();

    const response = await server.inject({
      method: "POST", url: "/api/auth/users",
      payload: { name: "New Employee", email: "employee@example.test", password: "StrongPass1!", role: "GENERAL" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "New employees must register and verify their own phone number.",
      code: "self_registration_required",
    });
    expect(mocks.create).not.toHaveBeenCalled();
    await server.close();
  });

  it("returns safe phone-verification state needed for administrator recovery controls", async () => {
    mocks.findMany.mockResolvedValue([{
      id: "user-2", name: "Employee", email: "employee@example.test", employeeNumber: "EMP-2",
      role: "GENERAL", jobTitle: null, isActive: true, mfaEnabled: true, phoneVerifiedAt: new Date("2026-09-01T12:00:00Z"),
    }]);
    const server = await app();

    const response = await server.inject({ method: "GET", url: "/api/auth/users" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([expect.objectContaining({ id: "user-2", phoneVerified: true })]);
    expect(response.json()[0]).not.toHaveProperty("phoneVerifiedAt");
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        organizationMemberships: {
          some: {
            isActive: true,
            organization: {
              isActive: true,
              memberships: {
                some: { userId: "user-1", isActive: true, role: { in: ["OWNER", "ADMIN"] } },
              },
            },
          },
          none: {
            isActive: true,
            organization: {
              isActive: true,
              memberships: {
                none: { userId: "user-1", isActive: true, role: { in: ["OWNER", "ADMIN"] } },
              },
            },
          },
        },
      },
    }));
    await server.close();
  });

  it("does not let the generic profile route replace the registered recovery email", async () => {
    const server = await app();

    const response = await server.inject({
      method: "PATCH",
      url: "/api/auth/profile",
      payload: { email: "attacker@example.test", currentPassword: "StrongPass1!" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "Registered email changes require a separately verified security workflow.",
      code: "verified_email_change_required",
    });
    expect(bcrypt.compare).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    await server.close();
  });

  it("fails closed instead of offering TOTP setup to an SMS-only user when SMS delivery is disabled", async () => {
    process.env.SMS_MFA_ENABLED = "false";
    mocks.findFirst.mockResolvedValue({
      id: "sms-only-user",
      name: "Mitchell Kobran",
      email: "mitchell.kobran@continuixai.com",
      employeeNumber: "EMP-1",
      passwordHash: "hash",
      role: "ADMIN",
      tokenVersion: 3,
      isActive: true,
      accountStatus: "ACTIVE",
      phoneEncrypted: "encrypted-phone",
      phoneEncryptionKeyVersion: 1,
      phoneLookupHash: "phone-hash",
      phoneLookupKeyVersion: 1,
      phoneVersion: 2,
      phoneLast4: "3355",
      phoneVerifiedAt: new Date(),
      mfaEnabled: false,
      mfaSecretEncrypted: null,
    });
    const server = await app();

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { identifier: "mitchell.kobran@continuixai.com", password: "StrongPass1!" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "SMS verification is temporarily unavailable. Use an existing backup factor or contact support.",
      code: "sms_verification_unavailable",
    });
    expect(response.json()).not.toHaveProperty("challengeToken");
    expect(response.json()).not.toHaveProperty("enrollmentRequired");
    await server.close();
  });

  it("starts an enrolled local backup challenge when SMS delivery fails", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "backup-user", name: "Mitchell", email: "mitchell.kobran@continuixai.com", employeeNumber: "EMP-1",
      passwordHash: "hash", role: "ADMIN", tokenVersion: 3, isActive: true, accountStatus: "ACTIVE",
      phoneEncrypted: "encrypted-phone", phoneEncryptionKeyVersion: 1, phoneLookupHash: "phone-hash",
      phoneVersion: 2, phoneLast4: "3355", phoneVerifiedAt: new Date(),
      mfaEnabled: true, mfaSecretEncrypted: "encrypted-totp", mfaBackupCodeHashes: ["recovery-hash"],
    });
    mocks.startChallenge.mockRejectedValue(new Error("provider unavailable"));
    mocks.startLocalChallenge.mockResolvedValue({ id: "fallback-totp", expiresAt: new Date(Date.now() + 600_000) });
    const server = await app();

    const response = await server.inject({
      method: "POST", url: "/api/auth/login",
      payload: { identifier: "mitchell.kobran@continuixai.com", password: "StrongPass1!" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ mfaRequired: true, method: "TOTP", smsUnavailable: true });
    expect(String(response.headers["set-cookie"])).toContain("continuixai_mfa_challenge=fallback-totp");
    expect(mocks.startLocalChallenge).toHaveBeenCalledWith(expect.objectContaining({
      userId: "backup-user", purpose: "LOGIN", method: "TOTP", tokenVersionAtIssue: 3,
    }));
    await server.close();
  });

  it("allows a phone-verified recovery-code-only account to use its existing backup during an SMS outage", async () => {
    process.env.SMS_MFA_ENABLED = "false";
    const recoveryOnlyUser = {
      id: "recovery-only-user",
      name: "Mitchell Kobran",
      email: "mitchell.kobran@continuixai.com",
      employeeNumber: "EMP-1",
      passwordHash: "hash",
      role: "ADMIN",
      tokenVersion: 3,
      isActive: true,
      accountStatus: "ACTIVE",
      phoneEncrypted: "encrypted-phone",
      phoneEncryptionKeyVersion: 1,
      phoneLookupHash: "phone-hash",
      phoneVersion: 2,
      phoneLast4: "3355",
      phoneVerifiedAt: new Date(),
      mfaEnabled: false,
      mfaSecretEncrypted: null,
      mfaBackupCodeHashes: ["recovery-hash"],
    };
    mocks.findFirst.mockResolvedValue(recoveryOnlyUser);
    mocks.findUnique.mockResolvedValue(recoveryOnlyUser);
    mocks.startLocalChallenge.mockResolvedValue({ id: "outage-recovery-challenge", expiresAt: new Date(Date.now() + 600_000) });
    mocks.queryRaw.mockResolvedValue([{ userId: "recovery-only-user", purpose: "LOGIN", method: "RECOVERY_CODE" }]);
    mocks.completeLocalChallenge.mockResolvedValue({ approved: true });
    const server = await app();

    const login = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { identifier: "mitchell.kobran@continuixai.com", password: "StrongPass1!" },
    });

    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ mfaRequired: true, method: "RECOVERY_CODE" });
    expect(login.json()).not.toHaveProperty("challengeToken");
    expect(String(login.headers["set-cookie"])).toContain("continuixai_mfa_challenge=outage-recovery-challenge");

    const verified = await server.inject({
      method: "POST",
      url: "/api/auth/mfa/check",
      headers: { cookie: "continuixai_mfa_challenge=outage-recovery-challenge" },
      payload: { code: "A1B2C3D4E5" },
    });

    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toHaveProperty("token");
    expect(mocks.startLocalChallenge).toHaveBeenCalledWith(expect.objectContaining({
      userId: "recovery-only-user", purpose: "LOGIN", method: "RECOVERY_CODE",
    }));
    expect(mocks.completeLocalChallenge).toHaveBeenCalledWith(expect.objectContaining({
      challengeId: "outage-recovery-challenge", userId: "recovery-only-user", purpose: "LOGIN", method: "RECOVERY_CODE",
    }), expect.any(Function));
    await server.close();
  });

  it("allows a phone-verified account to use its enrolled authenticator during an SMS outage", async () => {
    process.env.SMS_MFA_ENABLED = "false";
    const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    const totpUser = {
      id: "totp-user",
      name: "Mitchell Kobran",
      email: "mitchell.kobran@continuixai.com",
      employeeNumber: "EMP-1",
      passwordHash: "hash",
      role: "ADMIN",
      tokenVersion: 3,
      isActive: true,
      accountStatus: "ACTIVE",
      phoneVerifiedAt: new Date(),
      mfaEnabled: true,
      mfaSecretEncrypted: encryptSecret(secret),
      mfaBackupCodeHashes: [],
    };
    mocks.findFirst.mockResolvedValue(totpUser);
    mocks.findUnique.mockResolvedValue(totpUser);
    mocks.startLocalChallenge.mockResolvedValue({ id: "outage-totp-challenge", expiresAt: new Date(Date.now() + 600_000) });
    mocks.queryRaw.mockResolvedValue([{ userId: "totp-user", purpose: "LOGIN", method: "TOTP" }]);
    mocks.completeLocalChallenge.mockResolvedValue({ approved: true });
    const server = await app();

    const login = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { identifier: "mitchell.kobran@continuixai.com", password: "StrongPass1!" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ mfaRequired: true, method: "TOTP" });
    expect(login.json()).not.toHaveProperty("challengeToken");
    expect(String(login.headers["set-cookie"])).toContain("continuixai_mfa_challenge=outage-totp-challenge");

    const verified = await server.inject({
      method: "POST",
      url: "/api/auth/mfa/check",
      headers: { cookie: "continuixai_mfa_challenge=outage-totp-challenge" },
      payload: { code: currentTotp(secret) },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toHaveProperty("token");
    expect(mocks.completeLocalChallenge).toHaveBeenCalledWith(expect.objectContaining({
      challengeId: "outage-totp-challenge", userId: "totp-user", purpose: "LOGIN", method: "TOTP",
    }), expect.any(Function));
    await server.close();
  });

  it("rejects a legacy TOTP setup token for an account with a verified phone", async () => {
    process.env.SMS_MFA_ENABLED = "false";
    mocks.findUnique.mockResolvedValue({
      id: "sms-only-user",
      email: "mitchell.kobran@continuixai.com",
      employeeNumber: "EMP-1",
      role: "ADMIN",
      tokenVersion: 3,
      isActive: true,
      accountStatus: "ACTIVE",
      phoneVerifiedAt: new Date(),
      mfaEnabled: false,
      mfaSecretEncrypted: null,
    });
    const server = await app();
    const challengeToken = server.jwt.sign({
      sub: "sms-only-user", role: "ADMIN", tv: 3, purpose: "mfa-setup",
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/mfa/setup",
      payload: { challengeToken },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Authenticator enrollment requires verification with an existing factor." });
    expect(mocks.update).not.toHaveBeenCalled();
    await server.close();
  });

  it("rejects legacy TOTP confirmation for an account with a verified phone", async () => {
    process.env.SMS_MFA_ENABLED = "false";
    mocks.findUnique.mockResolvedValue({
      id: "sms-only-user",
      email: "mitchell.kobran@continuixai.com",
      employeeNumber: "EMP-1",
      role: "ADMIN",
      tokenVersion: 3,
      isActive: true,
      accountStatus: "ACTIVE",
      phoneVerifiedAt: new Date(),
      mfaEnabled: false,
      mfaSecretEncrypted: "staged-secret",
    });
    const server = await app();
    const challengeToken = server.jwt.sign({
      sub: "sms-only-user", role: "ADMIN", tv: 3, purpose: "mfa-setup",
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/mfa/confirm",
      payload: { challengeToken, code: "123456" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Authenticator enrollment requires verification with an existing factor." });
    expect(mocks.update).not.toHaveBeenCalled();
    await server.close();
  });

  it("rejects a still-valid legacy MFA login token for an account with a verified phone", async () => {
    process.env.SMS_MFA_ENABLED = "false";
    mocks.findUnique.mockResolvedValue({
      id: "verified-phone-user",
      name: "Mitchell Kobran",
      email: "mitchell.kobran@continuixai.com",
      employeeNumber: "EMP-1",
      role: "ADMIN",
      tokenVersion: 3,
      isActive: true,
      accountStatus: "ACTIVE",
      phoneVerifiedAt: new Date(),
      mfaEnabled: false,
      mfaSecretEncrypted: null,
      mfaBackupCodeHashes: ["recovery-hash"],
    });
    const server = await app();
    const challengeToken = server.jwt.sign({
      sub: "verified-phone-user", role: "ADMIN", tv: 3, purpose: "mfa-login",
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/mfa/verify",
      payload: { challengeToken, code: "A1B2C3D4E5" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Use the current backup verification flow." });
    expect(mocks.update).not.toHaveBeenCalled();
    await server.close();
  });

  it("performs eight recovery-code comparisons on the legacy verification route", async () => {
    process.env.SMS_MFA_ENABLED = "false";
    mocks.findUnique.mockResolvedValue({
      id: "legacy-user",
      name: "Mitchell Kobran",
      email: "mitchell.kobran@continuixai.com",
      employeeNumber: "EMP-1",
      role: "ADMIN",
      tokenVersion: 3,
      isActive: true,
      accountStatus: "ACTIVE",
      phoneVerifiedAt: null,
      mfaEnabled: false,
      mfaSecretEncrypted: null,
      mfaBackupCodeHashes: ["recovery-hash"],
    });
    vi.mocked(bcrypt.compare).mockResolvedValue(false);
    const server = await app();
    const challengeToken = server.jwt.sign({
      sub: "legacy-user", role: "ADMIN", tv: 3, purpose: "mfa-login",
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/mfa/verify",
      payload: { challengeToken, code: "INVALIDCODE" },
    });

    expect(response.statusCode).toBe(401);
    expect(bcrypt.compare).toHaveBeenCalledTimes(8);
    await server.close();
  });

  it("requires a fresh existing-factor session before a phone can be staged", () => {
    const now = 2_000_000;
    expect(isRecentAuthentication(now - 599, now)).toBe(true);
    expect(isRecentAuthentication(now - 601, now)).toBe(false);
    expect(isRecentAuthentication(undefined, now)).toBe(false);
    expect(isRecentAuthentication(now + 1, now)).toBe(false);
  });

  it("replaces the current SMS challenge when a user requests another code", async () => {
    mocks.queryRaw.mockResolvedValue([{ userId: "user-1", purpose: "LOGIN", method: "SMS" }]);
    mocks.findUnique.mockResolvedValue({
      id: "user-1", email: "mitchell.kobran@continuixai.com", isActive: true, accountStatus: "ACTIVE",
      phoneEncrypted: "encrypted-phone", phoneEncryptionKeyVersion: 1, phoneLookupHash: "phone-hash",
      phoneVersion: 2, phoneLast4: "3355", phoneVerifiedAt: new Date(),
    });
    mocks.resendChallenge.mockResolvedValue({ id: "replacement-challenge", expiresAt: new Date(Date.now() + 600_000) });
    const server = await app();
    const response = await server.inject({
      method: "POST", url: "/api/auth/mfa/resend",
      headers: { cookie: "continuixai_mfa_challenge=original-challenge" }, payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ method: "SMS", maskedDestination: "your phone" });
    expect(mocks.resendChallenge).toHaveBeenCalledWith(expect.objectContaining({
      previousChallengeId: "original-challenge", userId: "user-1", purpose: "LOGIN", method: "SMS",
      destinationHash: "phone-hash", destinationVersion: 2,
    }));
    expect(String(response.headers["set-cookie"])).toContain("continuixai_mfa_challenge=replacement-challenge");
    await server.close();
  });

  it("starts phone enrollment from an existing authenticated TOTP session", async () => {
    const currentUser = {
      id: "user-1", name: "Mitchell Kobran", email: "mitchell.kobran@continuixai.com",
      employeeNumber: "EMP-1", passwordHash: "hash", role: "ADMIN", tokenVersion: 3,
      isActive: true, accountStatus: "ACTIVE", phoneVerifiedAt: null, mfaEnabled: true,
      mfaSecretEncrypted: "existing-enrolled-secret",
    };
    mocks.findUnique.mockResolvedValueOnce(currentUser).mockResolvedValueOnce(null);
    mocks.update.mockResolvedValue({ id: "user-1" });
    mocks.startChallenge.mockResolvedValue({ id: "phone-enrollment-1", expiresAt: new Date(Date.now() + 600_000) });
    const server = await app();

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/mfa/phone/enroll/start",
      payload: {
        phone: "(631) 742-3355", smsConsent: true, consentVersion: "2026-09-01",
        turnstileToken: "human-proof",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "verification_pending", maskedDestination: "(***) ***-3355" });
    expect(String(response.headers["set-cookie"])).toContain("continuixai_mfa_challenge=");
    expect(String(response.headers["set-cookie"])).toContain("continuixai_mfa_challenge=phone-enrollment-1");
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "user-1" },
      data: expect.objectContaining({
        phoneEncrypted: "staged-encrypted-phone", phoneLookupHash: "staged-phone-hash",
        phoneVerifiedAt: null, phoneConsentSource: "legacy_self_enrollment",
      }),
    }));
    expect(mocks.startChallenge).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1", purpose: "PHONE_CHANGE", method: "SMS",
      destination: "+16317423355", destinationHash: "staged-phone-hash",
    }));
    await server.close();
  });

  it("does not replace an existing verified phone through the migration enrollment route", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "user-1", passwordHash: "hash", isActive: true, accountStatus: "ACTIVE",
      phoneVerifiedAt: new Date(), mfaEnabled: true, mfaSecretEncrypted: "existing-enrolled-secret",
    });
    const server = await app();

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/mfa/phone/enroll/start",
      payload: {
        phone: "(631) 742-3355", smsConsent: true, consentVersion: "2026-09-01",
        turnstileToken: "human-proof",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.startChallenge).not.toHaveBeenCalled();
    await server.close();
  });

  it("keeps duplicate-phone resend and code attempts on a durable decoy challenge", async () => {
    mocks.queryRaw.mockResolvedValueOnce([{
      userId: "user-1", purpose: "PHONE_CHANGE", method: "SMS", providerRef: "decoy",
      phoneLookupHash: "staged-phone-hash", phonePrefixHash: "d".repeat(64), destinationVersion: 1,
    }]);
    mocks.findUnique.mockResolvedValue({
      id: "user-1", email: "mitchell.kobran@continuixai.com", isActive: true, accountStatus: "ACTIVE",
    });
    const server = await app();
    const resend = await server.inject({
      method: "POST", url: "/api/auth/mfa/resend",
      headers: { cookie: "continuixai_mfa_challenge=decoy-challenge" }, payload: {},
    });
    expect(resend.statusCode).toBe(200);
    expect(resend.json()).toEqual({ method: "SMS", maskedDestination: "your phone" });
    expect(mocks.resendDecoySmsChallenge).toHaveBeenCalledWith(expect.objectContaining({
      previousChallengeId: "decoy-challenge", destinationHash: "staged-phone-hash", destinationVersion: 1,
      dimensions: expect.arrayContaining([`phone-prefix:${"d".repeat(64)}`]),
    }));

    mocks.queryRaw.mockResolvedValueOnce([{
      userId: "user-1", purpose: "PHONE_CHANGE", method: "SMS", providerRef: "decoy",
      phoneLookupHash: "staged-phone-hash", destinationVersion: 1,
    }]);
    const check = await server.inject({
      method: "POST", url: "/api/auth/mfa/phone/enroll/check",
      headers: { cookie: "continuixai_mfa_challenge=replacement-decoy" }, payload: { code: "123456" },
    });
    expect(check.statusCode).toBe(401);
    expect(mocks.rejectDecoySmsChallenge).toHaveBeenCalledWith(expect.objectContaining({
      challengeId: "replacement-decoy", destinationHash: "staged-phone-hash", destinationVersion: 1,
    }));
    await server.close();
  });

  it("uses the same accepted envelope when the requested phone belongs to another account", async () => {
    const currentUser = {
      id: "user-1", email: "mitchell.kobran@continuixai.com", isActive: true, accountStatus: "ACTIVE",
      phoneVerifiedAt: null, phoneVersion: 0, mfaEnabled: true, mfaSecretEncrypted: "existing-enrolled-secret",
    };
    mocks.findUnique.mockResolvedValueOnce(currentUser);
    mocks.aliasFindFirst.mockResolvedValueOnce({ userId: "other-user" });
    const server = await app();
    const response = await server.inject({
      method: "POST", url: "/api/auth/mfa/phone/enroll/start",
      payload: { phone: "(631) 742-3355", smsConsent: true, consentVersion: "2026-09-01", turnstileToken: "human-proof" },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "verification_pending", maskedDestination: "(***) ***-3355" });
    expect(String(response.headers["set-cookie"])).toContain("continuixai_mfa_challenge=");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.startChallenge).not.toHaveBeenCalled();
    expect(mocks.startDecoySmsChallenge).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1", purpose: "PHONE_CHANGE", method: "SMS",
      destinationHash: "staged-phone-hash", destinationVersion: 1,
    }));
    expect(mocks.aliasFindFirst).toHaveBeenCalledWith({
      where: { hash: { in: ["staged-phone-hash", "old-phone-hash"] } },
      select: { userId: true },
    });
    await server.close();
  });

  it("turns a late cross-version alias race into the same decoy response", async () => {
    const currentUser = {
      id: "user-1", email: "mitchell.kobran@continuixai.com", isActive: true, accountStatus: "ACTIVE",
      phoneVerifiedAt: null, phoneVersion: 0, mfaEnabled: true, mfaSecretEncrypted: "existing-enrolled-secret",
    };
    mocks.findUnique.mockResolvedValueOnce(currentUser);
    mocks.aliasFindFirst.mockResolvedValueOnce(null);
    mocks.aliasCreateMany.mockRejectedValueOnce(Object.assign(new Error("unique conflict"), { code: "P2002" }));
    const server = await app();

    const response = await server.inject({
      method: "POST", url: "/api/auth/mfa/phone/enroll/start",
      payload: { phone: "(631) 742-3355", smsConsent: true, consentVersion: "2026-09-01", turnstileToken: "human-proof" },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "verification_pending", maskedDestination: "(***) ***-3355" });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.startChallenge).not.toHaveBeenCalled();
    expect(mocks.startDecoySmsChallenge).toHaveBeenCalledOnce();
    await server.close();
  });

  it("requires security support when an active legacy account has no working factor", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "user-1", passwordHash: "hash", isActive: true, accountStatus: "ACTIVE",
      phoneEncrypted: null, phoneVerifiedAt: null, mfaEnabled: false,
    });
    const server = await app();
    const response = await server.inject({
      method: "POST", url: "/api/auth/login",
      payload: { identifier: "mitchell.kobran@continuixai.com", password: "StrongPass1!" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "This account needs security support before phone enrollment can continue.",
      code: "security_support_required",
    });
    await server.close();
  });

  it("keeps TOTP login working for an existing account until SMS is enrolled", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "user-1", passwordHash: "hash", isActive: true, accountStatus: "ACTIVE",
      tokenVersion: 3, mfaEnabled: true, mfaSecretEncrypted: "existing-enrolled-secret",
      phoneEncrypted: null, phoneVerifiedAt: null,
    });
    mocks.startLocalChallenge.mockResolvedValue({ id: "totp-migration-1", expiresAt: new Date(Date.now() + 600_000) });
    const server = await app();
    const response = await server.inject({
      method: "POST", url: "/api/auth/login",
      payload: { identifier: "mitchell.kobran@continuixai.com", password: "StrongPass1!" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ mfaRequired: true, method: "TOTP", phoneEnrollmentRequired: true });
    expect(mocks.startChallenge).not.toHaveBeenCalled();
    expect(mocks.startLocalChallenge).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1", purpose: "LOGIN", method: "TOTP", destinationVersion: 3,
    }));
    expect(String(response.headers["set-cookie"])).toContain("continuixai_mfa_challenge=totp-migration-1");
    await server.close();
  });

  it("requires a valid human check before staging an existing account phone", async () => {
    mocks.verifyHuman.mockResolvedValue(false);
    const server = await app();
    const response = await server.inject({
      method: "POST", url: "/api/auth/mfa/phone/enroll/start",
      payload: {
        identifier: "mitchell.kobran@continuixai.com", password: "StrongPass1!",
        phone: "(631) 742-3355", smsConsent: true, consentVersion: "2026-09-01",
        turnstileToken: "invalid-human-proof",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.startChallenge).not.toHaveBeenCalled();
    await server.close();
  });

  it("requires an enrolled current factor before authenticated phone enrollment", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "user-1", passwordHash: "hash", isActive: true, accountStatus: "ACTIVE",
      phoneVerifiedAt: null, mfaEnabled: false, mfaSecretEncrypted: null,
    });
    const server = await app();
    const response = await server.inject({
      method: "POST", url: "/api/auth/mfa/phone/enroll/start",
      payload: {
        phone: "(631) 742-3355", smsConsent: true, consentVersion: "2026-09-01",
        turnstileToken: "human-proof",
      },
    });
    expect(response.statusCode).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.startChallenge).not.toHaveBeenCalled();
    await server.close();
  });

  it("approves existing-account phone enrollment atomically and preserves active TOTP", async () => {
    const stagedUser = {
      id: "user-1", name: "Mitchell Kobran", email: "mitchell.kobran@continuixai.com",
      employeeNumber: "EMP-1", role: "ADMIN", tokenVersion: 3, isActive: true,
      accountStatus: "ACTIVE", phoneEncrypted: "staged-encrypted-phone",
      phoneEncryptionKeyVersion: 1, phoneLookupHash: "staged-phone-hash", phoneVersion: 4,
      phoneVerifiedAt: null, mfaEnabled: true, mfaSecretEncrypted: "existing-enrolled-secret",
    };
    const approvedUser = { ...stagedUser, tokenVersion: 4, phoneVerifiedAt: new Date() };
    mocks.queryRaw.mockResolvedValue([{ userId: "user-1", purpose: "PHONE_CHANGE", method: "SMS" }]);
    mocks.findUnique.mockResolvedValue(stagedUser);
    mocks.executeRaw.mockResolvedValue(1);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.mockImplementation(async (operation: (tx: unknown) => unknown) => operation({
      $executeRaw: mocks.executeRaw,
      user: { updateMany: mocks.updateMany, findUnique: vi.fn(async () => approvedUser) },
      securityAuditEvent: { create: mocks.auditCreate },
    }));
    mocks.completeChallenge.mockImplementation(async (_input, complete) => ({ approved: true, value: await complete("phone-enrollment-1", new Date()) }));
    const server = await app();

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/mfa/phone/enroll/check",
      headers: { cookie: "continuixai_mfa_challenge=phone-enrollment-1" },
      payload: { code: "123456" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty("token");
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "user-1", phoneLookupHash: "staged-phone-hash", phoneVersion: 4, phoneVerifiedAt: null }),
      data: expect.objectContaining({
        phoneVerifiedAt: expect.any(Date), recoveryPinHash: null, tokenVersion: { increment: 1 },
      }),
    }));
    expect(mocks.updateMany.mock.calls[0]?.[0]?.data).not.toHaveProperty("mfaSecretEncrypted");
    expect(mocks.updateMany.mock.calls[0]?.[0]?.data).not.toHaveProperty("mfaEnabled");
    expect(String(response.headers["set-cookie"])).toContain("continuixai_mfa_challenge=;");
    await server.close();
  });

  it("does not activate a phone or change TOTP when the SMS code is rejected", async () => {
    mocks.queryRaw.mockResolvedValue([{ userId: "user-1", purpose: "PHONE_CHANGE", method: "SMS" }]);
    mocks.findUnique.mockResolvedValue({
      id: "user-1", isActive: true, accountStatus: "ACTIVE", phoneEncrypted: "staged-encrypted-phone",
      phoneEncryptionKeyVersion: 1, phoneLookupHash: "staged-phone-hash", phoneVersion: 4,
      phoneVerifiedAt: null, mfaEnabled: true, mfaSecretEncrypted: "existing-enrolled-secret",
    });
    mocks.completeChallenge.mockResolvedValue({ approved: false });
    const server = await app();
    const response = await server.inject({
      method: "POST", url: "/api/auth/mfa/phone/enroll/check",
      headers: { cookie: "continuixai_mfa_challenge=phone-enrollment-1" },
      payload: { code: "000000" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).not.toHaveProperty("token");
    expect(response.json()).not.toHaveProperty("backupCodes");
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
    await server.close();
  });

  it("requires a fresh phone challenge after an ambiguous provider result", async () => {
    mocks.queryRaw.mockResolvedValue([{ userId: "user-1", purpose: "PHONE_CHANGE", method: "SMS" }]);
    mocks.findUnique.mockResolvedValue({
      id: "user-1", isActive: true, accountStatus: "ACTIVE", phoneEncrypted: "staged-encrypted-phone",
      phoneEncryptionKeyVersion: 1, phoneLookupHash: "staged-phone-hash", phoneVersion: 4,
      phoneVerifiedAt: null, mfaEnabled: true, mfaSecretEncrypted: "existing-enrolled-secret",
    });
    mocks.completeChallenge.mockRejectedValue(new VerificationAmbiguousError());
    const server = await app();
    const response = await server.inject({
      method: "POST", url: "/api/auth/mfa/phone/enroll/check",
      headers: { cookie: "continuixai_mfa_challenge=phone-enrollment-1" }, payload: { code: "123456" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "Verification could not be confirmed. Start again for a new code.",
      code: "fresh_challenge_required",
    });
    expect(String(response.headers["set-cookie"])).toContain("continuixai_mfa_challenge=;");
    expect(mocks.transaction).not.toHaveBeenCalled();
    await server.close();
  });

  it("returns the shared generic 429 for a denied login SMS budget", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "user-1", name: "Mitchell", email: "mitchell.kobran@continuixai.com", employeeNumber: "EMP-1",
      passwordHash: "hash", role: "ADMIN", tokenVersion: 3, isActive: true, accountStatus: "ACTIVE",
      phoneEncrypted: "encrypted-phone", phoneEncryptionKeyVersion: 1, phoneLookupHash: "phone-hash",
      phoneVersion: 2, phoneLast4: "3355", phoneVerifiedAt: new Date(), mfaEnabled: true,
    });
    mocks.startChallenge.mockRejectedValue(new VerificationLockedError(30, "Too many verification requests. Please try again later."));
    const server = await app();

    const response = await server.inject({
      method: "POST", url: "/api/auth/login",
      payload: { identifier: "Mitchell.Kobran@ContinuiXAi.com", password: "StrongPass1!" },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("30");
    expect(response.json()).toEqual({ error: "Too many verification requests. Please try again later." });
    await server.close();
  });

  it("checks the SMS challenge from the cookie and issues a session only after approval", async () => {
    mocks.queryRaw.mockResolvedValue([{ userId: "user-1", purpose: "LOGIN", method: "SMS" }]);
    mocks.findUnique.mockResolvedValue({
      id: "user-1", name: "Mitchell Kobran", email: "mitchell.kobran@continuixai.com", employeeNumber: "EMP-1",
      role: "ADMIN", tokenVersion: 3, isActive: true, accountStatus: "ACTIVE",
      phoneEncrypted: "encrypted-phone", phoneEncryptionKeyVersion: 1, phoneLookupHash: "phone-hash", phoneVersion: 2,
    });
    mocks.executeRaw.mockResolvedValue(1);
    mocks.completeChallenge.mockImplementation(async (input, completeAtomically) => ({
      approved: true,
      value: await completeAtomically(input.challengeId, new Date(), input.tokenVersionAtIssue),
    }));
    const server = await app();

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/mfa/check",
      headers: { cookie: "continuixai_mfa_challenge=challenge-1" },
      payload: { code: "123456" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty("token");
    expect(response.json()).not.toHaveProperty("challengeToken");
    const mediaToken = String(response.headers["set-cookie"]).match(/continuixai_media=([^;,]+)/)?.[1];
    expect(mediaToken).toBeDefined();
    expect(server.jwt.verify(mediaToken!)).toMatchObject({ sub: "user-1", purpose: "media", tv: 3 });
    expect(mocks.completeChallenge).toHaveBeenCalledWith({
      challengeId: "challenge-1", userId: "user-1", purpose: "LOGIN", method: "SMS", destination: "+16317423355",
      destinationHash: "phone-hash", destinationVersion: 2, tokenVersionAtIssue: 3, code: "123456",
    }, expect.any(Function));
    expect(String(response.headers["set-cookie"])).toContain("continuixai_mfa_challenge=;");
    await server.close();
  });

  it("does not issue a session when the account token version changes before atomic SMS consumption", async () => {
    mocks.queryRaw.mockResolvedValue([{ userId: "user-1", purpose: "LOGIN", method: "SMS" }]);
    mocks.findUnique.mockResolvedValue({
      id: "user-1", name: "Mitchell", email: "mitchell.kobran@continuixai.com", employeeNumber: "EMP-1",
      role: "ADMIN", tokenVersion: 3, isActive: true, accountStatus: "ACTIVE",
      phoneEncrypted: "encrypted-phone", phoneEncryptionKeyVersion: 1, phoneLookupHash: "phone-hash", phoneVersion: 2,
    });
    mocks.executeRaw.mockResolvedValue(0);
    mocks.completeChallenge.mockImplementation(async (input, completeAtomically) => ({
      approved: true,
      value: await completeAtomically(input.challengeId, new Date(), input.tokenVersionAtIssue),
    }));
    const server = await app();

    const response = await server.inject({
      method: "POST", url: "/api/auth/mfa/check",
      headers: { cookie: "continuixai_mfa_challenge=stale-challenge" }, payload: { code: "123456" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).not.toHaveProperty("token");
    await server.close();
  });

  it("atomically disables an account and invalidates its old access version", async () => {
    mocks.findFirst.mockResolvedValue({ id: "user-2" });
    mocks.update.mockResolvedValue({ id: "user-2", tokenVersion: 4 });
    mocks.updateMany.mockResolvedValue({ count: 1 });
    const server = await app();

    const response = await server.inject({ method: "DELETE", url: "/api/auth/users/user-2" });

    expect(response.statusCode).toBe(204);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "user-2" },
      data: {
        accountStatus: "DISABLED",
        isActive: false,
        phoneVerifiedAt: null,
        tokenVersion: { increment: 1 },
      },
    });
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { userId: "user-2" }, data: { isActive: false } });

    mocks.findUnique.mockResolvedValue({ tokenVersion: 4, isActive: false, accountStatus: "DISABLED" });
    await expect(isCurrentActiveAccess("user-2", 3)).resolves.toBe(false);
    await server.close();
  });

  it("does not disable a user unless the administrator manages every active target organization", async () => {
    mocks.findFirst.mockResolvedValue(null);
    const server = await app();

    const response = await server.inject({ method: "DELETE", url: "/api/auth/users/foreign-user" });

    expect(response.statusCode).toBe(404);
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "foreign-user",
        organizationMemberships: {
          some: {
            isActive: true,
            organization: {
              isActive: true,
              memberships: {
                some: { userId: "user-1", isActive: true, role: { in: ["OWNER", "ADMIN"] } },
              },
            },
          },
          none: {
            isActive: true,
            organization: {
              isActive: true,
              memberships: {
                none: { userId: "user-1", isActive: true, role: { in: ["OWNER", "ADMIN"] } },
              },
            },
          },
        },
      },
    }));
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
    await server.close();
  });

  it("does not allow the legacy TOTP endpoint to consume an SMS-first login", async () => {
    const server = await app();
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/mfa/verify",
      headers: { cookie: "continuixai_mfa_challenge=challenge-1" },
      payload: { challengeToken: "client-visible-token", code: "123456" },
    });
    expect(response.statusCode).toBe(410);
    expect(mocks.checkChallenge).not.toHaveBeenCalled();
    await server.close();
  });

  it("fails closed when SMS delivery is unavailable", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "user-1", name: "Mitchell", email: "mitchell.kobran@continuixai.com", employeeNumber: "EMP-1",
      passwordHash: "hash", role: "ADMIN", tokenVersion: 3, isActive: true, accountStatus: "ACTIVE",
      phoneEncrypted: "encrypted-phone", phoneEncryptionKeyVersion: 1, phoneLookupHash: "phone-hash",
      phoneVersion: 2, phoneLast4: "3355", phoneVerifiedAt: new Date(), mfaEnabled: true,
    });
    mocks.startChallenge.mockRejectedValue(new Error("provider unavailable"));
    const server = await app();
    const response = await server.inject({
      method: "POST", url: "/api/auth/login",
      payload: { identifier: "Mitchell.Kobran@ContinuiXAi.com", password: "StrongPass1!" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).not.toHaveProperty("token");
    expect(response.json()).not.toHaveProperty("challengeToken");
    await server.close();
  });

  it("switches to recovery codes by invalidating the SMS challenge and replacing its cookie", async () => {
    mocks.queryRaw.mockResolvedValue([{ userId: "user-1", purpose: "LOGIN", method: "SMS" }]);
    mocks.findUnique.mockResolvedValue({
      id: "user-1", isActive: true, accountStatus: "ACTIVE", tokenVersion: 3,
      mfaBackupCodeHashes: ["hash-1"], mfaSecretEncrypted: "totp-secret",
    });
    mocks.switchChallengeMethod.mockResolvedValue({ id: "recovery-challenge", expiresAt: new Date(Date.now() + 600_000) });
    const server = await app();
    const response = await server.inject({
      method: "POST", url: "/api/auth/mfa/method",
      headers: { cookie: "continuixai_mfa_challenge=sms-challenge" },
      payload: { method: "RECOVERY_CODE" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ method: "RECOVERY_CODE" });
    expect(mocks.switchChallengeMethod).toHaveBeenCalledWith(expect.objectContaining({
      challengeId: "sms-challenge", userId: "user-1", purpose: "LOGIN", method: "RECOVERY_CODE",
    }));
    expect(String(response.headers["set-cookie"])).toContain("continuixai_mfa_challenge=recovery-challenge");
    await server.close();
  });

  it("switches between already-enrolled local backup factors during an SMS outage", async () => {
    process.env.SMS_MFA_ENABLED = "false";
    mocks.queryRaw.mockResolvedValue([{ userId: "user-1", purpose: "LOGIN", method: "TOTP" }]);
    mocks.findUnique.mockResolvedValue({
      id: "user-1", isActive: true, accountStatus: "ACTIVE", tokenVersion: 3,
      phoneVerifiedAt: new Date(), mfaBackupCodeHashes: ["recovery-hash"],
    });
    mocks.switchChallengeMethod.mockResolvedValue({ id: "outage-recovery", expiresAt: new Date(Date.now() + 600_000) });
    const server = await app();

    const response = await server.inject({
      method: "POST", url: "/api/auth/mfa/method",
      headers: { cookie: "continuixai_mfa_challenge=outage-totp" },
      payload: { method: "RECOVERY_CODE" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ method: "RECOVERY_CODE" });
    expect(mocks.switchChallengeMethod).toHaveBeenCalledWith(expect.objectContaining({
      challengeId: "outage-totp", userId: "user-1", purpose: "LOGIN", method: "RECOVERY_CODE",
    }));
    expect(String(response.headers["set-cookie"])).toContain("continuixai_mfa_challenge=outage-recovery");
    await server.close();
  });

  it("issues a session only after a method-bound recovery challenge is atomically completed", async () => {
    mocks.queryRaw.mockResolvedValue([{ userId: "user-1", purpose: "LOGIN", method: "RECOVERY_CODE" }]);
    mocks.findUnique.mockResolvedValue({
      id: "user-1", name: "Mitchell", email: "mitchell.kobran@continuixai.com", employeeNumber: "EMP-1",
      role: "ADMIN", tokenVersion: 3, isActive: true, accountStatus: "ACTIVE", mfaBackupCodeHashes: ["hash-1"],
    });
    mocks.completeLocalChallenge.mockResolvedValue({ approved: true });
    const server = await app();
    const response = await server.inject({ method: "POST", url: "/api/auth/mfa/check", headers: { cookie: "continuixai_mfa_challenge=recovery-challenge" }, payload: { code: "A1B2C3D4E5" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty("token");
    expect(mocks.completeLocalChallenge).toHaveBeenCalledWith(expect.objectContaining({
      challengeId: "recovery-challenge", userId: "user-1", purpose: "LOGIN", method: "RECOVERY_CODE",
    }), expect.any(Function));
    await server.close();
  });

  it("performs eight recovery-code comparisons inside a method-bound transaction", async () => {
    mocks.queryRaw.mockResolvedValue([{ userId: "user-1", purpose: "LOGIN", method: "RECOVERY_CODE" }]);
    mocks.findUnique.mockResolvedValue({
      id: "user-1", name: "Mitchell", email: "mitchell.kobran@continuixai.com", employeeNumber: "EMP-1",
      role: "ADMIN", tokenVersion: 3, isActive: true, accountStatus: "ACTIVE", mfaBackupCodeHashes: ["hash-1"],
    });
    mocks.transaction.mockImplementation(async (operation: (tx: unknown) => unknown) => operation({
      $queryRaw: vi.fn(async () => [{ mfaBackupCodeHashes: ["hash-1"] }]),
      $executeRaw: vi.fn(),
      user: { update: vi.fn() },
    }));
    mocks.completeLocalChallenge.mockImplementation(async (_binding, verify) => ({
      approved: await verify("recovery-challenge", new Date()) === "approved",
    }));
    vi.mocked(bcrypt.compare).mockResolvedValue(false);
    const server = await app();

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/mfa/check",
      headers: { cookie: "continuixai_mfa_challenge=recovery-challenge" },
      payload: { code: "INVALIDCODE" },
    });

    expect(response.statusCode).toBe(401);
    expect(bcrypt.compare).toHaveBeenCalledTimes(8);
    await server.close();
  });

  it("accepts TOTP only through a method-bound local challenge", async () => {
    mocks.queryRaw.mockResolvedValue([{ userId: "user-1", purpose: "LOGIN", method: "TOTP" }]);
    mocks.findUnique.mockResolvedValue({
      id: "user-1", name: "Mitchell", email: "mitchell.kobran@continuixai.com", employeeNumber: "EMP-1",
      role: "ADMIN", tokenVersion: 3, isActive: true, accountStatus: "ACTIVE", mfaSecretEncrypted: "encrypted-totp",
    });
    mocks.completeLocalChallenge.mockResolvedValue({ approved: true });
    const server = await app();
    const response = await server.inject({ method: "POST", url: "/api/auth/mfa/check", headers: { cookie: "continuixai_mfa_challenge=totp-challenge" }, payload: { code: "123456" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty("token");
    expect(mocks.completeLocalChallenge).toHaveBeenCalledWith(expect.objectContaining({
      challengeId: "totp-challenge", userId: "user-1", purpose: "LOGIN", method: "TOTP",
    }), expect.any(Function));
    await server.close();
  });

  it("starts optional TOTP enrollment with both a QR code and manual key", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "user-1",
      email: "mitchell.kobran@continuixai.com",
      employeeNumber: "EMP-1",
      tokenVersion: 3,
      isActive: true,
      accountStatus: "ACTIVE",
      phoneVerifiedAt: new Date(),
      mfaEnabled: false,
      mfaSecretEncrypted: null,
    });
    mocks.update.mockResolvedValue({ id: "user-1" });
    const server = await app();

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/mfa/totp/enroll",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      account: "EMP-1",
      manualKey: expect.stringMatching(/^[A-Z2-7]{32}$/),
      qrDataUrl: expect.stringMatching(/^data:image\/png;base64,/),
    });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "user-1" },
      data: expect.objectContaining({ mfaEnabled: false }),
    }));
    expect(response.json()).not.toHaveProperty("token");
    await server.close();
  });

  it("requires recent MFA for both stages of optional TOTP enrollment", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "user-1",
      email: "mitchell.kobran@continuixai.com",
      employeeNumber: "EMP-1",
      tokenVersion: 3,
      isActive: true,
      accountStatus: "ACTIVE",
      phoneVerifiedAt: new Date(),
      mfaEnabled: false,
      mfaSecretEncrypted: encryptSecret("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"),
    });
    const server = await app({
      sub: "user-1", role: "ADMIN", tv: 3,
      iat: Math.floor(Date.now() / 1_000) - 601,
      amr: "SMS",
    });

    const start = await server.inject({ method: "POST", url: "/api/auth/mfa/totp/enroll" });
    const confirm = await server.inject({
      method: "POST", url: "/api/auth/mfa/totp/enroll", payload: { code: "123456" },
    });

    expect(start.statusCode).toBe(403);
    expect(confirm.statusCode).toBe(403);
    expect(start.json()).toEqual({ error: "Sign in again before adding an authenticator." });
    expect(confirm.json()).toEqual({ error: "Sign in again before adding an authenticator." });
    expect(mocks.update).not.toHaveBeenCalled();
    await server.close();
  });

  it("activates a staged TOTP factor only after a valid generated code", async () => {
    const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    mocks.findUnique.mockResolvedValue({
      id: "user-1",
      email: "mitchell.kobran@continuixai.com",
      employeeNumber: "EMP-1",
      tokenVersion: 3,
      isActive: true,
      accountStatus: "ACTIVE",
      phoneVerifiedAt: new Date(),
      mfaEnabled: false,
      mfaSecretEncrypted: encryptSecret(secret),
    });
    mocks.update.mockResolvedValue({ id: "user-1", mfaEnabled: true });
    const server = await app();

    const rejected = await server.inject({
      method: "POST",
      url: "/api/auth/mfa/totp/enroll",
      payload: { code: "000000" },
    });
    expect(rejected.statusCode).toBe(401);
    expect(mocks.update).not.toHaveBeenCalled();

    const approved = await server.inject({
      method: "POST",
      url: "/api/auth/mfa/totp/enroll",
      payload: { code: currentTotp(secret) },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toEqual({ enrolled: true });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { mfaEnabled: true },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({ data: {
      eventType: "totp_enrolled",
      outcome: "succeeded",
      method: "TOTP",
      actorUserId: "user-1",
      targetUserId: "user-1",
      safeReasonCode: "generated_code_approved",
      correlationId: expect.any(String),
    } });
    await server.close();
  });

  it("does not offer a staged unconfirmed TOTP secret as a login factor", async () => {
    mocks.queryRaw.mockResolvedValue([{ userId: "user-1", purpose: "LOGIN", method: "SMS" }]);
    mocks.findUnique.mockResolvedValue({
      id: "user-1",
      isActive: true,
      accountStatus: "ACTIVE",
      tokenVersion: 3,
      mfaEnabled: false,
      mfaSecretEncrypted: "staged-secret",
    });
    const server = await app();

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/mfa/method",
      headers: { cookie: "continuixai_mfa_challenge=sms-challenge" },
      payload: { method: "TOTP" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "That backup method is not available." });
    expect(mocks.switchChallengeMethod).not.toHaveBeenCalled();
    await server.close();
  });

  function removableTotpUser() {
    return {
      id: "user-1",
      email: "mitchell.kobran@continuixai.com",
      accountStatus: "ACTIVE",
      isActive: true,
      mfaEnabled: true,
      mfaSecretEncrypted: "encrypted-totp",
      phoneEncrypted: "encrypted-phone",
      phoneEncryptionKeyVersion: 1,
      phoneLookupHash: "phone-hash",
      phoneVersion: 2,
      phoneLast4: "3355",
      phoneVerifiedAt: new Date(),
    };
  }

  async function confirmRemoval(server: Awaited<ReturnType<typeof app>>) {
    return server.inject({
      method: "POST",
      url: "/api/auth/mfa/totp/remove",
      headers: { cookie: "continuixai_mfa_challenge=removal-1" },
      payload: { code: "123456" },
    });
  }

  it("refuses to start removal when security notifications are not configured", async () => {
    delete process.env.TWILIO_NOTIFICATION_API_KEY_SID;
    const server = await app();

    const response = await server.inject({ method: "POST", url: "/api/auth/mfa/totp/remove" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "Security notifications are temporarily unavailable. Factor removal was not started.",
    });
    expect(mocks.startTotpRemoval).not.toHaveBeenCalled();
    await server.close();
  });

  it("starts an SMS factor-removal challenge without changing the factor", async () => {
    mocks.findUnique.mockResolvedValue(removableTotpUser());
    mocks.startTotpRemoval.mockResolvedValue({ id: "removal-1", expiresAt: new Date(Date.now() + 600_000) });
    const server = await app();

    const response = await server.inject({ method: "POST", url: "/api/auth/mfa/totp/remove" });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      status: "verification_pending",
      method: "SMS",
      maskedDestination: "(***) ***-3355",
    });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.startTotpRemoval).toHaveBeenCalledWith(expect.objectContaining({ id: "user-1" }), expect.arrayContaining([
      `account:${createHmac("sha256", "rate-secret").update("mitchell.kobran@continuixai.com").digest("hex")}`,
    ]));
    expect(String(response.headers["set-cookie"])).toContain("continuixai_mfa_challenge=removal-1");
    await server.close();
  });

  it("returns the shared generic 429 for a denied factor-removal SMS budget", async () => {
    mocks.findUnique.mockResolvedValue(removableTotpUser());
    mocks.startTotpRemoval.mockRejectedValue(new VerificationLockedError(30, "Too many verification requests. Please try again later."));
    const server = await app();

    const response = await server.inject({ method: "POST", url: "/api/auth/mfa/totp/remove" });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("30");
    expect(response.json()).toEqual({ error: "Too many verification requests. Please try again later." });
    await server.close();
  });

  it("confirms removal without returning a replacement session", async () => {
    mocks.queryRaw.mockResolvedValue([{ userId: "user-1", purpose: "FACTOR_REMOVAL", method: "SMS" }]);
    mocks.findUnique.mockResolvedValue(removableTotpUser());
    mocks.confirmTotpRemoval.mockResolvedValue({ removed: true, notification: "accepted" });
    const server = await app();

    const response = await confirmRemoval(server);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ removed: true, notification: "accepted" });
    expect(response.json()).not.toHaveProperty("token");
    expect(mocks.confirmTotpRemoval).toHaveBeenCalledWith(expect.objectContaining({ id: "user-1" }), "removal-1", "123456");
    expect(String(response.headers["set-cookie"])).toContain("continuixai_mfa_challenge=;");
    expect(String(response.headers["set-cookie"])).toContain("continuixai_media=;");
    await server.close();
  });

  it("reports a committed removal when the notification request fails", async () => {
    mocks.queryRaw.mockResolvedValue([{ userId: "user-1", purpose: "FACTOR_REMOVAL", method: "SMS" }]);
    mocks.findUnique.mockResolvedValue(removableTotpUser());
    mocks.confirmTotpRemoval.mockResolvedValue({ removed: true, notification: "failed" });
    const server = await app();

    const response = await confirmRemoval(server);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      removed: true,
      notification: "failed",
      warning: "Authenticator removed, but the security text could not be sent.",
    });
    await server.close();
  });

  it("reports a Verify outage separately from an invalid code", async () => {
    mocks.queryRaw.mockResolvedValue([{ userId: "user-1", purpose: "FACTOR_REMOVAL", method: "SMS" }]);
    mocks.findUnique.mockResolvedValue(removableTotpUser());
    mocks.confirmTotpRemoval.mockRejectedValue(new VerificationProviderError());
    const server = await app();

    const response = await confirmRemoval(server);

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Verification is temporarily unavailable. Please try again." });
    expect(response.json()).not.toHaveProperty("phone");
    expect(response.json()).not.toHaveProperty("code");
    expect(String(response.headers["set-cookie"])).not.toContain("continuixai_mfa_challenge=;");
    expect(String(response.headers["set-cookie"])).not.toContain("continuixai_media=;");
    await server.close();
  });

  it.each([
    { notification: "accepted" as const, expected: { removed: true, notification: "accepted" } },
    {
      notification: "failed" as const,
      expected: {
        removed: true,
        notification: "failed",
        warning: "Authenticator removed, but the security text could not be sent.",
      },
    },
  ])("returns the committed $notification result when notification-audit persistence fails", async ({ notification, expected }) => {
    mocks.queryRaw.mockResolvedValue([{ userId: "user-1", purpose: "FACTOR_REMOVAL", method: "SMS" }]);
    mocks.findUnique.mockResolvedValue(removableTotpUser());
    mocks.confirmTotpRemoval.mockRejectedValue(new FactorRemovalCommittedResultError({ removed: true, notification }));
    const server = await app();

    const response = await confirmRemoval(server);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expected);
    expect(String(response.headers["set-cookie"])).toContain("continuixai_mfa_challenge=;");
    expect(String(response.headers["set-cookie"])).toContain("continuixai_media=;");
    await server.close();
  });

  it("rejects a missing or invalid factor-removal challenge cookie", async () => {
    const server = await app();
    const missing = await server.inject({
      method: "POST",
      url: "/api/auth/mfa/totp/remove",
      payload: { code: "123456" },
    });
    mocks.queryRaw.mockResolvedValue([]);
    const invalid = await confirmRemoval(server);

    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({ error: "That verification code is not correct or has expired." });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toEqual({ error: "That verification code is not correct or has expired." });
    expect(mocks.confirmTotpRemoval).not.toHaveBeenCalled();
    await server.close();
  });

  it("requires the confirmation challenge before checking notification configuration", async () => {
    delete process.env.TWILIO_NOTIFICATION_API_KEY_SID;
    const server = await app();

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/mfa/totp/remove",
      payload: { code: "123456" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "That verification code is not correct or has expired." });
    expect(mocks.confirmTotpRemoval).not.toHaveBeenCalled();
    await server.close();
  });

  it("rejects a TOTP factor-removal challenge", async () => {
    mocks.queryRaw.mockResolvedValue([{ userId: "user-1", purpose: "FACTOR_REMOVAL", method: "TOTP" }]);
    const server = await app();

    const response = await confirmRemoval(server);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "That verification code is not correct or has expired." });
    expect(mocks.confirmTotpRemoval).not.toHaveBeenCalled();
    await server.close();
  });

  it("rejects a login-purpose SMS challenge for factor removal", async () => {
    mocks.queryRaw.mockResolvedValue([{ userId: "user-1", purpose: "LOGIN", method: "SMS" }]);
    const server = await app();

    const response = await confirmRemoval(server);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "That verification code is not correct or has expired." });
    expect(mocks.confirmTotpRemoval).not.toHaveBeenCalled();
    await server.close();
  });

  it("maps malformed and rejected verification codes to the same generic response", async () => {
    mocks.queryRaw.mockResolvedValue([{ userId: "user-1", purpose: "FACTOR_REMOVAL", method: "SMS" }]);
    mocks.findUnique.mockResolvedValue(removableTotpUser());
    mocks.confirmTotpRemoval.mockRejectedValue(new FactorRemovalVerificationRejectedError());
    const server = await app();

    const malformed = await server.inject({
      method: "POST",
      url: "/api/auth/mfa/totp/remove",
      headers: { cookie: "continuixai_mfa_challenge=removal-1" },
      payload: { code: "12345" },
    });
    const rejected = await confirmRemoval(server);

    expect(malformed.statusCode).toBe(401);
    expect(malformed.json()).toEqual({ error: "That verification code is not correct or has expired." });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toEqual({ error: "That verification code is not correct or has expired." });
    await server.close();
  });

  it("returns the factor-removal lockout with a 15-minute Retry-After", async () => {
    mocks.queryRaw.mockResolvedValue([{ userId: "user-1", purpose: "FACTOR_REMOVAL", method: "SMS" }]);
    mocks.findUnique.mockResolvedValue(removableTotpUser());
    mocks.confirmTotpRemoval.mockRejectedValue(new VerificationLockedError());
    const server = await app();

    const response = await confirmRemoval(server);

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("900");
    await server.close();
  });
});
