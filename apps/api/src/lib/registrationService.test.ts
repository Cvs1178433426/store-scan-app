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

const phoneA = "+16317423355";
const phoneB = "+15615551234";
const allowedBudget = async () => ({ allowed: true, retryAfterSeconds: 0 });

function policy(): RegistrationChallengePolicy & {
  starts: Array<{ userId: string; destinationHash: string; dimensions: string[] }>;
  replacements: string[];
} {
  return {
    starts: [],
    replacements: [],
    async startChallenge(input) {
      this.starts.push({ userId: input.userId!, destinationHash: input.destinationHash, dimensions: input.dimensions });
      return { id: `challenge-${this.starts.length}`, expiresAt: new Date("2026-09-01T12:10:00Z") };
    },
    async startDecoySmsChallenge() {
      return { id: "decoy-challenge", expiresAt: new Date("2026-09-01T12:10:00Z") };
    },
    async resendChallenge(input) {
      this.replacements.push(input.previousChallengeId);
      this.starts.push({ userId: input.userId!, destinationHash: input.destinationHash, dimensions: input.dimensions });
      return { id: `challenge-${this.starts.length}`, expiresAt: new Date("2026-09-01T12:10:00Z") };
    },
    async checkChallenge() { return { approved: true }; },
    async completeChallenge(input, completeAtomically) {
      return { approved: true, value: await completeAtomically(input.challengeId, new Date("2026-09-01T12:00:00Z")) };
    },
  };
}

describe("pending SMS registration", () => {
  it("creates an inactive pending user and starts verification", async () => {
    const repository = new InMemoryRegistrationRepository();
    const challengePolicy = policy();
    const service = new RegistrationService(repository, challengePolicy, allowedBudget);
    const result = await service.start({ name: "Mitchell Kobran", email: "Mitchell.Kobran@ContinuiXAi.com", phone: phoneA, passwordHash: "hash", consentVersion: "2026-09-01", dimensions: ["ip:hash"] });
    expect(result.dispatched).toBe(true);
    const user = repository.users[0];
    expect(user.email).toBe("mitchell.kobran@continuixai.com");
    expect(user.accountStatus).toBe("PENDING_PHONE_VERIFICATION");
    expect(user.isActive).toBe(false);
    expect(user.tokenVersion).toBe(0);
    expect(challengePolicy.starts).toHaveLength(1);
  });

  it("resumes only an exact email and phone match", async () => {
    const repository = new InMemoryRegistrationRepository();
    const challengePolicy = policy();
    const service = new RegistrationService(repository, challengePolicy, allowedBudget);
    const first = { name: "Mitchell", email: "mitchell@continuixai.com", phone: phoneA, passwordHash: "hash", consentVersion: "v1", dimensions: ["ip:hash"] };
    await service.start(first);
    await expect(service.start(first)).resolves.toMatchObject({ dispatched: true });
    await expect(service.start({ ...first, phone: phoneB })).resolves.toMatchObject({ dispatched: false, challengeId: "decoy-challenge" });
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

  it("activates an approved registration and assigns only one first admin", async () => {
    const repository = new InMemoryRegistrationRepository();
    const challengePolicy = policy();
    const service = new RegistrationService(repository, challengePolicy, allowedBudget);
    const first = await service.start({ name: "First", email: "first@continuixai.com", phone: phoneA, passwordHash: "hash", consentVersion: "v1", dimensions: ["ip:a"] });
    const second = await service.start({ name: "Second", email: "second@continuixai.com", phone: phoneB, passwordHash: "hash", consentVersion: "v1", dimensions: ["ip:b"] });
    const [a, b] = await Promise.all([
      service.approve({ challengeId: first.challengeId!, userId: first.userId!, code: "123456" }),
      service.approve({ challengeId: second.challengeId!, userId: second.userId!, code: "123456" }),
    ]);
    expect([a.role, b.role].filter((role) => role === "ADMIN")).toHaveLength(1);
    expect(repository.users.every((user) => user.accountStatus === "ACTIVE" && user.isActive)).toBe(true);
  });

  it("resends only for the same pending user and replaces the challenge", async () => {
    const repository = new InMemoryRegistrationRepository();
    const challengePolicy = policy();
    const service = new RegistrationService(repository, challengePolicy, allowedBudget);
    const started = await service.start({ name: "Mitchell", email: "mitchell@continuixai.com", phone: phoneA, passwordHash: "hash", consentVersion: "v1", dimensions: ["ip:hash"] });
    const resent = await service.resend(started.userId!, started.challengeId!, ["ip:hash"]);
    expect(resent.challengeId).not.toBe(started.challengeId);
    expect(challengePolicy.starts).toHaveLength(2);
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
      accountHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      ipHash: "a".repeat(64),
      now: new Date("2026-09-02T12:00:00Z"),
    });
    expect(repository.users).toHaveLength(0);
    expect(challengePolicy.starts).toHaveLength(0);
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
    expect(challengePolicy.starts[0].dimensions).toContain(`account:${accountHash}`);
  });
});
