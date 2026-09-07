import { createHmac, randomUUID } from "node:crypto";
import { VerificationAmbiguousError, VerificationProviderError, type VerificationProvider } from "./verificationProvider.js";
import { prisma } from "./prisma.js";
import { encryptPhone } from "./phone.js";
import {
  consumeVerificationBudget,
  consumeIncorrectVerificationAttempt,
  checkVerificationAttemptLock,
  claimVerificationBudgetReservation,
  createIncorrectVerificationAttemptConsumer,
  createVerificationAttemptLockChecker,
  InMemoryVerificationRateLimitStore,
  verificationPhonePrefixHash,
  VerificationRateLimitUnavailableError,
  type VerificationAttemptInput,
  type VerificationBudgetInput,
  type VerificationBudgetReservation,
  type VerificationBudgetResult,
} from "./verificationRateLimit.js";

export type PolicyMethod = "SMS" | "TOTP" | "RECOVERY_CODE";
export type PolicyPurpose = "REGISTRATION" | "LOGIN" | "PASSWORD_RESET" | "PHONE_CHANGE" | "FACTOR_REMOVAL" | "PHONE_RECOVERY_SMS";
export type SmsDeliveryState = "PENDING" | "CLAIMED" | "SENDING" | "SENT" | "FAILED" | "AMBIGUOUS";

export type PolicyChallenge = {
  id: string;
  userId: string | null;
  purpose: PolicyPurpose;
  method: PolicyMethod;
  destinationHash: string;
  phonePrefixHash: string | null;
  accountRateLimitHash: string | null;
  destinationVersion: number;
  tokenVersionAtIssue: number | null;
  providerRef: string;
  smsDestinationEncrypted?: string | null;
  smsDestinationEncryptionKeyVersion?: number | null;
  smsDeliveryState?: SmsDeliveryState | null;
  smsDeliveryLeaseId?: string | null;
  smsDeliveryLeaseAt?: Date | null;
  smsDeliveryAttemptedAt?: Date | null;
  smsDeliveryCompletedAt?: Date | null;
  expiresAt: Date;
  incorrectAttempts: number;
  consumedAt: Date | null;
  invalidatedAt: Date | null;
};

export type StartChallengeInput = {
  userId: string | null;
  purpose: PolicyPurpose;
  method: PolicyMethod;
  destination: string;
  destinationHash: string;
  destinationVersion: number;
  tokenVersionAtIssue: number | null;
  dimensions: string[];
  verificationBudgetReservation?: VerificationBudgetReservation;
  decoyOnDeliveryFailure?: boolean;
};

export interface VerificationPolicyStore {
  reserveSend(input: StartChallengeInput, now: Date): Promise<void>;
  createChallenge(challenge: PolicyChallenge): Promise<void>;
  getChallenge(id: string): Promise<PolicyChallenge | null>;
  consumeChallenge(id: string, at: Date): Promise<boolean>;
  incrementIncorrect(id: string): Promise<number | null>;
  invalidateChallenge(id: string, at: Date): Promise<void>;
  replaceChallenge(previousId: string, replacement: PolicyChallenge, at: Date): Promise<boolean>;
}

export class VerificationLockedError extends Error {
  constructor(
    readonly retryAfter = 900,
    message = "Too many verification attempts. Please try again in 15 minutes.",
  ) {
    super(message);
    this.name = "VerificationLockedError";
  }
}

export class VerificationRejectedError extends Error {
  constructor() {
    super("Verification challenge is invalid.");
    this.name = "VerificationRejectedError";
  }
}

export class InMemoryVerificationPolicyStore implements VerificationPolicyStore {
  private readonly challenges = new Map<string, PolicyChallenge>();
  private readonly sends = new Map<string, number[]>();
  private readonly globalSends: number[] = [];
  private lockedUntil = 0;

  async reserveSend(input: StartChallengeInput, now: Date): Promise<void> {
    const dimensions = [...new Set([`phone:${input.destinationHash}`, ...input.dimensions])];
    const nowMs = now.getTime();
    if (this.lockedUntil > nowMs) throw new VerificationLockedError();
    const globalRecent = this.globalSends.filter((at) => at > nowMs - 60_000).length;
    if (globalRecent >= 100) throw new VerificationLockedError();
    const cooldownSends = dimensions
      .filter((dimension) => !dimension.startsWith("ip:"))
      .flatMap((dimension) => this.sends.get(dimension) ?? [])
      .filter((at) => at > nowMs - 30_000);
    if (cooldownSends.length > 0) {
      const latest = Math.max(...cooldownSends);
      throw new VerificationLockedError(
        Math.max(1, Math.ceil((latest + 30_000 - nowMs) / 1_000)),
        "Another verification code cannot be sent yet.",
      );
    }
    for (const dimension of dimensions) {
      const sends = this.sends.get(dimension) ?? [];
      if (sends.filter((at) => at > nowMs - 15 * 60_000).length >= 3 || sends.filter((at) => at > nowMs - 24 * 60 * 60_000).length >= 10) {
        this.lockedUntil = nowMs + 15 * 60_000;
        throw new VerificationLockedError();
      }
    }
    this.globalSends.push(now.getTime());
    for (const dimension of dimensions) {
      const sends = this.sends.get(dimension) ?? [];
      sends.push(now.getTime());
      this.sends.set(dimension, sends);
    }
  }

  async createChallenge(challenge: PolicyChallenge): Promise<void> { this.challenges.set(challenge.id, challenge); }
  async getChallenge(id: string): Promise<PolicyChallenge | null> { return this.challenges.get(id) ?? null; }
  async consumeChallenge(id: string, at: Date): Promise<boolean> {
    const challenge = this.challenges.get(id);
    if (!challenge || challenge.consumedAt || challenge.invalidatedAt) return false;
    this.challenges.set(id, { ...challenge, consumedAt: at });
    return true;
  }
  async incrementIncorrect(id: string): Promise<number | null> {
    const challenge = this.challenges.get(id);
    if (!challenge || challenge.incorrectAttempts >= 5) return null;
    const incorrectAttempts = challenge.incorrectAttempts + 1;
    this.challenges.set(id, { ...challenge, incorrectAttempts });
    return incorrectAttempts;
  }
  async invalidateChallenge(id: string, at: Date): Promise<void> {
    const challenge = this.challenges.get(id);
    if (challenge) this.challenges.set(id, { ...challenge, invalidatedAt: at });
  }
  async replaceChallenge(previousId: string, replacement: PolicyChallenge, at: Date): Promise<boolean> {
    const previous = this.challenges.get(previousId);
    if (!previous || previous.consumedAt || previous.invalidatedAt || previous.expiresAt <= at
      || previous.userId !== replacement.userId || previous.purpose !== replacement.purpose
      || previous.tokenVersionAtIssue !== replacement.tokenVersionAtIssue) return false;
    this.challenges.set(previousId, { ...previous, invalidatedAt: at });
    this.challenges.set(replacement.id, replacement);
    return true;
  }
}

function splitDimension(value: string): { dimension: string; keyHash: string } {
  const separator = value.indexOf(":");
  if (separator < 1 || separator === value.length - 1) throw new Error("Invalid rate-limit dimension.");
  return { dimension: value.slice(0, separator), keyHash: value.slice(separator + 1) };
}

function challengePhonePrefixHash(input: StartChallengeInput): string {
  const supplied = input.dimensions
    .map(splitDimension)
    .find(({ dimension }) => dimension === "phone-prefix")?.keyHash;
  const phonePrefixHash = supplied ?? verificationPhonePrefixHash(input.destination);
  if (!/^[a-f0-9]{64}$/.test(phonePrefixHash)) {
    throw new Error("Invalid phone-prefix rate-limit binding.");
  }
  return phonePrefixHash;
}

function challengeAccountRateLimitHash(input: StartChallengeInput): string | null {
  return input.dimensions
    .map(splitDimension)
    .find(({ dimension }) => dimension === "account")?.keyHash ?? null;
}

export class PrismaVerificationPolicyStore implements VerificationPolicyStore {
  constructor(
    private readonly consumeBudget: (input: VerificationBudgetInput) => Promise<VerificationBudgetResult> = consumeVerificationBudget,
  ) {}

  async reserveSend(input: StartChallengeInput, now: Date): Promise<void> {
    const parsed = input.dimensions.map(splitDimension);
    const accountHash = parsed.find(({ dimension }) => dimension === "account")?.keyHash;
    const ipHash = parsed.find(({ dimension }) => dimension === "ip" || dimension.endsWith("-ip"))?.keyHash;
    const phonePrefixHash = challengePhonePrefixHash(input);
    const budgetInput = {
      action: input.purpose,
      phoneHash: input.destinationHash,
      phonePrefixHash,
      accountHash,
      ipHash,
      now,
    };
    const result = await this.consumeBudget(budgetInput);
    if (!result.allowed) {
      throw new VerificationLockedError(
        result.retryAfterSeconds,
        "Too many verification requests. Please try again later.",
      );
    }
  }

  async createChallenge(challenge: PolicyChallenge): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO "MfaChallenge" ("id", "userId", "phoneLookupHash", "phonePrefixHash", "accountRateLimitHash", "purpose", "method", "destinationVersion", "tokenVersionAtIssue", "providerRef", "smsDestinationEncrypted", "smsDestinationEncryptionKeyVersion", "smsDeliveryState", "smsDeliveryLeaseId", "smsDeliveryLeaseAt", "smsDeliveryAttemptedAt", "smsDeliveryCompletedAt", "expiresAt", "incorrectAttempts", "createdAt")
      VALUES (${challenge.id}, ${challenge.userId}, ${challenge.destinationHash}, ${challenge.phonePrefixHash}, ${challenge.accountRateLimitHash}, ${challenge.purpose}::"MfaChallengePurpose", ${challenge.method}::"MfaMethod", ${challenge.destinationVersion}, ${challenge.tokenVersionAtIssue}, ${challenge.providerRef}, ${challenge.smsDestinationEncrypted ?? null}, ${challenge.smsDestinationEncryptionKeyVersion ?? null}, ${challenge.smsDeliveryState ?? null}::"SmsDeliveryState", ${challenge.smsDeliveryLeaseId ?? null}, ${challenge.smsDeliveryLeaseAt ?? null}, ${challenge.smsDeliveryAttemptedAt ?? null}, ${challenge.smsDeliveryCompletedAt ?? null}, ${challenge.expiresAt}, ${challenge.incorrectAttempts}, NOW())
    `;
  }

  async getChallenge(id: string): Promise<PolicyChallenge | null> {
    const rows = await prisma.$queryRaw<Array<{
      id: string; userId: string | null; purpose: PolicyPurpose; method: PolicyMethod; phoneLookupHash: string | null; phonePrefixHash: string | null; accountRateLimitHash: string | null;
      destinationVersion: number | null; tokenVersionAtIssue: number | null; providerRef: string | null; expiresAt: Date; incorrectAttempts: number;
      consumedAt: Date | null; invalidatedAt: Date | null;
      smsDestinationEncrypted: string | null; smsDestinationEncryptionKeyVersion: number | null; smsDeliveryState: SmsDeliveryState | null;
      smsDeliveryLeaseId: string | null; smsDeliveryLeaseAt: Date | null; smsDeliveryAttemptedAt: Date | null; smsDeliveryCompletedAt: Date | null;
    }>>`SELECT "id", "userId", "purpose", "method", "phoneLookupHash", "phonePrefixHash", "accountRateLimitHash", "destinationVersion", "tokenVersionAtIssue", "providerRef", "smsDestinationEncrypted", "smsDestinationEncryptionKeyVersion", "smsDeliveryState", "smsDeliveryLeaseId", "smsDeliveryLeaseAt", "smsDeliveryAttemptedAt", "smsDeliveryCompletedAt", "expiresAt", "incorrectAttempts", "consumedAt", "invalidatedAt" FROM "MfaChallenge" WHERE "id" = ${id}`;
    const challenge = rows[0];
    if (!challenge?.phoneLookupHash || !challenge.providerRef || challenge.destinationVersion === null) return null;
    return { ...challenge, destinationHash: challenge.phoneLookupHash, destinationVersion: challenge.destinationVersion, providerRef: challenge.providerRef };
  }

  async consumeChallenge(id: string, at: Date): Promise<boolean> {
    const changed = await prisma.$executeRaw`
      UPDATE "MfaChallenge" AS challenge SET "consumedAt" = ${at}
      WHERE challenge."id" = ${id} AND challenge."consumedAt" IS NULL AND challenge."invalidatedAt" IS NULL
        AND (
          challenge."userId" IS NULL
          OR EXISTS (
            SELECT 1 FROM "User" AS account
            WHERE account."id" = challenge."userId"
              AND account."tokenVersion" = challenge."tokenVersionAtIssue"
          )
        )
    `;
    return changed === 1;
  }

  async incrementIncorrect(id: string): Promise<number | null> {
    const rows = await prisma.$queryRaw<Array<{ incorrectAttempts: number }>>`
      UPDATE "MfaChallenge" SET "incorrectAttempts" = "incorrectAttempts" + 1
      WHERE "id" = ${id} AND "incorrectAttempts" < 5 AND "consumedAt" IS NULL AND "invalidatedAt" IS NULL
      RETURNING "incorrectAttempts"
    `;
    return rows[0]?.incorrectAttempts ?? null;
  }

  async invalidateChallenge(id: string, at: Date): Promise<void> {
    await prisma.$executeRaw`UPDATE "MfaChallenge" SET "invalidatedAt" = ${at} WHERE "id" = ${id} AND "consumedAt" IS NULL`;
  }

  async replaceChallenge(previousId: string, replacement: PolicyChallenge, at: Date): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const changed = await tx.$executeRaw`
        UPDATE "MfaChallenge" SET "invalidatedAt" = ${at}
        WHERE "id" = ${previousId} AND "userId" IS NOT DISTINCT FROM ${replacement.userId}
          AND "purpose" = ${replacement.purpose}::"MfaChallengePurpose"
          AND "tokenVersionAtIssue" IS NOT DISTINCT FROM ${replacement.tokenVersionAtIssue}
          AND "expiresAt" > ${at} AND "consumedAt" IS NULL AND "invalidatedAt" IS NULL
          AND (
            ${replacement.userId}::text IS NULL
            OR EXISTS (
              SELECT 1 FROM "User" AS account
              WHERE account."id" = ${replacement.userId}
                AND account."tokenVersion" = ${replacement.tokenVersionAtIssue}
            )
          )
      `;
      if (changed !== 1) return false;
      await tx.$executeRaw`
        INSERT INTO "MfaChallenge" ("id", "userId", "phoneLookupHash", "phonePrefixHash", "accountRateLimitHash", "purpose", "method", "destinationVersion", "tokenVersionAtIssue", "providerRef", "smsDestinationEncrypted", "smsDestinationEncryptionKeyVersion", "smsDeliveryState", "smsDeliveryLeaseId", "smsDeliveryLeaseAt", "smsDeliveryAttemptedAt", "smsDeliveryCompletedAt", "expiresAt", "incorrectAttempts", "createdAt")
        VALUES (${replacement.id}, ${replacement.userId}, ${replacement.destinationHash}, ${replacement.phonePrefixHash}, ${replacement.accountRateLimitHash}, ${replacement.purpose}::"MfaChallengePurpose", ${replacement.method}::"MfaMethod", ${replacement.destinationVersion}, ${replacement.tokenVersionAtIssue}, ${replacement.providerRef}, ${replacement.smsDestinationEncrypted ?? null}, ${replacement.smsDestinationEncryptionKeyVersion ?? null}, ${replacement.smsDeliveryState ?? null}::"SmsDeliveryState", ${replacement.smsDeliveryLeaseId ?? null}, ${replacement.smsDeliveryLeaseAt ?? null}, ${replacement.smsDeliveryAttemptedAt ?? null}, ${replacement.smsDeliveryCompletedAt ?? null}, ${replacement.expiresAt}, 0, ${at})
      `;
      return true;
    });
  }
}

export class VerificationPolicy {
  private readonly consumeIncorrectAttempt: (input: VerificationAttemptInput) => Promise<VerificationBudgetResult>;
  private readonly checkAttemptLock: (input: VerificationAttemptInput) => Promise<VerificationBudgetResult>;

  constructor(
    private readonly store: VerificationPolicyStore,
    private readonly provider: VerificationProvider,
    private readonly now: () => Date = () => new Date(),
    attemptControls?: {
      consume: (input: VerificationAttemptInput) => Promise<VerificationBudgetResult>;
      check: (input: VerificationAttemptInput) => Promise<VerificationBudgetResult>;
    },
  ) {
    if (attemptControls) {
      this.consumeIncorrectAttempt = attemptControls.consume;
      this.checkAttemptLock = attemptControls.check;
    } else if (store instanceof InMemoryVerificationPolicyStore) {
      const attemptStore = new InMemoryVerificationRateLimitStore();
      this.consumeIncorrectAttempt = createIncorrectVerificationAttemptConsumer(attemptStore);
      this.checkAttemptLock = createVerificationAttemptLockChecker(attemptStore);
    } else {
      this.consumeIncorrectAttempt = consumeIncorrectVerificationAttempt;
      this.checkAttemptLock = checkVerificationAttemptLock;
    }
  }

  private durableAttemptHash(value: string): string {
    if (/^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
    const key = process.env.RATE_LIMIT_HMAC_KEY?.trim();
    if (!key) throw new VerificationRateLimitUnavailableError();
    return createHmac("sha256", key).update(value).digest("hex");
  }

  private attemptInput(challenge: Pick<PolicyChallenge, "purpose" | "destinationHash" | "accountRateLimitHash" | "userId">, now: Date): VerificationAttemptInput {
    return {
      action: challenge.purpose,
      phoneHash: this.durableAttemptHash(challenge.destinationHash),
      accountHash: challenge.accountRateLimitHash
        ? this.durableAttemptHash(challenge.accountRateLimitHash)
        : challenge.userId ? this.durableAttemptHash(challenge.userId) : undefined,
      now,
    };
  }

  private async assertAttemptUnlocked(challenge: Pick<PolicyChallenge, "purpose" | "destinationHash" | "accountRateLimitHash" | "userId">, now: Date): Promise<void> {
    const result = await this.checkAttemptLock(this.attemptInput(challenge, now));
    if (!result.allowed) throw new VerificationLockedError(result.retryAfterSeconds);
  }

  private async recordIncorrectAttempt(challenge: PolicyChallenge, now: Date): Promise<void> {
    const result = await this.consumeIncorrectAttempt(this.attemptInput(challenge, now));
    if (!result.allowed) {
      await this.store.invalidateChallenge(challenge.id, now);
      throw new VerificationLockedError(result.retryAfterSeconds);
    }
  }

  private async reserveOrClaimSend(input: StartChallengeInput, now: Date): Promise<void> {
    await this.assertAttemptUnlocked({
      purpose: input.purpose,
      destinationHash: input.destinationHash,
      accountRateLimitHash: challengeAccountRateLimitHash(input),
      userId: input.userId,
    }, now);
    if (input.verificationBudgetReservation) {
      const parsed = input.dimensions.map(splitDimension);
      const expected = {
        action: input.purpose,
        phoneHash: input.destinationHash,
        phonePrefixHash: challengePhonePrefixHash(input),
        accountHash: parsed.find(({ dimension }) => dimension === "account")?.keyHash,
        ipHash: parsed.find(({ dimension }) => dimension === "ip" || dimension.endsWith("-ip"))?.keyHash,
      };
      if (!claimVerificationBudgetReservation(input.verificationBudgetReservation, expected)) {
        throw new VerificationRateLimitUnavailableError();
      }
      return;
    }
    await this.store.reserveSend(input, now);
  }

  private async deliverOrCreateRegistrationDecoy(input: StartChallengeInput): Promise<{ providerRef: string; dispatched: boolean }> {
    try {
      return { providerRef: (await this.provider.start(input.destination, "sms")).providerRef, dispatched: true };
    } catch (error) {
      if (input.purpose !== "REGISTRATION" || !input.decoyOnDeliveryFailure || !(error instanceof VerificationProviderError)) throw error;
      return { providerRef: "decoy", dispatched: false };
    }
  }

  async queueSmsChallenge(input: StartChallengeInput): Promise<{ id: string; expiresAt: Date }> {
    if (input.method !== "SMS" || !["REGISTRATION", "PASSWORD_RESET"].includes(input.purpose)) {
      throw new Error("Queued delivery is available only for public SMS challenges.");
    }
    const now = this.now();
    const protectedDestination = encryptPhone(input.destination);
    const challenge: PolicyChallenge = {
      id: randomUUID(),
      userId: input.userId,
      purpose: input.purpose,
      method: "SMS",
      destinationHash: input.destinationHash,
      phonePrefixHash: challengePhonePrefixHash(input),
      accountRateLimitHash: challengeAccountRateLimitHash(input),
      destinationVersion: input.destinationVersion,
      tokenVersionAtIssue: input.tokenVersionAtIssue ?? null,
      providerRef: `pending:${randomUUID()}`,
      smsDestinationEncrypted: protectedDestination.ciphertext,
      smsDestinationEncryptionKeyVersion: protectedDestination.keyVersion,
      smsDeliveryState: "PENDING",
      smsDeliveryLeaseId: null,
      smsDeliveryLeaseAt: null,
      smsDeliveryAttemptedAt: null,
      smsDeliveryCompletedAt: null,
      expiresAt: new Date(now.getTime() + 10 * 60_000),
      incorrectAttempts: 0,
      consumedAt: null,
      invalidatedAt: null,
    };
    await this.reserveOrClaimSend(input, now);
    await this.store.createChallenge(challenge);
    return { id: challenge.id, expiresAt: challenge.expiresAt };
  }

  async queuePasswordRecoveryDecoy(
    accountRateLimitHash: string,
    binding?: { userId: string; tokenVersionAtIssue: number },
  ): Promise<{ id: string; expiresAt: Date }> {
    if (!/^[a-f0-9]{64}$/.test(accountRateLimitHash)) throw new Error("Invalid password-recovery decoy binding.");
    const now = this.now();
    const challenge: PolicyChallenge = {
      id: randomUUID(),
      userId: binding?.userId ?? null,
      purpose: "PASSWORD_RESET",
      method: "SMS",
      destinationHash: accountRateLimitHash,
      phonePrefixHash: accountRateLimitHash,
      accountRateLimitHash,
      destinationVersion: binding?.tokenVersionAtIssue ?? 0,
      tokenVersionAtIssue: binding?.tokenVersionAtIssue ?? null,
      providerRef: "decoy",
      smsDestinationEncrypted: null,
      smsDestinationEncryptionKeyVersion: null,
      smsDeliveryState: null,
      smsDeliveryLeaseId: null,
      smsDeliveryLeaseAt: null,
      smsDeliveryAttemptedAt: null,
      smsDeliveryCompletedAt: null,
      expiresAt: new Date(now.getTime() + 10 * 60_000),
      incorrectAttempts: 0,
      consumedAt: null,
      invalidatedAt: null,
    };
    await this.store.createChallenge(challenge);
    return { id: challenge.id, expiresAt: challenge.expiresAt };
  }

  async queueSmsResend(input: StartChallengeInput & { previousChallengeId: string }): Promise<{ id: string; expiresAt: Date }> {
    if (input.method !== "SMS" || !["REGISTRATION", "PASSWORD_RESET"].includes(input.purpose)) {
      throw new Error("Queued delivery is available only for public SMS challenges.");
    }
    const now = this.now();
    await this.assertAttemptUnlocked({
      purpose: input.purpose,
      destinationHash: input.destinationHash,
      accountRateLimitHash: challengeAccountRateLimitHash(input),
      userId: input.userId,
    }, now);
    const phonePrefixHash = challengePhonePrefixHash(input);
    const accountRateLimitHash = challengeAccountRateLimitHash(input);
    const previous = await this.store.getChallenge(input.previousChallengeId);
    if (!previous || previous.userId !== input.userId || previous.purpose !== input.purpose
      || previous.method !== "SMS" || previous.destinationHash !== input.destinationHash
      || previous.destinationVersion !== input.destinationVersion
      || previous.phonePrefixHash !== phonePrefixHash
      || previous.accountRateLimitHash !== accountRateLimitHash
      || previous.tokenVersionAtIssue !== (input.tokenVersionAtIssue ?? null)
      || previous.consumedAt || previous.invalidatedAt || previous.expiresAt <= now) {
      throw new VerificationRejectedError();
    }
    await this.reserveOrClaimSend(input, now);
    const replacement: PolicyChallenge = {
      ...previous,
      id: randomUUID(),
      providerRef: `pending:${randomUUID()}`,
      smsDeliveryState: "PENDING",
      smsDeliveryLeaseId: null,
      smsDeliveryLeaseAt: null,
      smsDeliveryAttemptedAt: null,
      smsDeliveryCompletedAt: null,
      expiresAt: new Date(now.getTime() + 10 * 60_000),
      incorrectAttempts: 0,
      consumedAt: null,
      invalidatedAt: null,
    };
    if (!await this.store.replaceChallenge(previous.id, replacement, now)) throw new VerificationRejectedError();
    return { id: replacement.id, expiresAt: replacement.expiresAt };
  }

  async startChallenge(input: StartChallengeInput): Promise<{ id: string; expiresAt: Date; dispatched?: false }> {
    if (input.method !== "SMS") throw new Error("Provider delivery is available only for SMS challenges.");
    const now = this.now();
    const phonePrefixHash = challengePhonePrefixHash(input);
    const accountRateLimitHash = challengeAccountRateLimitHash(input);
    await this.reserveOrClaimSend(input, now);
    const { providerRef, dispatched } = await this.deliverOrCreateRegistrationDecoy(input);
    const challenge: PolicyChallenge = {
      id: randomUUID(),
      userId: input.userId,
      purpose: input.purpose,
      method: input.method,
      destinationHash: input.destinationHash,
      phonePrefixHash,
      accountRateLimitHash,
      destinationVersion: input.destinationVersion,
      tokenVersionAtIssue: input.tokenVersionAtIssue ?? null,
      providerRef,
      expiresAt: new Date(now.getTime() + 10 * 60_000),
      incorrectAttempts: 0,
      consumedAt: null,
      invalidatedAt: null,
    };
    await this.store.createChallenge(challenge);
    return dispatched
      ? { id: challenge.id, expiresAt: challenge.expiresAt }
      : { id: challenge.id, expiresAt: challenge.expiresAt, dispatched: false };
  }

  async switchChallengeMethod(input: {
    challengeId: string;
    userId: string | null;
    purpose: PolicyPurpose;
    method: Exclude<PolicyMethod, "SMS">;
    destinationHash: string;
    destinationVersion: number;
    tokenVersionAtIssue: number | null;
    previousAccountRateLimitHash?: string;
  }): Promise<{ id: string; expiresAt: Date }> {
    const now = this.now();
    if (input.previousAccountRateLimitHash !== undefined) {
      const previous = await this.store.getChallenge(input.challengeId);
      if (!previous || previous.method !== "SMS"
        || previous.accountRateLimitHash !== input.previousAccountRateLimitHash) {
        throw new VerificationRejectedError();
      }
    }
    const replacement: PolicyChallenge = {
      id: randomUUID(), userId: input.userId, purpose: input.purpose, method: input.method,
      destinationHash: input.destinationHash, destinationVersion: input.destinationVersion,
      phonePrefixHash: null,
      accountRateLimitHash: input.previousAccountRateLimitHash ?? null,
      tokenVersionAtIssue: input.tokenVersionAtIssue ?? null,
      providerRef: "local", expiresAt: new Date(now.getTime() + 10 * 60_000), incorrectAttempts: 0,
      consumedAt: null, invalidatedAt: null,
    };
    if (!await this.store.replaceChallenge(input.challengeId, replacement, now)) {
      throw new VerificationRejectedError();
    }
    return { id: replacement.id, expiresAt: replacement.expiresAt };
  }

  async startLocalChallenge(input: {
    userId: string;
    purpose: PolicyPurpose;
    method: Exclude<PolicyMethod, "SMS">;
    destinationHash: string;
    destinationVersion: number;
    tokenVersionAtIssue: number | null;
  }): Promise<{ id: string; expiresAt: Date }> {
    const now = this.now();
    const challenge: PolicyChallenge = {
      id: randomUUID(), userId: input.userId, purpose: input.purpose, method: input.method,
      destinationHash: input.destinationHash, destinationVersion: input.destinationVersion,
      phonePrefixHash: null,
      accountRateLimitHash: null,
      tokenVersionAtIssue: input.tokenVersionAtIssue ?? null,
      providerRef: "local", expiresAt: new Date(now.getTime() + 10 * 60_000), incorrectAttempts: 0,
      consumedAt: null, invalidatedAt: null,
    };
    await this.store.createChallenge(challenge);
    return { id: challenge.id, expiresAt: challenge.expiresAt };
  }

  async startDecoySmsChallenge(input: StartChallengeInput): Promise<{ id: string; expiresAt: Date }> {
    const now = this.now();
    const phonePrefixHash = challengePhonePrefixHash(input);
    const accountRateLimitHash = challengeAccountRateLimitHash(input);
    await this.reserveOrClaimSend(input, now);
    const challenge: PolicyChallenge = {
      id: randomUUID(), userId: input.userId, purpose: input.purpose, method: "SMS",
      destinationHash: input.destinationHash, destinationVersion: input.destinationVersion,
      phonePrefixHash,
      accountRateLimitHash,
      tokenVersionAtIssue: input.tokenVersionAtIssue ?? null,
      providerRef: "decoy", expiresAt: new Date(now.getTime() + 10 * 60_000), incorrectAttempts: 0,
      consumedAt: null, invalidatedAt: null,
    };
    await this.store.createChallenge(challenge);
    return { id: challenge.id, expiresAt: challenge.expiresAt };
  }

  async resendChallenge(input: StartChallengeInput & { previousChallengeId: string }): Promise<{ id: string; expiresAt: Date; dispatched?: false }> {
    const now = this.now();
    await this.assertAttemptUnlocked({
      purpose: input.purpose,
      destinationHash: input.destinationHash,
      accountRateLimitHash: challengeAccountRateLimitHash(input),
      userId: input.userId,
    }, now);
    const phonePrefixHash = challengePhonePrefixHash(input);
    const accountRateLimitHash = challengeAccountRateLimitHash(input);
    const previous = await this.store.getChallenge(input.previousChallengeId);
    if (!previous || previous.userId !== input.userId || previous.purpose !== input.purpose
      || previous.method !== "SMS" || input.method !== "SMS"
      || previous.destinationHash !== input.destinationHash || previous.destinationVersion !== input.destinationVersion
      || previous.phonePrefixHash !== phonePrefixHash
      || previous.accountRateLimitHash !== accountRateLimitHash
      || previous.tokenVersionAtIssue !== (input.tokenVersionAtIssue ?? null)
      || previous.consumedAt || previous.invalidatedAt || previous.expiresAt <= now) {
      throw new VerificationRejectedError();
    }
    await this.reserveOrClaimSend(input, now);
    const { providerRef, dispatched } = await this.deliverOrCreateRegistrationDecoy(input);
    const replacedAt = this.now();
    if (previous.expiresAt <= replacedAt) {
      await this.store.invalidateChallenge(previous.id, replacedAt);
      throw new VerificationRejectedError();
    }
    const replacement: PolicyChallenge = {
      id: randomUUID(), userId: input.userId, purpose: input.purpose, method: "SMS",
      destinationHash: input.destinationHash, destinationVersion: input.destinationVersion,
      phonePrefixHash,
      accountRateLimitHash,
      tokenVersionAtIssue: input.tokenVersionAtIssue ?? null,
      providerRef, expiresAt: new Date(now.getTime() + 10 * 60_000), incorrectAttempts: 0,
      consumedAt: null, invalidatedAt: null,
    };
    if (!await this.store.replaceChallenge(input.previousChallengeId, replacement, replacedAt)) {
      throw new VerificationRejectedError();
    }
    return dispatched
      ? { id: replacement.id, expiresAt: replacement.expiresAt }
      : { id: replacement.id, expiresAt: replacement.expiresAt, dispatched: false };
  }

  async resendDecoySmsChallenge(input: StartChallengeInput & { previousChallengeId: string }): Promise<{ id: string; expiresAt: Date }> {
    const now = this.now();
    await this.assertAttemptUnlocked({
      purpose: input.purpose,
      destinationHash: input.destinationHash,
      accountRateLimitHash: challengeAccountRateLimitHash(input),
      userId: input.userId,
    }, now);
    const phonePrefixHash = challengePhonePrefixHash(input);
    const accountRateLimitHash = challengeAccountRateLimitHash(input);
    const previous = await this.store.getChallenge(input.previousChallengeId);
    if (!previous || previous.providerRef !== "decoy" || previous.userId !== input.userId
      || previous.purpose !== input.purpose || previous.method !== "SMS" || input.method !== "SMS"
      || previous.destinationHash !== input.destinationHash || previous.destinationVersion !== input.destinationVersion
      || previous.phonePrefixHash !== phonePrefixHash
      || previous.accountRateLimitHash !== accountRateLimitHash
      || previous.tokenVersionAtIssue !== (input.tokenVersionAtIssue ?? null)
      || previous.consumedAt || previous.invalidatedAt || previous.expiresAt <= now) {
      throw new VerificationRejectedError();
    }
    await this.reserveOrClaimSend(input, now);
    const replacedAt = this.now();
    if (previous.expiresAt <= replacedAt) {
      await this.store.invalidateChallenge(previous.id, replacedAt);
      throw new VerificationRejectedError();
    }
    const replacement: PolicyChallenge = {
      id: randomUUID(), userId: input.userId, purpose: input.purpose, method: "SMS",
      destinationHash: input.destinationHash, destinationVersion: input.destinationVersion,
      phonePrefixHash,
      accountRateLimitHash,
      tokenVersionAtIssue: input.tokenVersionAtIssue ?? null,
      providerRef: "decoy", expiresAt: new Date(now.getTime() + 10 * 60_000), incorrectAttempts: 0,
      consumedAt: null, invalidatedAt: null,
    };
    if (!await this.store.replaceChallenge(input.previousChallengeId, replacement, replacedAt)) {
      throw new VerificationRejectedError();
    }
    return { id: replacement.id, expiresAt: replacement.expiresAt };
  }

  async rejectDecoySmsChallenge(input: {
    challengeId: string;
    userId: string | null;
    purpose: PolicyPurpose;
    destinationHash: string;
    destinationVersion: number;
    tokenVersionAtIssue: number | null;
  }): Promise<{ approved: false }> {
    const now = this.now();
    const challenge = await this.store.getChallenge(input.challengeId);
    if (!challenge || challenge.providerRef !== "decoy" || challenge.userId !== input.userId
      || challenge.purpose !== input.purpose || challenge.method !== "SMS"
      || challenge.destinationHash !== input.destinationHash || challenge.destinationVersion !== input.destinationVersion
      || challenge.tokenVersionAtIssue !== (input.tokenVersionAtIssue ?? null)
      || challenge.consumedAt || challenge.invalidatedAt || challenge.expiresAt <= now) {
      throw new VerificationRejectedError();
    }
    await this.assertAttemptUnlocked(challenge, now);
    if (await this.store.incrementIncorrect(challenge.id) === null) throw new VerificationLockedError();
    await this.recordIncorrectAttempt(challenge, now);
    return { approved: false };
  }

  async checkChallenge(input: { challengeId: string; userId: string | null; purpose: PolicyPurpose; method: PolicyMethod; destination: string; destinationHash: string; destinationVersion: number; tokenVersionAtIssue: number | null; code: string }): Promise<{ approved: boolean }> {
    return this.verify(input, async (challenge, now) => {
      if (!await this.store.consumeChallenge(challenge.id, now)) throw new VerificationRejectedError();
    });
  }

  async completeChallenge<T>(
    input: { challengeId: string; userId: string | null; purpose: PolicyPurpose; method: PolicyMethod; destination: string; destinationHash: string; destinationVersion: number; tokenVersionAtIssue: number | null; code: string },
    completeAtomically: (challengeId: string, approvedAt: Date, tokenVersionAtIssue: number | null) => Promise<T>,
  ): Promise<{ approved: boolean; value?: T }> {
    return this.verify(input, async (challenge, now) => completeAtomically(challenge.id, now, challenge.tokenVersionAtIssue));
  }

  async completeLocalChallenge(
    input: {
      challengeId: string; userId: string | null; purpose: PolicyPurpose; method: Exclude<PolicyMethod, "SMS">;
      destinationHash: string; destinationVersion: number;
      tokenVersionAtIssue: number | null;
    },
    verifyAndConsume: (challengeId: string, approvedAt: Date, tokenVersionAtIssue: number | null) => Promise<"approved" | "incorrect" | "conflict">,
  ): Promise<{ approved: boolean }> {
    const challenge = await this.store.getChallenge(input.challengeId);
    const now = this.now();
    if (!challenge || challenge.userId !== input.userId || challenge.purpose !== input.purpose || challenge.method !== input.method || challenge.destinationHash !== input.destinationHash || challenge.destinationVersion !== input.destinationVersion || challenge.tokenVersionAtIssue !== (input.tokenVersionAtIssue ?? null) || challenge.consumedAt || challenge.invalidatedAt || challenge.expiresAt <= now) {
      throw new VerificationRejectedError();
    }
    await this.assertAttemptUnlocked(challenge, now);
    if (await this.store.incrementIncorrect(challenge.id) === null) throw new VerificationLockedError();
    const result = await verifyAndConsume(challenge.id, now, challenge.tokenVersionAtIssue);
    if (result === "approved") return { approved: true };
    if (result === "conflict") throw new VerificationRejectedError();
    await this.recordIncorrectAttempt(challenge, now);
    return { approved: false };
  }

  private async verify<T>(
    input: { challengeId: string; userId: string | null; purpose: PolicyPurpose; method: PolicyMethod; destination: string; destinationHash: string; destinationVersion: number; tokenVersionAtIssue: number | null; code: string },
    onApproved: (challenge: PolicyChallenge, approvedAt: Date) => Promise<T>,
  ): Promise<{ approved: boolean; value?: T }> {
    const challenge = await this.store.getChallenge(input.challengeId);
    const now = this.now();
    if (!challenge || challenge.userId !== input.userId || challenge.purpose !== input.purpose || challenge.method !== input.method || challenge.destinationHash !== input.destinationHash || challenge.destinationVersion !== input.destinationVersion || challenge.tokenVersionAtIssue !== (input.tokenVersionAtIssue ?? null) || challenge.consumedAt || challenge.invalidatedAt || challenge.expiresAt <= now) {
      throw new VerificationRejectedError();
    }
    await this.assertAttemptUnlocked(challenge, now);
    if (await this.store.incrementIncorrect(challenge.id) === null) throw new VerificationLockedError();
    if (challenge.providerRef === "decoy" || challenge.providerRef.startsWith("pending:") || challenge.providerRef.startsWith("dispatching:")) {
      await this.recordIncorrectAttempt(challenge, now);
      return { approved: false };
    }
    try {
      const result = await this.provider.check(challenge.providerRef, input.destination, input.code);
      const completedAt = this.now();
      if (challenge.expiresAt <= completedAt) {
        await this.store.invalidateChallenge(challenge.id, completedAt);
        throw new VerificationRejectedError();
      }
      if (result.matched) {
        return { approved: true, value: await onApproved(challenge, completedAt) };
      }
      await this.recordIncorrectAttempt(challenge, completedAt);
      return { approved: false };
    } catch (error) {
      if (error instanceof VerificationAmbiguousError) {
        await this.store.invalidateChallenge(challenge.id, now);
      }
      throw error;
    }
  }
}
