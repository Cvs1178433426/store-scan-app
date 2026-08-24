import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCountQueueForSession,
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
      { sessionId: "s1", locationId: "l1", barcodeValue: "123", quantityDelta: 1 },
      id,
    );

    expect(returned).toBe(id);
    expect(getCountQueue()).toHaveLength(1);
    expect(getCountQueue()[0]).toMatchObject({
      id,
      sessionId: "s1",
      locationId: "l1",
      barcodeValue: "123",
      quantityDelta: 1,
      status: "pending",
    });
  });

  it("does not duplicate one physical scan when the same retry id is enqueued twice", () => {
    const id = createCountScanId();
    const scan = { sessionId: "s1", locationId: "l1", barcodeValue: "123", quantityDelta: 1 };
    enqueueCountScan(scan, id);
    enqueueCountScan(scan, id);

    expect(getCountQueue()).toHaveLength(1);
    expect(getCountQueue()[0].id).toBe(id);
  });

  it("generates distinct ids for separate physical scans", () => {
    const first = enqueueCountScan({ sessionId: "s1", locationId: "l1", barcodeValue: "123", quantityDelta: 1 });
    const second = enqueueCountScan({ sessionId: "s1", locationId: "l1", barcodeValue: "123", quantityDelta: 1 });
    expect(first).not.toBe(second);
  });

  it("preserves a permanently failed scan for reconciliation instead of deleting it", () => {
    const id = enqueueCountScan({ sessionId: "s1", locationId: "l1", barcodeValue: "123", quantityDelta: 1 });
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
    const id = enqueueCountScan({ sessionId: "s1", locationId: "l1", barcodeValue: "123", quantityDelta: 1 });
    markCountScanFailed(id, "Temporary admin correction required");
    retryFailedCountScan(id);

    expect(getFailedCountQueue()).toHaveLength(0);
    expect(getPendingCountQueue()).toHaveLength(1);
    expect(getPendingCountQueue()[0]).toMatchObject({ id, status: "pending" });
  });

  it("treats legacy queue rows with no status as pending", () => {
    localStorage.setItem("store_scan_count_queue", JSON.stringify([{
      id: "legacy-1",
      sessionId: "s1",
      locationId: "l1",
      barcodeValue: "123",
      quantityDelta: 1,
      queuedAt: 123,
    }]));

    expect(getPendingCountQueue()).toHaveLength(1);
    expect(getPendingCountQueue()[0].status).toBe("pending");
  });

  it("removes only the requested queued scan", () => {
    const first = enqueueCountScan({ sessionId: "s1", locationId: "l1", barcodeValue: "123", quantityDelta: 1 });
    const second = enqueueCountScan({ sessionId: "s1", locationId: "l1", barcodeValue: "456", quantityDelta: 1 });
    removeFromCountQueue(first);
    expect(getCountQueue()).toHaveLength(1);
    expect(getCountQueue()[0].id).toBe(second);
  });

  it("clears only scans belonging to a cancelled session", () => {
    enqueueCountScan({ sessionId: "s1", locationId: "l1", barcodeValue: "123", quantityDelta: 1 });
    enqueueCountScan({ sessionId: "s2", locationId: "l1", barcodeValue: "456", quantityDelta: 1 });
    clearCountQueueForSession("s1");
    expect(getCountQueue()).toHaveLength(1);
    expect(getCountQueue()[0].sessionId).toBe("s2");
  });

  it("recovers from corrupted local storage", () => {
    localStorage.setItem("store_scan_count_queue", "{bad json");
    expect(getCountQueue()).toEqual([]);
  });
});
