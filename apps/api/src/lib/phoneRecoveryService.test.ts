import { describe, expect, it, vi } from "vitest";
import { InMemoryPhoneRecoveryRepository } from "./phoneRecoveryRepository.js";
import { PhoneRecoveryService, PhoneRecoveryUnavailableError } from "./phoneRecoveryService.js";
import { PhoneRecoveryLockedError } from "./phoneRecoveryService.js";
import { VerificationLockedError, VerificationRejectedError } from "./verificationPolicy.js";

const users = [
  { id: "admin-1", role: "ADMIN" as const, isActive: true, accountStatus: "ACTIVE" as const, email: "admin@example.com", employeeNumber: "ADM-1", tokenVersion: 4, phoneVersion: 2, phoneVerifiedAt: new Date() },
  {
    id: "user-1", role: "GENERAL" as const, isActive: true, accountStatus: "ACTIVE" as const,
    email: "employee@example.com", employeeNumber: "EMP-1", tokenVersion: 7, phoneVersion: 3,
    phoneVerifiedAt: new Date(), phoneEncrypted: "encrypted-old-phone", phoneEncryptionKeyVersion: 1,
  },
];

function setup(options: {
  failNotice?: boolean; failCompletionEmail?: boolean; failOldPhoneNotice?: boolean;
  failRecoveryCode?: boolean; attemptAllowed?: boolean; smsLocked?: boolean; smsRejected?: boolean; smsAttemptLocked?: boolean;
} = {}) {
  let currentTime = new Date("2026-09-07T12:00:00.000Z");
  let emailAttemptLocked = false;
  const repository = new InMemoryPhoneRecoveryRepository(users);
  const send = vi.fn(async (message: { kind: string }) => {
    if ((options.failNotice && message.kind === "recovery_requested")
      || (options.failRecoveryCode && message.kind === "recovery_code")
      || (options.failCompletionEmail && message.kind === "recovery_completed")) throw new Error("provider detail");
    return { accepted: true as const };
  });
  const notifyFactorChanged = vi.fn(async () => {
    if (options.failOldPhoneNotice) throw new Error("provider detail");
    return { providerRef: "SM-old-phone-notice" };
  });
  const service = new PhoneRecoveryService(repository, { send }, {
    emailOtpKey: "e".repeat(32),
    now: () => new Date(currentTime),
    randomReference: () => "case-reference-1234567890",
    randomCode: () => "12345678",
    checkAttemptLock: async (input) => ({
      allowed: !((options.smsAttemptLocked && input.action === "PHONE_RECOVERY_SMS")
        || (emailAttemptLocked && input.action === "PHONE_RECOVERY_EMAIL")),
      retryAfterSeconds: (options.smsAttemptLocked && input.action === "PHONE_RECOVERY_SMS")
        || (emailAttemptLocked && input.action === "PHONE_RECOVERY_EMAIL") ? 900 : 0,
    }),
    consumeIncorrectAttempt: async () => ({ allowed: options.attemptAllowed ?? true, retryAfterSeconds: options.attemptAllowed === false ? 900 : 0 }),
    verifyHuman: async () => true,
    reserveSmsBudget: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    protectPhone: () => ({
      destination: "+16317423355", encrypted: "encrypted-new-phone", encryptionKeyVersion: 1,
      primaryHash: "1".repeat(64), primaryKeyVersion: 1, prefixHash: "2".repeat(64),
      aliases: [{ hash: "1".repeat(64), keyVersion: 1 }], phoneLast4: "3355",
    }),
    queueProviderRef: () => "VE-recovery",
    decryptPhone: () => "+16317423355",
    smsPolicy: {
      completeChallenge: async (_input, complete) => {
        if (options.smsLocked) throw new VerificationLockedError(900);
        if (options.smsRejected) throw new VerificationRejectedError();
        return { approved: true, value: await complete(_input.challengeId, new Date("2026-09-07T12:00:05.000Z"), 7) };
      },
    },
    notificationProvider: { notifyFactorChanged },
  });
  return {
    repository, service, send, notifyFactorChanged,
    setNow: (value: string) => { currentTime = new Date(value); },
    setEmailAttemptLocked: (value: boolean) => { emailAttemptLocked = value; },
  };
}

describe("PhoneRecoveryService", () => {
  it("creates a usable case only after the registered-email notice is accepted", async () => {
    const { repository, service, send } = setup();
    const result = await service.initiate({ actorUserId: "admin-1", targetUserId: "user-1" });
    expect(result).toMatchObject({ caseReference: "case-reference-1234567890" });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: "recovery_requested", destination: "employee@example.com" }));
    await expect(repository.findPublicCase({
      email: "employee@example.com", employeeNumber: "EMP-1",
      caseReferenceHash: service.hashCaseReference(result.caseReference), now: new Date("2026-09-07T12:00:01.000Z"),
    })).resolves.toMatchObject({ id: result.caseId, status: "EMAIL_PENDING" });
  });

  it("makes provider failure terminal without leaking provider detail", async () => {
    const { repository, service } = setup({ failNotice: true });
    await expect(service.initiate({ actorUserId: "admin-1", targetUserId: "user-1" })).rejects.toBeInstanceOf(PhoneRecoveryUnavailableError);
    expect(repository.openCasesFor("user-1")).toHaveLength(0);
  });

  it("returns the same public contract for matching and nonmatching identities", async () => {
    const { repository, service } = setup();
    const initiated = await service.initiate({ actorUserId: "admin-1", targetUserId: "user-1" });
    const real = await service.startEmailProof({ email: "employee@example.com", employeeNumber: "EMP-1", caseReference: initiated.caseReference, accountHash: "a".repeat(64) });
    const decoy = await service.startEmailProof({ email: "missing@example.com", employeeNumber: "EMP-9", caseReference: initiated.caseReference, accountHash: "b".repeat(64) });
    expect(real.status).toBe("verification_pending");
    expect(decoy.status).toBe(real.status);
    expect(real.challengeId).toHaveLength(decoy.challengeId.length);
    await expect(repository.readEmailChallenge(decoy.challengeId)).resolves.toMatchObject({
      caseId: null,
      accountRateLimitHash: "b".repeat(64),
    });
    await expect(service.checkEmailCode({ challengeId: decoy.challengeId, code: "00000000" }))
      .rejects.toBeInstanceOf(PhoneRecoveryUnavailableError);
  });

  it("accepts the eight-digit email proof once and creates no session", async () => {
    const { service } = setup();
    const initiated = await service.initiate({ actorUserId: "admin-1", targetUserId: "user-1" });
    const pending = await service.startEmailProof({ email: "employee@example.com", employeeNumber: "EMP-1", caseReference: initiated.caseReference, accountHash: "a".repeat(64) });
    await expect(service.checkEmailCode({ challengeId: pending.challengeId, code: "12345678" })).resolves.toEqual({ status: "email_verified", caseId: initiated.caseId });
    await expect(service.checkEmailCode({ challengeId: pending.challengeId, code: "12345678" })).rejects.toBeInstanceOf(PhoneRecoveryUnavailableError);
  });

  it("keeps provider-failed starts on the same durable public challenge", async () => {
    const { repository, service } = setup({ failRecoveryCode: true });
    const initiated = await service.initiate({ actorUserId: "admin-1", targetUserId: "user-1" });

    const pending = await service.startEmailProof({
      email: "employee@example.com", employeeNumber: "EMP-1",
      caseReference: initiated.caseReference, accountHash: "a".repeat(64),
    });

    await expect(repository.readEmailChallenge(pending.challengeId)).resolves.toMatchObject({
      caseId: initiated.caseId,
      accountRateLimitHash: "a".repeat(64),
    });
    await expect(service.checkEmailCode({ challengeId: pending.challengeId, code: "00000000" }))
      .rejects.toBeInstanceOf(PhoneRecoveryUnavailableError);
  });

  it("replaces a registered-email challenge and makes the old OTP unusable", async () => {
    const { repository, service, send } = setup();
    const initiated = await service.initiate({ actorUserId: "admin-1", targetUserId: "user-1" });
    const original = await service.startEmailProof({
      email: "employee@example.com", employeeNumber: "EMP-1",
      caseReference: initiated.caseReference, accountHash: "a".repeat(64),
    });

    const replacement = await service.resend({ challengeId: original.challengeId, ip: "127.0.0.1" });

    expect(replacement).toMatchObject({ status: "verification_pending", stage: "email" });
    await expect(repository.readEmailChallenge(original.challengeId)).resolves.toBeNull();
    await expect(repository.readEmailChallenge(replacement.challengeId)).resolves.toMatchObject({
      caseId: initiated.caseId,
      accountRateLimitHash: "a".repeat(64),
    });
    await expect(service.checkEmailCode({ challengeId: original.challengeId, code: "12345678" }))
      .rejects.toBeInstanceOf(PhoneRecoveryUnavailableError);
    await expect(service.checkEmailCode({ challengeId: replacement.challengeId, code: "12345678" }))
      .resolves.toEqual({ status: "email_verified", caseId: initiated.caseId });
    expect(send.mock.calls.filter(([message]) => message.kind === "recovery_code")).toHaveLength(2);
  });

  it("replaces a decoy email challenge with the same public contract", async () => {
    const { repository, service, send } = setup();
    const original = await service.startEmailProof({
      email: "missing@example.com", employeeNumber: "EMP-9",
      caseReference: "unknown-reference", accountHash: "b".repeat(64),
    });

    const replacement = await service.resend({ challengeId: original.challengeId, ip: "127.0.0.1" });

    expect(replacement).toMatchObject({ status: "verification_pending", stage: "email" });
    await expect(repository.readEmailChallenge(original.challengeId)).resolves.toBeNull();
    await expect(repository.readEmailChallenge(replacement.challengeId)).resolves.toMatchObject({
      caseId: null,
      accountRateLimitHash: "b".repeat(64),
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not let an email resend clear the durable incorrect-attempt lock", async () => {
    const { repository, service, setEmailAttemptLocked } = setup();
    const initiated = await service.initiate({ actorUserId: "admin-1", targetUserId: "user-1" });
    const original = await service.startEmailProof({
      email: "employee@example.com", employeeNumber: "EMP-1",
      caseReference: initiated.caseReference, accountHash: "a".repeat(64),
    });
    setEmailAttemptLocked(true);

    await expect(service.resend({ challengeId: original.challengeId, ip: "127.0.0.1" }))
      .rejects.toEqual(expect.objectContaining<Partial<PhoneRecoveryLockedError>>({ retryAfterSeconds: 900 }));
    await expect(repository.readEmailChallenge(original.challengeId)).resolves.toMatchObject({
      caseId: initiated.caseId,
    });
  });

  it("applies the fifth-attempt lock to a nonmatching identity decoy", async () => {
    const { service } = setup({ attemptAllowed: false });
    const pending = await service.startEmailProof({
      email: "missing@example.com", employeeNumber: "EMP-9",
      caseReference: "unknown-reference", accountHash: "b".repeat(64),
    });

    await expect(service.checkEmailCode({ challengeId: pending.challengeId, code: "00000000" }))
      .rejects.toMatchObject({ retryAfterSeconds: 900 });
  });

  it("resumes each live recovery stage from its browser-bound challenge", async () => {
    const { service } = setup();
    const initiated = await service.initiate({ actorUserId: "admin-1", targetUserId: "user-1" });
    const email = await service.startEmailProof({
      email: "employee@example.com", employeeNumber: "EMP-1",
      caseReference: initiated.caseReference, accountHash: "a".repeat(64),
    });
    await expect(service.resume({ challengeId: email.challengeId })).resolves.toEqual({ stage: "email" });

    await service.checkEmailCode({ challengeId: email.challengeId, code: "12345678" });
    await expect(service.resume({ challengeId: email.challengeId })).resolves.toEqual({ stage: "phone" });

    const phone = await service.startPhoneProof({
      emailChallengeId: email.challengeId, phone: "+1 631 742 3355", smsConsent: true,
      consentVersion: "2026-09-01", turnstileToken: "human", ip: "127.0.0.1",
    });
    await expect(service.resume({ challengeId: phone.challengeId })).resolves.toEqual({
      stage: "sms",
      maskedDestination: "(***) ***-3355",
    });
  });

  it("resumes a live decoy without revealing that the recovery identity did not match", async () => {
    const { service } = setup();
    const decoy = await service.startEmailProof({
      email: "missing@example.com", employeeNumber: "EMP-9",
      caseReference: "unknown-reference", accountHash: "b".repeat(64),
    });

    await expect(service.resume({ challengeId: decoy.challengeId })).resolves.toEqual({ stage: "email" });
    await expect(service.resume({ challengeId: "unknown" })).rejects.toBeInstanceOf(PhoneRecoveryUnavailableError);
  });

  it("turns the fifth wrong email proof into a durable lock", async () => {
    const { service } = setup({ attemptAllowed: false });
    const initiated = await service.initiate({ actorUserId: "admin-1", targetUserId: "user-1" });
    const pending = await service.startEmailProof({ email: "employee@example.com", employeeNumber: "EMP-1", caseReference: initiated.caseReference, accountHash: "a".repeat(64) });
    await expect(service.checkEmailCode({ challengeId: pending.challengeId, code: "00000000" })).rejects.toMatchObject({ retryAfterSeconds: 900 });
  });

  it("requires browser-bound email approval before reserving the replacement phone", async () => {
    const { service } = setup();
    await expect(service.startPhoneProof({
      emailChallengeId: "unknown", phone: "+1 631 742 3355", smsConsent: true,
      consentVersion: "2026-09-01", turnstileToken: "human", ip: "127.0.0.1",
    })).rejects.toBeInstanceOf(PhoneRecoveryUnavailableError);
  });

  it("caps the replacement-phone challenge at the recovery-case deadline", async () => {
    const { repository, service, setNow } = setup();
    const initiated = await service.initiate({ actorUserId: "admin-1", targetUserId: "user-1" });
    setNow("2026-09-08T11:55:00.000Z");
    const email = await service.startEmailProof({ email: "employee@example.com", employeeNumber: "EMP-1", caseReference: initiated.caseReference, accountHash: "a".repeat(64) });
    await service.checkEmailCode({ challengeId: email.challengeId, code: "12345678" });
    const phone = await service.startPhoneProof({
      emailChallengeId: email.challengeId, phone: "+1 631 742 3355", smsConsent: true,
      consentVersion: "2026-09-01", turnstileToken: "human", ip: "127.0.0.1",
    });
    await expect(repository.readPhoneChallenge(phone.challengeId)).resolves.toMatchObject({
      expiresAt: new Date("2026-09-08T12:00:00.000Z"),
    });
  });

  it("verifies the replacement phone and revokes both phone and session versions atomically", async () => {
    const { repository, service, send, notifyFactorChanged } = setup();
    const initiated = await service.initiate({ actorUserId: "admin-1", targetUserId: "user-1" });
    const email = await service.startEmailProof({ email: "employee@example.com", employeeNumber: "EMP-1", caseReference: initiated.caseReference, accountHash: "a".repeat(64) });
    await service.checkEmailCode({ challengeId: email.challengeId, code: "12345678" });
    const phone = await service.startPhoneProof({
      emailChallengeId: email.challengeId, phone: "+1 631 742 3355", smsConsent: true,
      consentVersion: "2026-09-01", turnstileToken: "human", ip: "127.0.0.1",
    });
    await expect(service.checkPhoneCodeAndComplete({ smsChallengeId: phone.challengeId, code: "123456" }))
      .resolves.toEqual({ status: "recovery_complete", notificationWarning: false });
    expect(repository.user("user-1")).toMatchObject({ tokenVersion: 8, phoneVersion: 4, phoneLookupHash: "1".repeat(64) });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: "recovery_completed", destination: "employee@example.com" }));
    expect(notifyFactorChanged).toHaveBeenCalledWith(expect.objectContaining({
      event: "PHONE_RECOVERED", destination: "+16317423355", correlationId: initiated.caseId,
    }));
    expect(repository.audits()).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "phone_recovery_email_notification", correlationId: initiated.caseId }),
      expect.objectContaining({ eventType: "phone_recovery_sms_notification", correlationId: initiated.caseId }),
    ]));
  });

  it("keeps the committed replacement and reports a warning when post-commit notices fail", async () => {
    const { repository, service } = setup({ failCompletionEmail: true, failOldPhoneNotice: true });
    const initiated = await service.initiate({ actorUserId: "admin-1", targetUserId: "user-1" });
    const email = await service.startEmailProof({ email: "employee@example.com", employeeNumber: "EMP-1", caseReference: initiated.caseReference, accountHash: "a".repeat(64) });
    await service.checkEmailCode({ challengeId: email.challengeId, code: "12345678" });
    const phone = await service.startPhoneProof({
      emailChallengeId: email.challengeId, phone: "+1 631 742 3355", smsConsent: true,
      consentVersion: "2026-09-01", turnstileToken: "human", ip: "127.0.0.1",
    });
    await expect(service.checkPhoneCodeAndComplete({ smsChallengeId: phone.challengeId, code: "123456" }))
      .resolves.toEqual({ status: "recovery_complete", notificationWarning: true });
    expect(repository.user("user-1")).toMatchObject({ tokenVersion: 8, phoneVersion: 4 });
  });

  it("preserves the durable SMS lockout as a public recovery lock", async () => {
    const { repository, service } = setup({ smsLocked: true });
    const initiated = await service.initiate({ actorUserId: "admin-1", targetUserId: "user-1" });
    const email = await service.startEmailProof({ email: "employee@example.com", employeeNumber: "EMP-1", caseReference: initiated.caseReference, accountHash: "a".repeat(64) });
    await service.checkEmailCode({ challengeId: email.challengeId, code: "12345678" });
    const phone = await service.startPhoneProof({
      emailChallengeId: email.challengeId, phone: "+1 631 742 3355", smsConsent: true,
      consentVersion: "2026-09-01", turnstileToken: "human", ip: "127.0.0.1",
    });
    await expect(service.checkPhoneCodeAndComplete({ smsChallengeId: phone.challengeId, code: "000000" }))
      .rejects.toEqual(expect.objectContaining<Partial<PhoneRecoveryLockedError>>({ retryAfterSeconds: 900 }));
    expect(repository.audits()).toContainEqual(expect.objectContaining({
      eventType: "phone_recovery_sms_locked", outcome: "locked", safeReasonCode: "attempt_limit",
    }));
  });

  it("audits rejected email and SMS proofs without sensitive values", async () => {
    const emailSetup = setup();
    const initiated = await emailSetup.service.initiate({ actorUserId: "admin-1", targetUserId: "user-1" });
    const email = await emailSetup.service.startEmailProof({
      email: "employee@example.com", employeeNumber: "EMP-1",
      caseReference: initiated.caseReference, accountHash: "a".repeat(64),
    });
    await expect(emailSetup.service.checkEmailCode({ challengeId: email.challengeId, code: "00000000" }))
      .rejects.toBeInstanceOf(PhoneRecoveryUnavailableError);
    expect(emailSetup.repository.audits()).toContainEqual(expect.objectContaining({
      eventType: "phone_recovery_email_denied", outcome: "denied", safeReasonCode: "invalid_code",
    }));

    const smsSetup = setup({ smsRejected: true });
    const smsInitiated = await smsSetup.service.initiate({ actorUserId: "admin-1", targetUserId: "user-1" });
    const approvedEmail = await smsSetup.service.startEmailProof({
      email: "employee@example.com", employeeNumber: "EMP-1",
      caseReference: smsInitiated.caseReference, accountHash: "a".repeat(64),
    });
    await smsSetup.service.checkEmailCode({ challengeId: approvedEmail.challengeId, code: "12345678" });
    const phone = await smsSetup.service.startPhoneProof({
      emailChallengeId: approvedEmail.challengeId, phone: "+1 631 742 3355", smsConsent: true,
      consentVersion: "2026-09-01", turnstileToken: "human", ip: "127.0.0.1",
    });
    await expect(smsSetup.service.checkPhoneCodeAndComplete({ smsChallengeId: phone.challengeId, code: "000000" }))
      .rejects.toBeInstanceOf(PhoneRecoveryUnavailableError);
    const audits = smsSetup.repository.audits();
    expect(audits).toContainEqual(expect.objectContaining({
      eventType: "phone_recovery_sms_denied", outcome: "denied", safeReasonCode: "invalid_code",
    }));
    expect(JSON.stringify(audits)).not.toMatch(/employee@example|6317423355|000000|12345678/);
  });

  it("replaces the browser-bound SMS challenge without reviving the old code", async () => {
    const { repository, service } = setup();
    const initiated = await service.initiate({ actorUserId: "admin-1", targetUserId: "user-1" });
    const email = await service.startEmailProof({
      email: "employee@example.com", employeeNumber: "EMP-1",
      caseReference: initiated.caseReference, accountHash: "a".repeat(64),
    });
    await service.checkEmailCode({ challengeId: email.challengeId, code: "12345678" });
    const original = await service.startPhoneProof({
      emailChallengeId: email.challengeId, phone: "+1 631 742 3355", smsConsent: true,
      consentVersion: "2026-09-01", turnstileToken: "human", ip: "127.0.0.1",
    });

    const replacement = await service.resendPhoneProof({
      smsChallengeId: original.challengeId,
      ip: "127.0.0.1",
    });

    await expect(repository.readPhoneChallenge(original.challengeId)).resolves.toBeNull();
    await expect(repository.readPhoneChallenge(replacement.challengeId)).resolves.toMatchObject({
      caseId: initiated.caseId,
      phoneLast4: "3355",
    });
    await expect(service.checkPhoneCodeAndComplete({ smsChallengeId: original.challengeId, code: "123456" }))
      .rejects.toBeInstanceOf(PhoneRecoveryUnavailableError);
  });

  it("does not let an SMS resend clear the durable incorrect-attempt lock", async () => {
    const { repository, service } = setup({ smsAttemptLocked: true });
    const initiated = await service.initiate({ actorUserId: "admin-1", targetUserId: "user-1" });
    const email = await service.startEmailProof({
      email: "employee@example.com", employeeNumber: "EMP-1",
      caseReference: initiated.caseReference, accountHash: "a".repeat(64),
    });
    await service.checkEmailCode({ challengeId: email.challengeId, code: "12345678" });
    const original = await service.startPhoneProof({
      emailChallengeId: email.challengeId, phone: "+1 631 742 3355", smsConsent: true,
      consentVersion: "2026-09-01", turnstileToken: "human", ip: "127.0.0.1",
    });

    await expect(service.resendPhoneProof({ smsChallengeId: original.challengeId, ip: "127.0.0.1" }))
      .rejects.toEqual(expect.objectContaining<Partial<PhoneRecoveryLockedError>>({ retryAfterSeconds: 900 }));
    await expect(repository.readPhoneChallenge(original.challengeId)).resolves.toMatchObject({
      caseId: initiated.caseId,
    });
  });
});
