import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  update: vi.fn(),
  auditCreate: vi.fn(),
  hash: vi.fn(async () => "new-password-hash"),
  verifyTotp: vi.fn(() => true),
  consumeBackupCode: vi.fn(async () => ({ valid: true, remaining: ["remaining-hash"] })),
  invalidateTokenVersionCache: vi.fn(),
}));

vi.mock("bcryptjs", () => ({ default: { hash: mocks.hash } }));
vi.mock("./prisma.js", () => ({
  prisma: {
    $transaction: mocks.transaction,
    $queryRaw: mocks.queryRaw,
  },
}));
vi.mock("./mfa.js", () => ({
  consumeBackupCode: mocks.consumeBackupCode,
  decryptSecret: vi.fn(() => "totp-secret"),
  verifyTotp: mocks.verifyTotp,
}));
vi.mock("./phone.js", () => ({ decryptPhone: vi.fn(() => "+16317423355") }));
vi.mock("./tokenVersion.js", () => ({ invalidateTokenVersionCache: mocks.invalidateTokenVersionCache }));

import {
  PasswordRecoveryRejectedError,
  PasswordRecoveryService,
  PrismaPasswordRecoveryRepository,
  type PasswordRecoveryChallengePolicy,
  type PasswordRecoveryRepository,
} from "./passwordRecoveryService.js";
import { VerificationProviderError } from "./verificationProvider.js";
import { VerificationLockedError, VerificationRejectedError } from "./verificationPolicy.js";
import { VerificationRateLimitUnavailableError, type VerificationBudgetInput } from "./verificationRateLimit.js";

const activeUser = {
  id: "user-1",
  email: "known@company.test",
  accountStatus: "ACTIVE" as const,
  isActive: true,
  tokenVersion: 3,
  phoneEncrypted: "encrypted-phone",
  phoneEncryptionKeyVersion: 1,
  phoneLookupHash: "phone-hash",
  phoneVersion: 2,
  phoneVerifiedAt: new Date("2026-09-02T12:00:00Z"),
  mfaEnabled: true,
  mfaSecretEncrypted: "encrypted-totp",
  mfaBackupCodeHashes: ["backup-hash"],
};

function dependencies(consumeBudget: (input: VerificationBudgetInput) => Promise<{ allowed: boolean; retryAfterSeconds: number }> = async () => ({ allowed: true, retryAfterSeconds: 0 })) {
  const repository: PasswordRecoveryRepository = {
    findByEmail: vi.fn(async () => activeUser),
    findChallenge: vi.fn(async () => ({ id: "challenge-1", userId: "user-1", purpose: "PASSWORD_RESET", method: "SMS", user: activeUser })),
    resetPasswordFromChallenge: vi.fn(async () => "approved" as const),
  };
  const policy: PasswordRecoveryChallengePolicy = {
    startChallenge: vi.fn(async () => ({ id: "challenge-1", expiresAt: new Date("2026-09-02T12:10:00Z") })),
    switchChallengeMethod: vi.fn(),
    completeChallenge: vi.fn(async (input, completeAtomically) => ({
      approved: true,
      value: await completeAtomically(input.challengeId, new Date("2026-09-02T12:00:00Z")),
    })),
    completeLocalChallenge: vi.fn(async (input, verifyAndConsume) => ({
      approved: await verifyAndConsume(input.challengeId, new Date("2026-09-02T12:00:00Z")) === "approved",
    })),
  };
  return { repository, policy, service: new PasswordRecoveryService(repository, policy, consumeBudget, () => new Date("2026-09-02T12:00:00Z")) };
}

describe("factor-backed password recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RATE_LIMIT_HMAC_KEY = "rate-secret";
  });

  it("starts only an active user's verified SMS PASSWORD_RESET challenge", async () => {
    const { service, policy } = dependencies();

    await expect(service.beginPasswordRecovery("KNOWN@COMPANY.TEST", { dimensions: ["ip:hash"] }))
      .resolves.toEqual({ challengeId: "challenge-1" });

    expect(policy.startChallenge).toHaveBeenCalledWith({
      userId: "user-1",
      purpose: "PASSWORD_RESET",
      method: "SMS",
      destination: "+16317423355",
      destinationHash: "phone-hash",
      destinationVersion: 2,
      dimensions: ["ip:hash", `account:${createHmac("sha256", "rate-secret").update("known@company.test").digest("hex")}`],
      verificationBudgetReservation: undefined,
    });
  });

  it.each([
    ["missing account", null],
    ["inactive account", { ...activeUser, isActive: false }],
    ["disabled account", { ...activeUser, accountStatus: "DISABLED" as const }],
  ])("does not create a recovery challenge for a %s", async (_label, user) => {
    const { service, repository, policy } = dependencies();
    vi.mocked(repository.findByEmail).mockResolvedValue(user);

    await expect(service.beginPasswordRecovery("missing@company.test", { dimensions: ["ip:hash"] })).resolves.toEqual({});

    expect(policy.startChallenge).not.toHaveBeenCalled();
  });

  it("fails closed when SMS delivery fails", async () => {
    const { service, policy } = dependencies();
    vi.mocked(policy.startChallenge).mockRejectedValue(new VerificationProviderError());

    await expect(service.beginPasswordRecovery("known@company.test", { dimensions: ["ip:hash"] }))
      .rejects.toBeInstanceOf(VerificationProviderError);
  });

  it.each([
    ["known", activeUser],
    ["unknown", null],
  ])("applies the same pre-lookup SMS budget to a %s recovery identifier", async (_label, user) => {
    const consumeBudget = vi.fn(async () => ({ allowed: false, retryAfterSeconds: 30 }));
    const { service, repository, policy } = dependencies(consumeBudget);
    vi.mocked(repository.findByEmail).mockResolvedValue(user);

    await expect(service.beginPasswordRecovery("KNOWN@COMPANY.TEST", { dimensions: [`password-recovery-ip:${"a".repeat(64)}`] }))
      .rejects.toMatchObject({ message: "Too many verification requests. Please try again later.", retryAfter: 30 });

    expect(consumeBudget).toHaveBeenCalledWith({
      action: "PASSWORD_RESET",
      accountHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      ipHash: "a".repeat(64),
      now: new Date("2026-09-02T12:00:00Z"),
    });
    expect(repository.findByEmail).not.toHaveBeenCalled();
    expect(policy.startChallenge).not.toHaveBeenCalled();
  });

  it("fails closed before lookup and delivery when durable recovery limits are unavailable", async () => {
    const { service, repository, policy } = dependencies(async () => { throw new VerificationRateLimitUnavailableError(); });

    await expect(service.beginPasswordRecovery("known@company.test", { dimensions: [`password-recovery-ip:${"a".repeat(64)}`] }))
      .rejects.toBeInstanceOf(VerificationRateLimitUnavailableError);
    expect(repository.findByEmail).not.toHaveBeenCalled();
    expect(policy.startChallenge).not.toHaveBeenCalled();
  });

  it("adds the known destination phone to the canonical recovery budget before delivery", async () => {
    const consumeBudget = vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    const { service, policy } = dependencies(consumeBudget);

    await service.beginPasswordRecovery("KNOWN@COMPANY.TEST", { dimensions: [`password-recovery-ip:${"a".repeat(64)}`] });

    expect(consumeBudget).toHaveBeenCalledTimes(2);
    expect(consumeBudget).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: "PASSWORD_RESET",
      phoneHash: "phone-hash",
    }));
    expect(policy.startChallenge).toHaveBeenCalledTimes(1);
  });

  it("keeps a known destination-only denial enumeration-safe and does not deliver", async () => {
    const consumeBudget = vi.fn()
      .mockResolvedValueOnce({ allowed: true, retryAfterSeconds: 0, reservation: {} })
      .mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 900 });
    const { service, policy } = dependencies(consumeBudget);

    await expect(service.beginPasswordRecovery("known@company.test", { dimensions: [`password-recovery-ip:${"a".repeat(64)}`] }))
      .resolves.toEqual({});

    expect(policy.startChallenge).not.toHaveBeenCalled();
  });

  it("updates the password, consumes an approved SMS challenge, rotates sessions, and audits", async () => {
    const { service, repository, policy } = dependencies();

    await expect(service.completePasswordRecovery("challenge-1", "123456", "AnotherPass1!")).resolves.toBeUndefined();

    expect(policy.completeChallenge).toHaveBeenCalledWith(expect.objectContaining({
      challengeId: "challenge-1",
      userId: "user-1",
      method: "SMS",
      destination: "+16317423355",
      destinationHash: "phone-hash",
      destinationVersion: 2,
      code: "123456",
    }), expect.any(Function));
    expect(repository.resetPasswordFromChallenge).toHaveBeenCalledWith(expect.objectContaining({
      challengeId: "challenge-1",
      userId: "user-1",
      method: "SMS",
      passwordHash: "new-password-hash",
      tokenVersion: 3,
    }));
    expect(mocks.invalidateTokenVersionCache).toHaveBeenCalledWith("user-1");
  });

  it("accepts a method-bound TOTP challenge", async () => {
    const { service, repository, policy } = dependencies();
    vi.mocked(repository.findChallenge).mockResolvedValue({
      id: "challenge-1", userId: "user-1", purpose: "PASSWORD_RESET", method: "TOTP", user: activeUser,
    });

    await expect(service.completePasswordRecovery("challenge-1", "123456", "AnotherPass1!")).resolves.toBeUndefined();

    expect(policy.completeLocalChallenge).toHaveBeenCalledWith(expect.objectContaining({
      purpose: "PASSWORD_RESET", method: "TOTP", destinationVersion: 3,
    }), expect.any(Function));
    expect(mocks.verifyTotp).toHaveBeenCalledWith("totp-secret", "123456");
    expect(repository.resetPasswordFromChallenge).toHaveBeenCalledWith(expect.objectContaining({ method: "TOTP" }));
  });

  it("consumes a recovery code atomically with the password reset", async () => {
    const { service, repository, policy } = dependencies();
    vi.mocked(repository.findChallenge).mockResolvedValue({
      id: "challenge-1", userId: "user-1", purpose: "PASSWORD_RESET", method: "RECOVERY_CODE", user: activeUser,
    });

    await expect(service.completePasswordRecovery("challenge-1", "A1B2C3D4E5", "AnotherPass1!")).resolves.toBeUndefined();

    expect(policy.completeLocalChallenge).toHaveBeenCalledWith(expect.objectContaining({
      purpose: "PASSWORD_RESET", method: "RECOVERY_CODE", destinationVersion: 3,
    }), expect.any(Function));
    expect(repository.resetPasswordFromChallenge).toHaveBeenCalledWith(expect.objectContaining({
      method: "RECOVERY_CODE",
      recoveryCode: "A1B2C3D4E5",
    }));
  });

  it("rejects a replayed or otherwise unconsumable challenge", async () => {
    const { service, repository } = dependencies();
    vi.mocked(repository.resetPasswordFromChallenge).mockResolvedValue("conflict");

    await expect(service.completePasswordRecovery("challenge-1", "123456", "AnotherPass1!"))
      .rejects.toBeInstanceOf(PasswordRecoveryRejectedError);

    expect(mocks.invalidateTokenVersionCache).not.toHaveBeenCalled();
  });

  it("reports a recovery-code consumption race as a challenge conflict instead of a wrong-code attempt", async () => {
    const { service, repository, policy } = dependencies();
    vi.mocked(repository.findChallenge).mockResolvedValue({
      id: "challenge-1", userId: "user-1", purpose: "PASSWORD_RESET", method: "RECOVERY_CODE", user: activeUser,
    });
    vi.mocked(repository.resetPasswordFromChallenge).mockResolvedValue("conflict");
    vi.mocked(policy.completeLocalChallenge).mockImplementation(async (input, verifyAndConsume) => {
      expect(await verifyAndConsume(input.challengeId, new Date("2026-09-02T12:00:00Z"))).toBe("conflict");
      throw new VerificationRejectedError();
    });

    await expect(service.completePasswordRecovery("challenge-1", "A1B2C3D4E5", "AnotherPass1!"))
      .rejects.toBeInstanceOf(PasswordRecoveryRejectedError);
  });

  it("preserves the verification policy's 15-minute lock behavior", async () => {
    const { service, policy } = dependencies();
    vi.mocked(policy.completeChallenge).mockRejectedValue(new VerificationLockedError());

    await expect(service.completePasswordRecovery("challenge-1", "123456", "AnotherPass1!"))
      .rejects.toBeInstanceOf(VerificationLockedError);
  });
});

describe("Prisma password recovery repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (callback) => callback({
      $queryRaw: mocks.queryRaw,
      $executeRaw: mocks.executeRaw,
      user: { update: mocks.update },
      securityAuditEvent: { create: mocks.auditCreate },
    }));
    mocks.queryRaw.mockResolvedValue([{ id: "user-1", accountStatus: "ACTIVE", isActive: true, tokenVersion: 3, mfaBackupCodeHashes: ["backup-hash"] }]);
    mocks.executeRaw.mockResolvedValue(1);
    mocks.update.mockResolvedValue({ id: "user-1" });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("writes the password, token-version increment, consumed challenge, and audit in one transaction", async () => {
    const repository = new PrismaPasswordRecoveryRepository();

    await expect(repository.resetPasswordFromChallenge({
      challengeId: "challenge-1", userId: "user-1", method: "SMS", passwordHash: "password-hash",
      tokenVersion: 3, approvedAt: new Date("2026-09-02T12:00:00Z"), correlationId: "correlation-1",
    })).resolves.toBe("approved");

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "user-1" },
      data: expect.objectContaining({ passwordHash: "password-hash", tokenVersion: { increment: 1 } }),
    }));
    expect(mocks.auditCreate).toHaveBeenCalledWith({ data: {
      eventType: "password_recovered",
      outcome: "succeeded",
      method: "SMS",
      actorUserId: "user-1",
      targetUserId: "user-1",
      safeReasonCode: "factor_approved",
      correlationId: "correlation-1",
    } });
  });

  it("rejects a consumed challenge without changing credentials or writing an audit event", async () => {
    mocks.executeRaw.mockResolvedValue(0);
    const repository = new PrismaPasswordRecoveryRepository();

    await expect(repository.resetPasswordFromChallenge({
      challengeId: "challenge-1", userId: "user-1", method: "SMS", passwordHash: "password-hash",
      tokenVersion: 3, approvedAt: new Date("2026-09-02T12:00:00Z"), correlationId: "correlation-1",
    })).resolves.toBe("conflict");

    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
