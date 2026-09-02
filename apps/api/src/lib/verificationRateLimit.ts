import { randomUUID } from "node:crypto";
import { prisma } from "./prisma.js";

const TENANT_SCOPE = "continuixai";
const COOLDOWN_SECONDS = 30;
const LOCK_SECONDS = 15 * 60;
const SHORT_WINDOW_SECONDS = 15 * 60;
const DAILY_WINDOW_SECONDS = 24 * 60 * 60;
const GLOBAL_WINDOW_SECONDS = 60;

export type VerificationBudgetInput = {
  action: string;
  phoneHash?: string;
  accountHash?: string;
  ipHash?: string;
  now: Date;
  reservation?: VerificationBudgetReservation;
};

declare const verificationBudgetReservationBrand: unique symbol;
export type VerificationBudgetReservation = Readonly<{ [verificationBudgetReservationBrand]: true }>;
export type VerificationBudgetResult = {
  allowed: boolean;
  retryAfterSeconds: number;
  reservation?: VerificationBudgetReservation;
};

type RateLimitKey = { dimension: "phone" | "account" | "ip" | "global"; keyHash: string };
type RateLimitBucket = RateLimitKey & {
  action: string;
  limit: number;
  durationSeconds: number;
  cooldown: boolean;
};

type AtomicConsumption = {
  tenantScope: string;
  action: string;
  keys: RateLimitKey[];
  buckets: RateLimitBucket[];
  now: Date;
};

type ReservationState = { action: string; keyHashes: Set<string> };
const reservationStates = new WeakMap<VerificationBudgetReservation, ReservationState>();

export interface VerificationRateLimitStore {
  consumeAtomic(input: AtomicConsumption): Promise<VerificationBudgetResult>;
}

export class VerificationRateLimitUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("Verification rate limiting is temporarily unavailable.", options);
    this.name = "VerificationRateLimitUnavailableError";
  }
}

type StoredBucket = {
  tenantScope: string;
  action: string;
  keyHash: string;
  windowStart: Date;
  count: number;
  limit: number;
  expiresAt: Date;
};

function retryAfter(expiresAt: Date, now: Date): number {
  return Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1_000));
}

function lockAction(): string {
  return "sms-send:lock";
}

function bucketDefinitions(action: string, keys: RateLimitKey[]): RateLimitBucket[] {
  const subjectKeys = keys.filter(({ dimension }) => dimension !== "global");
  const cooldownKeys = subjectKeys.filter(({ dimension }) => dimension !== "ip");
  return [
    ...cooldownKeys.map((key) => ({ ...key, action: `sms-send:cooldown:${action}`, limit: 1, durationSeconds: COOLDOWN_SECONDS, cooldown: true })),
    ...subjectKeys.map((key) => ({ ...key, action: "sms-send:15m", limit: 3, durationSeconds: SHORT_WINDOW_SECONDS, cooldown: false })),
    ...subjectKeys.map((key) => ({ ...key, action: "sms-send:24h", limit: 10, durationSeconds: DAILY_WINDOW_SECONDS, cooldown: false })),
    ...(keys.some(({ dimension }) => dimension === "global")
      ? [{ dimension: "global" as const, keyHash: "global", action: "sms-send:global:1m", limit: 100, durationSeconds: GLOBAL_WINDOW_SECONDS, cooldown: false }]
      : []),
  ];
}

function suppliedKeys(input: Omit<VerificationBudgetInput, "now" | "reservation">): RateLimitKey[] {
  const supplied = [
    ["phone", input.phoneHash],
    ["account", input.accountHash],
    ["ip", input.ipHash],
  ] as const;
  if (!supplied.some(([, hash]) => hash !== undefined)) throw new Error("At least one hashed verification dimension is required.");
  return supplied.flatMap(([dimension, hash]) => {
    if (hash === undefined) return [];
    if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error("Verification dimensions must be HMAC-derived hashes.");
    return [{ dimension, keyHash: `${dimension}:${hash.toLowerCase()}` }];
  });
}

function normalizedInput(input: VerificationBudgetInput): { consumption: AtomicConsumption; reservationState: ReservationState } {
  if (!input.action.trim() || Number.isNaN(input.now.getTime())) throw new Error("Invalid verification budget input.");
  const action = input.action.trim().toUpperCase();
  const requested = suppliedKeys(input);
  const prior = input.reservation ? reservationStates.get(input.reservation) : undefined;
  if (input.reservation && (!prior || prior.action !== action)) throw new Error("Invalid verification budget reservation.");
  if (input.reservation) reservationStates.delete(input.reservation);
  const priorHashes = prior?.keyHashes ?? new Set<string>();
  const keys = requested.filter(({ keyHash }) => !priorHashes.has(keyHash));
  if (!prior) keys.push({ dimension: "global", keyHash: "global" });
  const keyHashes = new Set(priorHashes);
  for (const { keyHash } of requested) keyHashes.add(keyHash);
  keyHashes.add("global");
  return {
    consumption: {
      tenantScope: TENANT_SCOPE,
      action,
      keys,
      buckets: bucketDefinitions(action, keys),
      now: input.now,
    },
    reservationState: { action, keyHashes },
  };
}

export function claimVerificationBudgetReservation(
  reservation: VerificationBudgetReservation,
  expected: Omit<VerificationBudgetInput, "now" | "reservation">,
): boolean {
  try {
    const state = reservationStates.get(reservation);
    reservationStates.delete(reservation);
    if (!state || state.action !== expected.action.trim().toUpperCase()) return false;
    return suppliedKeys(expected).every(({ keyHash }) => state.keyHashes.has(keyHash));
  } catch {
    return false;
  }
}

export function createVerificationBudgetConsumer(store: VerificationRateLimitStore) {
  return async (input: VerificationBudgetInput): Promise<VerificationBudgetResult> => {
    let normalized: ReturnType<typeof normalizedInput>;
    try {
      normalized = normalizedInput(input);
    } catch (error) {
      throw new VerificationRateLimitUnavailableError({ cause: error });
    }
    try {
      const result = normalized.consumption.buckets.length === 0
        ? { allowed: true, retryAfterSeconds: 0 }
        : await store.consumeAtomic(normalized.consumption);
      if (!result.allowed) return result;
      const reservation = Object.freeze({}) as VerificationBudgetReservation;
      reservationStates.set(reservation, normalized.reservationState);
      return Object.defineProperty(
        { allowed: true, retryAfterSeconds: 0 },
        "reservation",
        { value: reservation, enumerable: false },
      ) as VerificationBudgetResult;
    } catch (error) {
      if (error instanceof VerificationRateLimitUnavailableError) throw error;
      throw new VerificationRateLimitUnavailableError({ cause: error });
    }
  };
}

export class InMemoryVerificationRateLimitStore implements VerificationRateLimitStore {
  private rows: StoredBucket[] = [];
  private queue: Promise<void> = Promise.resolve();

  async consumeAtomic(input: AtomicConsumption): Promise<VerificationBudgetResult> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return this.consumeWhileLocked(input);
    } finally {
      release();
    }
  }

  private consumeWhileLocked(input: AtomicConsumption): VerificationBudgetResult {
    this.rows = this.rows.filter(({ expiresAt }) => expiresAt > input.now);
    const keyHashes = new Set(input.keys.map(({ keyHash }) => keyHash));
    const locks = this.rows.filter((row) => row.tenantScope === input.tenantScope && row.action === lockAction() && keyHashes.has(row.keyHash));
    if (locks.length > 0) {
      return { allowed: false, retryAfterSeconds: Math.max(...locks.map((lock) => retryAfter(lock.expiresAt, input.now))) };
    }

    const active = input.buckets.map((bucket) => ({
      bucket,
      row: this.rows.find((candidate) => candidate.tenantScope === input.tenantScope
        && candidate.action === bucket.action && candidate.keyHash === bucket.keyHash),
    }));
    const exceeded = active.find(({ bucket, row }) => row && row.count >= bucket.limit);
    if (exceeded?.row) {
      if (exceeded.bucket.cooldown) {
        return { allowed: false, retryAfterSeconds: retryAfter(exceeded.row.expiresAt, input.now) };
      }
      const expiresAt = new Date(input.now.getTime() + LOCK_SECONDS * 1_000);
      this.rows.push({
        tenantScope: input.tenantScope, action: lockAction(), keyHash: exceeded.bucket.keyHash,
        windowStart: input.now, count: 0, limit: 0, expiresAt,
      });
      return { allowed: false, retryAfterSeconds: LOCK_SECONDS };
    }

    for (const { bucket, row } of active) {
      if (row) row.count += 1;
      else this.rows.push({
        tenantScope: input.tenantScope, action: bucket.action, keyHash: bucket.keyHash,
        windowStart: input.now, count: 1, limit: bucket.limit,
        expiresAt: new Date(input.now.getTime() + bucket.durationSeconds * 1_000),
      });
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

type SqlTransaction = {
  $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
  $queryRaw: <T>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
};

async function activeRow(tx: SqlTransaction, tenantScope: string, action: string, keyHash: string, now: Date): Promise<StoredBucket | undefined> {
  const rows = await tx.$queryRaw<StoredBucket[]>`
    SELECT "tenantScope", "action", "keyHash", "windowStart", "count", "limit", "expiresAt"
    FROM "VerificationRateLimit"
    WHERE "tenantScope" = ${tenantScope} AND "action" = ${action} AND "keyHash" = ${keyHash} AND "expiresAt" > ${now}
    ORDER BY "expiresAt" DESC LIMIT 1
  `;
  return rows[0];
}

export class PrismaVerificationRateLimitStore implements VerificationRateLimitStore {
  constructor(private readonly client: Pick<typeof prisma, "$transaction"> = prisma) {}

  async consumeAtomic(input: AtomicConsumption): Promise<VerificationBudgetResult> {
    return this.client.$transaction(async (tx) => {
      const sql = tx as unknown as SqlTransaction;
      await sql.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('continuixai-verification-rate-limit'))`;
      await sql.$executeRaw`DELETE FROM "VerificationRateLimit" WHERE "expiresAt" <= ${input.now}`;

      const locks: StoredBucket[] = [];
      for (const key of input.keys) {
        const lock = await activeRow(sql, input.tenantScope, lockAction(), key.keyHash, input.now);
        if (lock) locks.push(lock);
      }
      if (locks.length > 0) {
        return { allowed: false, retryAfterSeconds: Math.max(...locks.map((lock) => retryAfter(lock.expiresAt, input.now))) };
      }

      const active: Array<{ bucket: RateLimitBucket; row?: StoredBucket }> = [];
      for (const bucket of input.buckets) {
        active.push({ bucket, row: await activeRow(sql, input.tenantScope, bucket.action, bucket.keyHash, input.now) });
      }
      const exceeded = active.find(({ bucket, row }) => row && row.count >= bucket.limit);
      if (exceeded?.row) {
        if (exceeded.bucket.cooldown) {
          return { allowed: false, retryAfterSeconds: retryAfter(exceeded.row.expiresAt, input.now) };
        }
        const expiresAt = new Date(input.now.getTime() + LOCK_SECONDS * 1_000);
        await sql.$executeRaw`
          INSERT INTO "VerificationRateLimit" ("id", "tenantScope", "action", "keyHash", "windowStart", "count", "limit", "expiresAt", "updatedAt")
          VALUES (${randomUUID()}, ${input.tenantScope}, ${lockAction()}, ${exceeded.bucket.keyHash}, ${input.now}, 0, 0, ${expiresAt}, ${input.now})
          ON CONFLICT ("tenantScope", "action", "keyHash", "windowStart")
          DO UPDATE SET "expiresAt" = GREATEST("VerificationRateLimit"."expiresAt", EXCLUDED."expiresAt"), "updatedAt" = EXCLUDED."updatedAt"
        `;
        return { allowed: false, retryAfterSeconds: LOCK_SECONDS };
      }

      for (const { bucket, row } of active) {
        const windowStart = row?.windowStart ?? input.now;
        const expiresAt = row?.expiresAt ?? new Date(input.now.getTime() + bucket.durationSeconds * 1_000);
        await sql.$executeRaw`
          INSERT INTO "VerificationRateLimit" ("id", "tenantScope", "action", "keyHash", "windowStart", "count", "limit", "expiresAt", "updatedAt")
          VALUES (${randomUUID()}, ${input.tenantScope}, ${bucket.action}, ${bucket.keyHash}, ${windowStart}, 1, ${bucket.limit}, ${expiresAt}, ${input.now})
          ON CONFLICT ("tenantScope", "action", "keyHash", "windowStart")
          DO UPDATE SET "count" = "VerificationRateLimit"."count" + 1, "limit" = EXCLUDED."limit", "updatedAt" = EXCLUDED."updatedAt"
        `;
      }
      return { allowed: true, retryAfterSeconds: 0 };
    });
  }
}

const consumeWithPrisma = createVerificationBudgetConsumer(new PrismaVerificationRateLimitStore());

export async function consumeVerificationBudget(input: VerificationBudgetInput): Promise<VerificationBudgetResult> {
  return consumeWithPrisma(input);
}
