import { describe, expect, it } from "vitest";
import { buildSummaryRows, type SummaryEntryInput } from "./storeCount.js";

describe("buildSummaryRows", () => {
  it("merges different barcodes that resolve to the same product", () => {
    const entries: SummaryEntryInput[] = [
      { productId: "prod_1", barcodeValue: "0001", quantity: 3, locationId: "loc_a", location: { code: "Z99" }, product: { name: "Widget", packageSize: "1ct" } },
      { productId: "prod_1", barcodeValue: "0002-case", quantity: 2, locationId: "loc_b", location: { code: "K10" }, product: { name: "Widget", packageSize: "1ct" } },
    ];
    const rows = buildSummaryRows(entries);
    expect(rows).toHaveLength(1);
    expect(rows[0].total).toBe(5);
    expect(rows[0].byLocation.loc_a.quantity).toBe(3);
    expect(rows[0].byLocation.loc_b.quantity).toBe(2);
  });

  it("keeps unidentified barcodes separate", () => {
    const entries: SummaryEntryInput[] = [
      { productId: null, barcodeValue: "9999", quantity: 1, locationId: "loc_a", location: { code: "Z99" }, product: null },
      { productId: null, barcodeValue: "8888", quantity: 1, locationId: "loc_a", location: { code: "Z99" }, product: null },
    ];
    expect(buildSummaryRows(entries)).toHaveLength(2);
  });

  it("accumulates quantities at the same location", () => {
    const entries: SummaryEntryInput[] = [
      { productId: "prod_1", barcodeValue: "0001", quantity: 2, locationId: "loc_a", location: { code: "Z99" }, product: { name: "Widget", packageSize: null } },
      { productId: "prod_1", barcodeValue: "0001", quantity: 1, locationId: "loc_a", location: { code: "Z99" }, product: { name: "Widget", packageSize: null } },
    ];
    expect(buildSummaryRows(entries)[0].byLocation.loc_a.quantity).toBe(3);
  });

  it("sorts by product name", () => {
    const entries: SummaryEntryInput[] = [
      { productId: "prod_z", barcodeValue: "z", quantity: 1, locationId: "loc_a", location: { code: "Z99" }, product: { name: "Zebra Snacks", packageSize: null } },
      { productId: "prod_a", barcodeValue: "a", quantity: 1, locationId: "loc_a", location: { code: "Z99" }, product: { name: "Apple Juice", packageSize: null } },
    ];
    expect(buildSummaryRows(entries).map((row) => row.productName)).toEqual(["Apple Juice", "Zebra Snacks"]);
  });

  it("returns an empty array for an empty session", () => {
    expect(buildSummaryRows([])).toEqual([]);
  });
});
