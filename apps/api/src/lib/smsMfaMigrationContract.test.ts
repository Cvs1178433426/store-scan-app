import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const rateLimitMigration = readFileSync(
  new URL("../../prisma/migrations/20260902010000_verification_rate_limits/migration.sql", import.meta.url),
  "utf8",
);
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
    expect(postgresValidation).toContain(
      "=== 28, \"upgrade seed must run after exactly the 28 pre-SMS migrations\"",
    );
  });
});
