BEGIN;

ALTER TABLE "MfaChallenge"
  ADD COLUMN "tokenVersionAtIssue" INTEGER;

UPDATE "MfaChallenge" AS challenge
SET "tokenVersionAtIssue" = account."tokenVersion"
FROM "User" AS account
WHERE challenge."userId" = account."id";

-- Challenges created before this binding existed cannot safely survive the upgrade.
UPDATE "MfaChallenge"
SET "invalidatedAt" = CURRENT_TIMESTAMP
WHERE "userId" IS NOT NULL
  AND "consumedAt" IS NULL
  AND "invalidatedAt" IS NULL;

ALTER TABLE "MfaChallenge"
  ADD CONSTRAINT "MfaChallenge_token_version_binding"
  CHECK (
    ("userId" IS NULL AND "tokenVersionAtIssue" IS NULL)
    OR
    ("userId" IS NOT NULL AND "tokenVersionAtIssue" IS NOT NULL AND "tokenVersionAtIssue" >= 0)
  );

COMMIT;
