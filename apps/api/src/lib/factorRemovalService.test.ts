import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptPhone } from "./phone.js";
import {
  FactorRemovalService,
  PrismaFactorRemovalRepository,
  type FactorRemovalChallengePolicy,
  type FactorRemovalRepository,
  type FactorRemovalUser,
} from "./factorRemovalService.js";
import type { SecurityNotificationProvider } from "./securityNotificationProvider.js";

const mocks = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  queryRaw: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
  invalidateTokenVersionCache: vi.fn(),
}));

vi.mock("./prisma.js", () => ({
  prisma: { $transaction: mocks.transaction, securityAuditEvent: { create: mocks.auditCreate } },
}));

vi.mock("./tokenVersion.js", () => ({
  invalidateTokenVersionCache: mocks.invalidateTokenVersionCache,
}));

process.env.PHONE_ENCRYPTION_KEYS = `1:${"11".repeat(32)}`;

const phone = "+16317423355";
const protectedPhone = encryptPhone(phone);
const activeUser: FactorRemovalUser = {
  id: "user-1",
  accountStatus: "ACTIVE",
  isActive: true,
  mfaEnabled: true,
  mfaSecretEncrypted: "encrypted-totp-secret",
  phoneEncrypted: protectedPhone.ciphertext,
  phoneEncryptionKeyVersion: protectedPhone.keyVersion,
  phoneLookupHash: "phone-hash",
  phoneVersion: 2,
  phoneVerifiedAt: new Date("2026-09-01T11:00:00Z"),
};

function normalizedSql(call: unknown[]): string {
  return (call[0] as TemplateStringsArray).join("?").replace(/\s+/g, " ").trim();
}

function dependencies() {
  const repository: FactorRemovalRepository = {
    removeTotpFromChallenge: vi.fn(async () => true),
    recordNotificationOutcome: vi.fn(async () => undefined),
  };
  const policy: FactorRemovalChallengePolicy = {
    startChallenge: vi.fn(async () => ({ id: "challenge-1", expiresAt: new Date("2026-09-01T12:10:00Z") })),
    completeChallenge: vi.fn(async (input, completeAtomically) => ({
      approved: true,
      value: await completeAtomically(input.challengeId, new Date("2026-09-01T12:00:00Z")),
    })),
  };
  const notificationProvider: SecurityNotificationProvider = {
    notifyFactorChanged: vi.fn(async () => ({ providerRef: "SM123" })),
  };
  return {
    repository,
    policy,
    notificationProvider,
    service: new FactorRemovalService(repository, policy, notificationProvider),
  };
}

describe("TOTP factor removal", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts only an SMS FACTOR_REMOVAL challenge", async () => {
    const { service, policy } = dependencies();

    await service.startTotpRemoval(activeUser, ["account:a", "ip:b"]);

    expect(policy.startChallenge).toHaveBeenCalledWith({
      userId: "user-1",
      purpose: "FACTOR_REMOVAL",
      method: "SMS",
      destination: phone,
      destinationHash: "phone-hash",
      destinationVersion: 2,
      dimensions: ["account:a", "ip:b"],
    });
  });

  it("removes TOTP before requesting the notification and reports provider acceptance honestly", async () => {
    const { service, repository, notificationProvider } = dependencies();
    const order: string[] = [];
    vi.mocked(repository.removeTotpFromChallenge).mockImplementation(async () => { order.push("commit"); return true; });
    mocks.invalidateTokenVersionCache.mockImplementation(() => { order.push("invalidate"); });
    vi.mocked(notificationProvider.notifyFactorChanged).mockImplementation(async () => { order.push("notify"); return { providerRef: "SM123" }; });
    vi.mocked(repository.recordNotificationOutcome).mockImplementation(async () => { order.push("audit"); });

    await expect(service.confirmTotpRemoval(activeUser, "challenge-1", "123456"))
      .resolves.toEqual({ removed: true, notification: "accepted" });

    expect(order).toEqual(["commit", "invalidate", "notify", "audit"]);
    expect(mocks.invalidateTokenVersionCache).toHaveBeenCalledWith("user-1");
    const removalInput = vi.mocked(repository.removeTotpFromChallenge).mock.calls[0][0];
    expect(notificationProvider.notifyFactorChanged).toHaveBeenCalledWith({
      destination: phone,
      event: "TOTP_REMOVED",
      correlationId: removalInput.correlationId,
    });
    expect(repository.recordNotificationOutcome).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      correlationId: removalInput.correlationId,
      outcome: "accepted",
      safeReasonCode: "provider_accepted",
    }));
    expect(repository.recordNotificationOutcome).not.toHaveBeenCalledWith(expect.objectContaining({ providerRef: expect.anything() }));
  });

  it("keeps the removal committed and records notification failure", async () => {
    const { service, repository, notificationProvider } = dependencies();
    vi.mocked(repository.removeTotpFromChallenge).mockResolvedValue(true);
    vi.mocked(notificationProvider.notifyFactorChanged).mockRejectedValue(new Error("provider unavailable"));

    await expect(service.confirmTotpRemoval(activeUser, "challenge-1", "123456"))
      .resolves.toEqual({ removed: true, notification: "failed" });

    expect(repository.recordNotificationOutcome).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      outcome: "failed",
      safeReasonCode: "provider_request_failed",
    }));
  });

  it.each([
    { notification: "accepted" as const, providerFails: false },
    { notification: "failed" as const, providerFails: true },
  ])("preserves the committed $notification result when notification-audit persistence fails", async ({ notification, providerFails }) => {
    const { service, repository, notificationProvider } = dependencies();
    if (providerFails) vi.mocked(notificationProvider.notifyFactorChanged).mockRejectedValue(new Error("provider unavailable"));
    vi.mocked(repository.recordNotificationOutcome).mockRejectedValue(new Error("audit unavailable"));

    await expect(service.confirmTotpRemoval(activeUser, "challenge-1", "123456"))
      .rejects.toMatchObject({
        name: "FactorRemovalCommittedResultError",
        result: { removed: true, notification },
      });

    expect(repository.removeTotpFromChallenge).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "has no enrolled TOTP factor", user: { ...activeUser, mfaEnabled: false } },
    { label: "has no verified phone", user: { ...activeUser, phoneVerifiedAt: null } },
    { label: "is inactive", user: { ...activeUser, isActive: false } },
    { label: "does not have ACTIVE status", user: { ...activeUser, accountStatus: "DISABLED" } },
  ])("rejects before starting when the user $label", async ({ user }) => {
    const { service, policy } = dependencies();

    await expect(service.startTotpRemoval(user, ["account:a"])).rejects.toThrow();

    expect(policy.startChallenge).not.toHaveBeenCalled();
  });

  it("rejects confirmation before consuming a challenge when required factors are unavailable", async () => {
    const { service, policy } = dependencies();

    await expect(service.confirmTotpRemoval({ ...activeUser, mfaSecretEncrypted: null }, "challenge-1", "123456"))
      .rejects.toThrow();

    expect(policy.completeChallenge).not.toHaveBeenCalled();
  });

  it("does not notify when challenge completion is not approved", async () => {
    const { service, policy, notificationProvider } = dependencies();
    vi.mocked(policy.completeChallenge).mockResolvedValue({ approved: false });

    await expect(service.confirmTotpRemoval(activeUser, "challenge-1", "000000"))
      .rejects.toMatchObject({ name: "FactorRemovalVerificationRejectedError" });

    expect(notificationProvider.notifyFactorChanged).not.toHaveBeenCalled();
    expect(mocks.invalidateTokenVersionCache).not.toHaveBeenCalled();
  });

  it("does not invalidate sessions or notify when atomic removal loses a race", async () => {
    const { service, repository, notificationProvider } = dependencies();
    vi.mocked(repository.removeTotpFromChallenge).mockResolvedValue(false);

    await expect(service.confirmTotpRemoval(activeUser, "challenge-1", "123456"))
      .rejects.toMatchObject({ name: "FactorRemovalVerificationRejectedError" });

    expect(mocks.invalidateTokenVersionCache).not.toHaveBeenCalled();
    expect(notificationProvider.notifyFactorChanged).not.toHaveBeenCalled();
  });
});

describe("Prisma factor-removal repository", () => {
  const approvedAt = new Date("2026-09-01T12:00:00Z");
  const removalInput = {
    challengeId: "challenge-1",
    userId: "user-1",
    approvedAt,
    correlationId: "correlation-1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (callback) => callback({
      $queryRaw: mocks.queryRaw,
      $executeRaw: mocks.executeRaw,
      securityAuditEvent: { create: mocks.auditCreate },
    }));
    mocks.queryRaw.mockResolvedValue([{ id: "user-1", mfaEnabled: true }]);
    mocks.executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("atomically consumes the bound SMS challenge, removes TOTP, rotates sessions, and audits", async () => {
    const repository = new PrismaFactorRemovalRepository();

    await expect(repository.removeTotpFromChallenge(removalInput)).resolves.toBe(true);

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.executeRaw).toHaveBeenCalledTimes(2);
    expect(normalizedSql(mocks.queryRaw.mock.calls[0])).toBe(
      'SELECT "id", "mfaEnabled" FROM "User" WHERE "id" = ? FOR UPDATE',
    );
    expect(mocks.queryRaw.mock.calls[0].slice(1)).toEqual(["user-1"]);
    expect(normalizedSql(mocks.executeRaw.mock.calls[0])).toContain(
      '"purpose" = \'FACTOR_REMOVAL\' AND "method" = \'SMS\'',
    );
    expect(normalizedSql(mocks.executeRaw.mock.calls[0])).toContain(
      '"consumedAt" IS NULL AND "invalidatedAt" IS NULL AND "expiresAt" > ?',
    );
    expect(mocks.executeRaw.mock.calls[0].slice(1)).toEqual([
      approvedAt,
      "challenge-1",
      "user-1",
      approvedAt,
    ]);
    expect(normalizedSql(mocks.executeRaw.mock.calls[1])).toContain(
      '"mfaEnabled" = false, "mfaSecretEncrypted" = NULL, "tokenVersion" = "tokenVersion" + 1',
    );
    expect(normalizedSql(mocks.executeRaw.mock.calls[1])).toContain(
      '"accountStatus" = \'ACTIVE\' AND "isActive" = true AND "mfaEnabled" = true AND "mfaSecretEncrypted" IS NOT NULL',
    );
    expect(mocks.executeRaw.mock.calls[1].slice(1)).toEqual(["user-1"]);
    expect(mocks.auditCreate).toHaveBeenCalledWith({ data: {
      eventType: "totp_removed",
      outcome: "succeeded",
      method: "SMS",
      actorUserId: "user-1",
      targetUserId: "user-1",
      safeReasonCode: "different_factor_approved",
      correlationId: "correlation-1",
    } });
  });

  it.each([
    { label: "challenge is stale", counts: [0, 1] },
    { label: "user factor is already absent", counts: [1, 0] },
  ])("aborts without an audit when the $label", async ({ counts }) => {
    const repository = new PrismaFactorRemovalRepository();
    mocks.executeRaw.mockReset();
    for (const count of counts) mocks.executeRaw.mockResolvedValueOnce(count);

    await expect(repository.removeTotpFromChallenge(removalInput)).rejects.toThrow();

    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("aborts before consuming a challenge when the user lock finds no enrolled factor", async () => {
    const repository = new PrismaFactorRemovalRepository();
    mocks.queryRaw.mockResolvedValue([]);

    await expect(repository.removeTotpFromChallenge(removalInput)).rejects.toThrow();

    expect(mocks.executeRaw).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("records only the approved non-PII notification outcome fields", async () => {
    const repository = new PrismaFactorRemovalRepository();

    await repository.recordNotificationOutcome({
      userId: "user-1",
      correlationId: "correlation-1",
      outcome: "failed",
      safeReasonCode: "provider_request_failed",
    });

    expect(mocks.auditCreate).toHaveBeenCalledWith({ data: {
      eventType: "factor_change_notification",
      outcome: "failed",
      method: "SMS",
      actorUserId: "user-1",
      targetUserId: "user-1",
      safeReasonCode: "provider_request_failed",
      correlationId: "correlation-1",
    } });
  });
});
