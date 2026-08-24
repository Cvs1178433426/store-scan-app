import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCountQueueForSession,
  createCountScanId,
  enqueueCountScan,
  getCountQueue,
  removeFromCountQueue,
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
