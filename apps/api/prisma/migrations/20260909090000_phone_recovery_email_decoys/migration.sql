BEGIN;

ALTER TABLE "MfaChallenge"
  DROP CONSTRAINT "MfaChallenge_phone_recovery_binding_check";

ALTER TABLE "MfaChallenge"
  ADD CONSTRAINT "MfaChallenge_phone_recovery_binding_check" CHECK (
    (
      "purpose" = 'PHONE_RECOVERY_EMAIL'
      AND "method" = 'EMAIL'
      AND "localCodeDigest" IS NOT NULL
      AND "accountRateLimitHash" IS NOT NULL
      AND "accountRateLimitHash" ~ '^[0-9a-f]{64}$'
      AND (
        ("phoneRecoveryCaseId" IS NOT NULL AND "userId" IS NOT NULL)
        OR ("phoneRecoveryCaseId" IS NULL AND "userId" IS NULL)
      )
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

COMMIT;
