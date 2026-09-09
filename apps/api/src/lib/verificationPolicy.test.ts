import { describe, expect, it, vi } from "vitest";
import { VerificationAmbiguousError, VerificationProviderError, type VerificationProvider } from "./verificationProvider.js";
import {
  InMemoryVerificationPolicyStore,
  PrismaVerificationPolicyStore,
  VerificationLockedError,
  VerificationPolicy,
  VerificationRejectedError,
} from "./verificationPolicy.js";
import {
  createVerificationBudgetConsumer,
  InMemoryVerificationRateLimitStore,
  verificationPhonePrefixHash,
  VerificationRateLimitUnavailableError,
  type VerificationBudgetInput,
  type VerificationBudgetReservation,
} from "./verificationRateLimit.js";

const destination = "+16317423355";
const dimensions = ["account:user-1", "phone:hash-1", "ip:203.0.113"];
process.env.RATE_LIMIT_HMAC_KEY = "verification-policy-test-rate-limit-key";
process.env.PHONE_ENCRYPTION_KEYS = `1:${"11".repeat(32)}`;
const phonePrefixHash = verificationPhonePrefixHash(destination);
const allowAttemptControls = {
  consume: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  check: async () => ({ allowed: true, retryAfterSeconds: 0 }),
};

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
  it("persists a queued public SMS challenge without waiting for the provider", async () => {
    const start = vi.fn(async () => ({ providerRef: "VE123" }));
    const store = new InMemoryVerificationPolicyStore();
    const policy = new VerificationPolicy(store, { start, check: vi.fn() }, () => new Date("2026-09-01T12:00:00Z"));

    const challenge = await policy.queueSmsChallenge({
      userId: "user-1", purpose: "PASSWORD_RESET", method: "SMS", destination,
      destinationHash: "hash-1", destinationVersion: 2, tokenVersionAtIssue: 4,
      dimensions,
    });

    expect(start).not.toHaveBeenCalled();
    expect(await store.getChallenge(challenge.id)).toMatchObject({
      providerRef: expect.stringMatching(/^pending:/),
      smsDeliveryState: "PENDING",
      smsDestinationEncrypted: expect.stringMatching(/^[^.]+\.[^.]+\.[^.]+$/),
      smsDestinationEncryptionKeyVersion: 1,
    });
  });

  it("persists a non-dispatching recovery decoy without consuming a second send budget", async () => {
    const store = new InMemoryVerificationPolicyStore();
    const start = vi.fn();
    const policy = new VerificationPolicy(store, { start, check: vi.fn() }, () => new Date("2026-09-01T12:00:00Z"));

    const challenge = await policy.queuePasswordRecoveryDecoy("a".repeat(64));

    expect(start).not.toHaveBeenCalled();
    expect(await store.getChallenge(challenge.id)).toMatchObject({
      userId: null,
      purpose: "PASSWORD_RESET",
      method: "SMS",
      providerRef: "decoy",
      smsDeliveryState: null,
      accountRateLimitHash: "a".repeat(64),
    });
  });

  it("handles queued and failed internal delivery references without contacting the provider", async () => {
    const check = vi.fn(async () => ({ matched: true }));
    const store = new InMemoryVerificationPolicyStore();
    const policy = new VerificationPolicy(store, { start: vi.fn(), check }, () => new Date("2026-09-01T12:00:00Z"));
    const challenge = await policy.queueSmsChallenge({
      userId: "user-1", purpose: "PASSWORD_RESET", method: "SMS", destination,
      destinationHash: "hash-1", destinationVersion: 2, tokenVersionAtIssue: 4,
      dimensions,
    });

    await expect(policy.checkChallenge({
      challengeId: challenge.id, userId: "user-1", purpose: "PASSWORD_RESET", method: "SMS",
      destination, destinationHash: "hash-1", destinationVersion: 2, tokenVersionAtIssue: 4, code: "123456",
    })).resolves.toEqual({ approved: false });
    expect(check).not.toHaveBeenCalled();
  });

  it("atomically replaces a queued public challenge without provider delivery", async () => {
    const start = vi.fn(async () => ({ providerRef: "VE123" }));
    const store = new InMemoryVerificationPolicyStore();
    let now = new Date("2026-09-01T12:00:00Z");
    const policy = new VerificationPolicy(store, { start, check: vi.fn() }, () => now);
    const original = await policy.queueSmsChallenge({
      userId: "user-1", purpose: "REGISTRATION", method: "SMS", destination,
      destinationHash: "hash-1", destinationVersion: 2, tokenVersionAtIssue: 4,
      dimensions,
    });
    now = new Date("2026-09-01T12:00:31Z");

    const replacement = await policy.queueSmsResend({
      previousChallengeId: original.id,
      userId: "user-1", purpose: "REGISTRATION", method: "SMS", destination,
      destinationHash: "hash-1", destinationVersion: 2, tokenVersionAtIssue: 4,
      dimensions,
    });

    expect(start).not.toHaveBeenCalled();
    expect((await store.getChallenge(original.id))?.invalidatedAt).not.toBeNull();
    expect((await store.getChallenge(replacement.id))?.providerRef).toMatch(/^pending:/);
  });

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

  it("locks a challenge on the fifth incorrect check", async () => {
    const store = new InMemoryVerificationPolicyStore();
    const policy = new VerificationPolicy(store, provider(false), () => new Date("2026-09-01T12:00:00Z"));
    const challenge = await policy.startChallenge({ userId: "user-1", purpose: "LOGIN", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 1, dimensions });
    for (let i = 0; i < 4; i += 1) await expect(policy.checkChallenge({ challengeId: challenge.id, userId: "user-1", purpose: "LOGIN", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 1, code: "000000" })).resolves.toEqual({ approved: false });
    await expect(policy.checkChallenge({ challengeId: challenge.id, userId: "user-1", purpose: "LOGIN", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 1, code: "000000" })).rejects.toBeInstanceOf(VerificationLockedError);
  });

  it("does not reset the incorrect-attempt lock when an SMS challenge is resent", async () => {
    let now = new Date("2026-09-01T12:00:00Z");
    const store = new InMemoryVerificationPolicyStore();
    const policy = new VerificationPolicy(store, provider(false), () => now);
    const original = await policy.startChallenge({
      userId: "user-1", purpose: "LOGIN", method: "SMS", destination,
      destinationHash: "hash-1", destinationVersion: 1, dimensions,
    });
    for (let i = 0; i < 4; i += 1) {
      await expect(policy.checkChallenge({
        challengeId: original.id, userId: "user-1", purpose: "LOGIN", method: "SMS",
        destination, destinationHash: "hash-1", destinationVersion: 1, tokenVersionAtIssue: null, code: "000000",
      })).resolves.toEqual({ approved: false });
    }
    now = new Date(now.getTime() + 31_000);
    const replacement = await policy.resendChallenge({
      previousChallengeId: original.id,
      userId: "user-1", purpose: "LOGIN", method: "SMS", destination,
      destinationHash: "hash-1", destinationVersion: 1, tokenVersionAtIssue: null, dimensions,
    });

    await expect(policy.checkChallenge({
      challengeId: replacement.id, userId: "user-1", purpose: "LOGIN", method: "SMS",
      destination, destinationHash: "hash-1", destinationVersion: 1, tokenVersionAtIssue: null, code: "000000",
    })).rejects.toBeInstanceOf(VerificationLockedError);
    now = new Date(now.getTime() + 31_000);
    await expect(policy.resendChallenge({
      previousChallengeId: replacement.id,
      userId: "user-1", purpose: "LOGIN", method: "SMS", destination,
      destinationHash: "hash-1", destinationVersion: 1, tokenVersionAtIssue: null, dimensions,
    })).rejects.toMatchObject({ retryAfter: 869 });
  });

  it("binds a challenge to one method and destination version and consumes it once", async () => {
    const policy = new VerificationPolicy(new InMemoryVerificationPolicyStore(), provider(true), () => new Date("2026-09-01T12:00:00Z"));
    const challenge = await policy.startChallenge({ userId: "user-1", purpose: "LOGIN", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 2, dimensions });
    await expect(policy.checkChallenge({ challengeId: challenge.id, userId: "user-2", purpose: "LOGIN", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 2, code: "123456" })).rejects.toThrow("Verification challenge is invalid.");
    await expect(policy.checkChallenge({ challengeId: challenge.id, userId: "user-1", purpose: "LOGIN", method: "TOTP", destination, destinationHash: "hash-1", destinationVersion: 2, code: "123456" })).rejects.toThrow("Verification challenge is invalid.");
    await expect(policy.checkChallenge({ challengeId: challenge.id, userId: "user-1", purpose: "LOGIN", method: "SMS", destination, destinationHash: "wrong-hash", destinationVersion: 2, code: "123456" })).rejects.toThrow("Verification challenge is invalid.");
    await expect(policy.checkChallenge({ challengeId: challenge.id, userId: "user-1", purpose: "LOGIN", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 1, code: "123456" })).rejects.toThrow("Verification challenge is invalid.");
    await expect(policy.checkChallenge({ challengeId: challenge.id, userId: "user-1", purpose: "LOGIN", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 2, code: "123456" })).resolves.toEqual({ approved: true });
    await expect(policy.checkChallenge({ challengeId: challenge.id, userId: "user-1", purpose: "LOGIN", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 2, code: "123456" })).rejects.toThrow("Verification challenge is invalid.");
  });

  it("rejects a challenge issued before the user's token version changed", async () => {
    const check = vi.fn(async () => ({ matched: true }));
    const policy = new VerificationPolicy(
      new InMemoryVerificationPolicyStore(),
      { start: vi.fn(async () => ({ providerRef: "VE123" })), check },
      () => new Date("2026-09-01T12:00:00Z"),
    );
    const challenge = await policy.startChallenge({
      userId: "user-1", purpose: "LOGIN", method: "SMS", destination,
      destinationHash: "hash-1", destinationVersion: 2, tokenVersionAtIssue: 3, dimensions,
    });

    await expect(policy.checkChallenge({
      challengeId: challenge.id, userId: "user-1", purpose: "LOGIN", method: "SMS",
      destination, destinationHash: "hash-1", destinationVersion: 2,
      tokenVersionAtIssue: 4, code: "123456",
    })).rejects.toThrow("Verification challenge is invalid.");
    expect(check).not.toHaveBeenCalled();
  });

  it("rejects an otherwise matching SMS challenge used for a different purpose", async () => {
    const check = vi.fn(async () => ({ matched: true }));
    const policy = new VerificationPolicy(
      new InMemoryVerificationPolicyStore(),
      { start: vi.fn(async () => ({ providerRef: "VE123" })), check },
      () => new Date("2026-09-01T12:00:00Z"),
    );
    const challenge = await policy.startChallenge({
      userId: "user-1", purpose: "LOGIN", method: "SMS", destination,
      destinationHash: "hash-1", destinationVersion: 2, dimensions,
    });
    const wrongPurpose = {
      challengeId: challenge.id,
      userId: "user-1",
      purpose: "PASSWORD_RESET",
      method: "SMS",
      destination,
      destinationHash: "hash-1",
      destinationVersion: 2,
      code: "123456",
    } as Parameters<typeof policy.checkChallenge>[0];

    await expect(policy.checkChallenge(wrongPurpose)).rejects.toThrow("Verification challenge is invalid.");
    expect(check).not.toHaveBeenCalled();
  });

  it("invalidates an ambiguous provider result after reserving its bounded attempt", async () => {
    const store = new InMemoryVerificationPolicyStore();
    const policy = new VerificationPolicy(store, provider("ambiguous"), () => new Date("2026-09-01T12:00:00Z"));
    const challenge = await policy.startChallenge({ userId: "user-1", purpose: "LOGIN", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 1, dimensions });
    await expect(policy.checkChallenge({ challengeId: challenge.id, userId: "user-1", purpose: "LOGIN", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 1, code: "123456" })).rejects.toBeInstanceOf(VerificationAmbiguousError);
    expect((await store.getChallenge(challenge.id))?.incorrectAttempts).toBe(1);
    expect((await store.getChallenge(challenge.id))?.invalidatedAt).not.toBeNull();
  });

  it("rejects and invalidates an SMS approval that arrives after local expiry", async () => {
    let now = new Date("2026-09-01T12:00:00Z");
    const store = new InMemoryVerificationPolicyStore();
    const policy = new VerificationPolicy(store, {
      async start() { return { providerRef: "VE123" }; },
      async check() {
        now = new Date("2026-09-01T12:10:01Z");
        return { matched: true };
      },
    }, () => now);
    const challenge = await policy.startChallenge({
      userId: "user-1", purpose: "LOGIN", method: "SMS", destination,
      destinationHash: "hash-1", destinationVersion: 1, dimensions,
    });

    await expect(policy.checkChallenge({
      challengeId: challenge.id, userId: "user-1", purpose: "LOGIN", method: "SMS",
      destination, destinationHash: "hash-1", destinationVersion: 1, code: "123456",
    })).rejects.toThrow("Verification challenge is invalid.");
    expect((await store.getChallenge(challenge.id))?.consumedAt).toBeNull();
    expect((await store.getChallenge(challenge.id))?.invalidatedAt).toEqual(now);
  });

  it("allows only one concurrent approval to consume a challenge", async () => {
    const policy = new VerificationPolicy(new InMemoryVerificationPolicyStore(), provider(true), () => new Date("2026-09-01T12:00:00Z"));
    const challenge = await policy.startChallenge({ userId: "user-1", purpose: "LOGIN", method: "SMS", destination, destinationHash: "hash-1", destinationVersion: 1, dimensions });
    const input = { challengeId: challenge.id, userId: "user-1", purpose: "LOGIN" as const, method: "SMS" as const, destination, destinationHash: "hash-1", destinationVersion: 1, code: "123456" };
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

  it("does not let a resend substitute a different account rate-limit binding", async () => {
    const start = vi.fn(async () => ({ providerRef: "VE123" }));
    const store = new InMemoryVerificationPolicyStore();
    let now = new Date("2026-09-01T12:00:00Z");
    const policy = new VerificationPolicy(store, { start, check: vi.fn() }, () => now);
    const original = await policy.startChallenge({
      userId: "user-1", purpose: "REGISTRATION", method: "SMS", destination,
      destinationHash: "hash-1", destinationVersion: 2,
      dimensions: [`account:${"a".repeat(64)}`, `phone-prefix:${phonePrefixHash}`],
    });
    now = new Date("2026-09-01T12:00:31Z");

    await expect(policy.resendChallenge({
      previousChallengeId: original.id,
      userId: "user-1", purpose: "REGISTRATION", method: "SMS", destination,
      destinationHash: "hash-1", destinationVersion: 2,
      dimensions: [`account:${"b".repeat(64)}`, `phone-prefix:${phonePrefixHash}`],
    })).rejects.toThrow("Verification challenge is invalid.");
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("does not replace a challenge that expires while the resend provider call is pending", async () => {
    let now = new Date("2026-09-01T12:00:00Z");
    let starts = 0;
    const store = new InMemoryVerificationPolicyStore();
    const policy = new VerificationPolicy(store, {
      async start() {
        starts += 1;
        if (starts === 2) now = new Date("2026-09-01T12:10:01Z");
        return { providerRef: `VE${starts}` };
      },
      async check() { return { matched: false }; },
    }, () => now);
    const original = await policy.startChallenge({
      userId: "user-1", purpose: "LOGIN", method: "SMS", destination,
      destinationHash: "hash-1", destinationVersion: 2, dimensions,
    });
    now = new Date("2026-09-01T12:09:59Z");

    await expect(policy.resendChallenge({
      previousChallengeId: original.id,
      userId: "user-1", purpose: "LOGIN", method: "SMS", destination,
      destinationHash: "hash-1", destinationVersion: 2, dimensions,
    })).rejects.toThrow("Verification challenge is invalid.");
    expect((await store.getChallenge(original.id))?.invalidatedAt).toEqual(now);
  });

  it("keeps decoy resend expiry behavior aligned when budget reservation crosses expiry", async () => {
    let now = new Date("2026-09-01T12:00:00Z");
    const store = new InMemoryVerificationPolicyStore();
    const reserveSend = store.reserveSend.bind(store);
    let reservations = 0;
    vi.spyOn(store, "reserveSend").mockImplementation(async (input, at) => {
      await reserveSend(input, at);
      reservations += 1;
      if (reservations === 2) now = new Date("2026-09-01T12:10:01Z");
    });
    const policy = new VerificationPolicy(store, provider(), () => now);
    const original = await policy.startDecoySmsChallenge({
      userId: null, purpose: "REGISTRATION", method: "SMS", destination,
      destinationHash: "hash-1", destinationVersion: 1, dimensions,
    });
    now = new Date("2026-09-01T12:09:59Z");

    await expect(policy.resendDecoySmsChallenge({
      previousChallengeId: original.id,
      userId: null, purpose: "REGISTRATION", method: "SMS", destination,
      destinationHash: "hash-1", destinationVersion: 1, dimensions,
    })).rejects.toThrow("Verification challenge is invalid.");
    expect((await store.getChallenge(original.id))?.invalidatedAt).toEqual(now);
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
    for (let attempt = 0; attempt < 4; attempt += 1) {
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

  it("replaces a decoy SMS challenge with a userless local decoy", async () => {
    const now = new Date("2026-09-01T12:00:00Z");
    const store = new InMemoryVerificationPolicyStore();
    const policy = new VerificationPolicy(store, provider(), () => now);
    const sms = await policy.startDecoySmsChallenge({
      userId: null,
      purpose: "PASSWORD_RESET",
      method: "SMS",
      destination: "+15555550123",
      destinationHash: "decoy-phone-hash",
      destinationVersion: 1,
      tokenVersionAtIssue: null,
      dimensions,
    });

    const replacement = await policy.switchChallengeMethod({
      challengeId: sms.id,
      userId: null,
      purpose: "PASSWORD_RESET",
      method: "TOTP",
      destinationHash: "decoy-factor-hash",
      destinationVersion: 1,
      tokenVersionAtIssue: null,
    });

    await expect(store.getChallenge(replacement.id)).resolves.toMatchObject({
      userId: null,
      purpose: "PASSWORD_RESET",
      method: "TOTP",
      providerRef: "local",
    });
  });

  it("keeps an active password-recovery decoy bound when switching to a backup method", async () => {
    const now = new Date("2026-09-01T12:00:00Z");
    const store = new InMemoryVerificationPolicyStore();
    const policy = new VerificationPolicy(store, provider(), () => now);
    const sms = await policy.queuePasswordRecoveryDecoy("a".repeat(64), {
      userId: "user-1",
      tokenVersionAtIssue: 3,
    });

    const replacement = await policy.switchChallengeMethod({
      challengeId: sms.id,
      userId: "user-1",
      purpose: "PASSWORD_RESET",
      method: "RECOVERY_CODE",
      destinationHash: "recovery-hash",
      destinationVersion: 3,
      tokenVersionAtIssue: 3,
    });

    await expect(store.getChallenge(replacement.id)).resolves.toMatchObject({
      userId: "user-1",
      tokenVersionAtIssue: 3,
      method: "RECOVERY_CODE",
    });
  });

  it("applies the same fifth-attempt lock to a userless local decoy", async () => {
    const now = new Date("2026-09-01T12:00:00Z");
    const store = new InMemoryVerificationPolicyStore();
    const policy = new VerificationPolicy(store, provider(), () => now);
    const sms = await policy.queuePasswordRecoveryDecoy("a".repeat(64));
    const replacement = await policy.switchChallengeMethod({
      challengeId: sms.id,
      userId: null,
      purpose: "PASSWORD_RESET",
      method: "RECOVERY_CODE",
      destinationHash: "decoy-recovery-hash",
      destinationVersion: 0,
      tokenVersionAtIssue: null,
    });
    const reject = async () => "incorrect" as const;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(policy.completeLocalChallenge({
        challengeId: replacement.id,
        userId: null,
        purpose: "PASSWORD_RESET",
        method: "RECOVERY_CODE",
        destinationHash: "decoy-recovery-hash",
        destinationVersion: 0,
        tokenVersionAtIssue: null,
      }, reject)).resolves.toEqual({ approved: false });
    }
    await expect(policy.completeLocalChallenge({
      challengeId: replacement.id,
      userId: null,
      purpose: "PASSWORD_RESET",
      method: "RECOVERY_CODE",
      destinationHash: "decoy-recovery-hash",
      destinationVersion: 0,
      tokenVersionAtIssue: null,
    }, reject)).rejects.toBeInstanceOf(VerificationLockedError);
  });

  it("atomically admits only five concurrent local verification attempts", async () => {
    const store = new InMemoryVerificationPolicyStore();
    const policy = new VerificationPolicy(store, provider());
    const challenge = await policy.startLocalChallenge({
      userId: "user-1",
      purpose: "PASSWORD_RESET",
      method: "TOTP",
      destinationHash: "totp-hash",
      destinationVersion: 3,
      tokenVersionAtIssue: 3,
    });
    let verifications = 0;

    const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => policy.completeLocalChallenge({
      challengeId: challenge.id,
      userId: "user-1",
      purpose: "PASSWORD_RESET",
      method: "TOTP",
      destinationHash: "totp-hash",
      destinationVersion: 3,
      tokenVersionAtIssue: 3,
    }, async () => {
      verifications += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "incorrect";
    })));

    expect(verifications).toBe(5);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(2);
  });

  it("rejects switching a userless recovery challenge under a different email binding", async () => {
    const store = new InMemoryVerificationPolicyStore();
    const policy = new VerificationPolicy(store, provider());
    const challenge = await policy.queuePasswordRecoveryDecoy("a".repeat(64));

    await expect(policy.switchChallengeMethod({
      challengeId: challenge.id,
      userId: null,
      purpose: "PASSWORD_RESET",
      method: "TOTP",
      destinationHash: "decoy-factor-hash",
      destinationVersion: 0,
      tokenVersionAtIssue: null,
      previousAccountRateLimitHash: "b".repeat(64),
    })).rejects.toBeInstanceOf(VerificationRejectedError);
  });

  it("rejects replacement of a challenge issued under an older token version", async () => {
    const now = new Date("2026-09-01T12:00:00Z");
    const store = new InMemoryVerificationPolicyStore();
    const policy = new VerificationPolicy(store, provider(), () => now);
    const sms = await policy.startChallenge({
      userId: "user-1",
      purpose: "PASSWORD_RESET",
      method: "SMS",
      destination,
      destinationHash: "hash-1",
      destinationVersion: 2,
      tokenVersionAtIssue: 2,
      dimensions,
    });

    await expect(policy.switchChallengeMethod({
      challengeId: sms.id,
      userId: "user-1",
      purpose: "PASSWORD_RESET",
      method: "TOTP",
      destinationHash: "totp-hash",
      destinationVersion: 3,
      tokenVersionAtIssue: 3,
    })).rejects.toBeInstanceOf(VerificationRejectedError);
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
      allowAttemptControls,
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
      phonePrefixHash,
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

  it("rejects a malformed phone-prefix binding before provider delivery", async () => {
    const start = vi.fn(async () => ({ providerRef: "VE123" }));
    const policy = new VerificationPolicy(
      new InMemoryVerificationPolicyStore(),
      { start, async check() { return { matched: false }; } },
    );

    await expect(policy.startChallenge({
      userId: "user-1", purpose: "LOGIN", method: "SMS", destination,
      destinationHash: "a".repeat(64), destinationVersion: 1,
      dimensions: [`phone-prefix:not-a-hmac`, `account:${"b".repeat(64)}`],
    })).rejects.toThrow("Invalid phone-prefix rate-limit binding.");
    expect(start).not.toHaveBeenCalled();
  });

  it("persists a non-activating decoy when registration delivery fails", async () => {
    const store = new InMemoryVerificationPolicyStore();
    const policy = new VerificationPolicy(store, {
      async start() { throw new VerificationProviderError(); },
      async check() { return { matched: false }; },
    }, () => new Date("2026-09-01T12:00:00Z"));

    const result = await policy.startChallenge({
      userId: "user-1", purpose: "REGISTRATION", method: "SMS", destination,
      destinationHash: "hash-1", destinationVersion: 1, tokenVersionAtIssue: 0,
      dimensions, decoyOnDeliveryFailure: true,
    });

    expect(result).toEqual({
      id: expect.any(String),
      expiresAt: new Date("2026-09-01T12:10:00Z"),
      dispatched: false,
    });
    await expect(store.getChallenge(result.id)).resolves.toMatchObject({
      userId: "user-1", purpose: "REGISTRATION", providerRef: "decoy",
      phonePrefixHash,
      consumedAt: null, invalidatedAt: null,
    });
  });

  it("replaces a registration challenge with a decoy when resend delivery fails", async () => {
    const store = new InMemoryVerificationPolicyStore();
    let now = new Date("2026-09-01T12:00:00Z");
    let sends = 0;
    const policy = new VerificationPolicy(store, {
      async start() {
        sends += 1;
        if (sends > 1) throw new VerificationProviderError();
        return { providerRef: "VE123" };
      },
      async check() { return { matched: false }; },
    }, () => now);
    const base = {
      userId: "user-1", purpose: "REGISTRATION" as const, method: "SMS" as const, destination,
      destinationHash: "hash-1", destinationVersion: 1, tokenVersionAtIssue: 0,
      dimensions,
    };
    const original = await policy.startChallenge(base);
    now = new Date("2026-09-01T12:00:31Z");

    const replacement = await policy.resendChallenge({
      ...base, previousChallengeId: original.id, decoyOnDeliveryFailure: true,
    });

    expect(replacement).toEqual({
      id: expect.any(String),
      expiresAt: new Date("2026-09-01T12:10:31Z"),
      dispatched: false,
    });
    await expect(store.getChallenge(original.id)).resolves.toMatchObject({ invalidatedAt: expect.any(Date) });
    await expect(store.getChallenge(replacement.id)).resolves.toMatchObject({
      userId: "user-1", providerRef: "decoy", consumedAt: null, invalidatedAt: null,
    });
  });

  it("accepts only an issued reservation receipt covering the exact provider delivery", async () => {
    const now = new Date("2026-09-01T12:00:00Z");
    const accountHash = "b".repeat(64);
    const phoneHash = "a".repeat(64);
    const ipHash = "c".repeat(64);
    const reserved = await createVerificationBudgetConsumer(new InMemoryVerificationRateLimitStore())({
      action: "LOGIN", phoneHash, phonePrefixHash, accountHash, ipHash, now,
    });
    expect(reserved.allowed).toBe(true);
    if (!reserved.allowed) throw new Error("expected reservation");
    const start = vi.fn(async () => ({ providerRef: "VE123" }));
    const store = new InMemoryVerificationPolicyStore();
    const policy = new VerificationPolicy(store, { start, async check() { return { matched: false }; } }, () => now);
    const base = {
      userId: "user-1", purpose: "LOGIN" as const, method: "SMS" as const, destination,
      destinationHash: phoneHash, destinationVersion: 1,
      dimensions: [`account:${accountHash}`, `ip:${ipHash}`, `phone-prefix:${phonePrefixHash}`],
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
      action: "LOGIN", phoneHash, phonePrefixHash, accountHash, ipHash, now,
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
      dimensions: [`account:${accountHash}`, `ip:${ipHash}`, `phone-prefix:${phonePrefixHash}`],
    };
    const first = await consume({ action: "REGISTRATION", phoneHash, phonePrefixHash, accountHash, ipHash, now });
    if (!first.allowed) throw new Error("expected reservation");
    const original = await policy.startDecoySmsChallenge({ ...base, verificationBudgetReservation: first.reservation });

    now = new Date("2026-09-01T12:00:30Z");
    const second = await consume({ action: "REGISTRATION", phoneHash, phonePrefixHash, accountHash, ipHash, now });
    if (!second.allowed) throw new Error("expected reservation");
    await expect(policy.resendDecoySmsChallenge({
      ...base, previousChallengeId: original.id, verificationBudgetReservation: second.reservation,
    })).resolves.toEqual({ id: expect.any(String), expiresAt: new Date("2026-09-01T12:10:30Z") });
    expect(reserveSend).not.toHaveBeenCalled();
  });
});
