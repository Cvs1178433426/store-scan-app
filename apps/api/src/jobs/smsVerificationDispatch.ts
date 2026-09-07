import { randomUUID } from "node:crypto";
import cron from "node-cron";
import { decryptPhone } from "../lib/phone.js";
import { prisma } from "../lib/prisma.js";
import { TwilioVerifyProvider } from "../lib/twilioVerifyProvider.js";
import { consumeSmsDispatchBudget } from "../lib/verificationRateLimit.js";
import type { VerificationProvider } from "../lib/verificationProvider.js";

export type PendingSmsVerification = { challengeId: string; leaseId: string; destination: string };

export interface SmsVerificationDispatchRepository {
  purgeExpired(now: Date): Promise<number>;
  claimPending(): Promise<PendingSmsVerification | null>;
  beginSending(challengeId: string, leaseId: string): Promise<boolean>;
  markDelivered(challengeId: string, leaseId: string, providerRef: string): Promise<boolean>;
  markFailed(challengeId: string, leaseId: string): Promise<void>;
  markAmbiguous(challengeId: string, leaseId: string): Promise<void>;
  releaseClaim(challengeId: string, leaseId: string): Promise<void>;
}

type ClaimedRow = { challengeId: string; smsDestinationEncrypted: string; smsDestinationEncryptionKeyVersion: number };

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when SMS MFA is enabled.`);
  return value;
}

export class PrismaSmsVerificationDispatchRepository implements SmsVerificationDispatchRepository {
  async purgeExpired(now: Date): Promise<number> {
    return prisma.$executeRaw`DELETE FROM "MfaChallenge" WHERE "expiresAt" <= ${now}`;
  }

  async claimPending(): Promise<PendingSmsVerification | null> {
    const leaseId = randomUUID();
    const row = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "MfaChallenge"
        SET "providerRef" = 'decoy', "smsDeliveryState" = 'AMBIGUOUS'::"SmsDeliveryState",
          "smsDeliveryCompletedAt" = NOW(), "smsDeliveryLeaseId" = NULL, "smsDeliveryLeaseAt" = NULL
        WHERE "smsDeliveryState" = 'SENDING'::"SmsDeliveryState"
          AND "smsDeliveryAttemptedAt" < NOW() - INTERVAL '1 minute'
          AND "smsDeliveryCompletedAt" IS NULL
      `;
      const rows = await tx.$queryRaw<ClaimedRow[]>`
        SELECT challenge."id" AS "challengeId", challenge."smsDestinationEncrypted",
          challenge."smsDestinationEncryptionKeyVersion"
        FROM "MfaChallenge" AS challenge
        WHERE challenge."method" = 'SMS'::"MfaMethod"
          AND challenge."purpose" IN ('REGISTRATION'::"MfaChallengePurpose", 'PASSWORD_RESET'::"MfaChallengePurpose", 'PHONE_RECOVERY_SMS'::"MfaChallengePurpose")
          AND (
            challenge."smsDeliveryState" = 'PENDING'::"SmsDeliveryState"
            OR (challenge."smsDeliveryState" = 'CLAIMED'::"SmsDeliveryState"
              AND challenge."smsDeliveryLeaseAt" < NOW() - INTERVAL '1 minute')
          )
          AND challenge."consumedAt" IS NULL AND challenge."invalidatedAt" IS NULL
          AND challenge."expiresAt" > NOW()
          AND challenge."smsDestinationEncrypted" IS NOT NULL
          AND challenge."smsDestinationEncryptionKeyVersion" IS NOT NULL
          AND (
            (challenge."userId" IS NULL AND challenge."purpose" = 'REGISTRATION'::"MfaChallengePurpose")
            OR EXISTS (
              SELECT 1 FROM "User" AS account
              WHERE account."id" = challenge."userId"
                AND challenge."tokenVersionAtIssue" = account."tokenVersion"
                AND (
                  (challenge."purpose" = 'REGISTRATION'::"MfaChallengePurpose"
                    AND challenge."phoneLookupHash" = account."phoneLookupHash"
                    AND challenge."destinationVersion" = account."phoneVersion"
                    AND account."accountStatus" = 'PENDING_PHONE_VERIFICATION'::"AccountStatus" AND account."isActive" = false)
                  OR (challenge."purpose" = 'PASSWORD_RESET'::"MfaChallengePurpose"
                    AND challenge."phoneLookupHash" = account."phoneLookupHash"
                    AND challenge."destinationVersion" = account."phoneVersion"
                    AND account."accountStatus" = 'ACTIVE'::"AccountStatus" AND account."isActive" = true
                    AND account."phoneVerifiedAt" IS NOT NULL)
                  OR (challenge."purpose" = 'PHONE_RECOVERY_SMS'::"MfaChallengePurpose"
                    AND account."accountStatus" = 'ACTIVE'::"AccountStatus" AND account."isActive" = true
                    AND EXISTS (
                      SELECT 1 FROM "PhoneRecoveryCase" AS recovery
                      WHERE recovery."id" = challenge."phoneRecoveryCaseId"
                        AND recovery."targetUserId" = account."id"
                        AND recovery."status" = 'PHONE_PENDING'::"PhoneRecoveryStatus"
                        AND recovery."pendingPhoneLookupHash" = challenge."phoneLookupHash"
                        AND recovery."tokenVersionAtIssue" = account."tokenVersion"
                        AND recovery."phoneVersionAtIssue" + 1 = challenge."destinationVersion"
                        AND recovery."expiresAt" > NOW()
                    ))
                )
            )
          )
        ORDER BY challenge."createdAt" ASC
        FOR UPDATE OF challenge SKIP LOCKED
        LIMIT 1
      `;
      const candidate = rows[0];
      if (!candidate) return null;
      const changed = await tx.$executeRaw`
        UPDATE "MfaChallenge"
        SET "smsDeliveryState" = 'CLAIMED'::"SmsDeliveryState", "smsDeliveryLeaseId" = ${leaseId},
          "smsDeliveryLeaseAt" = NOW(), "smsDeliveryAttemptedAt" = NULL, "smsDeliveryCompletedAt" = NULL
        WHERE "id" = ${candidate.challengeId}
          AND "smsDeliveryState" IN ('PENDING'::"SmsDeliveryState", 'CLAIMED'::"SmsDeliveryState")
          AND "consumedAt" IS NULL AND "invalidatedAt" IS NULL AND "expiresAt" > NOW()
      `;
      return changed === 1 ? candidate : null;
    });
    if (!row) return null;
    try {
      return {
        challengeId: row.challengeId,
        leaseId,
        destination: decryptPhone(row.smsDestinationEncrypted, row.smsDestinationEncryptionKeyVersion),
      };
    } catch {
      await this.markFailed(row.challengeId, leaseId);
      return null;
    }
  }

  async beginSending(challengeId: string, leaseId: string): Promise<boolean> {
    const changed = await prisma.$executeRaw`
      UPDATE "MfaChallenge" SET "smsDeliveryState" = 'SENDING'::"SmsDeliveryState", "smsDeliveryAttemptedAt" = NOW()
      WHERE "id" = ${challengeId} AND "smsDeliveryState" = 'CLAIMED'::"SmsDeliveryState"
        AND "smsDeliveryLeaseId" = ${leaseId} AND "consumedAt" IS NULL
        AND "invalidatedAt" IS NULL AND "expiresAt" > NOW()
    `;
    return changed === 1;
  }

  async markDelivered(challengeId: string, leaseId: string, providerRef: string): Promise<boolean> {
    if (!providerRef || providerRef.startsWith("pending:") || providerRef === "decoy") {
      await this.markAmbiguous(challengeId, leaseId);
      return false;
    }
    const changed = await prisma.$executeRaw`
      UPDATE "MfaChallenge"
      SET "providerRef" = ${providerRef}, "smsDeliveryState" = 'SENT'::"SmsDeliveryState",
        "smsDeliveryCompletedAt" = NOW(), "smsDeliveryLeaseId" = NULL, "smsDeliveryLeaseAt" = NULL
      WHERE "id" = ${challengeId} AND "smsDeliveryState" = 'SENDING'::"SmsDeliveryState"
        AND "smsDeliveryLeaseId" = ${leaseId} AND "consumedAt" IS NULL
        AND "invalidatedAt" IS NULL AND "expiresAt" > NOW()
    `;
    return changed === 1;
  }

  async markFailed(challengeId: string, leaseId: string): Promise<void> {
    await this.finish(challengeId, leaseId, "FAILED");
  }

  async markAmbiguous(challengeId: string, leaseId: string): Promise<void> {
    await this.finish(challengeId, leaseId, "AMBIGUOUS");
  }

  private async finish(challengeId: string, leaseId: string, state: "FAILED" | "AMBIGUOUS"): Promise<void> {
    await prisma.$executeRaw`
      UPDATE "MfaChallenge"
      SET "providerRef" = 'decoy', "smsDeliveryState" = ${state}::"SmsDeliveryState",
        "smsDeliveryCompletedAt" = NOW(), "smsDeliveryLeaseId" = NULL, "smsDeliveryLeaseAt" = NULL
      WHERE "id" = ${challengeId} AND "smsDeliveryLeaseId" = ${leaseId}
        AND "smsDeliveryState" IN ('CLAIMED'::"SmsDeliveryState", 'SENDING'::"SmsDeliveryState")
        AND "consumedAt" IS NULL AND "invalidatedAt" IS NULL
    `;
  }

  async releaseClaim(challengeId: string, leaseId: string): Promise<void> {
    await prisma.$executeRaw`
      UPDATE "MfaChallenge"
      SET "smsDeliveryState" = 'PENDING'::"SmsDeliveryState", "smsDeliveryLeaseId" = NULL, "smsDeliveryLeaseAt" = NULL
      WHERE "id" = ${challengeId} AND "smsDeliveryState" = 'CLAIMED'::"SmsDeliveryState"
        AND "smsDeliveryLeaseId" = ${leaseId} AND "smsDeliveryAttemptedAt" IS NULL
    `;
  }
}

export async function dispatchPendingSmsVerifications(
  repository: SmsVerificationDispatchRepository,
  provider: VerificationProvider,
  reserveProviderSend: () => Promise<boolean> = () => consumeSmsDispatchBudget(new Date()),
  limit = 20,
): Promise<void> {
  await repository.purgeExpired(new Date());
  for (let processed = 0; processed < limit; processed += 1) {
    const delivery = await repository.claimPending();
    if (!delivery) return;
    if (!await reserveProviderSend()) {
      await repository.releaseClaim(delivery.challengeId, delivery.leaseId);
      return;
    }
    if (!await repository.beginSending(delivery.challengeId, delivery.leaseId)) continue;
    try {
      const result = await provider.start(delivery.destination, "sms");
      await repository.markDelivered(delivery.challengeId, delivery.leaseId, result.providerRef);
    } catch {
      await repository.markAmbiguous(delivery.challengeId, delivery.leaseId);
    }
  }
}

export function createSerializedSmsDispatchRunner(cycle: () => Promise<void>): () => Promise<void> {
  let active: Promise<void> | null = null;
  return () => {
    if (active) return active;
    active = cycle().finally(() => { active = null; });
    return active;
  };
}

export async function cleanupExpiredMfaChallenges(
  repository: Pick<SmsVerificationDispatchRepository, "purgeExpired"> = new PrismaSmsVerificationDispatchRepository(),
  now = new Date(),
): Promise<number> {
  return repository.purgeExpired(now);
}

export function startExpiredMfaChallengeCleanupJob(): void {
  const run = () => cleanupExpiredMfaChallenges()
    .catch((error) => console.error("[mfa-challenge-cleanup] run failed", error instanceof Error ? error.name : "unknown"));
  void run();
  cron.schedule("17 * * * *", run);
}

export function startSmsVerificationDispatchJob(): void {
  const provider = new TwilioVerifyProvider({
    accountSid: required("TWILIO_ACCOUNT_SID"), apiKeySid: required("TWILIO_API_KEY_SID"),
    apiKeySecret: required("TWILIO_API_KEY_SECRET"), serviceSid: required("TWILIO_VERIFY_SERVICE_SID"),
  });
  const repository = new PrismaSmsVerificationDispatchRepository();
  const run = createSerializedSmsDispatchRunner(async () => {
    try {
      await dispatchPendingSmsVerifications(repository, provider);
    } catch (error) {
      console.error("[sms-verification-dispatch] run failed", error instanceof Error ? error.name : "unknown");
    }
  });
  void run();
  cron.schedule("*/2 * * * * *", () => { void run(); });
}
