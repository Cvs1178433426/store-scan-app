import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { RecoveryEmailProvider } from "./recoveryEmailProvider.js";
import {
  type PhoneRecoveryRepository,
  PhoneRecoveryConflictError,
} from "./phoneRecoveryRepository.js";
import {
  checkVerificationAttemptLock,
  consumeIncorrectVerificationAttempt,
  consumeVerificationBudget,
  type VerificationAttemptInput,
  type VerificationBudgetResult,
} from "./verificationRateLimit.js";
import { decryptPhone, encryptPhone, hashPhoneCandidates, normalizeUsPhone } from "./phone.js";
import { verifyHuman as verifyTurnstile } from "./turnstile.js";
import {
  VerificationLockedError,
  VerificationRejectedError,
  type VerificationPolicy,
} from "./verificationPolicy.js";
import { invalidateTokenVersionCache } from "./tokenVersion.js";
import type { SecurityNotificationProvider } from "./securityNotificationProvider.js";

const CASE_LIFETIME_MS = 24 * 60 * 60_000;
const CODE_LIFETIME_MS = 10 * 60_000;
const DUMMY_DIGEST = Buffer.alloc(32, 0);

type AttemptFunction = (input: VerificationAttemptInput) => Promise<VerificationBudgetResult>;
type SmsCompletionPolicy = Pick<VerificationPolicy, "completeChallenge">;
type ProtectedPhone = {
  destination: string;
  encrypted: string;
  encryptionKeyVersion: number;
  primaryHash: string;
  primaryKeyVersion: number;
  prefixHash: string;
  aliases: Array<{ hash: string; keyVersion: number }>;
  phoneLast4: string;
};

type PhoneRecoveryServiceOptions = {
  emailOtpKey?: string;
  now?: () => Date;
  randomReference?: () => string;
  randomCode?: () => string;
  checkAttemptLock?: AttemptFunction;
  consumeIncorrectAttempt?: AttemptFunction;
  verifyHuman?: (token: string, ip: string) => Promise<boolean>;
  reserveSmsBudget?: typeof consumeVerificationBudget;
  protectPhone?: (phone: string) => ProtectedPhone;
  queueProviderRef?: () => string;
  decryptPhone?: (ciphertext: string, keyVersion: number) => string;
  smsPolicy?: SmsCompletionPolicy;
  notificationProvider?: SecurityNotificationProvider;
};

export class PhoneRecoveryUnavailableError extends Error {
  constructor() {
    super("Phone recovery is unavailable.");
    this.name = "PhoneRecoveryUnavailableError";
  }
}

export class PhoneRecoveryLockedError extends PhoneRecoveryUnavailableError {
  constructor(readonly retryAfterSeconds: number) {
    super();
    this.name = "PhoneRecoveryLockedError";
  }
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeEmployeeNumber(value: string): string {
  return value.trim().toUpperCase();
}

export class PhoneRecoveryService {
  private readonly key: string;
  private readonly now: () => Date;
  private readonly randomReference: () => string;
  private readonly randomCode: () => string;
  private readonly checkAttemptLock: AttemptFunction;
  private readonly consumeIncorrectAttempt: AttemptFunction;
  private readonly verifyHuman: (token: string, ip: string) => Promise<boolean>;
  private readonly reserveSmsBudget: typeof consumeVerificationBudget;
  private readonly protectPhone: (phone: string) => ProtectedPhone;
  private readonly queueProviderRef: () => string;
  private readonly decryptPhoneValue: (ciphertext: string, keyVersion: number) => string;
  private readonly smsPolicy?: SmsCompletionPolicy;
  private readonly notificationProvider?: SecurityNotificationProvider;

  constructor(
    private readonly repository: PhoneRecoveryRepository,
    private readonly emailProvider: RecoveryEmailProvider,
    options: PhoneRecoveryServiceOptions = {},
  ) {
    this.key = options.emailOtpKey ?? process.env.EMAIL_OTP_HMAC_KEY?.trim() ?? "";
    if (this.key.length < 32) throw new Error("EMAIL_OTP_HMAC_KEY is required for phone recovery.");
    this.now = options.now ?? (() => new Date());
    this.randomReference = options.randomReference ?? (() => randomBytes(16).toString("base64url"));
    this.randomCode = options.randomCode ?? (() => randomInt(0, 100_000_000).toString().padStart(8, "0"));
    this.checkAttemptLock = options.checkAttemptLock ?? checkVerificationAttemptLock;
    this.consumeIncorrectAttempt = options.consumeIncorrectAttempt ?? consumeIncorrectVerificationAttempt;
    this.verifyHuman = options.verifyHuman ?? ((token, ip) => verifyTurnstile(token, ip, {
      secret: process.env.TURNSTILE_SECRET_KEY?.trim() ?? "",
      expectedHostname: process.env.TURNSTILE_EXPECTED_HOSTNAME?.trim() ?? "",
      expectedAction: "phone_recovery",
    }));
    this.reserveSmsBudget = options.reserveSmsBudget ?? consumeVerificationBudget;
    this.protectPhone = options.protectPhone ?? ((phone) => {
      const destination = normalizeUsPhone(phone);
      const candidates = hashPhoneCandidates(destination);
      const primary = candidates[0];
      const protectedPhone = encryptPhone(destination);
      const rateKey = process.env.RATE_LIMIT_HMAC_KEY?.trim();
      if (!rateKey) throw new PhoneRecoveryUnavailableError();
      return {
        destination, encrypted: protectedPhone.ciphertext, encryptionKeyVersion: protectedPhone.keyVersion,
        primaryHash: primary.hash, primaryKeyVersion: primary.version,
        prefixHash: createHmac("sha256", rateKey).update(destination.slice(0, 5)).digest("hex"),
        aliases: candidates.map(({ hash, version }) => ({ hash, keyVersion: version })),
        phoneLast4: destination.slice(-4),
      };
    });
    this.queueProviderRef = options.queueProviderRef ?? (() => `pending:${randomUUID()}`);
    this.decryptPhoneValue = options.decryptPhone ?? decryptPhone;
    this.smsPolicy = options.smsPolicy;
    this.notificationProvider = options.notificationProvider;
  }

  hashCaseReference(reference: string): string {
    return createHmac("sha256", this.key).update(`phone-recovery-case:${reference}`).digest("hex");
  }

  async adminStatus(input: { targetUserId: string }) {
    return this.repository.getAdminStatus(input.targetUserId);
  }

  private hashCode(challengeId: string, code: string): Buffer {
    return createHmac("sha256", this.key).update(`phone-recovery-email:${challengeId}:${code}`).digest();
  }

  private async auditAttempt(
    challengeId: string,
    phase: "EMAIL" | "SMS",
    outcome: "denied" | "locked",
    safeReasonCode: "invalid_code" | "attempt_limit" | "state_conflict",
    at: Date,
  ): Promise<void> {
    try {
      await this.repository.recordAttemptOutcome({ challengeId, phase, outcome, safeReasonCode, at });
    } catch { /* a failed audit write must not disclose or relax a rejected verification */ }
  }

  async initiate(input: { actorUserId: string; targetUserId: string }) {
    const now = this.now();
    const target = await this.repository.getRecoveryTarget(input.targetUserId);
    if (!target?.phoneVerifiedAt) throw new PhoneRecoveryUnavailableError();
    const caseId = randomUUID();
    const caseReference = this.randomReference();
    const expiresAt = new Date(now.getTime() + CASE_LIFETIME_MS);
    try {
      await this.repository.createNoticePending({
        id: caseId, actorUserId: input.actorUserId, targetUserId: target.id,
        caseReferenceHash: this.hashCaseReference(caseReference), expiresAt, now,
      });
      await this.emailProvider.send({ kind: "recovery_requested", destination: target.email, expiresAt, caseReference });
      if (!await this.repository.markNoticeAccepted(caseId, this.now())) throw new PhoneRecoveryUnavailableError();
      return { caseId, caseReference, expiresAt };
    } catch (error) {
      try { await this.repository.markNoticeFailed(caseId, "notification_unavailable", this.now()); } catch { /* terminal or never created */ }
      if (error instanceof PhoneRecoveryConflictError) throw new PhoneRecoveryUnavailableError();
      throw new PhoneRecoveryUnavailableError();
    }
  }

  async startEmailProof(input: { email: string; employeeNumber: string; caseReference: string; accountHash: string }) {
    const now = this.now();
    const challengeId = randomUUID();
    const email = normalizeEmail(input.email);
    const employeeNumber = normalizeEmployeeNumber(input.employeeNumber);
    const lock = await this.checkAttemptLock({ action: "PHONE_RECOVERY_EMAIL", accountHash: input.accountHash, now });
    if (!lock.allowed) throw new PhoneRecoveryLockedError(lock.retryAfterSeconds);
    const code = this.randomCode();
    if (!/^\d{8}$/.test(code)) throw new PhoneRecoveryUnavailableError();
    const codeDigest = this.hashCode(challengeId, code);
    const recoveryCase = await this.repository.findPublicCase({
      email, employeeNumber, caseReferenceHash: this.hashCaseReference(input.caseReference.trim()), now,
    });
    const expiresAt = new Date(recoveryCase
      ? Math.min(now.getTime() + CODE_LIFETIME_MS, recoveryCase.expiresAt.getTime())
      : now.getTime() + CODE_LIFETIME_MS);
    if (!recoveryCase) {
      await this.repository.beginEmailDecoy({
        challengeId, codeDigest, accountRateLimitHash: input.accountHash, expiresAt, now,
      });
      return { status: "verification_pending" as const, challengeId };
    }
    await this.repository.beginEmailProof({
      caseId: recoveryCase.id, challengeId, codeDigest,
      accountRateLimitHash: input.accountHash, expiresAt, now,
    });
    try {
      await this.emailProvider.send({ kind: "recovery_code", destination: email, code, expiresAt });
    } catch { /* preserve the generic, durable challenge contract without claiming delivery */ }
    return { status: "verification_pending" as const, challengeId };
  }

  async checkEmailCode(input: { challengeId: string; code: string }) {
    const now = this.now();
    const challenge = await this.repository.readEmailChallenge(input.challengeId);
    const candidate = /^\d{8}$/.test(input.code) ? this.hashCode(input.challengeId, input.code) : DUMMY_DIGEST;
    const expected = challenge?.codeDigest ?? DUMMY_DIGEST;
    const realCaseId = challenge?.caseId ?? null;
    const matched = timingSafeEqual(candidate, expected) && Boolean(realCaseId) && Boolean(challenge) && challenge!.expiresAt > now;
    if (!challenge) throw new PhoneRecoveryUnavailableError();
    const dimensions = { action: "PHONE_RECOVERY_EMAIL", accountHash: challenge.accountRateLimitHash, now };
    const lock = await this.checkAttemptLock(dimensions);
    if (!lock.allowed) {
      await this.auditAttempt(challenge.id, "EMAIL", "locked", "attempt_limit", now);
      throw new PhoneRecoveryLockedError(lock.retryAfterSeconds);
    }
    if (!matched || !realCaseId) {
      const attempt = await this.consumeIncorrectAttempt(dimensions);
      if (!attempt.allowed) {
        await this.auditAttempt(challenge.id, "EMAIL", "locked", "attempt_limit", now);
        throw new PhoneRecoveryLockedError(attempt.retryAfterSeconds);
      }
      await this.auditAttempt(challenge.id, "EMAIL", "denied", "invalid_code", now);
      throw new PhoneRecoveryUnavailableError();
    }
    if (!await this.repository.recordEmailApproval({ caseId: realCaseId, challengeId: challenge.id, approvedAt: now })) {
      throw new PhoneRecoveryUnavailableError();
    }
    return { status: "email_verified" as const, caseId: realCaseId };
  }

  async resume(input: { challengeId: string }) {
    const now = this.now();
    const email = await this.repository.readEmailChallenge(input.challengeId);
    if (email?.expiresAt && email.expiresAt > now) return { stage: "email" as const };
    const approved = await this.repository.readApprovedEmailChallenge(input.challengeId);
    if (approved?.caseExpiresAt && approved.caseExpiresAt > now) return { stage: "phone" as const };
    const phone = await this.repository.readPhoneChallenge(input.challengeId);
    if (phone?.expiresAt && phone.expiresAt > now) {
      return { stage: "sms" as const, maskedDestination: `(***) ***-${phone.phoneLast4}` };
    }
    throw new PhoneRecoveryUnavailableError();
  }

  async startPhoneProof(input: {
    emailChallengeId: string;
    phone: string;
    smsConsent: boolean;
    consentVersion: string;
    turnstileToken: string;
    ip: string;
  }) {
    const now = this.now();
    const approved = await this.repository.readApprovedEmailChallenge(input.emailChallengeId);
    if (!approved || !input.smsConsent || !input.consentVersion.trim()
      || !await this.verifyHuman(input.turnstileToken, input.ip)) throw new PhoneRecoveryUnavailableError();
    let phone: ProtectedPhone;
    try { phone = this.protectPhone(input.phone); } catch { throw new PhoneRecoveryUnavailableError(); }
    const rateKey = process.env.RATE_LIMIT_HMAC_KEY?.trim() ?? this.key;
    const ipHash = createHmac("sha256", rateKey).update(`phone-recovery-ip:${input.ip}`).digest("hex");
    const budget = await this.reserveSmsBudget({
      action: "PHONE_RECOVERY_SMS", phoneHash: phone.primaryHash, phonePrefixHash: phone.prefixHash,
      accountHash: approved.accountRateLimitHash, ipHash, now,
    });
    if (!budget.allowed) throw new PhoneRecoveryLockedError(budget.retryAfterSeconds);
    const challengeId = randomUUID();
    const expiresAt = new Date(Math.min(now.getTime() + CODE_LIFETIME_MS, approved.caseExpiresAt.getTime()));
    await this.repository.reservePhone({
      caseId: approved.caseId, challengeId, providerRef: this.queueProviderRef(),
      phoneEncrypted: phone.encrypted, phoneEncryptionKeyVersion: phone.encryptionKeyVersion,
      phoneLookupHash: phone.primaryHash, phonePrefixHash: phone.prefixHash,
      accountRateLimitHash: approved.accountRateLimitHash,
      phoneLookupKeyVersion: phone.primaryKeyVersion, phoneLast4: phone.phoneLast4,
      consentAt: now, consentVersion: input.consentVersion.trim(), aliases: phone.aliases, expiresAt, now,
    });
    return { status: "verification_pending" as const, challengeId };
  }

  async resend(input: { challengeId: string; ip: string }) {
    const now = this.now();
    const emailChallenge = await this.repository.readEmailChallenge(input.challengeId);
    if (!emailChallenge) {
      return { ...(await this.resendPhoneProof({ smsChallengeId: input.challengeId, ip: input.ip })), stage: "sms" as const };
    }
    if (emailChallenge.expiresAt <= now) throw new PhoneRecoveryUnavailableError();
    const attemptLock = await this.checkAttemptLock({
      action: "PHONE_RECOVERY_EMAIL", accountHash: emailChallenge.accountRateLimitHash, now,
    });
    if (!attemptLock.allowed) throw new PhoneRecoveryLockedError(attemptLock.retryAfterSeconds);
    const challengeId = randomUUID();
    const code = this.randomCode();
    if (!/^\d{8}$/.test(code)) throw new PhoneRecoveryUnavailableError();
    const expiresAt = new Date(Math.min(
      now.getTime() + CODE_LIFETIME_MS,
      emailChallenge.caseExpiresAt?.getTime() ?? Number.POSITIVE_INFINITY,
    ));
    let replacement;
    try {
      replacement = await this.repository.replaceEmailChallenge({
        previousChallengeId: emailChallenge.id, challengeId,
        codeDigest: this.hashCode(challengeId, code), expiresAt, now,
      });
    } catch (error) {
      if (error instanceof PhoneRecoveryConflictError) throw new PhoneRecoveryUnavailableError();
      throw error;
    }
    if (replacement.destinationEmail) {
      try {
        await this.emailProvider.send({
          kind: "recovery_code", destination: replacement.destinationEmail, code, expiresAt,
        });
      } catch { /* preserve the generic challenge contract without claiming delivery */ }
    }
    return { status: "verification_pending" as const, stage: "email" as const, challengeId };
  }

  async resendPhoneProof(input: { smsChallengeId: string; ip: string }) {
    const now = this.now();
    const challenge = await this.repository.readPhoneChallenge(input.smsChallengeId);
    if (!challenge || challenge.expiresAt <= now) throw new PhoneRecoveryUnavailableError();
    const attemptLock = await this.checkAttemptLock({
      action: "PHONE_RECOVERY_SMS",
      phoneHash: challenge.destinationHash,
      accountHash: challenge.accountRateLimitHash,
      now,
    });
    if (!attemptLock.allowed) throw new PhoneRecoveryLockedError(attemptLock.retryAfterSeconds);
    let destination: string;
    try { destination = this.decryptPhoneValue(challenge.destinationEncrypted, challenge.destinationEncryptionKeyVersion); }
    catch { throw new PhoneRecoveryUnavailableError(); }
    const rateKey = process.env.RATE_LIMIT_HMAC_KEY?.trim() ?? this.key;
    const ipHash = createHmac("sha256", rateKey).update(`phone-recovery-ip:${input.ip}`).digest("hex");
    const budget = await this.reserveSmsBudget({
      action: "PHONE_RECOVERY_SMS", phoneHash: challenge.destinationHash,
      phonePrefixHash: challenge.phonePrefixHash, accountHash: challenge.accountRateLimitHash,
      ipHash, now,
    });
    if (!budget.allowed) throw new PhoneRecoveryLockedError(budget.retryAfterSeconds);
    if (!/^\+1[2-9]\d{9}$/.test(destination)) throw new PhoneRecoveryUnavailableError();
    const challengeId = randomUUID();
    const expiresAt = new Date(Math.min(now.getTime() + CODE_LIFETIME_MS, challenge.caseExpiresAt.getTime()));
    try {
      await this.repository.replacePhoneChallenge({
        previousChallengeId: challenge.id, challengeId, providerRef: this.queueProviderRef(), expiresAt, now,
      });
    } catch (error) {
      if (error instanceof PhoneRecoveryConflictError) throw new PhoneRecoveryUnavailableError();
      throw error;
    }
    return {
      status: "verification_pending" as const,
      challengeId,
      maskedDestination: `(***) ***-${challenge.phoneLast4}`,
    };
  }

  async checkPhoneCodeAndComplete(input: { smsChallengeId: string; code: string }) {
    const now = this.now();
    const challenge = await this.repository.readPhoneChallenge(input.smsChallengeId);
    if (!challenge || challenge.expiresAt <= now || challenge.deliveryState !== "SENT" || !this.smsPolicy) {
      throw new PhoneRecoveryUnavailableError();
    }
    let destination: string;
    try { destination = this.decryptPhoneValue(challenge.destinationEncrypted, challenge.destinationEncryptionKeyVersion); }
    catch { throw new PhoneRecoveryUnavailableError(); }
    const priorTarget = await this.repository.getRecoveryTarget(challenge.userId);
    let result;
    try {
      result = await this.smsPolicy.completeChallenge({
        challengeId: challenge.id, userId: challenge.userId, purpose: "PHONE_RECOVERY_SMS", method: "SMS",
        destination, destinationHash: challenge.destinationHash, destinationVersion: challenge.destinationVersion,
        tokenVersionAtIssue: challenge.tokenVersionAtIssue, code: input.code,
      }, async (challengeId, completedAt) => this.repository.complete({ caseId: challenge.caseId, challengeId, completedAt }));
    } catch (error) {
      if (error instanceof VerificationLockedError) {
        await this.auditAttempt(challenge.id, "SMS", "locked", "attempt_limit", now);
        throw new PhoneRecoveryLockedError(error.retryAfter);
      }
      if (error instanceof VerificationRejectedError) {
        await this.auditAttempt(challenge.id, "SMS", "denied", "invalid_code", now);
        throw new PhoneRecoveryUnavailableError();
      }
      if (error instanceof PhoneRecoveryConflictError) {
        await this.auditAttempt(challenge.id, "SMS", "denied", "state_conflict", now);
        throw new PhoneRecoveryUnavailableError();
      }
      throw error;
    }
    if (!result.approved || !result.value) throw new PhoneRecoveryUnavailableError();
    let notificationWarning = false;
    try { invalidateTokenVersionCache(challenge.userId); } catch { notificationWarning = true; }

    const recordOutcome = async (
      channel: "EMAIL" | "SMS",
      outcome: "accepted" | "failed",
      safeReasonCode: "provider_accepted" | "provider_request_failed" | "provider_destination_unavailable",
    ) => {
      try {
        await this.repository.recordNotificationOutcome({
          caseId: challenge.caseId, userId: challenge.userId, channel, outcome, safeReasonCode, at: now,
        });
      } catch {
        notificationWarning = true;
      }
    };

    if (priorTarget) {
      try {
        await this.emailProvider.send({ kind: "recovery_completed", destination: priorTarget.email, completedAt: now });
        await recordOutcome("EMAIL", "accepted", "provider_accepted");
      } catch {
        notificationWarning = true;
        await recordOutcome("EMAIL", "failed", "provider_request_failed");
      }
    } else {
      notificationWarning = true;
      await recordOutcome("EMAIL", "failed", "provider_destination_unavailable");
    }

    if (priorTarget?.phoneEncrypted && priorTarget.phoneEncryptionKeyVersion !== null
      && priorTarget.phoneEncryptionKeyVersion !== undefined && this.notificationProvider) {
      try {
        const oldPhone = this.decryptPhoneValue(priorTarget.phoneEncrypted, priorTarget.phoneEncryptionKeyVersion);
        await this.notificationProvider.notifyFactorChanged({
          destination: oldPhone, event: "PHONE_RECOVERED", correlationId: challenge.caseId,
        });
        await recordOutcome("SMS", "accepted", "provider_accepted");
      } catch {
        notificationWarning = true;
        await recordOutcome("SMS", "failed", "provider_request_failed");
      }
    } else {
      notificationWarning = true;
      await recordOutcome("SMS", "failed", "provider_destination_unavailable");
    }
    return { status: "recovery_complete" as const, notificationWarning };
  }

  async cancel(input: { caseId: string; actorUserId: string }) {
    return this.repository.cancel({ ...input, cancelledAt: this.now() });
  }
}
