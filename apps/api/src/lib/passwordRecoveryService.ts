import { createHmac, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { consumeBackupCode, decryptSecret, verifyTotp } from "./mfa.js";
import { decryptPhone } from "./phone.js";
import { prisma } from "./prisma.js";
import { invalidateTokenVersionCache } from "./tokenVersion.js";
import { VerificationLockedError, VerificationRejectedError, type PolicyMethod, type VerificationPolicy } from "./verificationPolicy.js";
import { consumeVerificationBudget, type VerificationBudgetInput, type VerificationBudgetResult } from "./verificationRateLimit.js";

export type PasswordRecoveryMethod = PolicyMethod;

export type PasswordRecoveryUser = {
  id: string;
  email: string;
  accountStatus: "PENDING_PHONE_VERIFICATION" | "ACTIVE" | "DISABLED";
  isActive: boolean;
  tokenVersion: number;
  phoneEncrypted: string | null;
  phoneEncryptionKeyVersion: number | null;
  phoneLookupHash: string | null;
  phoneVersion: number;
  phoneVerifiedAt: Date | null;
  mfaEnabled: boolean;
  mfaSecretEncrypted: string | null;
  mfaBackupCodeHashes: unknown;
};

export type PasswordRecoveryChallenge = {
  id: string;
  userId: string | null;
  purpose: string;
  method: PasswordRecoveryMethod;
  user: PasswordRecoveryUser | null;
};

export interface PasswordRecoveryRepository {
  findByEmail(email: string): Promise<PasswordRecoveryUser | null>;
  findChallenge(challengeId: string): Promise<PasswordRecoveryChallenge | null>;
  resetPasswordFromChallenge(input: {
    challengeId: string;
    userId: string;
    method: PasswordRecoveryMethod;
    passwordHash: string;
    tokenVersion: number;
    approvedAt: Date;
    correlationId: string;
    recoveryCode?: string;
  }): Promise<"approved" | "incorrect" | "conflict">;
}

export type PasswordRecoveryChallengePolicy = Pick<VerificationPolicy, "startChallenge" | "switchChallengeMethod" | "completeChallenge" | "completeLocalChallenge">;

export class PasswordRecoveryRejectedError extends Error {
  constructor() {
    super("Password recovery challenge was not approved.");
    this.name = "PasswordRecoveryRejectedError";
  }
}

function activeUser(user: PasswordRecoveryUser | null): user is PasswordRecoveryUser {
  return Boolean(user && user.accountStatus === "ACTIVE" && user.isActive);
}

function verifiedSmsUser(user: PasswordRecoveryUser): user is PasswordRecoveryUser & {
  phoneEncrypted: string;
  phoneEncryptionKeyVersion: number;
  phoneLookupHash: string;
} {
  return Boolean(
    user.phoneEncrypted
    && user.phoneEncryptionKeyVersion !== null
    && user.phoneLookupHash
    && user.phoneVerifiedAt
    && Number.isInteger(user.phoneVersion)
    && user.phoneVersion > 0,
  );
}

function factorBinding(method: "TOTP" | "RECOVERY_CODE", userId: string): string {
  const key = process.env.RATE_LIMIT_HMAC_KEY?.trim();
  if (!key) throw new Error("RATE_LIMIT_HMAC_KEY is required.");
  return createHmac("sha256", key).update(`${method}:${userId}`).digest("hex");
}

function hasEnrolledMethod(user: PasswordRecoveryUser, method: Exclude<PasswordRecoveryMethod, "SMS">): boolean {
  if (method === "TOTP") return user.mfaEnabled && Boolean(user.mfaSecretEncrypted);
  return Array.isArray(user.mfaBackupCodeHashes) && user.mfaBackupCodeHashes.some((value) => typeof value === "string");
}

export class PasswordRecoveryService {
  constructor(
    private readonly repository: PasswordRecoveryRepository,
    private readonly policy: PasswordRecoveryChallengePolicy,
    private readonly consumeBudget: (input: VerificationBudgetInput) => Promise<VerificationBudgetResult> = consumeVerificationBudget,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private accountHash(email: string): string {
    const key = process.env.RATE_LIMIT_HMAC_KEY?.trim();
    if (!key) throw new Error("RATE_LIMIT_HMAC_KEY is required.");
    return createHmac("sha256", key).update(email.trim().toLowerCase()).digest("hex");
  }

  private async reserveSmsBudget(email: string, dimensions: string[]) {
    const ipDimension = dimensions.find((dimension) => dimension.startsWith("password-recovery-ip:") || dimension.startsWith("ip:"));
    const result = await this.consumeBudget({
      action: "PASSWORD_RESET",
      accountHash: this.accountHash(email),
      ipHash: ipDimension?.slice(ipDimension.indexOf(":") + 1),
      now: this.now(),
    });
    if (!result.allowed) {
      throw new VerificationLockedError(result.retryAfterSeconds, "Too many verification requests. Please try again later.");
    }
    return result.reservation;
  }

  async beginPasswordRecovery(
    email: string,
    context: { dimensions: string[]; method?: PasswordRecoveryMethod; previousChallengeId?: string },
  ): Promise<{ challengeId?: string }> {
    const normalizedEmail = email.trim().toLowerCase();
    const method = context.method ?? "SMS";
    const initialReservation = method === "SMS" ? await this.reserveSmsBudget(normalizedEmail, context.dimensions) : undefined;
    const user = await this.repository.findByEmail(normalizedEmail);
    if (!activeUser(user)) return {};

    if (method === "SMS") {
      if (!verifiedSmsUser(user)) return {};
      const phoneBudget = await this.consumeBudget({
        action: "PASSWORD_RESET",
        phoneHash: user.phoneLookupHash,
        now: this.now(),
        reservation: initialReservation,
      });
      if (!phoneBudget.allowed) return {};
      const challenge = await this.policy.startChallenge({
        userId: user.id,
        purpose: "PASSWORD_RESET",
        method,
        destination: decryptPhone(user.phoneEncrypted, user.phoneEncryptionKeyVersion),
        destinationHash: user.phoneLookupHash,
        destinationVersion: user.phoneVersion,
        dimensions: [...context.dimensions, `account:${this.accountHash(normalizedEmail)}`],
        verificationBudgetReservation: phoneBudget.reservation,
      });
      return { challengeId: challenge.id };
    }

    if (!context.previousChallengeId || !hasEnrolledMethod(user, method)) return {};
    try {
      const challenge = await this.policy.switchChallengeMethod({
        challengeId: context.previousChallengeId,
        userId: user.id,
        purpose: "PASSWORD_RESET",
        method,
        destinationHash: factorBinding(method, user.id),
        destinationVersion: user.tokenVersion,
      });
      return { challengeId: challenge.id };
    } catch (error) {
      if (error instanceof VerificationRejectedError) return {};
      throw error;
    }
  }

  async completePasswordRecovery(challengeId: string, code: string, newPassword: string): Promise<void> {
    const challenge = await this.repository.findChallenge(challengeId);
    const user = challenge?.user;
    if (!challenge || !user || !activeUser(user) || challenge.userId !== user.id || challenge.purpose !== "PASSWORD_RESET") {
      throw new PasswordRecoveryRejectedError();
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    const correlationId = randomUUID();
    const commit = async (boundChallengeId: string, approvedAt: Date, recoveryCode?: string) => this.repository.resetPasswordFromChallenge({
      challengeId: boundChallengeId,
      userId: user.id,
      method: challenge.method,
      passwordHash,
      tokenVersion: user.tokenVersion,
      approvedAt,
      correlationId,
      recoveryCode,
    });

    try {
      if (challenge.method === "SMS") {
        if (!verifiedSmsUser(user)) throw new PasswordRecoveryRejectedError();
        const result = await this.policy.completeChallenge({
          challengeId,
          userId: user.id,
          method: "SMS",
          destination: decryptPhone(user.phoneEncrypted, user.phoneEncryptionKeyVersion),
          destinationHash: user.phoneLookupHash,
          destinationVersion: user.phoneVersion,
          code,
        }, async (boundChallengeId, approvedAt) => commit(boundChallengeId, approvedAt));
        if (!result.approved || result.value !== "approved") throw new PasswordRecoveryRejectedError();
      } else if (challenge.method === "TOTP") {
        if (!user.mfaEnabled || !user.mfaSecretEncrypted) throw new PasswordRecoveryRejectedError();
        const result = await this.policy.completeLocalChallenge({
          challengeId,
          userId: user.id,
          purpose: "PASSWORD_RESET",
          method: "TOTP",
          destinationHash: factorBinding("TOTP", user.id),
          destinationVersion: user.tokenVersion,
        }, async (boundChallengeId, approvedAt) => {
          let valid = false;
          try { valid = verifyTotp(decryptSecret(user.mfaSecretEncrypted!), code); } catch { /* invalid stored factor */ }
          if (!valid) return "incorrect";
          return await commit(boundChallengeId, approvedAt) === "approved" ? "approved" : "conflict";
        });
        if (!result.approved) throw new PasswordRecoveryRejectedError();
      } else if (challenge.method === "RECOVERY_CODE") {
        if (!hasEnrolledMethod(user, "RECOVERY_CODE")) throw new PasswordRecoveryRejectedError();
        const result = await this.policy.completeLocalChallenge({
          challengeId,
          userId: user.id,
          purpose: "PASSWORD_RESET",
          method: "RECOVERY_CODE",
          destinationHash: factorBinding("RECOVERY_CODE", user.id),
          destinationVersion: user.tokenVersion,
        }, async (boundChallengeId, approvedAt) => commit(boundChallengeId, approvedAt, code));
        if (!result.approved) throw new PasswordRecoveryRejectedError();
      } else {
        throw new PasswordRecoveryRejectedError();
      }
    } catch (error) {
      if (error instanceof VerificationRejectedError) throw new PasswordRecoveryRejectedError();
      throw error;
    }
    invalidateTokenVersionCache(user.id);
  }
}

type RecoveryRow = PasswordRecoveryUser;

function rowToUser(row: RecoveryRow | undefined): PasswordRecoveryUser | null {
  return row ?? null;
}

export class PrismaPasswordRecoveryRepository implements PasswordRecoveryRepository {
  async findByEmail(email: string): Promise<PasswordRecoveryUser | null> {
    const rows = await prisma.$queryRaw<RecoveryRow[]>`
      SELECT "id", "email", "accountStatus", "isActive", "tokenVersion", "phoneEncrypted", "phoneEncryptionKeyVersion",
             "phoneLookupHash", "phoneVersion", "phoneVerifiedAt", "mfaEnabled", "mfaSecretEncrypted", "mfaBackupCodeHashes"
      FROM "User" WHERE "email" = ${email} LIMIT 1
    `;
    return rowToUser(rows[0]);
  }

  async findChallenge(challengeId: string): Promise<PasswordRecoveryChallenge | null> {
    const rows = await prisma.$queryRaw<Array<{
      id: string; userId: string | null; purpose: string; method: PasswordRecoveryMethod;
      email: string | null; accountStatus: PasswordRecoveryUser["accountStatus"] | null; isActive: boolean | null;
      tokenVersion: number | null; phoneEncrypted: string | null; phoneEncryptionKeyVersion: number | null;
      phoneLookupHash: string | null; phoneVersion: number | null; phoneVerifiedAt: Date | null;
      mfaEnabled: boolean | null; mfaSecretEncrypted: string | null; mfaBackupCodeHashes: unknown;
    }>>`
      SELECT c."id", c."userId", c."purpose", c."method", u."email", u."accountStatus", u."isActive", u."tokenVersion",
             u."phoneEncrypted", u."phoneEncryptionKeyVersion", u."phoneLookupHash", u."phoneVersion", u."phoneVerifiedAt",
             u."mfaEnabled", u."mfaSecretEncrypted", u."mfaBackupCodeHashes"
      FROM "MfaChallenge" c LEFT JOIN "User" u ON u."id" = c."userId"
      WHERE c."id" = ${challengeId} LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    const user = row.email !== null && row.accountStatus !== null && row.isActive !== null && row.tokenVersion !== null
      && row.phoneVersion !== null && row.mfaEnabled !== null
      ? {
        id: row.userId!, email: row.email, accountStatus: row.accountStatus, isActive: row.isActive, tokenVersion: row.tokenVersion,
        phoneEncrypted: row.phoneEncrypted, phoneEncryptionKeyVersion: row.phoneEncryptionKeyVersion, phoneLookupHash: row.phoneLookupHash,
        phoneVersion: row.phoneVersion, phoneVerifiedAt: row.phoneVerifiedAt, mfaEnabled: row.mfaEnabled,
        mfaSecretEncrypted: row.mfaSecretEncrypted, mfaBackupCodeHashes: row.mfaBackupCodeHashes,
      }
      : null;
    return { id: row.id, userId: row.userId, purpose: row.purpose, method: row.method, user };
  }

  async resetPasswordFromChallenge(input: {
    challengeId: string;
    userId: string;
    method: PasswordRecoveryMethod;
    passwordHash: string;
    tokenVersion: number;
    approvedAt: Date;
    correlationId: string;
    recoveryCode?: string;
  }): Promise<"approved" | "incorrect" | "conflict"> {
    return prisma.$transaction(async (tx) => {
      const users = await tx.$queryRaw<Array<{
        id: string; accountStatus: string; isActive: boolean; tokenVersion: number; mfaBackupCodeHashes: unknown;
      }>>`
        SELECT "id", "accountStatus", "isActive", "tokenVersion", "mfaBackupCodeHashes"
        FROM "User" WHERE "id" = ${input.userId} FOR UPDATE
      `;
      const user = users[0];
      if (!user || user.accountStatus !== "ACTIVE" || !user.isActive || user.tokenVersion !== input.tokenVersion) return "conflict";

      let remaining: string[] | undefined;
      if (input.method === "RECOVERY_CODE") {
        if (!input.recoveryCode) return "conflict";
        const hashes = Array.isArray(user.mfaBackupCodeHashes)
          ? user.mfaBackupCodeHashes.filter((value): value is string => typeof value === "string")
          : [];
        const backup = await consumeBackupCode(input.recoveryCode, hashes);
        if (!backup.valid) return "incorrect";
        remaining = backup.remaining;
      }

      const consumed = await tx.$executeRaw`
        UPDATE "MfaChallenge" SET "consumedAt" = ${input.approvedAt}
        WHERE "id" = ${input.challengeId} AND "userId" = ${input.userId}
          AND "purpose" = 'PASSWORD_RESET' AND "method" = ${input.method}::"MfaMethod"
          AND "consumedAt" IS NULL AND "invalidatedAt" IS NULL AND "expiresAt" > ${input.approvedAt}
      `;
      if (consumed !== 1) return "conflict";

      await tx.user.update({
        where: { id: input.userId },
        data: {
          passwordHash: input.passwordHash,
          tokenVersion: { increment: 1 },
          ...(remaining ? { mfaBackupCodeHashes: remaining } : {}),
        },
      });
      await tx.securityAuditEvent.create({ data: {
        eventType: "password_recovered",
        outcome: "succeeded",
        method: input.method,
        actorUserId: input.userId,
        targetUserId: input.userId,
        safeReasonCode: "factor_approved",
        correlationId: input.correlationId,
      } });
      return "approved";
    });
  }
}
