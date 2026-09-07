import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

export type PhoneRecoveryStatus =
  | "NOTICE_PENDING"
  | "EMAIL_PENDING"
  | "EMAIL_VERIFIED"
  | "PHONE_PENDING"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED"
  | "EXPIRED";

export type PhoneRecoveryCaseView = {
  id: string;
  targetUserId: string;
  actorUserId: string;
  status: PhoneRecoveryStatus;
  tokenVersionAtIssue: number;
  phoneVersionAtIssue: number;
  expiresAt: Date;
};

export type InitiateRecoveryInput = {
  id: string;
  actorUserId: string;
  targetUserId: string;
  caseReferenceHash: string;
  expiresAt: Date;
  now: Date;
};

export type BeginEmailProofInput = {
  caseId: string;
  challengeId: string;
  codeDigest: Buffer;
  accountRateLimitHash: string;
  expiresAt: Date;
  now: Date;
};
export type BeginEmailDecoyInput = Omit<BeginEmailProofInput, "caseId">;
export type ReplaceEmailChallengeInput = {
  previousChallengeId: string;
  challengeId: string;
  codeDigest: Buffer;
  expiresAt: Date;
  now: Date;
};

export type EmailApprovalInput = { caseId: string; challengeId: string; approvedAt: Date };

export type ReservePhoneInput = {
  caseId: string;
  challengeId: string;
  providerRef: string;
  phoneEncrypted: string;
  phoneEncryptionKeyVersion: number;
  phoneLookupHash: string;
  phonePrefixHash: string;
  accountRateLimitHash: string;
  phoneLookupKeyVersion: number;
  phoneLast4: string;
  consentAt: Date;
  consentVersion: string;
  aliases: Array<{ hash: string; keyVersion: number }>;
  expiresAt: Date;
  now: Date;
};

export type CompletePhoneRecoveryInput = { caseId: string; challengeId: string; completedAt: Date };
export type ReplacePhoneChallengeInput = {
  previousChallengeId: string;
  challengeId: string;
  providerRef: string;
  expiresAt: Date;
  now: Date;
};
export type CancelRecoveryInput = { caseId: string; actorUserId: string; cancelledAt: Date };
export type RecoveryNotificationOutcomeInput = {
  caseId: string;
  userId: string;
  channel: "EMAIL" | "SMS";
  outcome: "accepted" | "failed";
  safeReasonCode: "provider_accepted" | "provider_request_failed" | "provider_destination_unavailable";
  at: Date;
};
export type RecoveryAttemptOutcomeInput = {
  challengeId: string;
  phase: "EMAIL" | "SMS";
  outcome: "denied" | "locked";
  safeReasonCode: "invalid_code" | "attempt_limit" | "state_conflict";
  at: Date;
};

export type AdminPhoneRecoveryStatus = {
  cases: Array<{
    caseId: string;
    status: PhoneRecoveryStatus;
    startedAt: Date;
    expiresAt: Date;
  }>;
  events: Array<{
    eventType: string;
    outcome: string;
    safeReasonCode: string | null;
    occurredAt: Date;
  }>;
};

export type EmailProofChallenge = { id: string; caseId: string; expiresAt: Date };
export type PhoneProofChallenge = PhoneRecoveryCaseView & { challengeId: string };
export type CompletedRecovery = PhoneRecoveryCaseView & { tokenVersion: number; phoneVersion: number };
export type RecoveryTargetIdentity = {
  id: string;
  email: string;
  employeeNumber: string | null;
  phoneVerifiedAt: Date | null;
  phoneEncrypted?: string | null;
  phoneEncryptionKeyVersion?: number | null;
};
export type PublicRecoveryIdentity = {
  email: string;
  employeeNumber: string;
  caseReferenceHash: string;
  now: Date;
};
export type EmailChallengeProof = {
  id: string;
  caseId: string | null;
  codeDigest: Buffer;
  accountRateLimitHash: string;
  expiresAt: Date;
  caseExpiresAt: Date | null;
};
export type ReplacedEmailChallenge = EmailChallengeProof & { destinationEmail: string | null };
export type ApprovedEmailChallenge = Omit<EmailChallengeProof, "caseId"> & {
  caseId: string;
  approvedAt: Date;
  caseExpiresAt: Date;
};
export type RecoveryPhoneChallenge = {
  id: string;
  caseId: string;
  userId: string;
  destinationHash: string;
  phonePrefixHash: string;
  accountRateLimitHash: string;
  destinationVersion: number;
  tokenVersionAtIssue: number;
  destinationEncrypted: string;
  destinationEncryptionKeyVersion: number;
  phoneLast4: string;
  deliveryState: "PENDING" | "CLAIMED" | "SENDING" | "SENT" | "FAILED" | "AMBIGUOUS";
  expiresAt: Date;
  caseExpiresAt: Date;
};

export interface PhoneRecoveryRepository {
  getRecoveryTarget(userId: string): Promise<RecoveryTargetIdentity | null>;
  findPublicCase(input: PublicRecoveryIdentity): Promise<PhoneRecoveryCaseView | null>;
  readEmailChallenge(challengeId: string): Promise<EmailChallengeProof | null>;
  readApprovedEmailChallenge(challengeId: string): Promise<ApprovedEmailChallenge | null>;
  readPhoneChallenge(challengeId: string): Promise<RecoveryPhoneChallenge | null>;
  createNoticePending(input: InitiateRecoveryInput): Promise<PhoneRecoveryCaseView>;
  markNoticeAccepted(caseId: string, at: Date): Promise<boolean>;
  markNoticeFailed(caseId: string, reason: string, at: Date): Promise<void>;
  beginEmailProof(input: BeginEmailProofInput): Promise<EmailProofChallenge>;
  beginEmailDecoy(input: BeginEmailDecoyInput): Promise<EmailChallengeProof>;
  replaceEmailChallenge(input: ReplaceEmailChallengeInput): Promise<ReplacedEmailChallenge>;
  recordEmailApproval(input: EmailApprovalInput): Promise<boolean>;
  reservePhone(input: ReservePhoneInput): Promise<PhoneProofChallenge>;
  replacePhoneChallenge(input: ReplacePhoneChallengeInput): Promise<PhoneProofChallenge>;
  complete(input: CompletePhoneRecoveryInput): Promise<CompletedRecovery>;
  recordNotificationOutcome(input: RecoveryNotificationOutcomeInput): Promise<void>;
  recordAttemptOutcome(input: RecoveryAttemptOutcomeInput): Promise<void>;
  cancel(input: CancelRecoveryInput): Promise<boolean>;
  expireOpenCases(now: Date): Promise<number>;
  getAdminStatus(targetUserId: string): Promise<AdminPhoneRecoveryStatus>;
}

export class PhoneRecoveryConflictError extends Error {
  constructor() {
    super("Phone recovery state conflict.");
    this.name = "PhoneRecoveryConflictError";
  }
}

type RecoveryUser = {
  id: string;
  role: "ADMIN" | "GENERAL";
  isActive: boolean;
  accountStatus: "PENDING_PHONE_VERIFICATION" | "ACTIVE" | "DISABLED";
  email: string;
  employeeNumber: string | null;
  tokenVersion: number;
  phoneVersion: number;
  phoneEncrypted?: string | null;
  phoneEncryptionKeyVersion?: number | null;
  phoneLookupHash?: string | null;
  phoneLookupKeyVersion?: number | null;
  phoneLast4?: string | null;
  phoneVerifiedAt?: Date | null;
  phoneConsentAt?: Date | null;
  phoneConsentVersion?: string | null;
};

type StoredCase = PhoneRecoveryCaseView & {
  createdAt: Date;
  caseReferenceHash: string;
  noticeAcceptedAt: Date | null;
  emailVerifiedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  failedAt: Date | null;
  safeFailureReason: string | null;
  pendingPhone: ReservePhoneInput | null;
};

type StoredChallenge = {
  id: string;
  caseId: string | null;
  purpose: "PHONE_RECOVERY_EMAIL" | "PHONE_RECOVERY_SMS";
  codeDigest: Buffer | null;
  accountRateLimitHash: string | null;
  providerRef: string;
  expiresAt: Date;
  consumedAt: Date | null;
  invalidatedAt: Date | null;
  deliveryState: "PENDING" | "CLAIMED" | "SENDING" | "SENT" | "FAILED" | "AMBIGUOUS" | null;
};

const OPEN_STATUSES = new Set<PhoneRecoveryStatus>(["NOTICE_PENDING", "EMAIL_PENDING", "EMAIL_VERIFIED", "PHONE_PENDING"]);

function view(recoveryCase: StoredCase): PhoneRecoveryCaseView {
  return {
    id: recoveryCase.id,
    targetUserId: recoveryCase.targetUserId,
    actorUserId: recoveryCase.actorUserId,
    status: recoveryCase.status,
    tokenVersionAtIssue: recoveryCase.tokenVersionAtIssue,
    phoneVersionAtIssue: recoveryCase.phoneVersionAtIssue,
    expiresAt: new Date(recoveryCase.expiresAt),
  };
}

export class InMemoryPhoneRecoveryRepository implements PhoneRecoveryRepository {
  private readonly usersById = new Map<string, RecoveryUser>();
  private readonly cases = new Map<string, StoredCase>();
  private readonly challenges = new Map<string, StoredChallenge>();
  private readonly provisionalAliases = new Map<string, { caseId: string; keyVersion: number; expiresAt: Date }>();
  private readonly auditEvents: Array<{
    eventType: string; outcome?: string; actorUserId: string | null; targetUserId: string | null;
    correlationId: string; safeReasonCode?: string; createdAt: Date;
  }> = [];
  private queue: Promise<void> = Promise.resolve();

  private expireOpenCasesUnsafe(now: Date, targetUserId?: string): number {
    const expired = [...this.cases.values()].filter(
      (candidate) => (!targetUserId || candidate.targetUserId === targetUserId)
        && OPEN_STATUSES.has(candidate.status) && candidate.expiresAt <= now,
    );
    for (const recoveryCase of expired) {
      recoveryCase.status = "EXPIRED";
      for (const challenge of this.challenges.values()) {
        if (challenge.caseId === recoveryCase.id && !challenge.consumedAt && !challenge.invalidatedAt) {
          challenge.invalidatedAt = new Date(now);
        }
      }
      for (const [hash, alias] of this.provisionalAliases) {
        if (alias.caseId === recoveryCase.id) this.provisionalAliases.delete(hash);
      }
      this.auditEvents.push({
        eventType: "phone_recovery_expired", outcome: "accepted",
        actorUserId: recoveryCase.actorUserId, targetUserId: recoveryCase.targetUserId,
        correlationId: recoveryCase.id, safeReasonCode: "case_expired", createdAt: new Date(now),
      });
    }
    return expired.length;
  }

  constructor(users: RecoveryUser[]) {
    for (const user of users) this.usersById.set(user.id, structuredClone(user));
  }

  private async locked<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  async getRecoveryTarget(userId: string): Promise<RecoveryTargetIdentity | null> {
    const user = this.usersById.get(userId);
    if (!user) return null;
    return {
      id: user.id, email: user.email, employeeNumber: user.employeeNumber,
      phoneVerifiedAt: user.phoneVerifiedAt ?? null,
      phoneEncrypted: user.phoneEncrypted ?? null,
      phoneEncryptionKeyVersion: user.phoneEncryptionKeyVersion ?? null,
    };
  }

  async findPublicCase(input: PublicRecoveryIdentity): Promise<PhoneRecoveryCaseView | null> {
    const user = [...this.usersById.values()].find((candidate) => candidate.email === input.email
      && (candidate.employeeNumber === null
        ? input.employeeNumber === ""
        : candidate.employeeNumber === input.employeeNumber));
    if (!user || !user.isActive || user.accountStatus !== "ACTIVE") return null;
    const recoveryCase = [...this.cases.values()].find((candidate) => candidate.targetUserId === user.id
      && candidate.caseReferenceHash === input.caseReferenceHash && candidate.status === "EMAIL_PENDING" && candidate.expiresAt > input.now
      && candidate.tokenVersionAtIssue === user.tokenVersion);
    return recoveryCase ? view(recoveryCase) : null;
  }

  setUserTokenVersionForTest(userId: string, tokenVersion: number): void {
    const user = this.usersById.get(userId);
    if (!user) throw new Error("Unknown test user.");
    user.tokenVersion = tokenVersion;
  }

  async readEmailChallenge(challengeId: string): Promise<EmailChallengeProof | null> {
    const challenge = this.challenges.get(challengeId);
    if (!challenge || challenge.purpose !== "PHONE_RECOVERY_EMAIL" || !challenge.codeDigest || !challenge.accountRateLimitHash
      || challenge.consumedAt || challenge.invalidatedAt) return null;
    return {
      id: challenge.id, caseId: challenge.caseId, codeDigest: Buffer.from(challenge.codeDigest),
      accountRateLimitHash: challenge.accountRateLimitHash, expiresAt: new Date(challenge.expiresAt),
      caseExpiresAt: challenge.caseId ? new Date(this.cases.get(challenge.caseId)?.expiresAt ?? challenge.expiresAt) : null,
    };
  }

  async readApprovedEmailChallenge(challengeId: string): Promise<ApprovedEmailChallenge | null> {
    const challenge = this.challenges.get(challengeId);
    const recoveryCase = challenge?.caseId ? this.cases.get(challenge.caseId) : null;
    if (!challenge?.caseId || !recoveryCase || challenge.purpose !== "PHONE_RECOVERY_EMAIL" || !challenge.codeDigest
      || !challenge.accountRateLimitHash || !challenge.consumedAt || challenge.invalidatedAt
      || recoveryCase.status !== "EMAIL_VERIFIED") return null;
    return {
      id: challenge.id, caseId: challenge.caseId, codeDigest: Buffer.from(challenge.codeDigest),
      accountRateLimitHash: challenge.accountRateLimitHash, expiresAt: new Date(challenge.expiresAt),
      approvedAt: new Date(challenge.consumedAt), caseExpiresAt: new Date(recoveryCase.expiresAt),
    };
  }

  async readPhoneChallenge(challengeId: string): Promise<RecoveryPhoneChallenge | null> {
    const challenge = this.challenges.get(challengeId);
    const recoveryCase = challenge?.caseId ? this.cases.get(challenge.caseId) : null;
    const pending = recoveryCase?.pendingPhone;
    if (!challenge || !recoveryCase || !pending || challenge.purpose !== "PHONE_RECOVERY_SMS"
      || challenge.consumedAt || challenge.invalidatedAt || recoveryCase.status !== "PHONE_PENDING") return null;
    return {
      id: challenge.id, caseId: recoveryCase.id, userId: recoveryCase.targetUserId,
      destinationHash: pending.phoneLookupHash, phonePrefixHash: pending.phonePrefixHash,
      accountRateLimitHash: pending.accountRateLimitHash, destinationVersion: recoveryCase.phoneVersionAtIssue + 1,
      tokenVersionAtIssue: recoveryCase.tokenVersionAtIssue, destinationEncrypted: pending.phoneEncrypted,
      destinationEncryptionKeyVersion: pending.phoneEncryptionKeyVersion,
      phoneLast4: pending.phoneLast4,
      deliveryState: challenge.deliveryState ?? "FAILED", expiresAt: new Date(challenge.expiresAt),
      caseExpiresAt: new Date(recoveryCase.expiresAt),
    };
  }

  private liveCase(caseId: string, now: Date): StoredCase {
    const recoveryCase = this.cases.get(caseId);
    if (!recoveryCase || recoveryCase.expiresAt <= now || !OPEN_STATUSES.has(recoveryCase.status)) {
      throw new PhoneRecoveryConflictError();
    }
    return recoveryCase;
  }

  async createNoticePending(input: InitiateRecoveryInput): Promise<PhoneRecoveryCaseView> {
    return this.locked(() => {
      const actor = this.usersById.get(input.actorUserId);
      const target = this.usersById.get(input.targetUserId);
      this.expireOpenCasesUnsafe(input.now, input.targetUserId);
      if (!actor || actor.role !== "ADMIN" || !actor.isActive || actor.accountStatus !== "ACTIVE"
        || !target || !target.isActive || target.accountStatus !== "ACTIVE"
        || actor.id === target.id || input.expiresAt <= input.now
        || [...this.cases.values()].some((candidate) => candidate.targetUserId === target.id && candidate.expiresAt > input.now && OPEN_STATUSES.has(candidate.status))) {
        throw new PhoneRecoveryConflictError();
      }
      const recoveryCase: StoredCase = {
        id: input.id,
        actorUserId: actor.id,
        targetUserId: target.id,
        status: "NOTICE_PENDING",
        caseReferenceHash: input.caseReferenceHash,
        tokenVersionAtIssue: target.tokenVersion,
        phoneVersionAtIssue: target.phoneVersion,
        expiresAt: new Date(input.expiresAt),
        createdAt: new Date(input.now),
        noticeAcceptedAt: null,
        emailVerifiedAt: null,
        completedAt: null,
        cancelledAt: null,
        failedAt: null,
        safeFailureReason: null,
        pendingPhone: null,
      };
      this.cases.set(recoveryCase.id, recoveryCase);
      return view(recoveryCase);
    });
  }

  async markNoticeAccepted(caseId: string, at: Date): Promise<boolean> {
    return this.locked(() => {
      const recoveryCase = this.liveCase(caseId, at);
      if (recoveryCase.status !== "NOTICE_PENDING") return false;
      recoveryCase.status = "EMAIL_PENDING";
      recoveryCase.noticeAcceptedAt = new Date(at);
      return true;
    });
  }

  async markNoticeFailed(caseId: string, reason: string, at: Date): Promise<void> {
    await this.locked(() => {
      const recoveryCase = this.liveCase(caseId, at);
      if (recoveryCase.status !== "NOTICE_PENDING" || !reason.trim()) throw new PhoneRecoveryConflictError();
      recoveryCase.status = "FAILED";
      recoveryCase.failedAt = new Date(at);
      recoveryCase.safeFailureReason = reason.trim();
    });
  }

  async beginEmailProof(input: BeginEmailProofInput): Promise<EmailProofChallenge> {
    return this.locked(() => {
      const recoveryCase = this.liveCase(input.caseId, input.now);
      if (recoveryCase.status !== "EMAIL_PENDING" || input.codeDigest.length !== 32 || input.expiresAt <= input.now
        || input.expiresAt > recoveryCase.expiresAt) throw new PhoneRecoveryConflictError();
      for (const challenge of this.challenges.values()) {
        if (challenge.caseId === input.caseId && !challenge.consumedAt && !challenge.invalidatedAt) challenge.invalidatedAt = new Date(input.now);
      }
      this.challenges.set(input.challengeId, {
        id: input.challengeId, caseId: input.caseId, purpose: "PHONE_RECOVERY_EMAIL", codeDigest: Buffer.from(input.codeDigest),
        accountRateLimitHash: input.accountRateLimitHash,
        providerRef: "local", expiresAt: new Date(input.expiresAt), consumedAt: null, invalidatedAt: null,
        deliveryState: null,
      });
      return { id: input.challengeId, caseId: input.caseId, expiresAt: new Date(input.expiresAt) };
    });
  }

  async beginEmailDecoy(input: BeginEmailDecoyInput): Promise<EmailChallengeProof> {
    return this.locked(() => {
      if (input.codeDigest.length !== 32 || !/^[a-f0-9]{64}$/.test(input.accountRateLimitHash)
        || input.expiresAt <= input.now) throw new PhoneRecoveryConflictError();
      for (const challenge of this.challenges.values()) {
        if (challenge.caseId === null && challenge.purpose === "PHONE_RECOVERY_EMAIL"
          && challenge.accountRateLimitHash === input.accountRateLimitHash
          && !challenge.consumedAt && !challenge.invalidatedAt) challenge.invalidatedAt = new Date(input.now);
      }
      this.challenges.set(input.challengeId, {
        id: input.challengeId, caseId: null, purpose: "PHONE_RECOVERY_EMAIL", codeDigest: Buffer.from(input.codeDigest),
        accountRateLimitHash: input.accountRateLimitHash,
        providerRef: "local", expiresAt: new Date(input.expiresAt), consumedAt: null, invalidatedAt: null,
        deliveryState: null,
      });
      return {
        id: input.challengeId, caseId: null, codeDigest: Buffer.from(input.codeDigest),
        accountRateLimitHash: input.accountRateLimitHash, expiresAt: new Date(input.expiresAt),
        caseExpiresAt: null,
      };
    });
  }

  async replaceEmailChallenge(input: ReplaceEmailChallengeInput): Promise<ReplacedEmailChallenge> {
    return this.locked(() => {
      const previous = this.challenges.get(input.previousChallengeId);
      if (!previous || input.previousChallengeId === input.challengeId || previous.purpose !== "PHONE_RECOVERY_EMAIL"
        || !previous.codeDigest || !previous.accountRateLimitHash || previous.consumedAt || previous.invalidatedAt
        || previous.expiresAt <= input.now || input.codeDigest.length !== 32 || input.expiresAt <= input.now) {
        throw new PhoneRecoveryConflictError();
      }
      let destinationEmail: string | null = null;
      let caseExpiresAt: Date | null = null;
      if (previous.caseId) {
        const recoveryCase = this.liveCase(previous.caseId, input.now);
        const user = this.usersById.get(recoveryCase.targetUserId);
        if (recoveryCase.status !== "EMAIL_PENDING" || input.expiresAt > recoveryCase.expiresAt || !user
          || !user.isActive || user.accountStatus !== "ACTIVE" || user.tokenVersion !== recoveryCase.tokenVersionAtIssue) {
          throw new PhoneRecoveryConflictError();
        }
        destinationEmail = user.email;
        caseExpiresAt = new Date(recoveryCase.expiresAt);
      }
      previous.invalidatedAt = new Date(input.now);
      this.challenges.set(input.challengeId, {
        ...structuredClone(previous), id: input.challengeId, codeDigest: Buffer.from(input.codeDigest),
        expiresAt: new Date(input.expiresAt), consumedAt: null, invalidatedAt: null,
      });
      return {
        id: input.challengeId, caseId: previous.caseId, codeDigest: Buffer.from(input.codeDigest),
        accountRateLimitHash: previous.accountRateLimitHash, expiresAt: new Date(input.expiresAt),
        caseExpiresAt, destinationEmail,
      };
    });
  }

  async recordEmailApproval(input: EmailApprovalInput): Promise<boolean> {
    return this.locked(() => {
      const recoveryCase = this.liveCase(input.caseId, input.approvedAt);
      const challenge = this.challenges.get(input.challengeId);
      if (recoveryCase.status !== "EMAIL_PENDING" || !challenge || challenge.caseId !== recoveryCase.id
        || challenge.purpose !== "PHONE_RECOVERY_EMAIL" || challenge.expiresAt <= input.approvedAt
        || challenge.consumedAt || challenge.invalidatedAt) return false;
      challenge.consumedAt = new Date(input.approvedAt);
      recoveryCase.emailVerifiedAt = new Date(input.approvedAt);
      recoveryCase.status = "EMAIL_VERIFIED";
      return true;
    });
  }

  async reservePhone(input: ReservePhoneInput): Promise<PhoneProofChallenge> {
    return this.locked(() => {
      const recoveryCase = this.liveCase(input.caseId, input.now);
      if (recoveryCase.status !== "EMAIL_VERIFIED" || input.expiresAt <= input.now || input.expiresAt > recoveryCase.expiresAt
        || !/^\d{4}$/.test(input.phoneLast4) || input.aliases.length === 0
        || !input.aliases.some(({ hash, keyVersion }) => hash === input.phoneLookupHash && keyVersion === input.phoneLookupKeyVersion)) {
        throw new PhoneRecoveryConflictError();
      }
      for (const alias of input.aliases) {
        const provisional = this.provisionalAliases.get(alias.hash);
        const owned = [...this.usersById.values()].some((user) => user.phoneLookupHash === alias.hash && user.id !== recoveryCase.targetUserId);
        if (owned || (provisional && provisional.caseId !== recoveryCase.id && provisional.expiresAt > input.now)) {
          throw new PhoneRecoveryConflictError();
        }
      }
      for (const alias of input.aliases) this.provisionalAliases.set(alias.hash, { caseId: recoveryCase.id, keyVersion: alias.keyVersion, expiresAt: new Date(recoveryCase.expiresAt) });
      this.challenges.set(input.challengeId, {
        id: input.challengeId, caseId: recoveryCase.id, purpose: "PHONE_RECOVERY_SMS", codeDigest: null,
        accountRateLimitHash: input.accountRateLimitHash,
        providerRef: input.providerRef, expiresAt: new Date(input.expiresAt), consumedAt: null, invalidatedAt: null,
        deliveryState: input.providerRef.startsWith("pending:") ? "PENDING" : "SENT",
      });
      recoveryCase.pendingPhone = structuredClone(input);
      recoveryCase.status = "PHONE_PENDING";
      return { ...view(recoveryCase), challengeId: input.challengeId };
    });
  }

  async replacePhoneChallenge(input: ReplacePhoneChallengeInput): Promise<PhoneProofChallenge> {
    return this.locked(() => {
      const previous = this.challenges.get(input.previousChallengeId);
      const recoveryCase = previous?.caseId ? this.liveCase(previous.caseId, input.now) : null;
      if (!previous || !recoveryCase || recoveryCase.status !== "PHONE_PENDING" || !recoveryCase.pendingPhone
        || previous.purpose !== "PHONE_RECOVERY_SMS" || previous.consumedAt || previous.invalidatedAt
        || previous.expiresAt <= input.now || input.expiresAt <= input.now || input.expiresAt > recoveryCase.expiresAt) {
        throw new PhoneRecoveryConflictError();
      }
      previous.invalidatedAt = new Date(input.now);
      this.challenges.set(input.challengeId, {
        ...structuredClone(previous), id: input.challengeId, providerRef: input.providerRef,
        expiresAt: new Date(input.expiresAt), consumedAt: null, invalidatedAt: null,
        deliveryState: input.providerRef.startsWith("pending:") ? "PENDING" : "SENT",
      });
      return { ...view(recoveryCase), challengeId: input.challengeId };
    });
  }

  async complete(input: CompletePhoneRecoveryInput): Promise<CompletedRecovery> {
    return this.locked(() => {
      const recoveryCase = this.liveCase(input.caseId, input.completedAt);
      const user = this.usersById.get(recoveryCase.targetUserId);
      const challenge = this.challenges.get(input.challengeId);
      const pending = recoveryCase.pendingPhone;
      if (recoveryCase.status !== "PHONE_PENDING" || !user || !pending || !challenge
        || challenge.caseId !== recoveryCase.id || challenge.purpose !== "PHONE_RECOVERY_SMS"
        || challenge.expiresAt <= input.completedAt || challenge.consumedAt || challenge.invalidatedAt
        || user.tokenVersion !== recoveryCase.tokenVersionAtIssue || user.phoneVersion !== recoveryCase.phoneVersionAtIssue) {
        throw new PhoneRecoveryConflictError();
      }
      challenge.consumedAt = new Date(input.completedAt);
      for (const candidate of this.challenges.values()) {
        if (candidate.caseId === recoveryCase.id && !candidate.consumedAt) candidate.invalidatedAt = new Date(input.completedAt);
      }
      for (const alias of pending.aliases) this.provisionalAliases.delete(alias.hash);
      Object.assign(user, {
        phoneEncrypted: pending.phoneEncrypted,
        phoneEncryptionKeyVersion: pending.phoneEncryptionKeyVersion,
        phoneLookupHash: pending.phoneLookupHash,
        phoneLookupKeyVersion: pending.phoneLookupKeyVersion,
        phoneLast4: pending.phoneLast4,
        phoneVerifiedAt: new Date(input.completedAt),
        phoneConsentAt: new Date(pending.consentAt),
        phoneConsentVersion: pending.consentVersion,
        tokenVersion: user.tokenVersion + 1,
        phoneVersion: user.phoneVersion + 1,
      });
      recoveryCase.status = "COMPLETED";
      recoveryCase.completedAt = new Date(input.completedAt);
      this.auditEvents.push({
        eventType: "phone_recovery_completed", actorUserId: recoveryCase.actorUserId,
        targetUserId: recoveryCase.targetUserId, correlationId: recoveryCase.id, createdAt: new Date(input.completedAt),
      });
      return { ...view(recoveryCase), tokenVersion: user.tokenVersion, phoneVersion: user.phoneVersion };
    });
  }

  async recordNotificationOutcome(input: RecoveryNotificationOutcomeInput): Promise<void> {
    this.auditEvents.push({
      eventType: `phone_recovery_${input.channel.toLowerCase()}_notification`,
      outcome: input.outcome,
      actorUserId: input.userId,
      targetUserId: input.userId,
      correlationId: input.caseId,
      safeReasonCode: input.safeReasonCode,
      createdAt: new Date(input.at),
    });
  }

  async recordAttemptOutcome(input: RecoveryAttemptOutcomeInput): Promise<void> {
    const challenge = this.challenges.get(input.challengeId);
    const recoveryCase = challenge?.caseId ? this.cases.get(challenge.caseId) : null;
    this.auditEvents.push({
      eventType: `phone_recovery_${input.phase.toLowerCase()}_${input.outcome}`,
      outcome: input.outcome,
      actorUserId: recoveryCase?.actorUserId ?? null,
      targetUserId: recoveryCase?.targetUserId ?? null,
      correlationId: recoveryCase?.id ?? input.challengeId,
      safeReasonCode: input.safeReasonCode,
      createdAt: new Date(input.at),
    });
  }

  async cancel(input: CancelRecoveryInput): Promise<boolean> {
    return this.locked(() => {
      const recoveryCase = this.liveCase(input.caseId, input.cancelledAt);
      const actor = this.usersById.get(input.actorUserId);
      if (!actor || actor.role !== "ADMIN" || !actor.isActive || actor.accountStatus !== "ACTIVE") return false;
      recoveryCase.status = "CANCELLED";
      recoveryCase.cancelledAt = new Date(input.cancelledAt);
      for (const challenge of this.challenges.values()) {
        if (challenge.caseId === recoveryCase.id && !challenge.consumedAt) challenge.invalidatedAt = new Date(input.cancelledAt);
      }
      for (const [hash, alias] of this.provisionalAliases) if (alias.caseId === recoveryCase.id) this.provisionalAliases.delete(hash);
      return true;
    });
  }

  async expireOpenCases(now: Date): Promise<number> {
    return this.locked(() => this.expireOpenCasesUnsafe(now));
  }

  async getAdminStatus(targetUserId: string): Promise<AdminPhoneRecoveryStatus> {
    const cases = [...this.cases.values()]
      .filter((candidate) => candidate.targetUserId === targetUserId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 10)
      .map((candidate) => ({
        caseId: candidate.id, status: candidate.status,
        startedAt: new Date(candidate.createdAt), expiresAt: new Date(candidate.expiresAt),
      }));
    const caseIds = new Set(cases.map(({ caseId }) => caseId));
    const events = this.auditEvents
      .filter((event) => caseIds.has(event.correlationId))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 50)
      .map((event) => ({
        eventType: event.eventType, outcome: event.outcome ?? "accepted",
        safeReasonCode: event.safeReasonCode ?? null, occurredAt: new Date(event.createdAt),
      }));
    return { cases, events };
  }

  user(id: string): RecoveryUser | undefined {
    const user = this.usersById.get(id);
    return user ? structuredClone(user) : undefined;
  }

  audits() {
    return structuredClone(this.auditEvents);
  }

  openCasesFor(userId: string): PhoneRecoveryCaseView[] {
    return [...this.cases.values()].filter((candidate) => candidate.targetUserId === userId && OPEN_STATUSES.has(candidate.status)).map(view);
  }
}

type DatabaseCaseRow = {
  id: string;
  targetUserId: string;
  actorUserId: string;
  status: PhoneRecoveryStatus;
  tokenVersionAtIssue: number;
  phoneVersionAtIssue: number;
  expiresAt: Date;
  pendingPhoneEncrypted: string | null;
  pendingPhoneEncryptionKeyVersion: number | null;
  pendingPhoneLookupHash: string | null;
  pendingPhoneLookupKeyVersion: number | null;
  pendingPhoneLast4: string | null;
  pendingConsentAt: Date | null;
  pendingConsentVersion: string | null;
};

function databaseView(recoveryCase: Pick<DatabaseCaseRow, "id" | "targetUserId" | "actorUserId" | "status" | "tokenVersionAtIssue" | "phoneVersionAtIssue" | "expiresAt">): PhoneRecoveryCaseView {
  return {
    id: recoveryCase.id,
    targetUserId: recoveryCase.targetUserId,
    actorUserId: recoveryCase.actorUserId,
    status: recoveryCase.status,
    tokenVersionAtIssue: recoveryCase.tokenVersionAtIssue,
    phoneVersionAtIssue: recoveryCase.phoneVersionAtIssue,
    expiresAt: recoveryCase.expiresAt,
  };
}

async function lockRecoveryCase(tx: Prisma.TransactionClient, caseId: string): Promise<DatabaseCaseRow | null> {
  const rows = await tx.$queryRaw<DatabaseCaseRow[]>`
    SELECT "id", "targetUserId", "actorUserId", "status", "tokenVersionAtIssue", "phoneVersionAtIssue", "expiresAt",
      "pendingPhoneEncrypted", "pendingPhoneEncryptionKeyVersion", "pendingPhoneLookupHash", "pendingPhoneLookupKeyVersion",
      "pendingPhoneLast4", "pendingConsentAt", "pendingConsentVersion"
    FROM "PhoneRecoveryCase" WHERE "id" = ${caseId} FOR UPDATE
  `;
  return rows[0] ?? null;
}

function isLive(recoveryCase: DatabaseCaseRow | null, now: Date, status?: PhoneRecoveryStatus): recoveryCase is DatabaseCaseRow {
  return Boolean(recoveryCase && recoveryCase.expiresAt > now && OPEN_STATUSES.has(recoveryCase.status)
    && (status === undefined || recoveryCase.status === status));
}

export class PrismaPhoneRecoveryRepository implements PhoneRecoveryRepository {
  constructor(private readonly client: Pick<typeof prisma, "$transaction"> = prisma) {}

  async getRecoveryTarget(userId: string): Promise<RecoveryTargetIdentity | null> {
    return prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, employeeNumber: true, phoneVerifiedAt: true, phoneEncrypted: true, phoneEncryptionKeyVersion: true },
    });
  }

  async findPublicCase(input: PublicRecoveryIdentity): Promise<PhoneRecoveryCaseView | null> {
    const recoveryCase = await prisma.phoneRecoveryCase.findFirst({
      where: {
        caseReferenceHash: input.caseReferenceHash,
        status: "EMAIL_PENDING",
        expiresAt: { gt: input.now },
        targetUser: {
          email: input.email,
          employeeNumber: input.employeeNumber === "" ? null : input.employeeNumber,
          isActive: true,
          accountStatus: "ACTIVE",
        },
      },
      include: { targetUser: { select: { tokenVersion: true } } },
    });
    return recoveryCase && recoveryCase.targetUser.tokenVersion === recoveryCase.tokenVersionAtIssue
      ? databaseView(recoveryCase as DatabaseCaseRow)
      : null;
  }

  async readEmailChallenge(challengeId: string): Promise<EmailChallengeProof | null> {
    const challenge = await prisma.mfaChallenge.findFirst({
      where: {
        id: challengeId, purpose: "PHONE_RECOVERY_EMAIL", method: "EMAIL",
        consumedAt: null, invalidatedAt: null,
      },
      select: {
        id: true, phoneRecoveryCaseId: true, localCodeDigest: true, accountRateLimitHash: true, expiresAt: true,
        phoneRecoveryCase: { select: { expiresAt: true } },
      },
    });
    if (!challenge?.localCodeDigest || !challenge.accountRateLimitHash) return null;
    return {
      id: challenge.id, caseId: challenge.phoneRecoveryCaseId, codeDigest: Buffer.from(challenge.localCodeDigest),
      accountRateLimitHash: challenge.accountRateLimitHash, expiresAt: challenge.expiresAt,
      caseExpiresAt: challenge.phoneRecoveryCase?.expiresAt ?? null,
    };
  }

  async readApprovedEmailChallenge(challengeId: string): Promise<ApprovedEmailChallenge | null> {
    const challenge = await prisma.mfaChallenge.findFirst({
      where: {
        id: challengeId, purpose: "PHONE_RECOVERY_EMAIL", method: "EMAIL",
        consumedAt: { not: null }, invalidatedAt: null,
        phoneRecoveryCase: { status: "EMAIL_VERIFIED" },
      },
      select: {
        id: true, phoneRecoveryCaseId: true, localCodeDigest: true, accountRateLimitHash: true,
        expiresAt: true, consumedAt: true, phoneRecoveryCase: { select: { expiresAt: true } },
      },
    });
    if (!challenge?.phoneRecoveryCaseId || !challenge.localCodeDigest || !challenge.accountRateLimitHash
      || !challenge.consumedAt || !challenge.phoneRecoveryCase) return null;
    return {
      id: challenge.id, caseId: challenge.phoneRecoveryCaseId, codeDigest: Buffer.from(challenge.localCodeDigest),
      accountRateLimitHash: challenge.accountRateLimitHash, expiresAt: challenge.expiresAt, approvedAt: challenge.consumedAt,
      caseExpiresAt: challenge.phoneRecoveryCase.expiresAt,
    };
  }

  async readPhoneChallenge(challengeId: string): Promise<RecoveryPhoneChallenge | null> {
    const challenge = await prisma.mfaChallenge.findFirst({
      where: {
        id: challengeId, purpose: "PHONE_RECOVERY_SMS", method: "SMS", consumedAt: null, invalidatedAt: null,
        phoneRecoveryCase: { status: "PHONE_PENDING" },
      },
      select: {
        id: true, phoneRecoveryCaseId: true, userId: true, phoneLookupHash: true, phonePrefixHash: true,
        accountRateLimitHash: true, destinationVersion: true,
        tokenVersionAtIssue: true, smsDestinationEncrypted: true, smsDestinationEncryptionKeyVersion: true,
        smsDeliveryState: true, expiresAt: true,
        phoneRecoveryCase: { select: { pendingPhoneLast4: true, expiresAt: true } },
      },
    });
    if (!challenge?.phoneRecoveryCaseId || !challenge.userId || !challenge.phoneLookupHash || !challenge.phonePrefixHash
      || !challenge.accountRateLimitHash
      || challenge.destinationVersion === null || challenge.tokenVersionAtIssue === null
      || !challenge.smsDestinationEncrypted || challenge.smsDestinationEncryptionKeyVersion === null
      || !challenge.phoneRecoveryCase?.pendingPhoneLast4
      || !challenge.smsDeliveryState) return null;
    return {
      id: challenge.id, caseId: challenge.phoneRecoveryCaseId, userId: challenge.userId,
      destinationHash: challenge.phoneLookupHash, phonePrefixHash: challenge.phonePrefixHash,
      accountRateLimitHash: challenge.accountRateLimitHash, destinationVersion: challenge.destinationVersion,
      tokenVersionAtIssue: challenge.tokenVersionAtIssue, destinationEncrypted: challenge.smsDestinationEncrypted,
      destinationEncryptionKeyVersion: challenge.smsDestinationEncryptionKeyVersion,
      phoneLast4: challenge.phoneRecoveryCase.pendingPhoneLast4,
      deliveryState: challenge.smsDeliveryState, expiresAt: challenge.expiresAt,
      caseExpiresAt: challenge.phoneRecoveryCase.expiresAt,
    };
  }

  async createNoticePending(input: InitiateRecoveryInput): Promise<PhoneRecoveryCaseView> {
    if (input.actorUserId === input.targetUserId || input.expiresAt <= input.now) throw new PhoneRecoveryConflictError();
    try {
      return await this.client.$transaction(async (tx) => {
        const users = await tx.$queryRaw<Array<{
          id: string; role: "ADMIN" | "GENERAL"; isActive: boolean; accountStatus: string;
          tokenVersion: number; phoneVersion: number;
        }>>`
          SELECT "id", "role", "isActive", "accountStatus", "tokenVersion", "phoneVersion"
          FROM "User" WHERE "id" IN (${input.actorUserId}, ${input.targetUserId}) ORDER BY "id" FOR UPDATE
        `;
        const actor = users.find(({ id }) => id === input.actorUserId);
        const target = users.find(({ id }) => id === input.targetUserId);
        if (!actor || actor.role !== "ADMIN" || !actor.isActive || actor.accountStatus !== "ACTIVE"
          || !target || !target.isActive || target.accountStatus !== "ACTIVE") throw new PhoneRecoveryConflictError();
        const expired = await tx.$queryRaw<Array<{ id: string; actorUserId: string; targetUserId: string }>>`
          SELECT "id", "actorUserId", "targetUserId"
          FROM "PhoneRecoveryCase"
          WHERE "targetUserId" = ${target.id}
            AND "status" IN ('NOTICE_PENDING', 'EMAIL_PENDING', 'EMAIL_VERIFIED', 'PHONE_PENDING')
            AND "expiresAt" <= ${input.now}
          ORDER BY "id"
          FOR UPDATE
        `;
        if (expired.length > 0) {
          const expiredIds = expired.map(({ id }) => id);
          await tx.phoneRecoveryCase.updateMany({
            where: { id: { in: expiredIds } },
            data: { status: "EXPIRED", expiredAt: input.now, updatedAt: input.now },
          });
          await tx.mfaChallenge.updateMany({
            where: { phoneRecoveryCaseId: { in: expiredIds }, consumedAt: null, invalidatedAt: null },
            data: { invalidatedAt: input.now },
          });
          await tx.phoneRecoveryPhoneAlias.deleteMany({ where: { caseId: { in: expiredIds } } });
          await tx.securityAuditEvent.createMany({
            data: expired.map((recoveryCase) => ({
              id: randomUUID(), eventType: "phone_recovery_expired", outcome: "accepted",
              actorUserId: recoveryCase.actorUserId, targetUserId: recoveryCase.targetUserId,
              safeReasonCode: "case_expired", correlationId: recoveryCase.id, createdAt: input.now,
            })),
          });
        }
        const created = await tx.phoneRecoveryCase.create({
          data: {
            id: input.id,
            actorUserId: actor.id,
            targetUserId: target.id,
            caseReferenceHash: input.caseReferenceHash,
            tokenVersionAtIssue: target.tokenVersion,
            phoneVersionAtIssue: target.phoneVersion,
            expiresAt: input.expiresAt,
            createdAt: input.now,
            updatedAt: input.now,
          },
        });
        await tx.securityAuditEvent.create({
          data: {
            id: randomUUID(), eventType: "phone_recovery_initiated", outcome: "accepted",
            actorUserId: actor.id, targetUserId: target.id, safeReasonCode: null,
            correlationId: created.id, createdAt: input.now,
          },
        });
        return databaseView(created as DatabaseCaseRow);
      });
    } catch (error) {
      if (error instanceof PhoneRecoveryConflictError || (typeof error === "object" && error !== null && "code" in error && error.code === "P2002")) {
        throw new PhoneRecoveryConflictError();
      }
      throw error;
    }
  }

  async markNoticeAccepted(caseId: string, at: Date): Promise<boolean> {
    return this.client.$transaction(async (tx) => {
      const recoveryCase = await lockRecoveryCase(tx, caseId);
      if (!isLive(recoveryCase, at, "NOTICE_PENDING")) return false;
      const updated = await tx.phoneRecoveryCase.updateMany({
        where: { id: caseId, status: "NOTICE_PENDING" },
        data: { status: "EMAIL_PENDING", noticeAcceptedAt: at, updatedAt: at },
      });
      return updated.count === 1;
    });
  }

  async markNoticeFailed(caseId: string, reason: string, at: Date): Promise<void> {
    if (!reason.trim()) throw new PhoneRecoveryConflictError();
    await this.client.$transaction(async (tx) => {
      const recoveryCase = await lockRecoveryCase(tx, caseId);
      if (!isLive(recoveryCase, at, "NOTICE_PENDING")) throw new PhoneRecoveryConflictError();
      await tx.phoneRecoveryCase.update({
        where: { id: caseId },
        data: { status: "FAILED", failedAt: at, safeFailureReason: reason.trim(), updatedAt: at },
      });
      await tx.securityAuditEvent.create({
        data: {
          id: randomUUID(), eventType: "phone_recovery_notice_failed", outcome: "failed",
          actorUserId: recoveryCase.actorUserId, targetUserId: recoveryCase.targetUserId,
          safeReasonCode: reason.trim(), correlationId: recoveryCase.id, createdAt: at,
        },
      });
    });
  }

  async beginEmailProof(input: BeginEmailProofInput): Promise<EmailProofChallenge> {
    if (input.codeDigest.length !== 32 || input.expiresAt <= input.now) throw new PhoneRecoveryConflictError();
    return this.client.$transaction(async (tx) => {
      const recoveryCase = await lockRecoveryCase(tx, input.caseId);
      if (!isLive(recoveryCase, input.now, "EMAIL_PENDING") || input.expiresAt > recoveryCase.expiresAt) {
        throw new PhoneRecoveryConflictError();
      }
      await tx.mfaChallenge.updateMany({
        where: { phoneRecoveryCaseId: input.caseId, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: input.now },
      });
      await tx.mfaChallenge.create({
        data: {
          id: input.challengeId,
          userId: recoveryCase.targetUserId,
          phoneRecoveryCaseId: recoveryCase.id,
          purpose: "PHONE_RECOVERY_EMAIL",
          method: "EMAIL",
          destinationVersion: recoveryCase.tokenVersionAtIssue,
          tokenVersionAtIssue: recoveryCase.tokenVersionAtIssue,
          providerRef: "local",
          localCodeDigest: new Uint8Array(input.codeDigest),
          accountRateLimitHash: input.accountRateLimitHash,
          expiresAt: input.expiresAt,
          createdAt: input.now,
        },
      });
      return { id: input.challengeId, caseId: input.caseId, expiresAt: input.expiresAt };
    });
  }

  async beginEmailDecoy(input: BeginEmailDecoyInput): Promise<EmailChallengeProof> {
    if (input.codeDigest.length !== 32 || !/^[a-f0-9]{64}$/.test(input.accountRateLimitHash)
      || input.expiresAt <= input.now) throw new PhoneRecoveryConflictError();
    return this.client.$transaction(async (tx) => {
      await tx.mfaChallenge.updateMany({
        where: {
          purpose: "PHONE_RECOVERY_EMAIL", method: "EMAIL", phoneRecoveryCaseId: null,
          accountRateLimitHash: input.accountRateLimitHash, consumedAt: null, invalidatedAt: null,
        },
        data: { invalidatedAt: input.now },
      });
      await tx.mfaChallenge.create({
        data: {
          id: input.challengeId,
          purpose: "PHONE_RECOVERY_EMAIL",
          method: "EMAIL",
          providerRef: "local",
          localCodeDigest: new Uint8Array(input.codeDigest),
          accountRateLimitHash: input.accountRateLimitHash,
          expiresAt: input.expiresAt,
          createdAt: input.now,
        },
      });
      return {
        id: input.challengeId, caseId: null, codeDigest: Buffer.from(input.codeDigest),
        accountRateLimitHash: input.accountRateLimitHash, expiresAt: input.expiresAt,
        caseExpiresAt: null,
      };
    });
  }

  async replaceEmailChallenge(input: ReplaceEmailChallengeInput): Promise<ReplacedEmailChallenge> {
    if (input.previousChallengeId === input.challengeId || input.codeDigest.length !== 32 || input.expiresAt <= input.now) {
      throw new PhoneRecoveryConflictError();
    }
    return this.client.$transaction(async (tx) => {
      const previous = await tx.mfaChallenge.findFirst({
        where: {
          id: input.previousChallengeId, purpose: "PHONE_RECOVERY_EMAIL", method: "EMAIL",
          consumedAt: null, invalidatedAt: null, expiresAt: { gt: input.now },
        },
        select: { phoneRecoveryCaseId: true, userId: true, accountRateLimitHash: true },
      });
      if (!previous?.accountRateLimitHash) throw new PhoneRecoveryConflictError();

      let destinationEmail: string | null = null;
      let caseExpiresAt: Date | null = null;
      let destinationVersion: number | null = null;
      let tokenVersionAtIssue: number | null = null;
      if (previous.phoneRecoveryCaseId) {
        const recoveryCase = await lockRecoveryCase(tx, previous.phoneRecoveryCaseId);
        if (!isLive(recoveryCase, input.now, "EMAIL_PENDING") || input.expiresAt > recoveryCase.expiresAt
          || previous.userId !== recoveryCase.targetUserId) throw new PhoneRecoveryConflictError();
        const users = await tx.$queryRaw<Array<{
          id: string; email: string; isActive: boolean; accountStatus: string; tokenVersion: number;
        }>>`
          SELECT "id", "email", "isActive", "accountStatus", "tokenVersion" FROM "User"
          WHERE "id" = ${recoveryCase.targetUserId} FOR UPDATE
        `;
        const user = users[0];
        if (!user || !user.isActive || user.accountStatus !== "ACTIVE"
          || user.tokenVersion !== recoveryCase.tokenVersionAtIssue) throw new PhoneRecoveryConflictError();
        destinationEmail = user.email;
        caseExpiresAt = recoveryCase.expiresAt;
        destinationVersion = recoveryCase.tokenVersionAtIssue;
        tokenVersionAtIssue = recoveryCase.tokenVersionAtIssue;
      }

      const invalidated = await tx.mfaChallenge.updateMany({
        where: {
          id: input.previousChallengeId, purpose: "PHONE_RECOVERY_EMAIL", method: "EMAIL",
          consumedAt: null, invalidatedAt: null, expiresAt: { gt: input.now },
        },
        data: { invalidatedAt: input.now },
      });
      if (invalidated.count !== 1) throw new PhoneRecoveryConflictError();
      await tx.mfaChallenge.create({
        data: {
          id: input.challengeId, userId: previous.userId, phoneRecoveryCaseId: previous.phoneRecoveryCaseId,
          purpose: "PHONE_RECOVERY_EMAIL", method: "EMAIL", providerRef: "local",
          destinationVersion, tokenVersionAtIssue,
          localCodeDigest: new Uint8Array(input.codeDigest),
          accountRateLimitHash: previous.accountRateLimitHash,
          expiresAt: input.expiresAt, createdAt: input.now,
        },
      });
      return {
        id: input.challengeId, caseId: previous.phoneRecoveryCaseId,
        codeDigest: Buffer.from(input.codeDigest), accountRateLimitHash: previous.accountRateLimitHash,
        expiresAt: input.expiresAt, caseExpiresAt, destinationEmail,
      };
    });
  }

  async recordEmailApproval(input: EmailApprovalInput): Promise<boolean> {
    return this.client.$transaction(async (tx) => {
      const recoveryCase = await lockRecoveryCase(tx, input.caseId);
      if (!isLive(recoveryCase, input.approvedAt, "EMAIL_PENDING")) return false;
      const consumed = await tx.mfaChallenge.updateMany({
        where: {
          id: input.challengeId, phoneRecoveryCaseId: input.caseId, purpose: "PHONE_RECOVERY_EMAIL", method: "EMAIL",
          consumedAt: null, invalidatedAt: null, expiresAt: { gt: input.approvedAt },
        },
        data: { consumedAt: input.approvedAt },
      });
      if (consumed.count !== 1) return false;
      const updated = await tx.phoneRecoveryCase.updateMany({
        where: { id: input.caseId, status: "EMAIL_PENDING" },
        data: { status: "EMAIL_VERIFIED", emailVerifiedAt: input.approvedAt, updatedAt: input.approvedAt },
      });
      return updated.count === 1;
    });
  }

  async reservePhone(input: ReservePhoneInput): Promise<PhoneProofChallenge> {
    if (input.aliases.length === 0 || input.expiresAt <= input.now || !/^\d{4}$/.test(input.phoneLast4)
      || !input.aliases.some(({ hash, keyVersion }) => hash === input.phoneLookupHash && keyVersion === input.phoneLookupKeyVersion)) {
      throw new PhoneRecoveryConflictError();
    }
    try {
      return await this.client.$transaction(async (tx) => {
        const recoveryCase = await lockRecoveryCase(tx, input.caseId);
        if (!isLive(recoveryCase, input.now, "EMAIL_VERIFIED") || input.expiresAt > recoveryCase.expiresAt) {
          throw new PhoneRecoveryConflictError();
        }
        for (const alias of [...input.aliases].sort((left, right) => left.hash.localeCompare(right.hash))) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${alias.hash}))`;
        }
        await tx.phoneRecoveryPhoneAlias.deleteMany({ where: { expiresAt: { lte: input.now } } });
        const owned = await tx.phoneLookupAlias.findFirst({
          where: { hash: { in: input.aliases.map(({ hash }) => hash) }, userId: { not: recoveryCase.targetUserId } },
          select: { hash: true },
        });
        const reserved = await tx.phoneRecoveryPhoneAlias.findFirst({
          where: { hash: { in: input.aliases.map(({ hash }) => hash) }, caseId: { not: recoveryCase.id }, expiresAt: { gt: input.now } },
          select: { hash: true },
        });
        if (owned || reserved) throw new PhoneRecoveryConflictError();
        await tx.phoneRecoveryPhoneAlias.createMany({
          data: input.aliases.map((alias) => ({ ...alias, caseId: recoveryCase.id, expiresAt: recoveryCase.expiresAt, createdAt: input.now })),
        });
        await tx.mfaChallenge.create({
          data: {
            id: input.challengeId,
            userId: recoveryCase.targetUserId,
            phoneRecoveryCaseId: recoveryCase.id,
            purpose: "PHONE_RECOVERY_SMS",
            method: "SMS",
            phoneLookupHash: input.phoneLookupHash,
            phonePrefixHash: input.phonePrefixHash,
            accountRateLimitHash: input.accountRateLimitHash,
            destinationVersion: recoveryCase.phoneVersionAtIssue + 1,
            tokenVersionAtIssue: recoveryCase.tokenVersionAtIssue,
            providerRef: input.providerRef,
            smsDestinationEncrypted: input.phoneEncrypted,
            smsDestinationEncryptionKeyVersion: input.phoneEncryptionKeyVersion,
            smsDeliveryState: input.providerRef.startsWith("pending:") ? "PENDING" : "SENT",
            smsDeliveryCompletedAt: input.providerRef.startsWith("pending:") ? null : input.now,
            expiresAt: input.expiresAt,
            createdAt: input.now,
          },
        });
        const updated = await tx.phoneRecoveryCase.update({
          where: { id: recoveryCase.id },
          data: {
            status: "PHONE_PENDING",
            pendingPhoneEncrypted: input.phoneEncrypted,
            pendingPhoneEncryptionKeyVersion: input.phoneEncryptionKeyVersion,
            pendingPhoneLookupHash: input.phoneLookupHash,
            pendingPhoneLookupKeyVersion: input.phoneLookupKeyVersion,
            pendingPhoneLast4: input.phoneLast4,
            pendingConsentAt: input.consentAt,
            pendingConsentVersion: input.consentVersion,
            updatedAt: input.now,
          },
        });
        return { ...databaseView(updated as DatabaseCaseRow), challengeId: input.challengeId };
      });
    } catch (error) {
      if (error instanceof PhoneRecoveryConflictError || (typeof error === "object" && error !== null && "code" in error && error.code === "P2002")) {
        throw new PhoneRecoveryConflictError();
      }
      throw error;
    }
  }

  async replacePhoneChallenge(input: ReplacePhoneChallengeInput): Promise<PhoneProofChallenge> {
    return this.client.$transaction(async (tx) => {
      if (input.previousChallengeId === input.challengeId) throw new PhoneRecoveryConflictError();
      const binding = await tx.mfaChallenge.findUnique({
        where: { id: input.previousChallengeId },
        select: { phoneRecoveryCaseId: true },
      });
      if (!binding?.phoneRecoveryCaseId) throw new PhoneRecoveryConflictError();
      const recoveryCase = await lockRecoveryCase(tx, binding.phoneRecoveryCaseId);
      if (!isLive(recoveryCase, input.now, "PHONE_PENDING") || input.expiresAt <= input.now
        || input.expiresAt > recoveryCase.expiresAt || !recoveryCase.pendingPhoneEncrypted
        || recoveryCase.pendingPhoneEncryptionKeyVersion === null || !recoveryCase.pendingPhoneLookupHash) {
        throw new PhoneRecoveryConflictError();
      }
      const users = await tx.$queryRaw<Array<{ id: string; tokenVersion: number; phoneVersion: number }>>`
        SELECT "id", "tokenVersion", "phoneVersion" FROM "User"
        WHERE "id" = ${recoveryCase.targetUserId} FOR UPDATE
      `;
      const user = users[0];
      if (!user || user.tokenVersion !== recoveryCase.tokenVersionAtIssue
        || user.phoneVersion !== recoveryCase.phoneVersionAtIssue) throw new PhoneRecoveryConflictError();

      const previous = await tx.mfaChallenge.findFirst({
        where: {
          id: input.previousChallengeId, phoneRecoveryCaseId: recoveryCase.id,
          userId: recoveryCase.targetUserId, purpose: "PHONE_RECOVERY_SMS", method: "SMS",
          phoneLookupHash: recoveryCase.pendingPhoneLookupHash,
          destinationVersion: recoveryCase.phoneVersionAtIssue + 1,
          tokenVersionAtIssue: recoveryCase.tokenVersionAtIssue,
          consumedAt: null, invalidatedAt: null, expiresAt: { gt: input.now },
        },
        select: {
          phoneLookupHash: true, phonePrefixHash: true, accountRateLimitHash: true,
          destinationVersion: true, tokenVersionAtIssue: true, smsDestinationEncrypted: true,
          smsDestinationEncryptionKeyVersion: true,
        },
      });
      if (!previous?.phoneLookupHash || !previous.phonePrefixHash || !previous.accountRateLimitHash
        || previous.destinationVersion === null || previous.tokenVersionAtIssue === null
        || !previous.smsDestinationEncrypted || previous.smsDestinationEncryptionKeyVersion === null) {
        throw new PhoneRecoveryConflictError();
      }
      const invalidated = await tx.mfaChallenge.updateMany({
        where: {
          id: input.previousChallengeId, consumedAt: null, invalidatedAt: null,
          expiresAt: { gt: input.now },
        },
        data: { invalidatedAt: input.now },
      });
      if (invalidated.count !== 1) throw new PhoneRecoveryConflictError();
      await tx.mfaChallenge.create({
        data: {
          id: input.challengeId, userId: recoveryCase.targetUserId, phoneRecoveryCaseId: recoveryCase.id,
          purpose: "PHONE_RECOVERY_SMS", method: "SMS", phoneLookupHash: previous.phoneLookupHash,
          phonePrefixHash: previous.phonePrefixHash, accountRateLimitHash: previous.accountRateLimitHash,
          destinationVersion: previous.destinationVersion, tokenVersionAtIssue: previous.tokenVersionAtIssue,
          providerRef: input.providerRef, smsDestinationEncrypted: previous.smsDestinationEncrypted,
          smsDestinationEncryptionKeyVersion: previous.smsDestinationEncryptionKeyVersion,
          smsDeliveryState: input.providerRef.startsWith("pending:") ? "PENDING" : "SENT",
          smsDeliveryCompletedAt: input.providerRef.startsWith("pending:") ? null : input.now,
          expiresAt: input.expiresAt, createdAt: input.now,
        },
      });
      return { ...databaseView(recoveryCase), challengeId: input.challengeId };
    });
  }

  async complete(input: CompletePhoneRecoveryInput): Promise<CompletedRecovery> {
    return this.client.$transaction(async (tx) => {
      const recoveryCase = await lockRecoveryCase(tx, input.caseId);
      if (!isLive(recoveryCase, input.completedAt, "PHONE_PENDING")
        || !recoveryCase.pendingPhoneEncrypted || recoveryCase.pendingPhoneEncryptionKeyVersion === null
        || !recoveryCase.pendingPhoneLookupHash || recoveryCase.pendingPhoneLookupKeyVersion === null
        || !recoveryCase.pendingPhoneLast4 || !recoveryCase.pendingConsentAt || !recoveryCase.pendingConsentVersion) {
        throw new PhoneRecoveryConflictError();
      }
      const users = await tx.$queryRaw<Array<{ id: string; tokenVersion: number; phoneVersion: number }>>`
        SELECT "id", "tokenVersion", "phoneVersion" FROM "User"
        WHERE "id" = ${recoveryCase.targetUserId} FOR UPDATE
      `;
      const user = users[0];
      if (!user || user.tokenVersion !== recoveryCase.tokenVersionAtIssue || user.phoneVersion !== recoveryCase.phoneVersionAtIssue) {
        throw new PhoneRecoveryConflictError();
      }
      const challenge = await tx.mfaChallenge.updateMany({
        where: {
          id: input.challengeId, phoneRecoveryCaseId: recoveryCase.id, purpose: "PHONE_RECOVERY_SMS", method: "SMS",
          consumedAt: null, invalidatedAt: null, expiresAt: { gt: input.completedAt },
        },
        data: { consumedAt: input.completedAt },
      });
      if (challenge.count !== 1) throw new PhoneRecoveryConflictError();

      const aliases = await tx.phoneRecoveryPhoneAlias.findMany({ where: { caseId: recoveryCase.id }, orderBy: { hash: "asc" } });
      if (aliases.length === 0 || !aliases.some(({ hash }) => hash === recoveryCase.pendingPhoneLookupHash)) {
        throw new PhoneRecoveryConflictError();
      }
      const oldAliases = await tx.phoneLookupAlias.findMany({ where: { userId: user.id }, select: { hash: true } });
      for (const hash of [...new Set([...aliases.map(({ hash }) => hash), ...oldAliases.map(({ hash }) => hash)])].sort()) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${hash}))`;
      }
      await tx.phoneRecoveryPhoneAlias.deleteMany({ where: { caseId: recoveryCase.id } });
      await tx.phoneLookupAlias.deleteMany({ where: { userId: user.id } });
      const updated = await tx.user.updateMany({
        where: { id: user.id, tokenVersion: recoveryCase.tokenVersionAtIssue, phoneVersion: recoveryCase.phoneVersionAtIssue },
        data: {
          phoneEncrypted: recoveryCase.pendingPhoneEncrypted,
          phoneEncryptionKeyVersion: recoveryCase.pendingPhoneEncryptionKeyVersion,
          phoneLookupHash: recoveryCase.pendingPhoneLookupHash,
          phoneLookupKeyVersion: recoveryCase.pendingPhoneLookupKeyVersion,
          phoneLast4: recoveryCase.pendingPhoneLast4,
          phoneVerifiedAt: input.completedAt,
          phoneConsentAt: recoveryCase.pendingConsentAt,
          phoneConsentVersion: recoveryCase.pendingConsentVersion,
          phoneConsentSource: "PHONE_RECOVERY",
          tokenVersion: { increment: 1 },
          phoneVersion: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new PhoneRecoveryConflictError();
      await tx.phoneLookupAlias.createMany({
        data: aliases
          .filter(({ hash }) => hash !== recoveryCase.pendingPhoneLookupHash)
          .map(({ hash, keyVersion }) => ({ hash, keyVersion, userId: user.id })),
      });
      await tx.mfaChallenge.updateMany({
        where: { userId: user.id, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: input.completedAt },
      });
      await tx.phoneRecoveryCase.update({
        where: { id: recoveryCase.id },
        data: { status: "COMPLETED", phoneVerifiedAt: input.completedAt, completedAt: input.completedAt, updatedAt: input.completedAt },
      });
      await tx.securityAuditEvent.create({
        data: {
          id: randomUUID(), eventType: "phone_recovery_completed", outcome: "accepted", method: "SMS",
          actorUserId: recoveryCase.actorUserId, targetUserId: recoveryCase.targetUserId,
          safeReasonCode: null, correlationId: recoveryCase.id, createdAt: input.completedAt,
        },
      });
      return {
        ...databaseView({ ...recoveryCase, status: "COMPLETED" }),
        tokenVersion: user.tokenVersion + 1,
        phoneVersion: user.phoneVersion + 1,
      };
    });
  }

  async recordNotificationOutcome(input: RecoveryNotificationOutcomeInput): Promise<void> {
    await this.client.$transaction(async (tx) => {
      await tx.securityAuditEvent.create({
        data: {
          id: randomUUID(),
          eventType: `phone_recovery_${input.channel.toLowerCase()}_notification`,
          outcome: input.outcome,
          method: input.channel,
          actorUserId: input.userId,
          targetUserId: input.userId,
          safeReasonCode: input.safeReasonCode,
          correlationId: input.caseId,
          createdAt: input.at,
        },
      });
    });
  }

  async recordAttemptOutcome(input: RecoveryAttemptOutcomeInput): Promise<void> {
    await this.client.$transaction(async (tx) => {
      const challenge = await tx.mfaChallenge.findUnique({
        where: { id: input.challengeId },
        select: {
          phoneRecoveryCase: { select: { id: true, actorUserId: true, targetUserId: true } },
        },
      });
      const recoveryCase = challenge?.phoneRecoveryCase ?? null;
      await tx.securityAuditEvent.create({
        data: {
          id: randomUUID(),
          eventType: `phone_recovery_${input.phase.toLowerCase()}_${input.outcome}`,
          outcome: input.outcome,
          method: input.phase,
          actorUserId: recoveryCase?.actorUserId ?? null,
          targetUserId: recoveryCase?.targetUserId ?? null,
          safeReasonCode: input.safeReasonCode,
          correlationId: recoveryCase?.id ?? input.challengeId,
          createdAt: input.at,
        },
      });
    });
  }

  async cancel(input: CancelRecoveryInput): Promise<boolean> {
    return this.client.$transaction(async (tx) => {
      const recoveryCase = await lockRecoveryCase(tx, input.caseId);
      if (!isLive(recoveryCase, input.cancelledAt)) return false;
      const actor = await tx.user.findUnique({
        where: { id: input.actorUserId }, select: { role: true, isActive: true, accountStatus: true },
      });
      if (!actor || actor.role !== "ADMIN" || !actor.isActive || actor.accountStatus !== "ACTIVE") return false;
      await tx.phoneRecoveryCase.update({
        where: { id: recoveryCase.id }, data: { status: "CANCELLED", cancelledAt: input.cancelledAt, updatedAt: input.cancelledAt },
      });
      await tx.mfaChallenge.updateMany({
        where: { phoneRecoveryCaseId: recoveryCase.id, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: input.cancelledAt },
      });
      await tx.phoneRecoveryPhoneAlias.deleteMany({ where: { caseId: recoveryCase.id } });
      await tx.securityAuditEvent.create({
        data: {
          id: randomUUID(), eventType: "phone_recovery_cancelled", outcome: "accepted",
          actorUserId: actor ? input.actorUserId : null, targetUserId: recoveryCase.targetUserId,
          safeReasonCode: null, correlationId: recoveryCase.id, createdAt: input.cancelledAt,
        },
      });
      return true;
    });
  }

  async expireOpenCases(now: Date): Promise<number> {
    return this.client.$transaction(async (tx) => {
      const expired = await tx.$queryRaw<Array<{ id: string; actorUserId: string; targetUserId: string }>>`
        SELECT "id", "actorUserId", "targetUserId"
        FROM "PhoneRecoveryCase"
        WHERE "status" IN ('NOTICE_PENDING', 'EMAIL_PENDING', 'EMAIL_VERIFIED', 'PHONE_PENDING')
          AND "expiresAt" <= ${now}
        ORDER BY "id"
        FOR UPDATE
      `;
      if (expired.length === 0) return 0;
      const caseIds = expired.map(({ id }) => id);
      await tx.phoneRecoveryCase.updateMany({
        where: { id: { in: caseIds } },
        data: { status: "EXPIRED", expiredAt: now, updatedAt: now },
      });
      await tx.mfaChallenge.updateMany({
        where: { phoneRecoveryCaseId: { in: caseIds }, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: now },
      });
      await tx.phoneRecoveryPhoneAlias.deleteMany({ where: { caseId: { in: caseIds } } });
      await tx.securityAuditEvent.createMany({
        data: expired.map((recoveryCase) => ({
          id: randomUUID(), eventType: "phone_recovery_expired", outcome: "accepted",
          actorUserId: recoveryCase.actorUserId, targetUserId: recoveryCase.targetUserId,
          safeReasonCode: "case_expired", correlationId: recoveryCase.id, createdAt: now,
        })),
      });
      return expired.length;
    });
  }

  async getAdminStatus(targetUserId: string): Promise<AdminPhoneRecoveryStatus> {
    return this.client.$transaction(async (tx) => {
      const cases = await tx.phoneRecoveryCase.findMany({
        where: { targetUserId },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true, status: true, createdAt: true, expiresAt: true },
      });
      const caseIds = cases.map(({ id }) => id);
      const events = caseIds.length === 0 ? [] : await tx.securityAuditEvent.findMany({
        where: { correlationId: { in: caseIds }, eventType: { startsWith: "phone_recovery_" } },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { eventType: true, outcome: true, safeReasonCode: true, createdAt: true },
      });
      return {
        cases: cases.map((candidate) => ({
          caseId: candidate.id, status: candidate.status,
          startedAt: candidate.createdAt, expiresAt: candidate.expiresAt,
        })),
        events: events.map((event) => ({
          eventType: event.eventType, outcome: event.outcome,
          safeReasonCode: event.safeReasonCode, occurredAt: event.createdAt,
        })),
      };
    });
  }
}
