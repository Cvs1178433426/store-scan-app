import { describe, expect, it, vi } from "vitest";
import { cleanupPendingRegistrations } from "./pendingRegistrationCleanup.js";

describe("pending registration cleanup", () => {
  it("deletes only candidates observed before the 24-hour cutoff", async () => {
    const candidates = [{ id: "pending-1", phoneVersion: 2 }];
    const repository = {
      expiredCandidates: vi.fn(async () => candidates),
      deleteExpiredCandidates: vi.fn(async () => undefined),
    };
    const now = new Date("2026-09-06T12:00:00.000Z");

    await cleanupPendingRegistrations(repository, now);

    expect(repository.expiredCandidates).toHaveBeenCalledWith(new Date("2026-09-05T12:00:00.000Z"));
    expect(repository.deleteExpiredCandidates).toHaveBeenCalledWith(candidates);
  });
});
