import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCountQueueForSession,
  clearCountQueue,
  createCountScanId,
  enqueueCountScan,
  getCountQueue,
  getFailedCountQueue,
  getPendingCountQueue,
  markCountScanFailed,
  removeFromCountQueue,
  retryFailedCountScan,
} from "./storeCountQueue";

describe("storeCountQueue", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts empty", () => {
    expect(getCountQueue()).toEqual([]);
  });

  it("enqueues a count scan with a stable retry id", () => {
    const id = createCountScanId();
    const returned = enqueueCountScan(
      { ownerUserId: "user-a", sessionId: "s1", locationId: "l1", barcodeValue: "123", quantityDelta: 1 },
      id,
    );

    expect(returned).toBe(id);
    expect(getCountQueue()).toHaveLength(1);
    expect(getCountQueue()[0]).toMatchObject({
      id,
      ownerUserId: "user-a",
      sessionId: "s1",
      locationId: "l1",
      barcodeValue: "123",
      quantityDelta: 1,
      status: "pending",
    });
  });

  it("does not duplicate one physical scan when the same retry id is enqueued twice", () => {
    const id = createCountScanId();
    const scan = { ownerUserId: "user-a", sessionId: "s1", locationId: "l1", barcodeValue: "123", quantityDelta: 1 };
    enqueueCountScan(scan, id);
    enqueueCountScan(scan, id);

    expect(getCountQueue()).toHaveLength(1);
    expect(getCountQueue()[0].id).toBe(id);
  });

  it("generates distinct ids for separate physical scans", () => {
    const first = enqueueCountScan({ ownerUserId: "user-a", sessionId: "s1", locationId: "l1", barcodeValue: "123", quantityDelta: 1 });
    const second = enqueueCountScan({ ownerUserId: "user-a", sessionId: "s1", locationId: "l1", barcodeValue: "123", quantityDelta: 1 });
    expect(first).not.toBe(second);
  });

  it("preserves a permanently failed scan for reconciliation instead of deleting it", () => {
    const id = enqueueCountScan({ ownerUserId: "user-a", sessionId: "s1", locationId: "l1", barcodeValue: "123", quantityDelta: 1 });
    markCountScanFailed(id, "Count session is no longer active");

    expect(getPendingCountQueue()).toHaveLength(0);
    expect(getFailedCountQueue()).toHaveLength(1);
    expect(getFailedCountQueue()[0]).toMatchObject({
      id,
      status: "failed",
      failureReason: "Count session is no longer active",
    });
  });

  it("can explicitly retry a failed scan without changing its stable id", () => {
    const id = enqueueCountScan({ ownerUserId: "user-a", sessionId: "s1", locationId: "l1", barcodeValue: "123", quantityDelta: 1 });
    markCountScanFailed(id, "Temporary admin correction required");
    retryFailedCountScan(id);

    expect(getFailedCountQueue()).toHaveLength(0);
    expect(getPendingCountQueue()).toHaveLength(1);
    expect(getPendingCountQueue()[0]).toMatchObject({ id, status: "pending" });
  });

  it("refuses to auto-sync ownerless historical queue rows", () => {
    localStorage.setItem("continuixai_count_queue", JSON.stringify([{
      id: "historical-1",
      sessionId: "s1",
      locationId: "l1",
      barcodeValue: "123",
      quantityDelta: 1,
      queuedAt: 123,
    }]));

    expect(getPendingCountQueue("user-a")).toHaveLength(0);
    expect(getFailedCountQueue()).toHaveLength(1);
    expect(getFailedCountQueue()[0].failureReason).toContain("manual reconciliation");
  });


  it("migrates the pre-rebrand queue without auto-attributing it to the next user", () => {
    const legacyKey = ["store", "scan", "count", "queue"].join("_");
    localStorage.setItem(legacyKey, JSON.stringify([{
      id: "legacy-1",
      sessionId: "s1",
      locationId: "l1",
      barcodeValue: "123",
      quantityDelta: 1,
      queuedAt: 123,
    }]));

    expect(getPendingCountQueue("user-a")).toHaveLength(0);
    expect(getFailedCountQueue()).toHaveLength(1);
    expect(localStorage.getItem(legacyKey)).toBeNull();
    expect(localStorage.getItem("continuixai_count_queue")).not.toBeNull();
  });

  it("removes only the requested queued scan", () => {
    const first = enqueueCountScan({ ownerUserId: "user-a", sessionId: "s1", locationId: "l1", barcodeValue: "123", quantityDelta: 1 });
    const second = enqueueCountScan({ ownerUserId: "user-a", sessionId: "s1", locationId: "l1", barcodeValue: "456", quantityDelta: 1 });
    removeFromCountQueue(first);
    expect(getCountQueue()).toHaveLength(1);
    expect(getCountQueue()[0].id).toBe(second);
  });

  it("clears only the current employee's scans for a cancelled session", () => {
    enqueueCountScan({ ownerUserId: "user-a", sessionId: "s1", locationId: "l1", barcodeValue: "123", quantityDelta: 1 });
    enqueueCountScan({ ownerUserId: "user-b", sessionId: "s1", locationId: "l1", barcodeValue: "999", quantityDelta: 1 });
    enqueueCountScan({ ownerUserId: "user-a", sessionId: "s2", locationId: "l1", barcodeValue: "456", quantityDelta: 1 });
    clearCountQueueForSession("s1", "user-a");
    expect(getCountQueue()).toHaveLength(2);
    expect(getCountQueue().some((entry) => entry.ownerUserId === "user-b" && entry.sessionId === "s1")).toBe(true);
    expect(getCountQueue().some((entry) => entry.ownerUserId === "user-a" && entry.sessionId === "s2")).toBe(true);
  });

  it("recovers from corrupted local storage", () => {
    localStorage.setItem("continuixai_count_queue", "{bad json");
    expect(getCountQueue()).toEqual([]);
  });


  it("never returns another employee's queued scans for automatic replay", () => {
    enqueueCountScan({ ownerUserId: "user-a", sessionId: "s1", locationId: "l1", barcodeValue: "123", quantityDelta: 1 });
    enqueueCountScan({ ownerUserId: "user-b", sessionId: "s2", locationId: "l2", barcodeValue: "456", quantityDelta: 1 });
    expect(getPendingCountQueue("user-a")).toHaveLength(1);
    expect(getPendingCountQueue("user-a")[0].ownerUserId).toBe("user-a");
  });

  it("supports an explicit administrative purge when intentionally requested", () => {
    enqueueCountScan({ ownerUserId: "user-a", sessionId: "s1", locationId: "l1", barcodeValue: "123", quantityDelta: 1 });
    clearCountQueue();
    expect(getCountQueue()).toEqual([]);
  });
});
