import { randomUUID } from "node:crypto";
import { VerificationAmbiguousError, type VerificationProvider } from "./verificationProvider.js";
import { prisma } from "./prisma.js";
import {
  consumeVerificationBudget,
  claimVerificationBudgetReservation,
  VerificationRateLimitUnavailableError,
  type VerificationBudgetInput,
  type VerificationBudgetReservation,
  type VerificationBudgetResult,
} from "./verificationRateLimit.js";

export type PolicyMethod = "SMS" | "TOTP" | "RECOVERY_CODE";
export type PolicyPurpose = "REGISTRATION" | "LOGIN" | "PASSWORD_RESET" | "PHONE_CHANGE" | "FACTOR_REMOVAL";

export type PolicyChallenge = {
  id: string;
  userId: string | null;
  purpose: PolicyPurpose;
  method: PolicyMethod;
  destinationHash: string;
  destinationVersion: number;
  providerRef: string;
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
  dimensions: string[];
  verificationBudgetReservation?: VerificationBudgetReservation;
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
    if (!previous || previous.consumedAt || previous.invalidatedAt || previous.expiresAt <= at || previous.userId !== replacement.userId || previous.purpose !== replacement.purpose) return false;
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

export class PrismaVerificationPolicyStore implements VerificationPolicyStore {
  constructor(
    private readonly consumeBudget: (input: VerificationBudgetInput) => Promise<VerificationBudgetResult> = consumeVerificationBudget,
  ) {}

  async reserveSend(input: StartChallengeInput, now: Date): Promise<void> {
    const parsed = input.dimensions.map(splitDimension);
    const accountHash = parsed.find(({ dimension }) => dimension === "account")?.keyHash;
    const ipHash = parsed.find(({ dimension }) => dimension === "ip" || dimension.endsWith("-ip"))?.keyHash;
    const budgetInput = {
      action: input.purpose,
      phoneHash: input.destinationHash,
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
      INSERT INTO "MfaChallenge" ("id", "userId", "phoneLookupHash", "purpose", "method", "destinationVersion", "providerRef", "expiresAt", "incorrectAttempts", "createdAt")
      VALUES (${challenge.id}, ${challenge.userId}, ${challenge.destinationHash}, ${challenge.purpose}::"MfaChallengePurpose", ${challenge.method}::"MfaMethod", ${challenge.destinationVersion}, ${challenge.providerRef}, ${challenge.expiresAt}, ${challenge.incorrectAttempts}, NOW())
    `;
  }

  async getChallenge(id: string): Promise<PolicyChallenge | null> {
    const rows = await prisma.$queryRaw<Array<{
      id: string; userId: string | null; purpose: PolicyPurpose; method: PolicyMethod; phoneLookupHash: string | null;
      destinationVersion: number | null; providerRef: string | null; expiresAt: Date; incorrectAttempts: number;
      consumedAt: Date | null; invalidatedAt: Date | null;
    }>>`SELECT "id", "userId", "purpose", "method", "phoneLookupHash", "destinationVersion", "providerRef", "expiresAt", "incorrectAttempts", "consumedAt", "invalidatedAt" FROM "MfaChallenge" WHERE "id" = ${id}`;
    const challenge = rows[0];
    if (!challenge?.phoneLookupHash || !challenge.providerRef || challenge.destinationVersion === null) return null;
    return { ...challenge, destinationHash: challenge.phoneLookupHash, destinationVersion: challenge.destinationVersion, providerRef: challenge.providerRef };
  }

  async consumeChallenge(id: string, at: Date): Promise<boolean> {
    const changed = await prisma.$executeRaw`
      UPDATE "MfaChallenge" SET "consumedAt" = ${at}
      WHERE "id" = ${id} AND "consumedAt" IS NULL AND "invalidatedAt" IS NULL
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
        WHERE "id" = ${previousId} AND "userId" = ${replacement.userId}
          AND "purpose" = ${replacement.purpose}::"MfaChallengePurpose"
          AND "expiresAt" > ${at} AND "consumedAt" IS NULL AND "invalidatedAt" IS NULL
      `;
      if (changed !== 1) return false;
      await tx.$executeRaw`
        INSERT INTO "MfaChallenge" ("id", "userId", "phoneLookupHash", "purpose", "method", "destinationVersion", "providerRef", "expiresAt", "incorrectAttempts", "createdAt")
        VALUES (${replacement.id}, ${replacement.userId}, ${replacement.destinationHash}, ${replacement.purpose}::"MfaChallengePurpose", ${replacement.method}::"MfaMethod", ${replacement.destinationVersion}, ${replacement.providerRef}, ${replacement.expiresAt}, 0, ${at})
      `;
      return true;
    });
  }
}

export class VerificationPolicy {
  constructor(
    private readonly store: VerificationPolicyStore,
    private readonly provider: VerificationProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async reserveOrClaimSend(input: StartChallengeInput, now: Date): Promise<void> {
    if (input.verificationBudgetReservation) {
      const parsed = input.dimensions.map(splitDimension);
      const expected = {
        action: input.purpose,
        phoneHash: input.destinationHash,
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

  async startChallenge(input: StartChallengeInput): Promise<{ id: string; expiresAt: Date }> {
    if (input.method !== "SMS") throw new Error("Provider delivery is available only for SMS challenges.");
    const now = this.now();
    await this.reserveOrClaimSend(input, now);
    const started = await this.provider.start(input.destination, "sms");
    const challenge: PolicyChallenge = {
      id: randomUUID(),
      userId: input.userId,
      purpose: input.purpose,
      method: input.method,
      destinationHash: input.destinationHash,
      destinationVersion: input.destinationVersion,
      providerRef: started.providerRef,
      expiresAt: new Date(now.getTime() + 10 * 60_000),
      incorrectAttempts: 0,
      consumedAt: null,
      invalidatedAt: null,
    };
    await this.store.createChallenge(challenge);
    return { id: challenge.id, expiresAt: challenge.expiresAt };
  }

  async switchChallengeMethod(input: {
    challengeId: string;
    userId: string;
    purpose: PolicyPurpose;
    method: Exclude<PolicyMethod, "SMS">;
    destinationHash: string;
    destinationVersion: number;
  }): Promise<{ id: string; expiresAt: Date }> {
    const now = this.now();
    const replacement: PolicyChallenge = {
      id: randomUUID(), userId: input.userId, purpose: input.purpose, method: input.method,
      destinationHash: input.destinationHash, destinationVersion: input.destinationVersion,
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
  }): Promise<{ id: string; expiresAt: Date }> {
    const now = this.now();
    const challenge: PolicyChallenge = {
      id: randomUUID(), userId: input.userId, purpose: input.purpose, method: input.method,
      destinationHash: input.destinationHash, destinationVersion: input.destinationVersion,
      providerRef: "local", expiresAt: new Date(now.getTime() + 10 * 60_000), incorrectAttempts: 0,
      consumedAt: null, invalidatedAt: null,
    };
    await this.store.createChallenge(challenge);
    return { id: challenge.id, expiresAt: challenge.expiresAt };
  }

  async startDecoySmsChallenge(input: StartChallengeInput): Promise<{ id: string; expiresAt: Date }> {
    const now = this.now();
    await this.reserveOrClaimSend(input, now);
    const challenge: PolicyChallenge = {
      id: randomUUID(), userId: input.userId, purpose: input.purpose, method: "SMS",
      destinationHash: input.destinationHash, destinationVersion: input.destinationVersion,
      providerRef: "decoy", expiresAt: new Date(now.getTime() + 10 * 60_000), incorrectAttempts: 0,
      consumedAt: null, invalidatedAt: null,
    };
    await this.store.createChallenge(challenge);
    return { id: challenge.id, expiresAt: challenge.expiresAt };
  }

  async resendChallenge(input: StartChallengeInput & { previousChallengeId: string }): Promise<{ id: string; expiresAt: Date }> {
    const now = this.now();
    const previous = await this.store.getChallenge(input.previousChallengeId);
    if (!previous || previous.userId !== input.userId || previous.purpose !== input.purpose
      || previous.method !== "SMS" || input.method !== "SMS"
      || previous.destinationHash !== input.destinationHash || previous.destinationVersion !== input.destinationVersion
      || previous.consumedAt || previous.invalidatedAt || previous.expiresAt <= now) {
      throw new VerificationRejectedError();
    }
    await this.reserveOrClaimSend(input, now);
    const started = await this.provider.start(input.destination, "sms");
    const replacement: PolicyChallenge = {
      id: randomUUID(), userId: input.userId, purpose: input.purpose, method: "SMS",
      destinationHash: input.destinationHash, destinationVersion: input.destinationVersion,
      providerRef: started.providerRef, expiresAt: new Date(now.getTime() + 10 * 60_000), incorrectAttempts: 0,
      consumedAt: null, invalidatedAt: null,
    };
    if (!await this.store.replaceChallenge(input.previousChallengeId, replacement, now)) {
      throw new VerificationRejectedError();
    }
    return { id: replacement.id, expiresAt: replacement.expiresAt };
  }

  async resendDecoySmsChallenge(input: StartChallengeInput & { previousChallengeId: string }): Promise<{ id: string; expiresAt: Date }> {
    const now = this.now();
    const previous = await this.store.getChallenge(input.previousChallengeId);
    if (!previous || previous.providerRef !== "decoy" || previous.userId !== input.userId
      || previous.purpose !== input.purpose || previous.method !== "SMS" || input.method !== "SMS"
      || previous.destinationHash !== input.destinationHash || previous.destinationVersion !== input.destinationVersion
      || previous.consumedAt || previous.invalidatedAt || previous.expiresAt <= now) {
      throw new VerificationRejectedError();
    }
    await this.reserveOrClaimSend(input, now);
    const replacement: PolicyChallenge = {
      id: randomUUID(), userId: input.userId, purpose: input.purpose, method: "SMS",
      destinationHash: input.destinationHash, destinationVersion: input.destinationVersion,
      providerRef: "decoy", expiresAt: new Date(now.getTime() + 10 * 60_000), incorrectAttempts: 0,
      consumedAt: null, invalidatedAt: null,
    };
    if (!await this.store.replaceChallenge(input.previousChallengeId, replacement, now)) {
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
  }): Promise<{ approved: false }> {
    const now = this.now();
    const challenge = await this.store.getChallenge(input.challengeId);
    if (!challenge || challenge.providerRef !== "decoy" || challenge.userId !== input.userId
      || challenge.purpose !== input.purpose || challenge.method !== "SMS"
      || challenge.destinationHash !== input.destinationHash || challenge.destinationVersion !== input.destinationVersion
      || challenge.consumedAt || challenge.invalidatedAt || challenge.expiresAt <= now) {
      throw new VerificationRejectedError();
    }
    if (await this.store.incrementIncorrect(challenge.id) === null) throw new VerificationLockedError();
    return { approved: false };
  }

  async checkChallenge(input: { challengeId: string; userId: string | null; method: PolicyMethod; destination: string; destinationHash: string; destinationVersion: number; code: string }): Promise<{ approved: boolean }> {
    return this.verify(input, async (challenge, now) => {
      if (!await this.store.consumeChallenge(challenge.id, now)) throw new VerificationRejectedError();
    });
  }

  async completeChallenge<T>(
    input: { challengeId: string; userId: string | null; method: PolicyMethod; destination: string; destinationHash: string; destinationVersion: number; code: string },
    completeAtomically: (challengeId: string, approvedAt: Date) => Promise<T>,
  ): Promise<{ approved: boolean; value?: T }> {
    return this.verify(input, async (challenge, now) => completeAtomically(challenge.id, now));
  }

  async completeLocalChallenge(
    input: {
      challengeId: string; userId: string; purpose: PolicyPurpose; method: Exclude<PolicyMethod, "SMS">;
      destinationHash: string; destinationVersion: number;
    },
    verifyAndConsume: (challengeId: string, approvedAt: Date) => Promise<"approved" | "incorrect" | "conflict">,
  ): Promise<{ approved: boolean }> {
    const challenge = await this.store.getChallenge(input.challengeId);
    const now = this.now();
    if (!challenge || challenge.userId !== input.userId || challenge.purpose !== input.purpose || challenge.method !== input.method || challenge.destinationHash !== input.destinationHash || challenge.destinationVersion !== input.destinationVersion || challenge.consumedAt || challenge.invalidatedAt || challenge.expiresAt <= now) {
      throw new VerificationRejectedError();
    }
    if (challenge.incorrectAttempts >= 5) throw new VerificationLockedError();
    const result = await verifyAndConsume(challenge.id, now);
    if (result === "approved") return { approved: true };
    if (result === "conflict") throw new VerificationRejectedError();
    if (await this.store.incrementIncorrect(challenge.id) === null) throw new VerificationLockedError();
    return { approved: false };
  }

  private async verify<T>(
    input: { challengeId: string; userId: string | null; method: PolicyMethod; destination: string; destinationHash: string; destinationVersion: number; code: string },
    onApproved: (challenge: PolicyChallenge, approvedAt: Date) => Promise<T>,
  ): Promise<{ approved: boolean; value?: T }> {
    const challenge = await this.store.getChallenge(input.challengeId);
    const now = this.now();
    if (!challenge || challenge.userId !== input.userId || challenge.method !== input.method || challenge.destinationHash !== input.destinationHash || challenge.destinationVersion !== input.destinationVersion || challenge.consumedAt || challenge.invalidatedAt || challenge.expiresAt <= now) {
      throw new VerificationRejectedError();
    }
    if (challenge.incorrectAttempts >= 5) throw new VerificationLockedError();
    try {
      const result = await this.provider.check(challenge.providerRef, input.destination, input.code);
      if (result.matched) {
        return { approved: true, value: await onApproved(challenge, now) };
      }
      if (await this.store.incrementIncorrect(challenge.id) === null) throw new VerificationLockedError();
      return { approved: false };
    } catch (error) {
      if (error instanceof VerificationAmbiguousError) {
        await this.store.invalidateChallenge(challenge.id, now);
      }
      throw error;
    }
  }
}
