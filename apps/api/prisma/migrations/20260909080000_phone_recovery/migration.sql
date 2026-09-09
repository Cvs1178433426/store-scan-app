BEGIN;

CREATE TYPE "PhoneRecoveryStatus" AS ENUM (
  'NOTICE_PENDING',
  'EMAIL_PENDING',
  'EMAIL_VERIFIED',
  'PHONE_PENDING',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
  'EXPIRED'
);

CREATE TABLE "PhoneRecoveryCase" (
  "id" TEXT NOT NULL,
  "targetUserId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "status" "PhoneRecoveryStatus" NOT NULL DEFAULT 'NOTICE_PENDING',
  "caseReferenceHash" TEXT NOT NULL,
  "tokenVersionAtIssue" INTEGER NOT NULL,
  "phoneVersionAtIssue" INTEGER NOT NULL,
  "pendingPhoneEncrypted" TEXT,
  "pendingPhoneEncryptionKeyVersion" INTEGER,
  "pendingPhoneLookupHash" TEXT,
  "pendingPhoneLookupKeyVersion" INTEGER,
  "pendingPhoneLast4" TEXT,
  "pendingConsentAt" TIMESTAMP(3),
  "pendingConsentVersion" TEXT,
  "noticeAcceptedAt" TIMESTAMP(3),
  "emailVerifiedAt" TIMESTAMP(3),
  "phoneVerifiedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "expiredAt" TIMESTAMP(3),
  "safeFailureReason" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PhoneRecoveryCase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PhoneRecoveryCase_caseReferenceHash_key" UNIQUE ("caseReferenceHash"),
  CONSTRAINT "PhoneRecoveryCase_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PhoneRecoveryCase_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PhoneRecoveryCase_actor_target_check" CHECK ("actorUserId" <> "targetUserId"),
  CONSTRAINT "PhoneRecoveryCase_version_check" CHECK ("tokenVersionAtIssue" >= 0 AND "phoneVersionAtIssue" >= 0),
  CONSTRAINT "PhoneRecoveryCase_expiry_check" CHECK ("expiresAt" > "createdAt"),
  CONSTRAINT "PhoneRecoveryCase_pending_phone_check" CHECK (
    (
      "pendingPhoneEncrypted" IS NULL AND "pendingPhoneEncryptionKeyVersion" IS NULL
      AND "pendingPhoneLookupHash" IS NULL AND "pendingPhoneLookupKeyVersion" IS NULL
      AND "pendingPhoneLast4" IS NULL AND "pendingConsentAt" IS NULL AND "pendingConsentVersion" IS NULL
    ) OR (
      "pendingPhoneEncrypted" IS NOT NULL AND "pendingPhoneEncryptionKeyVersion" > 0
      AND "pendingPhoneLookupHash" IS NOT NULL AND "pendingPhoneLookupKeyVersion" > 0
      AND "pendingPhoneLast4" ~ '^[0-9]{4}$' AND "pendingConsentAt" IS NOT NULL
      AND NULLIF(BTRIM("pendingConsentVersion"), '') IS NOT NULL
    )
  ),
  CONSTRAINT "PhoneRecoveryCase_status_timestamps_check" CHECK (
    ("status" = 'NOTICE_PENDING' AND "noticeAcceptedAt" IS NULL)
    OR ("status" = 'EMAIL_PENDING' AND "noticeAcceptedAt" IS NOT NULL)
    OR ("status" = 'EMAIL_VERIFIED' AND "noticeAcceptedAt" IS NOT NULL AND "emailVerifiedAt" IS NOT NULL)
    OR ("status" = 'PHONE_PENDING' AND "noticeAcceptedAt" IS NOT NULL AND "emailVerifiedAt" IS NOT NULL AND "pendingPhoneEncrypted" IS NOT NULL)
    OR ("status" = 'COMPLETED' AND "noticeAcceptedAt" IS NOT NULL AND "emailVerifiedAt" IS NOT NULL AND "pendingPhoneEncrypted" IS NOT NULL AND "phoneVerifiedAt" IS NOT NULL AND "completedAt" IS NOT NULL)
    OR ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL)
    OR ("status" = 'FAILED' AND "failedAt" IS NOT NULL AND NULLIF(BTRIM("safeFailureReason"), '') IS NOT NULL)
    OR ("status" = 'EXPIRED' AND "expiredAt" IS NOT NULL)
  )
);

CREATE INDEX "PhoneRecoveryCase_targetUserId_createdAt_idx" ON "PhoneRecoveryCase"("targetUserId", "createdAt");
CREATE INDEX "PhoneRecoveryCase_actorUserId_createdAt_idx" ON "PhoneRecoveryCase"("actorUserId", "createdAt");
CREATE INDEX "PhoneRecoveryCase_status_expiresAt_idx" ON "PhoneRecoveryCase"("status", "expiresAt");
CREATE UNIQUE INDEX "PhoneRecoveryCase_one_open_per_user_key"
  ON "PhoneRecoveryCase"("targetUserId")
  WHERE "status" IN ('NOTICE_PENDING', 'EMAIL_PENDING', 'EMAIL_VERIFIED', 'PHONE_PENDING');

CREATE TABLE "PhoneRecoveryPhoneAlias" (
  "hash" TEXT NOT NULL,
  "keyVersion" INTEGER NOT NULL,
  "caseId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PhoneRecoveryPhoneAlias_pkey" PRIMARY KEY ("hash"),
  CONSTRAINT "PhoneRecoveryPhoneAlias_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "PhoneRecoveryCase"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PhoneRecoveryPhoneAlias_key_version_check" CHECK ("keyVersion" > 0),
  CONSTRAINT "PhoneRecoveryPhoneAlias_expiry_check" CHECK ("expiresAt" > "createdAt")
);

CREATE INDEX "PhoneRecoveryPhoneAlias_caseId_idx" ON "PhoneRecoveryPhoneAlias"("caseId");
CREATE INDEX "PhoneRecoveryPhoneAlias_expiresAt_idx" ON "PhoneRecoveryPhoneAlias"("expiresAt");

CREATE OR REPLACE FUNCTION "claim_recovery_phone_lookup_hash"()
RETURNS TRIGGER AS $$
DECLARE
  target_user_id TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW."hash"));
  SELECT "targetUserId" INTO target_user_id FROM "PhoneRecoveryCase" WHERE "id" = NEW."caseId";
  IF EXISTS (
    SELECT 1 FROM "PhoneLookupAlias"
    WHERE "hash" = NEW."hash" AND "userId" <> target_user_id
  ) THEN
    RAISE EXCEPTION 'phone lookup hash is already owned' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PhoneRecoveryPhoneAlias_claim_hash"
BEFORE INSERT OR UPDATE OF "hash", "caseId" ON "PhoneRecoveryPhoneAlias"
FOR EACH ROW EXECUTE FUNCTION "claim_recovery_phone_lookup_hash"();

CREATE OR REPLACE FUNCTION "protect_phone_lookup_hash_from_recovery"()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW."hash"));
  IF EXISTS (
    SELECT 1
    FROM "PhoneRecoveryPhoneAlias" AS provisional
    JOIN "PhoneRecoveryCase" AS recovery ON recovery."id" = provisional."caseId"
    WHERE provisional."hash" = NEW."hash"
      AND provisional."expiresAt" > NOW()
      AND recovery."targetUserId" <> NEW."userId"
  ) THEN
    RAISE EXCEPTION 'phone lookup hash is reserved for recovery' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PhoneLookupAlias_protect_recovery_hash"
BEFORE INSERT OR UPDATE OF "hash", "userId" ON "PhoneLookupAlias"
FOR EACH ROW EXECUTE FUNCTION "protect_phone_lookup_hash_from_recovery"();

ALTER TABLE "MfaChallenge"
  ADD COLUMN "phoneRecoveryCaseId" TEXT,
  ADD COLUMN "localCodeDigest" BYTEA,
  ADD CONSTRAINT "MfaChallenge_phoneRecoveryCaseId_fkey" FOREIGN KEY ("phoneRecoveryCaseId") REFERENCES "PhoneRecoveryCase"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MfaChallenge_phone_recovery_binding_check" CHECK (
    (
      "purpose" = 'PHONE_RECOVERY_EMAIL'
      AND "method" = 'EMAIL'
      AND "phoneRecoveryCaseId" IS NOT NULL
      AND "localCodeDigest" IS NOT NULL
    ) OR (
      "purpose" = 'PHONE_RECOVERY_SMS'
      AND "method" = 'SMS'
      AND "phoneRecoveryCaseId" IS NOT NULL
      AND "localCodeDigest" IS NULL
    ) OR (
      "purpose" NOT IN ('PHONE_RECOVERY_EMAIL', 'PHONE_RECOVERY_SMS')
      AND "phoneRecoveryCaseId" IS NULL
      AND "localCodeDigest" IS NULL
    )
  );

CREATE INDEX "MfaChallenge_phoneRecoveryCaseId_purpose_createdAt_idx"
  ON "MfaChallenge"("phoneRecoveryCaseId", "purpose", "createdAt");

COMMIT;
