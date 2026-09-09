import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryRegistrationRepository,
  RegistrationService,
  type RegistrationChallengePolicy,
} from "./registrationService.js";

process.env.PHONE_ENCRYPTION_KEYS = `1:${"11".repeat(32)}`;
process.env.PHONE_LOOKUP_HMAC_KEYS = `1:${"22".repeat(32)}`;
process.env.RATE_LIMIT_HMAC_KEY = "rate-limit-test-key";
process.env.SMS_MFA_BOOTSTRAP_ADMIN_EMAIL = "mitchell.kobran@continuixai.com";
process.env.SMS_MFA_BOOTSTRAP_ADMIN_PHONE = "+16317423355";

const phoneA = "+16317423355";
const phoneB = "+15615551234";
const allowedBudget = async () => ({ allowed: true, retryAfterSeconds: 0 });

function policy(): RegistrationChallengePolicy & {
  queuedStarts: Array<{ userId: string | null; destinationHash: string; dimensions: string[] }>;
  replacements: string[];
  queueSmsChallenge(input: Parameters<RegistrationChallengePolicy["queueSmsChallenge"]>[0]): Promise<{ id: string; expiresAt: Date }>;
  queueSmsResend(input: Parameters<RegistrationChallengePolicy["queueSmsResend"]>[0]): Promise<{ id: string; expiresAt: Date }>;
} {
  return {
    queuedStarts: [],
    replacements: [],
    async queueSmsChallenge(input) {
      this.queuedStarts.push({ userId: input.userId, destinationHash: input.destinationHash, dimensions: input.dimensions });
      return { id: `queued-${this.queuedStarts.length}`, expiresAt: new Date("2026-09-01T12:10:00Z") };
    },
    async queueSmsResend(input) {
      this.replacements.push(input.previousChallengeId);
      this.queuedStarts.push({ userId: input.userId, destinationHash: input.destinationHash, dimensions: input.dimensions });
      return { id: `queued-${this.queuedStarts.length}`, expiresAt: new Date("2026-09-01T12:10:00Z") };
    },
    async checkChallenge() { return { approved: true }; },
    async completeChallenge(input, completeAtomically) {
      return { approved: true, value: await completeAtomically(input.challengeId, new Date("2026-09-01T12:00:00Z"), input.tokenVersionAtIssue ?? null) };
    },
  };
}

describe("pending SMS registration", () => {
  it("creates an inactive pending user and starts verification", async () => {
    const repository = new InMemoryRegistrationRepository();
    const challengePolicy = policy();
    const service = new RegistrationService(repository, challengePolicy, allowedBudget);
    const result = await service.start({ name: "Mitchell Kobran", email: "Mitchell.Kobran@ContinuiXAi.com", phone: phoneA, passwordHash: "hash", consentVersion: "2026-09-01", dimensions: ["ip:hash"] });
    expect(result.dispatched).toBe(false);
    const user = repository.users[0];
    expect(user.email).toBe("mitchell.kobran@continuixai.com");
    expect(user.accountStatus).toBe("PENDING_PHONE_VERIFICATION");
    expect(user.isActive).toBe(false);
    expect(user.tokenVersion).toBe(0);
    expect(challengePolicy.queuedStarts).toHaveLength(1);
  });

  it("queues provider delivery and keeps the account inactive until approval", async () => {
    const repository = new InMemoryRegistrationRepository();
    const challengePolicy = policy();
    const service = new RegistrationService(repository, challengePolicy, allowedBudget);

    const result = await service.start({
      name: "Mitchell", email: "mitchell@continuixai.com", phone: phoneA,
      passwordHash: "hash", consentVersion: "v1", dimensions: ["ip:hash"],
    });

    expect(result).toEqual({
      dispatched: false,
      userId: repository.users[0].id,
      challengeId: "queued-1",
      maskedDestination: "(***) ***-3355",
    });
    expect(repository.users[0]).toMatchObject({
      accountStatus: "PENDING_PHONE_VERIFICATION", isActive: false,
    });
    expect(challengePolicy.queuedStarts).toHaveLength(1);
  });

  it("resumes only an exact email and phone match", async () => {
    const repository = new InMemoryRegistrationRepository();
    const challengePolicy = policy();
    const service = new RegistrationService(repository, challengePolicy, allowedBudget);
    const first = { name: "Mitchell", email: "mitchell@continuixai.com", phone: phoneA, passwordHash: "hash", consentVersion: "v1", dimensions: ["ip:hash"] };
    await service.start(first);
    await expect(service.start(first)).resolves.toMatchObject({ dispatched: false });
    await expect(service.start({ ...first, phone: phoneB })).resolves.toMatchObject({ dispatched: false, challengeId: "queued-3" });
    expect(challengePolicy.queuedStarts.at(-1)).toMatchObject({ userId: null });
    expect(repository.users).toHaveLength(1);
    expect(repository.users[0].phoneE164).toBe(phoneA);
  });

  it("rejects a phone match with a different email without revealing the conflict", async () => {
    const repository = new InMemoryRegistrationRepository();
    const challengePolicy = policy();
    const service = new RegistrationService(repository, challengePolicy, allowedBudget);
    const first = { name: "Mitchell", email: "mitchell@continuixai.com", phone: phoneA, passwordHash: "hash", consentVersion: "v1", dimensions: ["ip:hash"] };
    await service.start(first);
    await expect(service.start({ ...first, email: "attacker@continuixai.com" })).resolves.toMatchObject({ dispatched: false });
    expect(repository.users).toHaveLength(1);
  });

  it("rejects a phone stored under an older lookup key during rotation", async () => {
    const repository = new InMemoryRegistrationRepository();
    const challengePolicy = policy();
    const service = new RegistrationService(repository, challengePolicy, allowedBudget);
    const originalKeys = process.env.PHONE_LOOKUP_HMAC_KEYS;
    try {
      process.env.PHONE_LOOKUP_HMAC_KEYS = `1:${"22".repeat(32)}`;
      const initial = await service.start({
        name: "Existing", email: "existing@continuixai.com", phone: phoneA,
        passwordHash: "hash", consentVersion: "v1", dimensions: ["ip:hash"],
      });
      const storedHash = repository.users[0].phoneLookupHash;

      process.env.PHONE_LOOKUP_HMAC_KEYS = `2:${"33".repeat(32)},1:${"22".repeat(32)}`;
      const resumed = await service.start({
        name: "Existing", email: "existing@continuixai.com", phone: phoneA,
        passwordHash: "hash", consentVersion: "v1", dimensions: ["ip:hash"],
      });
      expect(resumed).toMatchObject({ dispatched: false, userId: initial.userId });
      expect(challengePolicy.queuedStarts.at(-1)?.destinationHash).toBe(storedHash);
      await expect(service.approve({
        challengeId: resumed.challengeId, userId: resumed.userId!, code: "123456",
      })).resolves.toMatchObject({
        user: { accountStatus: "ACTIVE" },
        backupCodes: expect.arrayContaining([expect.stringMatching(/^[A-Z0-9]{10}$/)]),
      });
      await expect(service.start({
        name: "Attacker", email: "attacker@continuixai.com", phone: phoneA,
        passwordHash: "hash", consentVersion: "v1", dimensions: ["ip:hash"],
      })).resolves.toMatchObject({ dispatched: false, challengeId: "queued-3" });
      expect(repository.users).toHaveLength(1);
    } finally {
      if (originalKeys === undefined) delete process.env.PHONE_LOOKUP_HMAC_KEYS;
      else process.env.PHONE_LOOKUP_HMAC_KEYS = originalKeys;
    }
  });

  it("converts a concurrent unique conflict into the same decoy response", async () => {
    const repository = new InMemoryRegistrationRepository();
    repository.createPending = vi.fn(async () => {
      throw Object.assign(new Error("unique conflict"), { code: "P2002" });
    });
    const challengePolicy = policy();
    const service = new RegistrationService(repository, challengePolicy, allowedBudget);

    await expect(service.start({
      name: "Concurrent", email: "concurrent@continuixai.com", phone: phoneA,
      passwordHash: "hash", consentVersion: "v1", dimensions: ["ip:hash"],
    })).resolves.toEqual({ dispatched: false, challengeId: "queued-1" });
    expect(challengePolicy.queuedStarts).toHaveLength(1);
    expect(challengePolicy.queuedStarts[0].userId).toBeNull();
  });

  it("reserves first-admin ownership for the configured email and verified phone", async () => {
    const repository = new InMemoryRegistrationRepository();
    const challengePolicy = policy();
    const service = new RegistrationService(repository, challengePolicy, allowedBudget);
    const first = await service.start({ name: "Unapproved", email: "attacker@continuixai.com", phone: phoneB, passwordHash: "hash", consentVersion: "v1", dimensions: ["ip:a"] });
    const second = await service.start({ name: "Mitchell", email: "mitchell.kobran@continuixai.com", phone: phoneA, passwordHash: "hash", consentVersion: "v1", dimensions: ["ip:b"] });
    const [a, b] = await Promise.all([
      service.approve({ challengeId: first.challengeId!, userId: first.userId!, code: "123456" }),
      service.approve({ challengeId: second.challengeId!, userId: second.userId!, code: "123456" }),
    ]);
    expect(a.user.role).toBe("GENERAL");
    expect(b.user.role).toBe("ADMIN");
    expect(a.backupCodes).toHaveLength(8);
    expect(b.backupCodes).toHaveLength(8);
    expect(repository.users.every((user) => user.mfaBackupCodeHashes?.length === 8)).toBe(true);
    expect(repository.users.some((user) => user.mfaBackupCodeHashes?.includes(a.backupCodes[0]))).toBe(false);
    expect(repository.users.every((user) => user.accountStatus === "ACTIVE" && user.isActive)).toBe(true);
  });

  it("resends only for the same pending user and replaces the challenge", async () => {
    const repository = new InMemoryRegistrationRepository();
    const challengePolicy = policy();
    const service = new RegistrationService(repository, challengePolicy, allowedBudget);
    const started = await service.start({ name: "Mitchell", email: "mitchell@continuixai.com", phone: phoneA, passwordHash: "hash", consentVersion: "v1", dimensions: ["ip:hash"] });
    const resent = await service.resend(started.userId!, started.challengeId!, ["ip:hash"]);
    expect(resent.challengeId).not.toBe(started.challengeId);
    expect(challengePolicy.queuedStarts).toHaveLength(2);
    expect(challengePolicy.replacements).toEqual([started.challengeId]);
  });

  it("does not delete a user activated after expiration candidates were observed", async () => {
    const repository = new InMemoryRegistrationRepository();
    const challengePolicy = policy();
    const service = new RegistrationService(repository, challengePolicy, allowedBudget);
    const started = await service.start({ name: "Mitchell", email: "mitchell@continuixai.com", phone: phoneA, passwordHash: "hash", consentVersion: "v1", dimensions: ["ip:hash"] });
    const candidates = await repository.expiredCandidates(new Date("2099-01-01T00:00:00Z"));
    await service.approve({ challengeId: started.challengeId!, userId: started.userId!, code: "123456" });
    await repository.deleteExpiredCandidates(candidates);
    expect(repository.users).toHaveLength(1);
    expect(repository.users[0].accountStatus).toBe("ACTIVE");
  });

  it("consumes hashed phone, email-account, and IP budgets before account lookup", async () => {
    const repository = new InMemoryRegistrationRepository();
    const challengePolicy = policy();
    const consumeBudget = vi.fn(async () => ({ allowed: false, retryAfterSeconds: 30 }));
    const service = new RegistrationService(repository, challengePolicy, consumeBudget, () => new Date("2026-09-02T12:00:00Z"));

    await expect(service.start({
      name: "Mitchell", email: "Existing@ContinuixAI.com", phone: phoneA,
      passwordHash: "hash", consentVersion: "v1", dimensions: [`ip:${"a".repeat(64)}`],
    })).rejects.toMatchObject({
      message: "Too many verification requests. Please try again later.",
      retryAfter: 30,
    });

    expect(consumeBudget).toHaveBeenCalledWith({
      action: "REGISTRATION",
      phoneHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      phonePrefixHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      accountHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      ipHash: "a".repeat(64),
      now: new Date("2026-09-02T12:00:00Z"),
    });
    expect(repository.users).toHaveLength(0);
    expect(challengePolicy.queuedStarts).toHaveLength(0);
  });

  it("keeps the canonical email-account hash from reservation through provider delivery", async () => {
    const repository = new InMemoryRegistrationRepository();
    const challengePolicy = policy();
    const consumeBudget = vi.fn(allowedBudget);
    const service = new RegistrationService(repository, challengePolicy, consumeBudget);
    const accountHash = createHmac("sha256", "rate-limit-test-key").update("mitchell@continuixai.com").digest("hex");

    await service.start({
      name: "Mitchell", email: "Mitchell@ContinuixAI.com", phone: phoneA,
      passwordHash: "hash", consentVersion: "v1", dimensions: [`ip:${"a".repeat(64)}`],
    });

    expect(consumeBudget).toHaveBeenCalledWith(expect.objectContaining({ accountHash }));
    expect(challengePolicy.queuedStarts[0].dimensions).toContain(`account:${accountHash}`);
  });

  it("keeps the candidate account and phone-prefix bindings on conflict decoys", async () => {
    const repository = new InMemoryRegistrationRepository();
    const challengePolicy = policy();
    const service = new RegistrationService(repository, challengePolicy, allowedBudget);
    await service.start({
      name: "Mitchell", email: "mitchell@continuixai.com", phone: phoneA,
      passwordHash: "hash", consentVersion: "v1", dimensions: [`ip:${"a".repeat(64)}`],
    });

    await service.start({
      name: "Mitchell", email: "mitchell@continuixai.com", phone: phoneB,
      passwordHash: "hash", consentVersion: "v1", dimensions: [`ip:${"b".repeat(64)}`],
    });

    const accountHash = createHmac("sha256", "rate-limit-test-key").update("mitchell@continuixai.com").digest("hex");
    const prefixHash = createHmac("sha256", "rate-limit-test-key").update(phoneB.slice(0, 5)).digest("hex");
    expect(challengePolicy.queuedStarts).toHaveLength(2);
    expect(challengePolicy.queuedStarts[1].userId).toBeNull();
    expect(challengePolicy.queuedStarts[1].dimensions).toEqual(expect.arrayContaining([
      `account:${accountHash}`,
      `phone-prefix:${prefixHash}`,
    ]));
  });
});
