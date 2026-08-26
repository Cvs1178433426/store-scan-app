import { describe, expect, it } from "vitest";
import { buildSummaryRows, type SummaryEntryInput } from "./storeCount.js";
import { buildStoreCountCsv, type StoreCountExportEntry } from "./storeCountExport.js";

describe("Store Count aggregation and CSV pure-function consistency", () => {
  it("keeps store totals, location totals, unknown UPC exceptions, and CSV quantities consistent", () => {
    const summaryEntries: SummaryEntryInput[] = [
      {
        productId: "prod-a",
        barcodeValue: "012345678905",
        quantity: 4,
        locationId: "front",
        location: { code: "FRONT" },
        product: { name: "Known Item", packageSize: "12 oz" },
      },
      {
        productId: "prod-a",
        barcodeValue: "012345678905",
        quantity: 6,
        locationId: "back",
        location: { code: "BACK" },
        product: { name: "Known Item", packageSize: "12 oz" },
      },
      {
        productId: null,
        barcodeValue: "999999999999",
        quantity: 2,
        locationId: "front",
        location: { code: "FRONT" },
        product: null,
      },
      {
        productId: null,
        barcodeValue: "999999999999",
        quantity: 3,
        locationId: "back",
        location: { code: "BACK" },
        product: null,
      },
    ];

    const rows = buildSummaryRows(summaryEntries);
    expect(rows).toHaveLength(2);

    const known = rows.find((row) => row.productId === "prod-a");
    const unknown = rows.find((row) => row.productId === null);

    expect(known?.total).toBe(10);
    expect(known?.byLocation.front.quantity).toBe(4);
    expect(known?.byLocation.back.quantity).toBe(6);
    expect(unknown?.total).toBe(5);
    expect(unknown?.byLocation.front.quantity).toBe(2);
    expect(unknown?.byLocation.back.quantity).toBe(3);

    const startedAt = new Date("2026-08-25T20:00:00.000Z");
    const completedAt = new Date("2026-08-25T20:30:00.000Z");
    const exportEntries: StoreCountExportEntry[] = [
      {
        barcodeValue: "012345678905",
        quantity: 4,
        scannedAt: startedAt,
        updatedAt: startedAt,
        location: { code: "FRONT", name: "Front" },
        product: { name: "Known Item", manufacturer: "Maker", packageSize: "12 oz" },
      },
      {
        barcodeValue: "012345678905",
        quantity: 6,
        scannedAt: startedAt,
        updatedAt: startedAt,
        location: { code: "BACK", name: "Back" },
        product: { name: "Known Item", manufacturer: "Maker", packageSize: "12 oz" },
      },
      {
        barcodeValue: "999999999999",
        quantity: 2,
        scannedAt: startedAt,
        updatedAt: startedAt,
        location: { code: "FRONT", name: "Front" },
        product: null,
      },
      {
        barcodeValue: "999999999999",
        quantity: 3,
        scannedAt: startedAt,
        updatedAt: startedAt,
        location: { code: "BACK", name: "Back" },
        product: null,
      },
    ];

    const csv = buildStoreCountCsv({
      session: {
        id: "session-unit",
        name: "Pilot Count",
        status: "COMPLETED",
        startedAt,
        completedAt,
        startedBy: { id: "counter-1", name: "Counter One", email: "counter@example.com" },
        site: { id: "site-1", code: "STORE-1", name: "Pilot Store" },
      },
      entries: exportEntries,
    });

    expect(csv.match(/UNKNOWN_UPC/g)).toHaveLength(2);
    expect(csv).toContain('"FRONT"');
    expect(csv).toContain('"BACK"');

    const quantities = csv
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => {
        const cells = line.match(/(?:^|,)("(?:[^"]|"")*")/g) ?? [];
        return Number(cells[13]?.replace(/^,?"|"$/g, ""));
      });

    expect(quantities).toEqual([4, 6, 2, 3]);
    expect(quantities.reduce((sum, value) => sum + value, 0)).toBe(15);
    expect(rows.reduce((sum, row) => sum + row.total, 0)).toBe(15);
  });

  it("neutralizes spreadsheet formula prefixes in exported text", () => {
    const when = new Date("2026-08-25T20:00:00.000Z");
    const csv = buildStoreCountCsv({
      session: {
        id: "session-formula",
        name: "Pilot Count",
        status: "COMPLETED",
        startedAt: when,
        completedAt: when,
        startedBy: { id: "counter-1", name: "Counter One", email: "counter@example.com" },
        site: { id: "site-1", code: "STORE-1", name: "Pilot Store" },
      },
      entries: [
        {
          barcodeValue: "012345678905",
          quantity: 1,
          scannedAt: when,
          updatedAt: when,
          location: { code: "FRONT", name: "Front" },
          product: { name: "=SUM(A1:A10)", manufacturer: "+cmd", packageSize: "@danger" },
        },
      ],
    });

    expect(csv).toContain("'=SUM(A1:A10)");
    expect(csv).toContain("'+cmd");
    expect(csv).toContain("'@danger");
  });
});
