import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { buildApp } from "../src/index.js";
import { FactorRemovalService, PrismaFactorRemovalRepository } from "../src/lib/factorRemovalService.js";
import { encryptSecret, hashBackupCodes } from "../src/lib/mfa.js";
import { MEDIA_COOKIE_NAME, requireMediaAccess, signMediaToken } from "../src/lib/mediaAuth.js";
import { PasswordRecoveryRejectedError, PasswordRecoveryService, PrismaPasswordRecoveryRepository } from "../src/lib/passwordRecoveryService.js";
import { prisma } from "../src/lib/prisma.js";
import { PrismaRegistrationRepository, RegistrationService } from "../src/lib/registrationService.js";
import type { SecurityNotificationProvider } from "../src/lib/securityNotificationProvider.js";
import { isCurrentActiveAccess } from "../src/lib/tokenVersion.js";
import {
  createVerificationBudgetConsumer,
  PrismaVerificationRateLimitStore,
} from "../src/lib/verificationRateLimit.js";
import type { VerificationProvider } from "../src/lib/verificationProvider.js";
import { PrismaVerificationPolicyStore, VerificationPolicy } from "../src/lib/verificationPolicy.js";

const EXPECTED_MIGRATION_COUNT = 31;
const LATEST_MIGRATION = "20260909010000_drop_verification_send_bucket";
const LEGACY_ACTIVE_ID = "sms-upgrade-active-user";
const LEGACY_DISABLED_ID = "sms-upgrade-disabled-user";
const SMS_CODE = "654321";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requiredUrl(name: "DATABASE_URL" | "DATABASE_ADMIN_URL" | "UPGRADE_DATABASE_URL"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function disposableDatabaseName(connectionString: string): string {
  const databaseName = new URL(connectionString).pathname.slice(1);
  assert(/(?:^|_)(?:ci|test|upgrade)(?:_|$)/i.test(databaseName), `Refusing to validate non-disposable database ${databaseName}.`);
  return databaseName;
}

class DeterministicVerificationProvider implements VerificationProvider {
  private readonly destinations = new Map<string, string>();

  async start(destination: string): Promise<{ providerRef: string }> {
    const providerRef = `validation-${randomUUID()}`;
    this.destinations.set(providerRef, destination);
    return { providerRef };
  }

  async check(providerRef: string, destination: string, code: string): Promise<{ matched: boolean }> {
    return { matched: this.destinations.get(providerRef) === destination && code === SMS_CODE };
  }
}

class DeterministicNotificationProvider implements SecurityNotificationProvider {
  async notifyFactorChanged(): Promise<{ providerRef: string }> {
    return { providerRef: `notification-${randomUUID()}` };
  }
}

async function assertMigrationHistory(expectedCount = EXPECTED_MIGRATION_COUNT): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{
    migration_name: string;
    finished_at: Date | null;
    rolled_back_at: Date | null;
  }>>`SELECT "migration_name", "finished_at", "rolled_back_at" FROM "_prisma_migrations" ORDER BY "migration_name"`;
  assert(rows.length === expectedCount, `expected ${expectedCount} applied migrations, got ${rows.length}`);
  assert(rows.every((row) => row.finished_at && !row.rolled_back_at), "every migration must be finished and not rolled back");
  assert(rows.some((row) => row.migration_name === LATEST_MIGRATION), `latest migration ${LATEST_MIGRATION} is not applied`);
}

async function prepareUpgradeDatabase(): Promise<void> {
  const targetUrl = requiredUrl("UPGRADE_DATABASE_URL");
  const databaseName = disposableDatabaseName(targetUrl);
  assert(/^[a-zA-Z0-9_]+$/.test(databaseName), "upgrade database name contains unsafe characters");
  const client = new Client({ connectionString: requiredUrl("DATABASE_ADMIN_URL") });
  await client.connect();
  try {
    const existing = await client.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists", [databaseName]);
    assert(existing.rows[0]?.exists === false, `upgrade database ${databaseName} already exists`);
    await client.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await client.end();
  }
  console.log(`Prepared disposable upgrade database ${databaseName}.`);
}

async function seedUpgradeDatabase(): Promise<void> {
  const connectionString = requiredUrl("DATABASE_URL");
  disposableDatabaseName(connectionString);
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const migrationCount = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
    );
    assert(Number(migrationCount.rows[0]?.count) === 28, "upgrade seed must run after exactly the 28 pre-SMS migrations");
    await client.query(
      `INSERT INTO "User" ("id", "name", "email", "passwordHash", "role", "isActive", "createdAt")
       VALUES ($1, 'Upgrade Active', 'upgrade-active@example.test', 'unused', 'GENERAL', true, NOW()),
              ($2, 'Upgrade Disabled', 'upgrade-disabled@example.test', 'unused', 'GENERAL', false, NOW())`,
      [LEGACY_ACTIVE_ID, LEGACY_DISABLED_ID],
    );
  } finally {
    await client.end();
  }
  console.log("Seeded active and inactive legacy users before SMS migrations.");
}

async function validateUpgradeDatabase(): Promise<void> {
  const connectionString = requiredUrl("DATABASE_URL");
  disposableDatabaseName(connectionString);
  try {
    await assertMigrationHistory();
    const users = await prisma.user.findMany({
      where: { id: { in: [LEGACY_ACTIVE_ID, LEGACY_DISABLED_ID] } },
      orderBy: { id: "asc" },
      select: { id: true, accountStatus: true, isActive: true, phoneVersion: true, phoneVerifiedAt: true },
    });
    assert(users.length === 2, `expected 2 migrated legacy users, got ${users.length}`);
    const active = users.find(({ id }) => id === LEGACY_ACTIVE_ID);
    const disabled = users.find(({ id }) => id === LEGACY_DISABLED_ID);
    assert(active?.accountStatus === "ACTIVE" && active.isActive, "active legacy user must remain ACTIVE");
    assert(disabled?.accountStatus === "DISABLED" && !disabled.isActive, "inactive legacy user must migrate to DISABLED");
    assert(users.every((user) => user.phoneVersion === 0 && user.phoneVerifiedAt === null), "legacy users must require explicit phone enrollment");

    let constraintRejected = false;
    try {
      await prisma.$executeRaw`UPDATE "User" SET "isActive" = true WHERE "id" = ${LEGACY_DISABLED_ID}`;
    } catch {
      constraintRejected = true;
    }
    assert(constraintRejected, "upgraded schema must enforce accountStatus/isActive consistency");
    console.log(`Upgrade migration validation passed: ${EXPECTED_MIGRATION_COUNT} migrations, 2 legacy users preserved.`);
  } finally {
    await prisma.$disconnect();
  }
}

async function validateFreshDatabase(): Promise<void> {
  const connectionString = requiredUrl("DATABASE_URL");
  disposableDatabaseName(connectionString);
  const initialUsers = await prisma.user.count();
  const initialChallenges = await prisma.mfaChallenge.count();
  assert(initialUsers === 0 && initialChallenges === 0, "fresh SMS MFA validation must run before fixture users or challenges are created");
  await assertMigrationHistory();

  const suffix = `${Date.now()}-${randomUUID()}`;
  const email = `sms-postgres-${suffix}@example.test`;
  const phone = "+16317423355";
  const ipHash = createHash("sha256").update(`registration-ip:${suffix}`).digest("hex");
  const provider = new DeterministicVerificationProvider();
  const store = new PrismaVerificationPolicyStore();
  const policy = new VerificationPolicy(store, provider);
  const registration = new RegistrationService(new PrismaRegistrationRepository(), policy);
  process.env.JWT_SECRET ??= "sms-postgres-validation-jwt-secret";
  const app = await buildApp();
  app.get("/media-validation", async (request, reply) => {
    if (!await requireMediaAccess(app, request, reply)) return reply;
    return { ok: true };
  });
  await app.ready();

  let userId: string | undefined;
  try {
    const started = await registration.start({
      name: "PostgreSQL SMS User",
      email,
      phone,
      passwordHash: "not-used-before-recovery",
      consentVersion: "ci-validation-v1",
      dimensions: [`ip:${ipHash}`],
    });
    assert(started.dispatched && started.userId && started.challengeId, "registration must dispatch a persisted SMS challenge");
    userId = started.userId;

    const pending = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    assert(pending.accountStatus === "PENDING_PHONE_VERIFICATION" && !pending.isActive, "registration must create an inactive pending account");
    assert(!await isCurrentActiveAccess(userId, pending.tokenVersion), "pending account must not pass authoritative access");
    const persistedRegistration = await prisma.mfaChallenge.findUniqueOrThrow({ where: { id: started.challengeId } });
    assert(persistedRegistration.providerRef?.startsWith("validation-") === true, "registration must persist the test provider reference");

    const approvals = await Promise.allSettled([
      registration.approve({ challengeId: started.challengeId, userId, code: SMS_CODE }),
      registration.approve({ challengeId: started.challengeId, userId, code: SMS_CODE }),
    ]);
    assert(approvals.filter(({ status }) => status === "fulfilled").length === 1, "concurrent duplicate registration completion must have one winner");
    assert(approvals.filter(({ status }) => status === "rejected").length === 1, "concurrent duplicate registration completion must reject one replay");

    const activated = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    assert(activated.accountStatus === "ACTIVE" && activated.isActive && activated.role === "ADMIN", "first verified user must atomically become the active administrator");
    assert(await prisma.user.count({ where: { email } }) === 1, "duplicate registration completion must not duplicate the account");
    assert(await prisma.mfaChallenge.count({ where: { id: started.challengeId, consumedAt: { not: null } } }) === 1, "registration challenge must be consumed exactly once");
    await assertRejects(
      () => registration.approve({ challengeId: started.challengeId!, userId: userId!, code: SMS_CODE }),
      "sequential registration replay must be rejected",
    );

    let constraintRejected = false;
    try {
      await prisma.$executeRaw`UPDATE "User" SET "isActive" = false WHERE "id" = ${userId}`;
    } catch {
      constraintRejected = true;
    }
    assert(constraintRejected, "fresh schema must reject accountStatus/isActive disagreement");

    const recoveryCode = "A1B2C3D4E5";
    const recoveryHashes = await hashBackupCodes([recoveryCode]);
    await prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: true, mfaSecretEncrypted: encryptSecret("JBSWY3DPEHPK3PXP"), mfaBackupCodeHashes: recoveryHashes },
    });
    const recovery = new PasswordRecoveryService(new PrismaPasswordRecoveryRepository(), policy);
    const recoverySms = await recovery.beginPasswordRecovery(email, {
      dimensions: [`password-recovery-ip:${createHash("sha256").update(`recovery-ip:${suffix}`).digest("hex")}`],
    });
    assert(recoverySms.challengeId, "password recovery must persist an SMS challenge");
    const recoveryLocal = await recovery.beginPasswordRecovery(email, {
      dimensions: [],
      method: "RECOVERY_CODE",
      previousChallengeId: recoverySms.challengeId,
    });
    assert(recoveryLocal.challengeId, "password recovery must bind a recovery-code challenge");
    await recovery.completePasswordRecovery(recoveryLocal.challengeId, recoveryCode, "ReplacementPass1!");
    await assertRejects(
      () => recovery.completePasswordRecovery(recoveryLocal.challengeId!, recoveryCode, "ReplayPass1!"),
      "recovery material and its challenge must be single-use",
      PasswordRecoveryRejectedError,
    );

    const recovered = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    assert(Array.isArray(recovered.mfaBackupCodeHashes) && recovered.mfaBackupCodeHashes.length === 0, "successful recovery must atomically consume the recovery code");
    assert(recovered.tokenVersion === activated.tokenVersion + 1, "password recovery must increment tokenVersion once");
    assert(await prisma.securityAuditEvent.count({ where: { targetUserId: userId, eventType: "password_recovered" } }) === 1, "password recovery must write exactly one audit event");

    const apiToken = app.jwt.sign({ sub: userId, role: recovered.role, tv: recovered.tokenVersion });
    const mediaToken = signMediaToken(app, userId, recovered.tokenVersion);
    const currentApi = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { authorization: `Bearer ${apiToken}` } });
    assert(currentApi.statusCode === 204, `current API credential must reach the production protected endpoint, got ${currentApi.statusCode}`);
    const currentMedia = await app.inject({ method: "GET", url: "/media-validation", headers: { cookie: `${MEDIA_COOKIE_NAME}=${mediaToken}` } });
    assert(currentMedia.statusCode === 200, `current media credential must be accepted, got ${currentMedia.statusCode}`);

    const removal = new FactorRemovalService(new PrismaFactorRemovalRepository(), policy, new DeterministicNotificationProvider());
    const removalChallenge = await removal.startTotpRemoval(recovered, [
      `account:${createHash("sha256").update(`removal-account:${suffix}`).digest("hex")}`,
      `ip:${createHash("sha256").update(`removal-ip:${suffix}`).digest("hex")}`,
    ]);
    const removalResult = await removal.confirmTotpRemoval(recovered, removalChallenge.id, SMS_CODE);
    assert(removalResult.removed && removalResult.notification === "accepted", "TOTP removal must commit before notification acceptance is reported");

    const removed = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    assert(!removed.mfaEnabled && removed.mfaSecretEncrypted === null, "TOTP secret and enabled flag must be removed transactionally");
    assert(removed.tokenVersion === recovered.tokenVersion + 1, "factor removal must increment tokenVersion exactly once");
    assert(await prisma.securityAuditEvent.count({ where: { targetUserId: userId, eventType: "totp_removed" } }) === 1, "factor removal must write exactly one committed audit event");
    const staleApi = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { authorization: `Bearer ${apiToken}` } });
    assert(
      staleApi.statusCode === 401 && JSON.stringify(staleApi.json()) === JSON.stringify({ error: "unauthorized" }),
      "old API credential must fail through production authentication with the generic 401 after tokenVersion increment",
    );
    const staleMedia = await app.inject({ method: "GET", url: "/media-validation", headers: { cookie: `${MEDIA_COOKIE_NAME}=${mediaToken}` } });
    assert(staleMedia.statusCode === 401 && staleMedia.json().error === "unauthorized", "old media credential must fail with the generic 401 after tokenVersion increment");

    const preDisableApiToken = app.jwt.sign({ sub: userId, role: removed.role, tv: removed.tokenVersion });
    const preDisableApi = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { authorization: `Bearer ${preDisableApiToken}` } });
    assert(preDisableApi.statusCode === 204, `current API credential must be accepted before account disablement, got ${preDisableApi.statusCode}`);
    await prisma.user.update({
      where: { id: userId },
      data: { accountStatus: "DISABLED", isActive: false },
    });
    const disabledApi = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { authorization: `Bearer ${preDisableApiToken}` } });
    assert(
      disabledApi.statusCode === 401 && JSON.stringify(disabledApi.json()) === JSON.stringify({ error: "unauthorized" }),
      "old API credential must fail through production authentication with the generic 401 after account disablement",
    );

    const durableHash = (label: string) => createHash("sha256").update(`${label}:${suffix}`).digest("hex");
    const durableInput = {
      action: "CI_DURABLE_LIMIT",
      phoneHash: durableHash("phone"),
      accountHash: durableHash("account"),
      ipHash: durableHash("ip"),
      now: new Date(),
    };
    const firstBudget = await createVerificationBudgetConsumer(new PrismaVerificationRateLimitStore())(durableInput);
    assert(firstBudget.allowed, "first durable verification budget reservation must be allowed");
    const secondBudget = await createVerificationBudgetConsumer(new PrismaVerificationRateLimitStore())({
      ...durableInput,
      now: new Date(durableInput.now.getTime() + 1_000),
    });
    assert(!secondBudget.allowed && secondBudget.retryAfterSeconds === 29, "a new store instance must enforce the persisted 30-second cooldown");
    const durableRows = await prisma.verificationRateLimit.count({
      where: { keyHash: { in: [`phone:${durableInput.phoneHash}`, `account:${durableInput.accountHash}`, `ip:${durableInput.ipHash}`] } },
    });
    assert(durableRows === 8, `expected 8 durable subject buckets, got ${durableRows}`);

    console.log("Fresh PostgreSQL SMS MFA validation passed:");
    console.log(`- ${EXPECTED_MIGRATION_COUNT} migrations applied with current schema parity`);
    console.log("- 1 pending registration, 1 concurrent completion winner, 1 active first administrator");
    console.log("- 1 recovery code consumed once and 1 TOTP factor removed transactionally");
    console.log("- production protected API route rejected stale and disabled-account JWTs with the generic 401");
    console.log("- stale media credentials rejected after authoritative token-version rotation");
    console.log(`- ${durableRows} subject rate-limit buckets persisted and enforced across store instances`);
  } finally {
    await app.close();
    if (userId) {
      await prisma.securityAuditEvent.deleteMany({ where: { OR: [{ actorUserId: userId }, { targetUserId: userId }] } });
      await prisma.user.deleteMany({ where: { id: userId } });
    } else {
      await prisma.user.deleteMany({ where: { email } });
    }
    await prisma.verificationRateLimit.deleteMany();
    await prisma.$disconnect();
  }
}

async function assertRejects(
  operation: () => Promise<unknown>,
  message: string,
  expectedType?: new (...args: never[]) => Error,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!expectedType || error instanceof expectedType) return;
    throw new Error(`${message}: rejected with ${error instanceof Error ? error.name : "unknown value"}`);
  }
  throw new Error(message);
}

const mode = process.argv[2] ?? "--fresh";
if (mode === "--prepare-upgrade") await prepareUpgradeDatabase();
else if (mode === "--seed-upgrade") await seedUpgradeDatabase();
else if (mode === "--validate-upgrade") await validateUpgradeDatabase();
else if (mode === "--fresh") await validateFreshDatabase();
else throw new Error(`Unknown validation mode: ${mode}`);
