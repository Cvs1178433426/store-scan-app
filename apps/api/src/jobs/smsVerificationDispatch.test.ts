import { describe, expect, it, vi } from "vitest";
import { cleanupExpiredMfaChallenges, createSerializedSmsDispatchRunner, dispatchPendingSmsVerifications } from "./smsVerificationDispatch.js";

describe("durable SMS verification dispatch", () => {
  it("claims a persisted job before provider delivery and records the provider reference", async () => {
    const order: string[] = [];
    const repository = {
      purgeExpired: vi.fn(async () => { order.push("purge"); return 0; }),
      claimPending: vi.fn(async () => {
        order.push("claim");
        return { challengeId: "challenge-1", leaseId: "lease-1", destination: "+16317423355" };
      }),
      beginSending: vi.fn(async () => { order.push("sending"); return true; }),
      markDelivered: vi.fn(async () => { order.push("delivered"); return true; }),
      markFailed: vi.fn(async () => { order.push("failed"); }),
      markAmbiguous: vi.fn(async () => { order.push("ambiguous"); }),
      releaseClaim: vi.fn(async () => { order.push("released"); }),
    };
    const provider = {
      start: vi.fn(async () => { order.push("provider"); return { providerRef: "VE123" }; }),
      check: vi.fn(),
    };

    await dispatchPendingSmsVerifications(repository, provider, vi.fn(async () => true), 1);

    expect(order).toEqual(["purge", "claim", "sending", "provider", "delivered"]);
    expect(repository.markDelivered).toHaveBeenCalledWith("challenge-1", "lease-1", "VE123");
    expect(repository.markAmbiguous).not.toHaveBeenCalled();
  });

  it("fails closed after a provider error and does not retry an already claimed delivery", async () => {
    const repository = {
      purgeExpired: vi.fn(async () => 0),
      claimPending: vi.fn()
        .mockResolvedValueOnce({ challengeId: "challenge-1", leaseId: "lease-1", destination: "+16317423355" })
        .mockResolvedValueOnce(null),
      beginSending: vi.fn(async () => true),
      markDelivered: vi.fn(),
      markFailed: vi.fn(async () => {}),
      markAmbiguous: vi.fn(async () => {}),
      releaseClaim: vi.fn(async () => {}),
    };
    const provider = { start: vi.fn(async () => { throw new Error("provider unavailable"); }), check: vi.fn() };

    await dispatchPendingSmsVerifications(repository, provider, vi.fn(async () => true), 5);

    expect(provider.start).toHaveBeenCalledTimes(1);
    expect(repository.markAmbiguous).toHaveBeenCalledWith("challenge-1", "lease-1");
    expect(repository.markDelivered).not.toHaveBeenCalled();
  });

  it("releases a pre-send claim when the durable provider-send breaker is full", async () => {
    const repository = {
      purgeExpired: vi.fn(async () => 0),
      claimPending: vi.fn(async () => ({ challengeId: "challenge-1", leaseId: "lease-1", destination: "+16317423355" })),
      beginSending: vi.fn(), markDelivered: vi.fn(), markFailed: vi.fn(), markAmbiguous: vi.fn(), releaseClaim: vi.fn(async () => {}),
    };
    const provider = { start: vi.fn(), check: vi.fn() };

    await dispatchPendingSmsVerifications(repository, provider, vi.fn(async () => false), 5);

    expect(repository.releaseClaim).toHaveBeenCalledWith("challenge-1", "lease-1");
    expect(repository.beginSending).not.toHaveBeenCalled();
    expect(provider.start).not.toHaveBeenCalled();
  });

  it("purges expired challenges before reading encrypted destinations", async () => {
    const repository = {
      purgeExpired: vi.fn(async () => 3), claimPending: vi.fn(async () => null), beginSending: vi.fn(),
      markDelivered: vi.fn(), markFailed: vi.fn(), markAmbiguous: vi.fn(), releaseClaim: vi.fn(),
    };
    await dispatchPendingSmsVerifications(repository, { start: vi.fn(), check: vi.fn() }, vi.fn(async () => true));
    expect(repository.purgeExpired).toHaveBeenCalledOnce();
    expect(repository.claimPending).toHaveBeenCalledOnce();
  });

  it("supports retention cleanup independently from SMS provider delivery", async () => {
    const repository = { purgeExpired: vi.fn(async () => 4) };
    const now = new Date("2026-09-06T14:00:00Z");
    await expect(cleanupExpiredMfaChallenges(repository, now)).resolves.toBe(4);
    expect(repository.purgeExpired).toHaveBeenCalledWith(now);
  });

  it("does not overlap scheduled dispatch cycles", async () => {
    let finish!: () => void;
    const cycle = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }))
      .mockResolvedValue(undefined);
    const run = createSerializedSmsDispatchRunner(cycle);

    const first = run();
    const second = run();
    expect(cycle).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([first, second]);
    await run();
    expect(cycle).toHaveBeenCalledTimes(2);
  });
});
