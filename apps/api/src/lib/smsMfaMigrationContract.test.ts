import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const rateLimitMigration = readFileSync(
  new URL("../../prisma/migrations/20260902010000_verification_rate_limits/migration.sql", import.meta.url),
  "utf8",
);
const phoneAliasMigration = readFileSync(
  new URL("../../prisma/migrations/20260909020000_phone_lookup_aliases/migration.sql", import.meta.url),
  "utf8",
);
const challengeTokenVersionMigration = readFileSync(
  new URL("../../prisma/migrations/20260909030000_mfa_challenge_token_version/migration.sql", import.meta.url),
  "utf8",
);
const phoneStateMigration = readFileSync(
  new URL("../../prisma/migrations/20260909040000_user_phone_state_constraints/migration.sql", import.meta.url),
  "utf8",
);
const challengePhonePrefixMigration = readFileSync(
  new URL("../../prisma/migrations/20260909050000_mfa_challenge_phone_prefix/migration.sql", import.meta.url),
  "utf8",
);
const challengeAccountLimitMigration = readFileSync(
  new URL("../../prisma/migrations/20260909060000_mfa_challenge_account_limit/migration.sql", import.meta.url),
  "utf8",
);
const smsDeliveryMigration = readFileSync(
  new URL("../../prisma/migrations/20260909070000_sms_delivery_state/migration.sql", import.meta.url),
  "utf8",
);
const phoneRecoveryEmailDecoyMigration = readFileSync(
  new URL("../../prisma/migrations/20260909090000_phone_recovery_email_decoys/migration.sql", import.meta.url),
  "utf8",
);
const auditIntegrityMigrationUrl = new URL(
  "../../prisma/migrations/20260909100000_security_audit_integrity/migration.sql",
  import.meta.url,
);
const auditIntegrityMigration = existsSync(auditIntegrityMigrationUrl)
  ? readFileSync(auditIntegrityMigrationUrl, "utf8")
  : "";
const ciWorkflow = readFileSync(new URL("../../../../.github/workflows/ci.yml", import.meta.url), "utf8");
const postgresValidation = readFileSync(
  new URL("../../scripts/smsMfaPostgresValidation.ts", import.meta.url),
  "utf8",
);

describe("SMS MFA migration contract", () => {
  it("uses the same explicit, PostgreSQL-safe rate-limit index name in schema and SQL", () => {
    const indexName = "VerificationRateLimit_scope_action_key_window_key";

    expect(schema).toContain(`@@unique([tenantScope, action, keyHash, windowStart], map: "${indexName}")`);
    expect(rateLimitMigration).toContain(`CONSTRAINT "${indexName}"`);
  });

  it("keeps every SMS MFA migration out of the populated pre-SMS fixture", () => {
    expect(ciWorkflow).toContain(
      "mv prisma/migrations/20260902010000_verification_rate_limits \"$upgrade_migrations\"/",
    );
    expect(ciWorkflow).toContain(
      "mv prisma/migrations/20260909000000_sms_first_mfa \"$upgrade_migrations\"/",
    );
    expect(ciWorkflow).toContain(
      "mv prisma/migrations/20260909010000_drop_verification_send_bucket \"$upgrade_migrations\"/",
    );
    expect(ciWorkflow).toContain(
      "mv prisma/migrations/20260909020000_phone_lookup_aliases \"$upgrade_migrations\"/",
    );
    expect(ciWorkflow).toContain(
      "mv prisma/migrations/20260909030000_mfa_challenge_token_version \"$upgrade_migrations\"/",
    );
    expect(ciWorkflow).toContain(
      "mv prisma/migrations/20260909040000_user_phone_state_constraints \"$upgrade_migrations\"/",
    );
    expect(ciWorkflow).toContain(
      "mv prisma/migrations/20260909050000_mfa_challenge_phone_prefix \"$upgrade_migrations\"/",
    );
    expect(ciWorkflow).toContain(
      "mv prisma/migrations/20260909060000_mfa_challenge_account_limit \"$upgrade_migrations\"/",
    );
    expect(ciWorkflow).toContain(
      "mv prisma/migrations/20260909070000_sms_delivery_state \"$upgrade_migrations\"/",
    );
    expect(postgresValidation).toContain(
      "=== 28, \"upgrade seed must run after exactly the 28 pre-SMS migrations\"",
    );
  });

  it("persists encrypted SMS dispatch state with crash-safe database constraints", () => {
    expect(schema).toContain("enum SmsDeliveryState");
    expect(schema).toMatch(/smsDestinationEncrypted\s+String\?/);
    expect(schema).toMatch(/smsDeliveryState\s+SmsDeliveryState\?/);
    expect(smsDeliveryMigration).toContain('CONSTRAINT "MfaChallenge_sms_delivery_destination_pair_check"');
    expect(smsDeliveryMigration).toContain('CONSTRAINT "MfaChallenge_sms_delivery_lease_check"');
    expect(smsDeliveryMigration).toContain('CONSTRAINT "MfaChallenge_sms_delivery_attempt_check"');
    expect(smsDeliveryMigration.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
  });

  it("invalidates legacy live challenges before enforcing token-version binding", () => {
    expect(schema).toMatch(/tokenVersionAtIssue\s+Int\?/);
    expect(challengeTokenVersionMigration).toContain('SET "invalidatedAt" = CURRENT_TIMESTAMP');
    expect(challengeTokenVersionMigration).toContain('CONSTRAINT "MfaChallenge_token_version_binding"');
    expect(challengeTokenVersionMigration.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
  });

  it("database-enforces complete and internally consistent phone state", () => {
    expect(phoneStateMigration).toContain('CONSTRAINT "User_phone_version_nonnegative"');
    expect(phoneStateMigration).toContain('CONSTRAINT "User_phone_identity_complete"');
    expect(phoneStateMigration).toContain('CONSTRAINT "User_phone_verification_state"');
    expect(phoneStateMigration).toContain('CONSTRAINT "User_phone_consent_complete"');
    expect(phoneStateMigration.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
  });

  it("persists an HMAC-only prefix on every new SMS challenge", () => {
    expect(schema).toMatch(/phonePrefixHash\s+String\?/);
    expect(challengePhonePrefixMigration).toContain('ADD COLUMN "phonePrefixHash" TEXT');
    expect(challengePhonePrefixMigration).toContain('CONSTRAINT "MfaChallenge_sms_prefix_binding"');
    expect(challengePhonePrefixMigration).toContain('SET "invalidatedAt" = NOW()');
    expect(challengePhonePrefixMigration).toContain('"phonePrefixHash" IS NOT NULL');
    expect(challengePhonePrefixMigration).toContain("NOT VALID");
    expect(challengePhonePrefixMigration).toContain(
      'VALIDATE CONSTRAINT "MfaChallenge_sms_prefix_binding"',
    );
    expect(challengePhonePrefixMigration.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
  });

  it("binds active registration challenges to their account rate limit", () => {
    expect(schema).toMatch(/accountRateLimitHash\s+String\?/);
    expect(challengeAccountLimitMigration).toContain('ADD COLUMN "accountRateLimitHash" TEXT');
    expect(challengeAccountLimitMigration).toContain('CONSTRAINT "MfaChallenge_registration_account_limit_binding"');
    expect(challengeAccountLimitMigration).toContain('SET "invalidatedAt" = NOW()');
    expect(challengeAccountLimitMigration).toContain('"purpose" <> \'REGISTRATION\'::"MfaChallengePurpose"');
    expect(challengeAccountLimitMigration).toContain('"accountRateLimitHash" IS NOT NULL');
    expect(challengeAccountLimitMigration).toContain("NOT VALID");
    expect(challengeAccountLimitMigration).toContain(
      'VALIDATE CONSTRAINT "MfaChallenge_registration_account_limit_binding"',
    );
    expect(challengeAccountLimitMigration.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
  });

  it("database-enforces versioned phone aliases for old and new application writers", () => {
    expect(schema).toContain("model PhoneLookupAlias");
    expect(phoneAliasMigration).toContain('CONSTRAINT "PhoneLookupAlias_pkey" PRIMARY KEY ("hash")');
    expect(phoneAliasMigration).toContain('CREATE TRIGGER "User_claim_phone_lookup_hash"');
    expect(phoneAliasMigration).toContain("IF NOT FOUND THEN");
    expect(phoneAliasMigration).toContain("ERRCODE = '23505'");
    expect(phoneAliasMigration.indexOf('CREATE TRIGGER "User_claim_phone_lookup_hash"')).toBeLessThan(
      phoneAliasMigration.indexOf('INSERT INTO "PhoneLookupAlias" ("hash", "keyVersion", "userId")\nSELECT'),
    );
    expect(phoneAliasMigration.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
  });

  it("permits only account-bound, userless decoys for public recovery email checks", () => {
    expect(phoneRecoveryEmailDecoyMigration).toContain('DROP CONSTRAINT "MfaChallenge_phone_recovery_binding_check"');
    expect(phoneRecoveryEmailDecoyMigration).toContain('"accountRateLimitHash" ~ \'^[0-9a-f]{64}$\'');
    expect(phoneRecoveryEmailDecoyMigration).toContain('("phoneRecoveryCaseId" IS NULL AND "userId" IS NULL)');
    expect(phoneRecoveryEmailDecoyMigration.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
  });

  it("database-enforces an append-only security audit trail", () => {
    expect(auditIntegrityMigration).toContain('CREATE TRIGGER "SecurityAuditEvent_immutable_guard"');
    expect(auditIntegrityMigration).toContain("SecurityAuditEvent rows are append-only");
    expect(auditIntegrityMigration).toContain("BEFORE UPDATE OR DELETE");
    expect(auditIntegrityMigration.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
    expect(ciWorkflow).toContain(
      'mv prisma/migrations/20260909100000_security_audit_integrity "$upgrade_migrations"/',
    );
  });
});
