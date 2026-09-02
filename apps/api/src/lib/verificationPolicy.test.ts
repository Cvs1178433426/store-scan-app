import { describe, expect, it, vi } from "vitest";
import { VerificationAmbiguousError, type VerificationProvider } from "./verificationProvider.js";
import {
  InMemoryVerificationPolicyStore,
  PrismaVerificationPolicyStore,
  VerificationLockedError,
  VerificationPolicy,
} from "./verificationPolicy.js";
import {
  createVerificationBudgetConsumer,
  InMemoryVerificationRateLimitStore,
  VerificationRateLimitUnavailableError,
  type VerificationBudgetInput,
  type VerificationBudgetReservation,
} from "./verificationRateLimit.js";

const destination = "+16317423355";
const dimensions = ["account:user-1", "phone:hash-1", "ip:203.0.113"];

function provider(matches: boolean | "ambiguous" = false): VerificationProvider {
  return {
    async start() { return { providerRef: "VE123" }; },
    async check() {
      if (matches === "ambiguous") throw new VerificationAmbiguousError();
      return { matched: matches };
    },
  };
}

describe("application-owned verification policy", () => {
  it("permits three sends in 15 minutes and locks the fourth for 15 minutes", async () => {
    let now = new Date("2026-09-01T12:00:00Z");
    const policy = new VerificationPolicy(new InMemoryVerificationPolicyStore(), provider(), () => now);
    for (let i = 0; i < 3; i += 1) {
      await policy.startChallenge({ userId: "user-1", purpose: "LOGIN", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 1, dimensions });
      now = new Date(now.getTime() + 31_000);
    }
    await expect(policy.startChallenge({ userId: "user-1", purpose: "LOGIN", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 1, dimensions }))
      .rejects.toMatchObject({ retryAfter: 900 });
  });

  it("locks a challenge after five incorrect checks", async () => {
    const store = new InMemoryVerificationPolicyStore();
    const policy = new VerificationPolicy(store, provider(false), () => new Date("2026-09-01T12:00:00Z"));
    const challenge = await policy.startChallenge({ userId: "user-1", purpose: "LOGIN", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 1, dimensions });
    for (let i = 0; i < 5; i += 1) await expect(policy.checkChallenge({ challengeId: challenge.id, userId: "user-1", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 1, code: "000000" })).resolves.toEqual({ approved: false });
    await expect(policy.checkChallenge({ challengeId: challenge.id, userId: "user-1", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 1, code: "000000" })).rejects.toBeInstanceOf(VerificationLockedError);
  });

  it("binds a challenge to one method and destination version and consumes it once", async () => {
    const policy = new VerificationPolicy(new InMemoryVerificationPolicyStore(), provider(true), () => new Date("2026-09-01T12:00:00Z"));
    const challenge = await policy.startChallenge({ userId: "user-1", purpose: "LOGIN", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 2, dimensions });
    await expect(policy.checkChallenge({ challengeId: challenge.id, userId: "user-2", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 2, code: "123456" })).rejects.toThrow("Verification challenge is invalid.");
    await expect(policy.checkChallenge({ challengeId: challenge.id, userId: "user-1", method: "TOTP", destination, destinationHash: "hash-1", destinationVersion: 2, code: "123456" })).rejects.toThrow("Verification challenge is invalid.");
    await expect(policy.checkChallenge({ challengeId: challenge.id, userId: "user-1", method: "SMS", destination, destinationHash: "wrong-hash", destinationVersion: 2, code: "123456" })).rejects.toThrow("Verification challenge is invalid.");
    await expect(policy.checkChallenge({ challengeId: challenge.id, userId: "user-1", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 1, code: "123456" })).rejects.toThrow("Verification challenge is invalid.");
    await expect(policy.checkChallenge({ challengeId: challenge.id, userId: "user-1", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 2, code: "123456" })).resolves.toEqual({ approved: true });
    await expect(policy.checkChallenge({ challengeId: challenge.id, userId: "user-1", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 2, code: "123456" })).rejects.toThrow("Verification challenge is invalid.");
  });

  it("invalidates an ambiguous provider result without counting a wrong attempt", async () => {
    const store = new InMemoryVerificationPolicyStore();
    const policy = new VerificationPolicy(store, provider("ambiguous"), () => new Date("2026-09-01T12:00:00Z"));
    const challenge = await policy.startChallenge({ userId: "user-1", purpose: "LOGIN", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 1, dimensions });
    await expect(policy.checkChallenge({ challengeId: challenge.id, userId: "user-1", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 1, code: "123456" })).rejects.toBeInstanceOf(VerificationAmbiguousError);
    expect((await store.getChallenge(challenge.id))?.incorrectAttempts).toBe(0);
    expect((await store.getChallenge(challenge.id))?.invalidatedAt).not.toBeNull();
  });

  it("allows only one concurrent approval to consume a challenge", async () => {
    const policy = new VerificationPolicy(new InMemoryVerificationPolicyStore(), provider(true), () => new Date("2026-09-01T12:00:00Z"));
    const challenge = await policy.startChallenge({ userId: "user-1", purpose: "LOGIN", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 1, dimensions });
    const input = { challengeId: challenge.id, userId: "user-1", method: "SMS" as const, destination, destinationHash: "hash-1", destinationVersion: 1, code: "123456" };
    const results = await Promise.allSettled([policy.checkChallenge(input), policy.checkChallenge(input)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("invalidates the previous challenge when switching to a different local method", async () => {
    const now = new Date("2026-09-01T12:00:00Z");
    const store = new InMemoryVerificationPolicyStore();
    const policy = new VerificationPolicy(store, provider(), () => now);
    const sms = await policy.startChallenge({ userId: "user-1", purpose: "LOGIN", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 2, dimensions });

    const backup = await policy.switchChallengeMethod({
      challengeId: sms.id,
      userId: "user-1",
      purpose: "LOGIN",
      method: "RECOVERY_CODE",
      destinationHash: "recovery:user-1",
      destinationVersion: 1,
    });

    expect((await store.getChallenge(sms.id))?.invalidatedAt).toEqual(now);
    expect(await store.getChallenge(backup.id)).toMatchObject({
      userId: "user-1", purpose: "LOGIN", method: "RECOVERY_CODE",
      destinationHash: "recovery:user-1", destinationVersion: 1,
    });
  });

  it("starts a method-bound local challenge without contacting the SMS provider", async () => {
    const start = vi.fn(async () => ({ providerRef: "must-not-run" }));
    const store = new InMemoryVerificationPolicyStore();
    const policy = new VerificationPolicy(store, { start, check: vi.fn() }, () => new Date("2026-09-01T12:00:00Z"));

    const challenge = await policy.startLocalChallenge({
      userId: "user-1", purpose: "LOGIN", method: "TOTP",
      destinationHash: "totp:user-1", destinationVersion: 7,
    });

    expect(start).not.toHaveBeenCalled();
    expect(await store.getChallenge(challenge.id)).toMatchObject({
      userId: "user-1", purpose: "LOGIN", method: "TOTP",
      destinationHash: "totp:user-1", destinationVersion: 7, providerRef: "local",
    });
  });

  it("resends SMS by replacing and invalidating the prior bound challenge", async () => {
    const start = vi.fn(async () => ({ providerRef: "VE123" }));
    const store = new InMemoryVerificationPolicyStore();
    let now = new Date("2026-09-01T12:00:00Z");
    const policy = new VerificationPolicy(store, { start, check: vi.fn() }, () => now);
    const original = await policy.startChallenge({ userId: "user-1", purpose: "LOGIN", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 2, dimensions });

    await expect(policy.resendChallenge({
      previousChallengeId: original.id,
      userId: "user-1", purpose: "LOGIN", method: "SMS", destination,
      destinationHash: "hash-1", destinationVersion: 2, dimensions,
    })).rejects.toMatchObject({ retryAfter: 30 });
    expect(start).toHaveBeenCalledTimes(1);
    now = new Date("2026-09-01T12:00:30Z");

    const replacement = await policy.resendChallenge({
      previousChallengeId: original.id,
      userId: "user-1", purpose: "LOGIN", method: "SMS", destination,
      destinationHash: "hash-1", destinationVersion: 2, dimensions,
    });

    expect(start).toHaveBeenCalledTimes(2);
    expect((await store.getChallenge(original.id))?.invalidatedAt).not.toBeNull();
    expect(await store.getChallenge(replacement.id)).toMatchObject({ userId: "user-1", purpose: "LOGIN", method: "SMS" });
  });

  it("gives a decoy SMS challenge the same cooldown, replacement, and attempt behavior without contacting the provider", async () => {
    const start = vi.fn(async () => ({ providerRef: "must-not-run" }));
    const store = new InMemoryVerificationPolicyStore();
    let now = new Date("2026-09-01T12:00:00Z");
    const policy = new VerificationPolicy(store, { start, check: vi.fn() }, () => now);
    const original = await policy.startDecoySmsChallenge({
      userId: "user-1", purpose: "PHONE_CHANGE", method: "SMS", destination,
      destinationHash: "hash-1", destinationVersion: 2, dimensions,
    });

    await expect(policy.resendDecoySmsChallenge({
      previousChallengeId: original.id, userId: "user-1", purpose: "PHONE_CHANGE", method: "SMS", destination,
      destinationHash: "hash-1", destinationVersion: 2, dimensions,
    })).rejects.toMatchObject({ retryAfter: 30 });
    now = new Date("2026-09-01T12:00:30Z");
    const replacement = await policy.resendDecoySmsChallenge({
      previousChallengeId: original.id, userId: "user-1", purpose: "PHONE_CHANGE", method: "SMS", destination,
      destinationHash: "hash-1", destinationVersion: 2, dimensions,
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(policy.rejectDecoySmsChallenge({
        challengeId: replacement.id, userId: "user-1", purpose: "PHONE_CHANGE",
        destinationHash: "hash-1", destinationVersion: 2,
      })).resolves.toEqual({ approved: false });
    }
    await expect(policy.rejectDecoySmsChallenge({
      challengeId: replacement.id, userId: "user-1", purpose: "PHONE_CHANGE",
      destinationHash: "hash-1", destinationVersion: 2,
    })).rejects.toBeInstanceOf(VerificationLockedError);
    expect(start).not.toHaveBeenCalled();
  });

  it("delegates local-factor consumption only for the bound live challenge", async () => {
    const now = new Date("2026-09-01T12:00:00Z");
    const store = new InMemoryVerificationPolicyStore();
    const policy = new VerificationPolicy(store, provider(), () => now);
    const sms = await policy.startChallenge({ userId: "user-1", purpose: "LOGIN", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 2, dimensions });
    const recovery = await policy.switchChallengeMethod({
      challengeId: sms.id, userId: "user-1", purpose: "LOGIN", method: "RECOVERY_CODE",
      destinationHash: "recovery:user-1", destinationVersion: 3,
    });
    let consumed = 0;
    const consume = async (challengeId: string, approvedAt: Date) => {
      if (!await store.consumeChallenge(challengeId, approvedAt)) return "conflict" as const;
      consumed += 1;
      return "approved" as const;
    };

    await expect(policy.completeLocalChallenge({
      challengeId: recovery.id, userId: "user-1", purpose: "LOGIN", method: "TOTP",
      destinationHash: "recovery:user-1", destinationVersion: 3,
    }, consume)).rejects.toThrow("Verification challenge is invalid.");
    expect(consumed).toBe(0);
    await expect(policy.completeLocalChallenge({
      challengeId: recovery.id, userId: "user-1", purpose: "LOGIN", method: "RECOVERY_CODE",
      destinationHash: "recovery:user-1", destinationVersion: 3,
    }, consume)).resolves.toEqual({ approved: true });
    expect(consumed).toBe(1);
    await expect(policy.completeLocalChallenge({
      challengeId: recovery.id, userId: "user-1", purpose: "LOGIN", method: "RECOVERY_CODE",
      destinationHash: "recovery:user-1", destinationVersion: 3,
    }, consume)).rejects.toThrow("Verification challenge is invalid.");
  });

  it("counts each provider send once in the global circuit breaker", async () => {
    const store = new InMemoryVerificationPolicyStore();
    const policy = new VerificationPolicy(store, provider(), () => new Date("2026-09-01T12:00:00Z"));
    for (let i = 0; i < 100; i += 1) {
      await policy.startChallenge({ userId: `user-${i}`, purpose: "LOGIN", method: "SMS", destination, destinationHash: `hash-${i}`, destinationVersion: 1, dimensions: [`account:user-${i}`, `phone:hash-${i}`, `ip:203.0.${i}`] });
    }
    await expect(policy.startChallenge({ userId: "user-101", purpose: "LOGIN", method: "SMS", destination, destinationHash: "hash-101", destinationVersion: 1, dimensions: ["account:user-101"] })).rejects.toBeInstanceOf(VerificationLockedError);
  });

  it("stops before provider delivery when the durable multi-dimensional budget is denied", async () => {
    const consume = vi.fn(async (_input: VerificationBudgetInput) => ({ allowed: false, retryAfterSeconds: 30 }));
    const start = vi.fn(async () => ({ providerRef: "VE123" }));
    const policy = new VerificationPolicy(
      new PrismaVerificationPolicyStore(consume),
      { start, async check() { return { matched: false }; } },
      () => new Date("2026-09-01T12:00:00Z"),
    );

    await expect(policy.startChallenge({
      userId: "user-1", purpose: "LOGIN", method: "SMS", destination,
      destinationHash: "a".repeat(64), destinationVersion: 1,
      dimensions: [`account:${"b".repeat(64)}`, `ip:${"c".repeat(64)}`],
    })).rejects.toMatchObject({
      message: "Too many verification requests. Please try again later.",
      retryAfter: 30,
    });
    expect(consume).toHaveBeenCalledWith({
      action: "LOGIN",
      phoneHash: "a".repeat(64),
      accountHash: "b".repeat(64),
      ipHash: "c".repeat(64),
      now: new Date("2026-09-01T12:00:00Z"),
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("fails closed before provider delivery when durable rate-limit state is unavailable", async () => {
    const consume = vi.fn(async (_input: VerificationBudgetInput) => {
      throw new VerificationRateLimitUnavailableError();
    });
    const start = vi.fn(async () => ({ providerRef: "VE123" }));
    const policy = new VerificationPolicy(
      new PrismaVerificationPolicyStore(consume),
      { start, async check() { return { matched: false }; } },
    );

    await expect(policy.startChallenge({
      userId: "user-1", purpose: "LOGIN", method: "SMS", destination,
      destinationHash: "a".repeat(64), destinationVersion: 1,
      dimensions: [`account:${"b".repeat(64)}`, `ip:${"c".repeat(64)}`],
    })).rejects.toBeInstanceOf(VerificationRateLimitUnavailableError);
    expect(start).not.toHaveBeenCalled();
  });

  it("accepts only an issued reservation receipt covering the exact provider delivery", async () => {
    const now = new Date("2026-09-01T12:00:00Z");
    const accountHash = "b".repeat(64);
    const phoneHash = "a".repeat(64);
    const ipHash = "c".repeat(64);
    const reserved = await createVerificationBudgetConsumer(new InMemoryVerificationRateLimitStore())({
      action: "LOGIN", phoneHash, accountHash, ipHash, now,
    });
    expect(reserved.allowed).toBe(true);
    if (!reserved.allowed) throw new Error("expected reservation");
    const start = vi.fn(async () => ({ providerRef: "VE123" }));
    const store = new InMemoryVerificationPolicyStore();
    const policy = new VerificationPolicy(store, { start, async check() { return { matched: false }; } }, () => now);
    const base = {
      userId: "user-1", purpose: "LOGIN" as const, method: "SMS" as const, destination,
      destinationHash: phoneHash, destinationVersion: 1,
      dimensions: [`account:${accountHash}`, `ip:${ipHash}`],
    };

    await expect(policy.startChallenge({ ...base, verificationBudgetReservation: reserved.reservation })).resolves.toEqual({
      id: expect.any(String), expiresAt: new Date("2026-09-01T12:10:00Z"),
    });
    expect(start).toHaveBeenCalledTimes(1);

    await expect(policy.startChallenge({ ...base, verificationBudgetReservation: reserved.reservation }))
      .rejects.toBeInstanceOf(VerificationRateLimitUnavailableError);
    expect(start).toHaveBeenCalledTimes(1);

    const forged = {} as VerificationBudgetReservation;
    await expect(policy.startChallenge({ ...base, verificationBudgetReservation: forged }))
      .rejects.toBeInstanceOf(VerificationRateLimitUnavailableError);
    const mismatch = await createVerificationBudgetConsumer(new InMemoryVerificationRateLimitStore())({
      action: "LOGIN", phoneHash, accountHash, ipHash, now,
    });
    if (!mismatch.allowed) throw new Error("expected reservation");
    await expect(policy.startChallenge({ ...base, destinationHash: "d".repeat(64), verificationBudgetReservation: mismatch.reservation }))
      .rejects.toBeInstanceOf(VerificationRateLimitUnavailableError);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("claims pre-consumed budgets for decoy start and resend without consuming them twice", async () => {
    let now = new Date("2026-09-01T12:00:00Z");
    const accountHash = "b".repeat(64);
    const phoneHash = "a".repeat(64);
    const ipHash = "c".repeat(64);
    const consume = createVerificationBudgetConsumer(new InMemoryVerificationRateLimitStore());
    const store = new InMemoryVerificationPolicyStore();
    const reserveSend = vi.spyOn(store, "reserveSend");
    const policy = new VerificationPolicy(store, provider(), () => now);
    const base = {
      userId: null, purpose: "REGISTRATION" as const, method: "SMS" as const, destination,
      destinationHash: phoneHash, destinationVersion: 1,
      dimensions: [`account:${accountHash}`, `ip:${ipHash}`],
    };
    const first = await consume({ action: "REGISTRATION", phoneHash, accountHash, ipHash, now });
    if (!first.allowed) throw new Error("expected reservation");
    const original = await policy.startDecoySmsChallenge({ ...base, verificationBudgetReservation: first.reservation });

    now = new Date("2026-09-01T12:00:30Z");
    const second = await consume({ action: "REGISTRATION", phoneHash, accountHash, ipHash, now });
    if (!second.allowed) throw new Error("expected reservation");
    await expect(policy.resendDecoySmsChallenge({
      ...base, previousChallengeId: original.id, verificationBudgetReservation: second.reservation,
    })).resolves.toEqual({ id: expect.any(String), expiresAt: new Date("2026-09-01T12:10:30Z") });
    expect(reserveSend).not.toHaveBeenCalled();
  });
});
