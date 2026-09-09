BEGIN;

ALTER TABLE "MfaChallenge"
  ADD COLUMN "accountRateLimitHash" TEXT;

-- The candidate email cannot be recovered from a decoy challenge, so existing
-- live registration challenges cannot be safely backfilled. Retire both real
-- and decoy rows uniformly before requiring the account binding.
UPDATE "MfaChallenge"
SET "invalidatedAt" = NOW()
WHERE "purpose" = 'REGISTRATION'::"MfaChallengePurpose"
  AND "method" = 'SMS'::"MfaMethod"
  AND "consumedAt" IS NULL
  AND "invalidatedAt" IS NULL;

ALTER TABLE "MfaChallenge"
  ADD CONSTRAINT "MfaChallenge_registration_account_limit_binding"
  CHECK (
    "purpose" <> 'REGISTRATION'::"MfaChallengePurpose"
    OR "method" <> 'SMS'::"MfaMethod"
    OR "consumedAt" IS NOT NULL
    OR "invalidatedAt" IS NOT NULL
    OR (
      "accountRateLimitHash" IS NOT NULL
      AND "accountRateLimitHash" ~ '^[0-9a-f]{64}$'
    )
  ) NOT VALID;

ALTER TABLE "MfaChallenge"
  VALIDATE CONSTRAINT "MfaChallenge_registration_account_limit_binding";

COMMIT;
