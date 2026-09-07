BEGIN;

ALTER TABLE "User"
  ADD CONSTRAINT "User_phone_version_nonnegative"
  CHECK ("phoneVersion" >= 0),
  ADD CONSTRAINT "User_phone_identity_complete"
  CHECK (
    (
      "phoneEncrypted" IS NULL
      AND "phoneEncryptionKeyVersion" IS NULL
      AND "phoneLookupHash" IS NULL
      AND "phoneLookupKeyVersion" IS NULL
      AND "phoneLast4" IS NULL
      AND "phoneVersion" = 0
      AND "phoneVerifiedAt" IS NULL
    )
    OR
    (
      "phoneEncrypted" IS NOT NULL
      AND "phoneEncryptionKeyVersion" > 0
      AND "phoneLookupHash" IS NOT NULL
      AND "phoneLookupKeyVersion" > 0
      AND "phoneLast4" ~ '^[0-9]{4}$'
      AND "phoneVersion" > 0
    )
  ),
  ADD CONSTRAINT "User_phone_verification_state"
  CHECK (
    "phoneVerifiedAt" IS NULL
    OR ("accountStatus" = 'ACTIVE' AND "isActive" = true)
  ),
  ADD CONSTRAINT "User_phone_consent_complete"
  CHECK (
    (
      "phoneConsentAt" IS NULL
      AND "phoneConsentVersion" IS NULL
      AND "phoneConsentSource" IS NULL
    )
    OR
    (
      "phoneConsentAt" IS NOT NULL
      AND NULLIF(BTRIM("phoneConsentVersion"), '') IS NOT NULL
      AND NULLIF(BTRIM("phoneConsentSource"), '') IS NOT NULL
    )
  );

COMMIT;
