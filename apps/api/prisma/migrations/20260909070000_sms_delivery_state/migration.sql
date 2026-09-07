BEGIN;

CREATE TYPE "SmsDeliveryState" AS ENUM ('PENDING', 'CLAIMED', 'SENDING', 'SENT', 'FAILED', 'AMBIGUOUS');

ALTER TABLE "MfaChallenge"
  ADD COLUMN "smsDestinationEncrypted" TEXT,
  ADD COLUMN "smsDestinationEncryptionKeyVersion" INTEGER,
  ADD COLUMN "smsDeliveryState" "SmsDeliveryState",
  ADD COLUMN "smsDeliveryLeaseId" TEXT,
  ADD COLUMN "smsDeliveryLeaseAt" TIMESTAMP(3),
  ADD COLUMN "smsDeliveryAttemptedAt" TIMESTAMP(3),
  ADD COLUMN "smsDeliveryCompletedAt" TIMESTAMP(3);

CREATE INDEX "MfaChallenge_smsDeliveryState_createdAt_idx"
  ON "MfaChallenge"("smsDeliveryState", "createdAt");

ALTER TABLE "MfaChallenge"
  ADD CONSTRAINT "MfaChallenge_sms_delivery_destination_pair_check"
    CHECK (("smsDestinationEncrypted" IS NULL) = ("smsDestinationEncryptionKeyVersion" IS NULL)),
  ADD CONSTRAINT "MfaChallenge_sms_delivery_state_destination_check"
    CHECK ("smsDeliveryState" IS NULL OR ("smsDestinationEncrypted" IS NOT NULL AND "smsDestinationEncryptionKeyVersion" IS NOT NULL)),
  ADD CONSTRAINT "MfaChallenge_sms_delivery_lease_check"
    CHECK (
      "smsDeliveryState" NOT IN ('CLAIMED', 'SENDING')
      OR ("smsDeliveryLeaseId" IS NOT NULL AND "smsDeliveryLeaseAt" IS NOT NULL)
    ),
  ADD CONSTRAINT "MfaChallenge_sms_delivery_attempt_check"
    CHECK ("smsDeliveryState" <> 'SENDING' OR "smsDeliveryAttemptedAt" IS NOT NULL),
  ADD CONSTRAINT "MfaChallenge_sms_delivery_complete_check"
    CHECK (
      "smsDeliveryState" NOT IN ('SENT', 'FAILED', 'AMBIGUOUS')
      OR "smsDeliveryCompletedAt" IS NOT NULL
    );

COMMIT;
