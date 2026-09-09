import { prisma } from "./prisma.js";

export const REQUIRED_SMS_MFA_MIGRATIONS = [
  "20260902010000_verification_rate_limits",
  "20260903000000_product_tenant_scope",
  "20260904000000_recovery_account_throttle",
  "20260905000000_task_workflow_completion",
  "20260906000000_task_reassignment_audit",
  "20260907000000_task_assignment_idempotency",
  "20260908000000_site_membership",
  "20260909000000_sms_first_mfa",
  "20260909010000_drop_verification_send_bucket",
  "20260909020000_phone_lookup_aliases",
  "20260909030000_mfa_challenge_token_version",
  "20260909040000_user_phone_state_constraints",
  "20260909050000_mfa_challenge_phone_prefix",
  "20260909060000_mfa_challenge_account_limit",
  "20260909070000_sms_delivery_state",
  "20260909075000_phone_recovery_enums",
  "20260909080000_phone_recovery",
  "20260909090000_phone_recovery_email_decoys",
  "20260909100000_security_audit_integrity",
] as const;

export type MigrationStateRow = {
  migrationName: string;
  finishedAt: Date | null;
  rolledBackAt: Date | null;
};

export type MigrationStateReader = () => Promise<MigrationStateRow[]>;

const MIGRATION_STATE_ERROR = "Required SMS MFA database migrations are not fully applied; startup is blocked.";

async function readPrismaMigrationState(): Promise<MigrationStateRow[]> {
  const rows = await prisma.$queryRaw<Array<{
    migration_name: string;
    finished_at: Date | null;
    rolled_back_at: Date | null;
  }>>`SELECT "migration_name", "finished_at", "rolled_back_at" FROM "_prisma_migrations"`;
  return rows.map((row) => ({
    migrationName: row.migration_name,
    finishedAt: row.finished_at,
    rolledBackAt: row.rolled_back_at,
  }));
}

export async function assertSmsMfaMigrationState(
  environment: Record<string, string | undefined> = process.env,
  readState: MigrationStateReader = readPrismaMigrationState,
): Promise<void> {
  if (environment.NODE_ENV !== "production" || environment.SMS_MFA_ENABLED !== "true") return;
  try {
    const rows = await readState();
    if (rows.some((row) => row.finishedAt === null && row.rolledBackAt === null)) {
      throw new Error(MIGRATION_STATE_ERROR);
    }
    for (const requiredMigration of REQUIRED_SMS_MFA_MIGRATIONS) {
      const isApplied = rows.some((row) => (
        row.migrationName === requiredMigration
        && row.finishedAt !== null
        && row.rolledBackAt === null
      ));
      if (!isApplied) throw new Error(MIGRATION_STATE_ERROR);
    }
  } catch {
    throw new Error(MIGRATION_STATE_ERROR);
  }
}
