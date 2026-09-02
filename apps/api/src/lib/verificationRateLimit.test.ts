import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createVerificationBudgetConsumer,
  InMemoryVerificationRateLimitStore,
  PrismaVerificationRateLimitStore,
  VerificationRateLimitUnavailableError,
  type VerificationBudgetInput,
  type VerificationRateLimitStore,
} from "./verificationRateLimit.js";

const key = (value: string) => createHmac("sha256", "rate-limit-test-key").update(value).digest("hex");
const start = new Date("2026-09-02T12:00:00.000Z");
const at = (seconds: number) => new Date(start.getTime() + seconds * 1_000);

type TestRow = {
  id: string;
  tenantScope: string;
  action: string;
  keyHash: string;
  windowStart: Date;
  count: number;
  limit: number;
  expiresAt: Date;
  updatedAt: Date;
};

class TransactionDatabase {
  rows: TestRow[] = [];
  events: string[] = [];
  failOnInsert = 0;
  private inserts = 0;

  async $transaction<T>(callback: (tx: {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
    $queryRaw: <R>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<R>;
  }) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.rows);
    this.inserts = 0;
    const tx = {
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?").replace(/\s+/g, " ").trim();
        if (sql.includes("pg_advisory_xact_lock")) {
          this.events.push("advisory-lock");
          return 1;
        }
        if (sql.startsWith('DELETE FROM "VerificationRateLimit"')) {
          this.events.push("cleanup");
          const now = values[0] as Date;
          const before = this.rows.length;
          this.rows = this.rows.filter(({ expiresAt }) => expiresAt > now);
          return before - this.rows.length;
        }
        if (sql.startsWith('INSERT INTO "VerificationRateLimit"')) {
          this.inserts += 1;
          this.events.push("upsert");
          if (this.failOnInsert === this.inserts) throw new Error("injected upsert failure");
          const [id, tenantScope, action, keyHash, windowStart, count, limit, expiresAt, updatedAt] = values as [string, string, string, string, Date, number, number, Date, Date];
          const existing = this.rows.find((row) => row.tenantScope === tenantScope && row.action === action
            && row.keyHash === keyHash && row.windowStart.getTime() === windowStart.getTime());
          if (existing) {
            if (sql.includes('"count" = "VerificationRateLimit"."count" + 1')) existing.count += 1;
            if (sql.includes('"expiresAt" = GREATEST')) existing.expiresAt = new Date(Math.max(existing.expiresAt.getTime(), expiresAt.getTime()));
            existing.limit = limit;
            existing.updatedAt = updatedAt;
          } else {
            this.rows.push({ id, tenantScope, action, keyHash, windowStart, count, limit, expiresAt, updatedAt });
          }
          return 1;
        }
        throw new Error(`unexpected execute: ${sql}`);
      },
      $queryRaw: async <R>(_strings: TemplateStringsArray, ...values: unknown[]) => {
        const [tenantScope, action, keyHash, now] = values as [string, string, string, Date];
        this.events.push(`read:${action}:${keyHash}`);
        const rows = this.rows
          .filter((row) => row.tenantScope === tenantScope && row.action === action && row.keyHash === keyHash && row.expiresAt > now)
          .sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime())
          .slice(0, 1);
        return rows as R;
      },
    };
    try {
      return await callback(tx);
    } catch (error) {
      this.rows = snapshot;
      throw error;
    }
  }
}

function input(overrides: Partial<VerificationBudgetInput> = {}): VerificationBudgetInput {
  return {
    action: "LOGIN",
    phoneHash: key("+16317423355"),
    accountHash: key("user-1"),
    ipHash: key("203.0.113.10"),
    now: start,
    ...overrides,
  };
}

describe("durable verification budgets", () => {
  it.each([
    ["phone", "phoneHash"],
    ["account", "accountHash"],
    ["IP", "ipHash"],
  ] as const)("enforces the three-per-15-minute %s budget independently", async (_label, field) => {
    const consume = createVerificationBudgetConsumer(new InMemoryVerificationRateLimitStore());
    const subject = { [field]: key(`${field}-one`) };

    for (const seconds of [0, 31, 62]) {
      await expect(consume(input({ phoneHash: undefined, accountHash: undefined, ipHash: undefined, ...subject, now: at(seconds) })))
        .resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    }
    await expect(consume(input({ phoneHash: undefined, accountHash: undefined, ipHash: undefined, ...subject, now: at(93) })))
      .resolves.toEqual({ allowed: false, retryAfterSeconds: 900 });
    await expect(consume(input({ phoneHash: undefined, accountHash: undefined, ipHash: undefined, [field]: key(`${field}-two`), now: at(93) })))
      .resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it("enforces ten sends per subject in 24 hours", async () => {
    const consume = createVerificationBudgetConsumer(new InMemoryVerificationRateLimitStore());
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(consume(input({ accountHash: undefined, ipHash: undefined, now: at(attempt * 16 * 60) })))
        .resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    }
    await expect(consume(input({ accountHash: undefined, ipHash: undefined, now: at(10 * 16 * 60) })))
      .resolves.toEqual({ allowed: false, retryAfterSeconds: 900 });
  });

  it("opens the global circuit breaker after 100 sends in one minute", async () => {
    const consume = createVerificationBudgetConsumer(new InMemoryVerificationRateLimitStore());
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await expect(consume(input({
        phoneHash: key(`phone-${attempt}`),
        accountHash: key(`account-${attempt}`),
        ipHash: key(`ip-${attempt}`),
      }))).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    }
    await expect(consume(input({ phoneHash: key("phone-101"), accountHash: key("account-101"), ipHash: key("ip-101") })))
      .resolves.toEqual({ allowed: false, retryAfterSeconds: 900 });
  });

  it("atomically admits only three concurrent consumers of a shared subject", async () => {
    const consume = createVerificationBudgetConsumer(new InMemoryVerificationRateLimitStore());
    const results = await Promise.all([
      consume(input({ action: "LOGIN", accountHash: undefined, ipHash: undefined })),
      consume(input({ action: "REGISTRATION", accountHash: undefined, ipHash: undefined })),
      consume(input({ action: "PASSWORD_RESET", accountHash: undefined, ipHash: undefined })),
      consume(input({ action: "FACTOR_REMOVAL", accountHash: undefined, ipHash: undefined })),
    ]);

    expect(results.filter(({ allowed }) => allowed)).toHaveLength(3);
    expect(results.filter(({ allowed }) => !allowed)).toEqual([{ allowed: false, retryAfterSeconds: 900 }]);
  });

  it("keeps a short-budget breach locked for 15 minutes", async () => {
    const consume = createVerificationBudgetConsumer(new InMemoryVerificationRateLimitStore());
    for (const seconds of [0, 31, 62]) await consume(input({ accountHash: undefined, ipHash: undefined, now: at(seconds) }));

    await expect(consume(input({ accountHash: undefined, ipHash: undefined, now: at(93) })))
      .resolves.toEqual({ allowed: false, retryAfterSeconds: 900 });
    await expect(consume(input({ accountHash: undefined, ipHash: undefined, now: at(93 + 14 * 60) })))
      .resolves.toEqual({ allowed: false, retryAfterSeconds: 60 });
    await expect(consume(input({ accountHash: undefined, ipHash: undefined, now: at(93 + 15 * 60) })))
      .resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it("returns the maximum Retry-After when applicable phone and account locks overlap", async () => {
    const consume = createVerificationBudgetConsumer(new InMemoryVerificationRateLimitStore());
    for (const seconds of [0, 31, 62]) {
      await consume(input({ accountHash: undefined, ipHash: undefined, now: at(seconds) }));
    }
    await consume(input({ accountHash: undefined, ipHash: undefined, now: at(93) }));
    for (const seconds of [100, 131, 162]) {
      await consume(input({ phoneHash: undefined, ipHash: undefined, now: at(seconds) }));
    }
    await consume(input({ phoneHash: undefined, ipHash: undefined, now: at(193) }));

    await expect(consume(input({ ipHash: undefined, now: at(200) })))
      .resolves.toMatchObject({ allowed: false, retryAfterSeconds: 893 });
  });

  it("enforces a 30-second resend cooldown and allows the next send after expiry cleanup", async () => {
    const consume = createVerificationBudgetConsumer(new InMemoryVerificationRateLimitStore());

    await expect(consume(input({ accountHash: undefined, ipHash: undefined })))
      .resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    await expect(consume(input({ accountHash: undefined, ipHash: undefined, now: at(10) })))
      .resolves.toEqual({ allowed: false, retryAfterSeconds: 20 });
    await expect(consume(input({ accountHash: undefined, ipHash: undefined, now: at(30) })))
      .resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    await expect(consume(input({ accountHash: undefined, ipHash: undefined, now: at(24 * 60 * 60 + 31) })))
      .resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it("fails closed when durable state is unavailable", async () => {
    const unavailable: VerificationRateLimitStore = {
      async consumeAtomic() { throw new Error("database unavailable"); },
    };
    const consume = createVerificationBudgetConsumer(unavailable);

    await expect(consume(input())).rejects.toBeInstanceOf(VerificationRateLimitUnavailableError);
  });

  it("rejects unhashed identifiers before touching durable state", async () => {
    let touched = false;
    const store: VerificationRateLimitStore = {
      async consumeAtomic() { touched = true; return { allowed: true, retryAfterSeconds: 0 }; },
    };
    const consume = createVerificationBudgetConsumer(store);

    await expect(consume(input({ phoneHash: "+16317423355" }))).rejects.toBeInstanceOf(VerificationRateLimitUnavailableError);
    expect(touched).toBe(false);
  });

  it("runs the production Prisma store as one locked cleanup-preflight-upsert transaction", async () => {
    const database = new TransactionDatabase();
    database.rows.push({
      id: "expired", tenantScope: "continuixai", action: "sms-send:15m", keyHash: `phone:${key("expired")}`,
      windowStart: at(-1_000), count: 3, limit: 3, expiresAt: at(-1), updatedAt: at(-1),
    });
    const consume = createVerificationBudgetConsumer(new PrismaVerificationRateLimitStore(database));

    await expect(consume(input())).resolves.toMatchObject({ allowed: true, retryAfterSeconds: 0 });

    expect(database.rows.some(({ id }) => id === "expired")).toBe(false);
    expect(database.rows).toHaveLength(9);
    expect(database.events.slice(0, 2)).toEqual(["advisory-lock", "cleanup"]);
    const firstUpsert = database.events.indexOf("upsert");
    const lastRead = database.events.reduce((last, event, index) => event.startsWith("read:") ? index : last, -1);
    expect(firstUpsert).toBeGreaterThan(lastRead);
    expect(database.rows.every(({ keyHash }) => keyHash === "global" || /^(phone|account|ip):[a-f0-9]{64}$/.test(keyHash))).toBe(true);
  });

  it("preflights every production Prisma lock and returns the maximum Retry-After without upserting", async () => {
    const database = new TransactionDatabase();
    database.rows.push(
      {
        id: "phone-lock", tenantScope: "continuixai", action: "sms-send:lock", keyHash: `phone:${key("+16317423355")}`,
        windowStart: at(100), count: 1, limit: 1, expiresAt: at(500), updatedAt: at(100),
      },
      {
        id: "account-lock", tenantScope: "continuixai", action: "sms-send:lock", keyHash: `account:${key("user-1")}`,
        windowStart: at(100), count: 1, limit: 1, expiresAt: at(900), updatedAt: at(100),
      },
    );
    const consume = createVerificationBudgetConsumer(new PrismaVerificationRateLimitStore(database));

    await expect(consume(input({ now: at(200) })))
      .resolves.toEqual({ allowed: false, retryAfterSeconds: 700 });

    expect(database.events.filter((event) => event.startsWith("read:sms-send:lock"))).toHaveLength(4);
    expect(database.events).not.toContain("upsert");
  });

  it("rolls back every production Prisma upsert when one write fails", async () => {
    const database = new TransactionDatabase();
    database.failOnInsert = 2;
    const consume = createVerificationBudgetConsumer(new PrismaVerificationRateLimitStore(database));

    await expect(consume(input())).rejects.toBeInstanceOf(VerificationRateLimitUnavailableError);

    expect(database.rows).toEqual([]);
    expect(database.events[0]).toBe("advisory-lock");
    expect(database.events).toContain("cleanup");
  });
});
