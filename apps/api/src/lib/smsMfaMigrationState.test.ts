import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertSmsMfaMigrationState,
  REQUIRED_SMS_MFA_MIGRATIONS,
  type MigrationStateRow,
} from "./smsMfaMigrationState.js";

const FIRST_REQUIRED_MIGRATION = "20260902010000_verification_rate_limits";

const enabledProduction = {
  NODE_ENV: "production",
  SMS_MFA_ENABLED: "true",
};

function appliedRows(): MigrationStateRow[] {
  return REQUIRED_SMS_MFA_MIGRATIONS.map((migrationName) => ({
    migrationName,
    finishedAt: new Date("2026-09-06T12:00:00.000Z"),
    rolledBackAt: null,
  }));
}

describe("SMS MFA migration startup gate", () => {
  it("requires the phone-recovery state-machine migration", () => {
    expect(REQUIRED_SMS_MFA_MIGRATIONS).toContain("20260909080000_phone_recovery");
  });

  it("accepts a database with every required migration successfully applied", async () => {
    const readState = vi.fn(async () => appliedRows());
    await expect(assertSmsMfaMigrationState(enabledProduction, readState)).resolves.toBeUndefined();
    expect(readState).toHaveBeenCalledTimes(1);
  });

  it("rejects a database missing a required migration", async () => {
    const rows = appliedRows().slice(1);
    await expect(assertSmsMfaMigrationState(enabledProduction, async () => rows))
      .rejects.toThrow("Required SMS MFA database migrations are not fully applied; startup is blocked.");
  });

  it.each([
    ["unfinished", { finishedAt: null, rolledBackAt: null }],
    ["rolled back", { finishedAt: new Date("2026-09-06T12:00:00.000Z"), rolledBackAt: new Date("2026-09-06T12:01:00.000Z") }],
  ])("rejects a required migration that is %s", async (_label, state) => {
    const rows = appliedRows();
    rows[0] = { ...rows[0], ...state };
    await expect(assertSmsMfaMigrationState(enabledProduction, async () => rows))
      .rejects.toThrow("Required SMS MFA database migrations are not fully applied; startup is blocked.");
  });

  it("rejects an unresolved failed migration even when required migrations are present", async () => {
    const rows = [
      ...appliedRows(),
      { migrationName: "future_migration", finishedAt: null, rolledBackAt: null },
    ];
    await expect(assertSmsMfaMigrationState(enabledProduction, async () => rows))
      .rejects.toThrow("Required SMS MFA database migrations are not fully applied; startup is blocked.");
  });

  it("fails closed without exposing database error details", async () => {
    const readState = async () => { throw new Error("password=do-not-leak"); };
    await expect(assertSmsMfaMigrationState(enabledProduction, readState))
      .rejects.toThrow("Required SMS MFA database migrations are not fully applied; startup is blocked.");
    await expect(assertSmsMfaMigrationState(enabledProduction, readState))
      .rejects.not.toThrow(/do-not-leak/);
  });

  it("does not query the database outside an enabled production deployment", async () => {
    const readState = vi.fn(async () => appliedRows());
    await expect(assertSmsMfaMigrationState({ ...enabledProduction, NODE_ENV: "test" }, readState))
      .resolves.toBeUndefined();
    await expect(assertSmsMfaMigrationState({ ...enabledProduction, SMS_MFA_ENABLED: "false" }, readState))
      .resolves.toBeUndefined();
    expect(readState).not.toHaveBeenCalled();
  });

  it("tracks every repository migration from the first SMS MFA migration onward", () => {
    const migrationsPath = resolve(process.cwd(), "prisma/migrations");
    const smsMigrations = readdirSync(migrationsPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name >= FIRST_REQUIRED_MIGRATION)
      .map((entry) => entry.name)
      .sort();
    expect([...REQUIRED_SMS_MFA_MIGRATIONS].sort()).toEqual(smsMigrations);
  });
});
