import { describe, expect, it, vi } from "vitest";
import { cleanupExpiredPhoneRecoveries } from "./phoneRecoveryCleanup.js";

describe("phone recovery cleanup", () => {
  it("passes one stable timestamp to the atomic repository cleanup", async () => {
    const repository = { expireOpenCases: vi.fn().mockResolvedValue(2) };
    const now = new Date("2026-09-07T14:00:00.000Z");

    await expect(cleanupExpiredPhoneRecoveries(repository, now)).resolves.toBe(2);
    expect(repository.expireOpenCases).toHaveBeenCalledOnce();
    expect(repository.expireOpenCases).toHaveBeenCalledWith(now);
  });
});
