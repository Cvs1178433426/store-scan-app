import { randomUUID } from "node:crypto";
import { decryptPhone } from "./phone.js";
import { prisma } from "./prisma.js";
import type { SecurityNotificationProvider } from "./securityNotificationProvider.js";
import { invalidateTokenVersionCache } from "./tokenVersion.js";
import { VerificationRejectedError, type StartChallengeInput, type VerificationPolicy } from "./verificationPolicy.js";

export type FactorRemovalResult = { removed: true; notification: "accepted" | "failed" };

export class FactorRemovalVerificationRejectedError extends Error {
  constructor() {
    super("Factor removal challenge was not approved.");
    this.name = "FactorRemovalVerificationRejectedError";
  }
}

export class FactorRemovalCommittedResultError extends Error {
  constructor(readonly result: FactorRemovalResult) {
    super("Factor removal committed but post-commit processing failed.");
    this.name = "FactorRemovalCommittedResultError";
  }
}

export type FactorRemovalUser = {
  id: string;
  accountStatus: "PENDING_PHONE_VERIFICATION" | "ACTIVE" | "DISABLED";
  isActive: boolean;
  mfaEnabled: boolean;
  mfaSecretEncrypted: string | null;
  phoneEncrypted: string | null;
  phoneEncryptionKeyVersion: number | null;
  phoneLookupHash: string | null;
  phoneVersion: number;
  phoneVerifiedAt: Date | null;
};

export type FactorRemovalChallengePolicy = Pick<VerificationPolicy, "startChallenge" | "completeChallenge">;

type RemoveTotpInput = {
  challengeId: string;
  userId: string;
  approvedAt: Date;
  correlationId: string;
};

type NotificationOutcomeInput = {
  userId: string;
  correlationId: string;
  outcome: "accepted" | "failed";
  safeReasonCode: "provider_accepted" | "provider_request_failed";
};

export interface FactorRemovalRepository {
  removeTotpFromChallenge(input: RemoveTotpInput): Promise<boolean>;
  recordNotificationOutcome(input: NotificationOutcomeInput): Promise<void>;
}

function verifiedRemovalUser(user: FactorRemovalUser): {
  phoneE164: string;
  phoneLookupHash: string;
  phoneVersion: number;
} {
  if (
    user.accountStatus !== "ACTIVE"
    || !user.isActive
    || !user.mfaEnabled
    || !user.mfaSecretEncrypted
    || !user.phoneEncrypted
    || user.phoneEncryptionKeyVersion === null
    || !user.phoneLookupHash
    || !user.phoneVerifiedAt
    || !Number.isInteger(user.phoneVersion)
    || user.phoneVersion < 1
  ) {
    throw new FactorRemovalVerificationRejectedError();
  }
  return {
    phoneE164: decryptPhone(user.phoneEncrypted, user.phoneEncryptionKeyVersion),
    phoneLookupHash: user.phoneLookupHash,
    phoneVersion: user.phoneVersion,
  };
}

export class FactorRemovalService {
  constructor(
    private readonly repository: FactorRemovalRepository,
    private readonly policy: FactorRemovalChallengePolicy,
    private readonly notificationProvider: SecurityNotificationProvider,
  ) {}

  async startTotpRemoval(
    user: FactorRemovalUser,
    dimensions: string[],
  ): Promise<{ id: string; expiresAt: Date }> {
    const phone = verifiedRemovalUser(user);
    const input: StartChallengeInput = {
      userId: user.id,
      purpose: "FACTOR_REMOVAL",
      method: "SMS",
      destination: phone.phoneE164,
      destinationHash: phone.phoneLookupHash,
      destinationVersion: phone.phoneVersion,
      dimensions,
    };
    return this.policy.startChallenge(input);
  }

  async confirmTotpRemoval(
    user: FactorRemovalUser,
    challengeId: string,
    code: string,
  ): Promise<FactorRemovalResult> {
    const phone = verifiedRemovalUser(user);
    const correlationId = randomUUID();
    let result: { approved: boolean; value?: boolean };
    try {
      result = await this.policy.completeChallenge({
        challengeId,
        userId: user.id,
        method: "SMS",
        destination: phone.phoneE164,
        destinationHash: phone.phoneLookupHash,
        destinationVersion: phone.phoneVersion,
        code,
      }, (boundChallengeId, approvedAt) => this.repository.removeTotpFromChallenge({
        challengeId: boundChallengeId,
        userId: user.id,
        approvedAt,
        correlationId,
      }));
    } catch (error) {
      if (error instanceof VerificationRejectedError) throw new FactorRemovalVerificationRejectedError();
      throw error;
    }
    if (!result.approved || result.value !== true) {
      throw new FactorRemovalVerificationRejectedError();
    }

    const notificationFailed: FactorRemovalResult = { removed: true, notification: "failed" };
    try {
      invalidateTokenVersionCache(user.id);
    } catch {
      throw new FactorRemovalCommittedResultError(notificationFailed);
    }
    try {
      await this.notificationProvider.notifyFactorChanged({
        destination: phone.phoneE164,
        event: "TOTP_REMOVED",
        correlationId,
      });
    } catch {
      try {
        await this.repository.recordNotificationOutcome({
          userId: user.id,
          correlationId,
          outcome: "failed",
          safeReasonCode: "provider_request_failed",
        });
      } catch {
        throw new FactorRemovalCommittedResultError(notificationFailed);
      }
      return notificationFailed;
    }

    const notificationAccepted: FactorRemovalResult = { removed: true, notification: "accepted" };
    try {
      await this.repository.recordNotificationOutcome({
        userId: user.id,
        correlationId,
        outcome: "accepted",
        safeReasonCode: "provider_accepted",
      });
    } catch {
      throw new FactorRemovalCommittedResultError(notificationAccepted);
    }
    return notificationAccepted;
  }
}

export class PrismaFactorRemovalRepository implements FactorRemovalRepository {
  async removeTotpFromChallenge(input: RemoveTotpInput): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const users = await tx.$queryRaw<Array<{ id: string; mfaEnabled: boolean }>>`
        SELECT "id", "mfaEnabled" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE
      `;
      if (!users[0]?.mfaEnabled) throw new FactorRemovalVerificationRejectedError();

      const consumed = await tx.$executeRaw`
        UPDATE "MfaChallenge" SET "consumedAt" = ${input.approvedAt}
        WHERE "id" = ${input.challengeId} AND "userId" = ${input.userId}
          AND "purpose" = 'FACTOR_REMOVAL' AND "method" = 'SMS'
          AND "consumedAt" IS NULL AND "invalidatedAt" IS NULL
          AND "expiresAt" > ${input.approvedAt}
      `;
      if (consumed !== 1) throw new FactorRemovalVerificationRejectedError();

      const removed = await tx.$executeRaw`
        UPDATE "User" SET "mfaEnabled" = false, "mfaSecretEncrypted" = NULL,
          "tokenVersion" = "tokenVersion" + 1
        WHERE "id" = ${input.userId} AND "accountStatus" = 'ACTIVE' AND "isActive" = true
          AND "mfaEnabled" = true AND "mfaSecretEncrypted" IS NOT NULL
      `;
      if (removed !== 1) throw new FactorRemovalVerificationRejectedError();

      await tx.securityAuditEvent.create({ data: {
        eventType: "totp_removed",
        outcome: "succeeded",
        method: "SMS",
        actorUserId: input.userId,
        targetUserId: input.userId,
        safeReasonCode: "different_factor_approved",
        correlationId: input.correlationId,
      } });
      return true;
    });
  }

  async recordNotificationOutcome(input: NotificationOutcomeInput): Promise<void> {
    await prisma.securityAuditEvent.create({ data: {
      eventType: "factor_change_notification",
      outcome: input.outcome,
      method: "SMS",
      actorUserId: input.userId,
      targetUserId: input.userId,
      safeReasonCode: input.safeReasonCode,
      correlationId: input.correlationId,
    } });
  }
}
