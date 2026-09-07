BEGIN;

ALTER TABLE "MfaChallenge"
  ADD COLUMN "phonePrefixHash" TEXT;

-- Existing SMS approvals cannot be backfilled because the raw phone number is
-- intentionally not retained on a challenge. Retire them before enforcing the
-- binding so deployment never revives an unbound challenge.
UPDATE "MfaChallenge"
SET "invalidatedAt" = NOW()
WHERE "method" = 'SMS'::"MfaMethod"
  AND "consumedAt" IS NULL
  AND "invalidatedAt" IS NULL;

ALTER TABLE "MfaChallenge"
  ADD CONSTRAINT "MfaChallenge_sms_prefix_binding"
  CHECK (
    "method" <> 'SMS'::"MfaMethod"
    OR "consumedAt" IS NOT NULL
    OR "invalidatedAt" IS NOT NULL
    OR (
      "phonePrefixHash" IS NOT NULL
      AND "phonePrefixHash" ~ '^[0-9a-f]{64}$'
    )
  ) NOT VALID;

ALTER TABLE "MfaChallenge"
  VALIDATE CONSTRAINT "MfaChallenge_sms_prefix_binding";

COMMIT;
