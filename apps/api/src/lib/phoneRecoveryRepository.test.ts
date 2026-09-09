import { describe, expect, it } from "vitest";
import { InMemoryPhoneRecoveryRepository, PhoneRecoveryConflictError } from "./phoneRecoveryRepository.js";

const startedAt = new Date("2026-09-06T16:00:00Z");
const expiresAt = new Date("2026-09-07T16:00:00Z");
const users = [
  { id: "admin-1", role: "ADMIN" as const, isActive: true, accountStatus: "ACTIVE" as const, email: "admin@example.com", employeeNumber: "ADM-1", tokenVersion: 4, phoneVersion: 2 },
  { id: "user-1", role: "GENERAL" as const, isActive: true, accountStatus: "ACTIVE" as const, email: "employee@example.com", employeeNumber: "EMP-1", tokenVersion: 7, phoneVersion: 3 },
  { id: "user-2", role: "GENERAL" as const, isActive: true, accountStatus: "ACTIVE" as const, email: "second@example.com", employeeNumber: "EMP-2", tokenVersion: 1, phoneVersion: 1 },
  { id: "legacy-user", role: "GENERAL" as const, isActive: true, accountStatus: "ACTIVE" as const, email: "legacy@example.com", employeeNumber: null, tokenVersion: 2, phoneVersion: 1 },
];

function initiation(targetUserId = "user-1") {
  return {
    id: `case-${targetUserId}`,
    actorUserId: "admin-1",
    targetUserId,
    caseReferenceHash: `${targetUserId}-reference-hash`,
    expiresAt,
    now: startedAt,
  };
}

describe("phone recovery repository state machine", () => {
  it("rejects self-initiation and permits only one open case per user", async () => {
    const repository = new InMemoryPhoneRecoveryRepository(users);
    await expect(repository.createNoticePending({ ...initiation(), targetUserId: "admin-1" }))
      .rejects.toBeInstanceOf(PhoneRecoveryConflictError);

    await expect(repository.createNoticePending(initiation())).resolves.toMatchObject({
      status: "NOTICE_PENDING", tokenVersionAtIssue: 7, phoneVersionAtIssue: 3,
    });
    await expect(repository.createNoticePending({ ...initiation(), id: "case-duplicate" }))
      .rejects.toBeInstanceOf(PhoneRecoveryConflictError);
  });

  it("makes notice failure terminal and prevents email proof", async () => {
    const repository = new InMemoryPhoneRecoveryRepository(users);
    await repository.createNoticePending(initiation());
    await repository.markNoticeFailed("case-user-1", "notice_rejected", new Date(startedAt.getTime() + 1_000));

    await expect(repository.beginEmailProof({
      caseId: "case-user-1", challengeId: "email-1", codeDigest: Buffer.alloc(32), accountRateLimitHash: "a".repeat(64),
      expiresAt: new Date(startedAt.getTime() + 10 * 60_000), now: new Date(startedAt.getTime() + 2_000),
    })).rejects.toBeInstanceOf(PhoneRecoveryConflictError);
  });

  it("binds public email proof to the target token version captured at initiation", async () => {
    const repository = new InMemoryPhoneRecoveryRepository(users);
    await repository.createNoticePending(initiation());
    await repository.markNoticeAccepted("case-user-1", new Date(startedAt.getTime() + 1_000));

    repository.setUserTokenVersionForTest("user-1", 8);

    await expect(repository.findPublicCase({
      email: "employee@example.com",
      employeeNumber: "EMP-1",
      caseReferenceHash: "user-1-reference-hash",
      now: new Date(startedAt.getTime() + 2_000),
    })).resolves.toBeNull();
  });

  it("lets a migrated user without an employee number prove the registered recovery identity", async () => {
    const repository = new InMemoryPhoneRecoveryRepository(users);
    await repository.createNoticePending(initiation("legacy-user"));
    await repository.markNoticeAccepted("case-legacy-user", new Date(startedAt.getTime() + 1_000));

    await expect(repository.findPublicCase({
      email: "legacy@example.com",
      employeeNumber: "",
      caseReferenceHash: "legacy-user-reference-hash",
      now: new Date(startedAt.getTime() + 2_000),
    })).resolves.toMatchObject({ id: "case-legacy-user", targetUserId: "legacy-user" });
  });

  it("persists a purpose-bound decoy email challenge with the public account lock", async () => {
    const repository = new InMemoryPhoneRecoveryRepository(users);
    const accountRateLimitHash = "d".repeat(64);

    await repository.beginEmailDecoy({
      challengeId: "decoy-email-1",
      codeDigest: Buffer.alloc(32, 7),
      accountRateLimitHash,
      expiresAt: new Date(startedAt.getTime() + 10 * 60_000),
      now: startedAt,
    });

    await expect(repository.readEmailChallenge("decoy-email-1")).resolves.toEqual({
      id: "decoy-email-1",
      caseId: null,
      codeDigest: Buffer.alloc(32, 7),
      accountRateLimitHash,
      expiresAt: new Date(startedAt.getTime() + 10 * 60_000),
      caseExpiresAt: null,
    });
  });

  it("enforces legal transitions and provisional phone ownership", async () => {
    const repository = new InMemoryPhoneRecoveryRepository(users);
    await repository.createNoticePending(initiation());
    await repository.createNoticePending(initiation("user-2"));
    await expect(repository.markNoticeAccepted("case-user-1", new Date(startedAt.getTime() + 1_000))).resolves.toBe(true);
    await expect(repository.markNoticeAccepted("case-user-2", new Date(startedAt.getTime() + 1_000))).resolves.toBe(true);
    await repository.beginEmailProof({
      caseId: "case-user-1", challengeId: "email-1", codeDigest: Buffer.alloc(32, 1), accountRateLimitHash: "a".repeat(64),
      expiresAt: new Date(startedAt.getTime() + 10 * 60_000), now: new Date(startedAt.getTime() + 2_000),
    });
    await repository.beginEmailProof({
      caseId: "case-user-2", challengeId: "email-2", codeDigest: Buffer.alloc(32, 2), accountRateLimitHash: "b".repeat(64),
      expiresAt: new Date(startedAt.getTime() + 10 * 60_000), now: new Date(startedAt.getTime() + 2_000),
    });
    await expect(repository.recordEmailApproval({ caseId: "case-user-1", challengeId: "email-1", approvedAt: new Date(startedAt.getTime() + 3_000) })).resolves.toBe(true);
    await expect(repository.recordEmailApproval({ caseId: "case-user-2", challengeId: "email-2", approvedAt: new Date(startedAt.getTime() + 3_000) })).resolves.toBe(true);

    const phone = {
      phoneEncrypted: "encrypted-new-phone", phoneEncryptionKeyVersion: 2,
      phoneLookupHash: "primary-phone-hash", phonePrefixHash: "phone-prefix-hash",
      accountRateLimitHash: "a".repeat(64), phoneLookupKeyVersion: 2, phoneLast4: "4455",
      consentAt: new Date(startedAt.getTime() + 4_000), consentVersion: "2026-09-01",
      aliases: [{ hash: "primary-phone-hash", keyVersion: 2 }, { hash: "old-key-phone-hash", keyVersion: 1 }],
    };
    await expect(repository.reservePhone({
      caseId: "case-user-1", challengeId: "sms-1", providerRef: "VE1", ...phone,
      expiresAt: new Date(startedAt.getTime() + 10 * 60_000), now: new Date(startedAt.getTime() + 4_000),
    })).resolves.toMatchObject({ status: "PHONE_PENDING" });
    await expect(repository.reservePhone({
      caseId: "case-user-2", challengeId: "sms-2", providerRef: "VE2", ...phone,
      expiresAt: new Date(startedAt.getTime() + 10 * 60_000), now: new Date(startedAt.getTime() + 4_000),
    })).rejects.toBeInstanceOf(PhoneRecoveryConflictError);
  });

  it("allows exactly one atomic completion and records version revocation plus audit", async () => {
    const repository = new InMemoryPhoneRecoveryRepository(users);
    await repository.createNoticePending(initiation());
    await repository.markNoticeAccepted("case-user-1", new Date(startedAt.getTime() + 1_000));
    await repository.beginEmailProof({
      caseId: "case-user-1", challengeId: "email-1", codeDigest: Buffer.alloc(32), accountRateLimitHash: "a".repeat(64),
      expiresAt: new Date(startedAt.getTime() + 10 * 60_000), now: new Date(startedAt.getTime() + 2_000),
    });
    await repository.recordEmailApproval({ caseId: "case-user-1", challengeId: "email-1", approvedAt: new Date(startedAt.getTime() + 3_000) });
    await repository.reservePhone({
      caseId: "case-user-1", challengeId: "sms-1", providerRef: "VE1",
      phoneEncrypted: "encrypted", phoneEncryptionKeyVersion: 2, phoneLookupHash: "new-hash",
      phonePrefixHash: "prefix-hash", accountRateLimitHash: "a".repeat(64),
      phoneLookupKeyVersion: 2, phoneLast4: "4455", consentAt: new Date(startedAt.getTime() + 4_000),
      consentVersion: "2026-09-01", aliases: [{ hash: "new-hash", keyVersion: 2 }],
      expiresAt: new Date(startedAt.getTime() + 10 * 60_000), now: new Date(startedAt.getTime() + 4_000),
    });
    const completedAt = new Date(startedAt.getTime() + 5_000);

    const outcomes = await Promise.allSettled([
      repository.complete({ caseId: "case-user-1", challengeId: "sms-1", completedAt }),
      repository.complete({ caseId: "case-user-1", challengeId: "sms-1", completedAt }),
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(repository.user("user-1")).toMatchObject({ tokenVersion: 8, phoneVersion: 4, phoneLookupHash: "new-hash" });
    expect(repository.audits()).toEqual([expect.objectContaining({ eventType: "phone_recovery_completed", targetUserId: "user-1" })]);
  });

  it("expires cases atomically and releases provisional phone ownership", async () => {
    const repository = new InMemoryPhoneRecoveryRepository(users);
    await repository.createNoticePending(initiation());
    await repository.markNoticeAccepted("case-user-1", new Date(startedAt.getTime() + 1_000));
    await repository.beginEmailProof({
      caseId: "case-user-1", challengeId: "email-1", codeDigest: Buffer.alloc(32), accountRateLimitHash: "a".repeat(64),
      expiresAt: new Date(startedAt.getTime() + 10 * 60_000), now: new Date(startedAt.getTime() + 2_000),
    });
    await repository.recordEmailApproval({ caseId: "case-user-1", challengeId: "email-1", approvedAt: new Date(startedAt.getTime() + 3_000) });
    await repository.reservePhone({
      caseId: "case-user-1", challengeId: "sms-1", providerRef: "VE1",
      phoneEncrypted: "encrypted", phoneEncryptionKeyVersion: 2, phoneLookupHash: "new-hash",
      phonePrefixHash: "prefix-hash", accountRateLimitHash: "a".repeat(64),
      phoneLookupKeyVersion: 2, phoneLast4: "4455", consentAt: new Date(startedAt.getTime() + 4_000),
      consentVersion: "2026-09-01", aliases: [{ hash: "new-hash", keyVersion: 2 }],
      expiresAt: new Date(startedAt.getTime() + 10 * 60_000), now: new Date(startedAt.getTime() + 4_000),
    });

    await expect(repository.expireOpenCases(new Date(expiresAt.getTime() + 1))).resolves.toBe(1);
    expect(repository.openCasesFor("user-1")).toEqual([]);
    expect(repository.audits()).toContainEqual(expect.objectContaining({
      eventType: "phone_recovery_expired", targetUserId: "user-1", correlationId: "case-user-1",
    }));

    await repository.createNoticePending({
      ...initiation("user-2"),
      expiresAt: new Date(expiresAt.getTime() + 24 * 60 * 60_000),
      now: new Date(expiresAt.getTime() + 2),
    });
    await repository.markNoticeAccepted("case-user-2", new Date(expiresAt.getTime() + 3));
    await repository.beginEmailProof({
      caseId: "case-user-2", challengeId: "email-2", codeDigest: Buffer.alloc(32), accountRateLimitHash: "b".repeat(64),
      expiresAt: new Date(expiresAt.getTime() + 10 * 60_000), now: new Date(expiresAt.getTime() + 4),
    });
    await repository.recordEmailApproval({ caseId: "case-user-2", challengeId: "email-2", approvedAt: new Date(expiresAt.getTime() + 5) });
    await expect(repository.reservePhone({
      caseId: "case-user-2", challengeId: "sms-2", providerRef: "VE2",
      phoneEncrypted: "encrypted", phoneEncryptionKeyVersion: 2, phoneLookupHash: "new-hash",
      phonePrefixHash: "prefix-hash", accountRateLimitHash: "b".repeat(64),
      phoneLookupKeyVersion: 2, phoneLast4: "4455", consentAt: new Date(expiresAt.getTime() + 6),
      consentVersion: "2026-09-01", aliases: [{ hash: "new-hash", keyVersion: 2 }],
      expiresAt: new Date(expiresAt.getTime() + 10 * 60_000), now: new Date(expiresAt.getTime() + 6),
    })).resolves.toMatchObject({ status: "PHONE_PENDING" });
  });

  it("fully expires an old case before creating its replacement", async () => {
    const repository = new InMemoryPhoneRecoveryRepository(users);
    await repository.createNoticePending(initiation());

    await expect(repository.createNoticePending({
      ...initiation(),
      id: "case-user-1-replacement",
      expiresAt: new Date(expiresAt.getTime() + 24 * 60 * 60_000),
      now: new Date(expiresAt.getTime() + 1),
    })).resolves.toMatchObject({ id: "case-user-1-replacement", status: "NOTICE_PENDING" });

    expect(repository.openCasesFor("user-1")).toEqual([
      expect.objectContaining({ id: "case-user-1-replacement" }),
    ]);
    expect(repository.audits()).toContainEqual(expect.objectContaining({
      eventType: "phone_recovery_expired", correlationId: "case-user-1",
    }));
  });

  it("returns bounded administrator history without recovery secrets", async () => {
    const repository = new InMemoryPhoneRecoveryRepository(users);
    await repository.createNoticePending(initiation());
    await repository.markNoticeAccepted("case-user-1", new Date(startedAt.getTime() + 1_000));
    await repository.recordNotificationOutcome({
      caseId: "case-user-1", userId: "user-1", channel: "EMAIL", outcome: "accepted",
      safeReasonCode: "provider_accepted", at: new Date(startedAt.getTime() + 2_000),
    });

    const result = await repository.getAdminStatus("user-1");

    expect(result.cases).toEqual([expect.objectContaining({
      caseId: "case-user-1", status: "EMAIL_PENDING", startedAt, expiresAt,
    })]);
    expect(result.events).toEqual([expect.objectContaining({
      eventType: "phone_recovery_email_notification", outcome: "accepted", safeReasonCode: "provider_accepted",
    })]);
    expect(JSON.stringify(result)).not.toMatch(/employee@example|reference-hash|encrypted|4455/);
  });
});
