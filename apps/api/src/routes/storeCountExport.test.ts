import { describe, expect, it } from "vitest";
import { buildStoreCountCsv } from "./storeCountExport.js";

describe("buildStoreCountCsv", () => {
  it("exports persisted quantities, metadata, unknown UPCs, and escaped text", () => {
    const startedAt = new Date("2026-08-25T12:00:00.000Z");
    const completedAt = new Date("2026-08-25T12:30:00.000Z");
    const csv = buildStoreCountCsv({
      session: {
        id: "session-1",
        name: "Aisle 1, Final",
        status: "COMPLETED",
        startedAt,
        completedAt,
        startedBy: { id: "user-1", name: "Counter One", email: "counter@example.com" },
        site: { id: "site-1", code: "S001", name: "Test Store" },
      },
      entries: [
        {
          barcodeValue: "012345678905",
          quantity: 7,
          scannedAt: new Date("2026-08-25T12:05:00.000Z"),
          updatedAt: new Date("2026-08-25T12:06:00.000Z"),
          location: { code: "A1", name: "Front, Shelf" },
          product: { name: "Widget \"Large\"", manufacturer: "Acme", packageSize: "12 oz" },
        },
        {
          barcodeValue: "999999999999",
          quantity: 3,
          scannedAt: new Date("2026-08-25T12:10:00.000Z"),
          updatedAt: new Date("2026-08-25T12:10:00.000Z"),
          location: { code: "A2", name: null },
          product: null,
        },
      ],
    });

    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('"quantity"');
    expect(lines[1]).toContain('"Aisle 1, Final"');
    expect(lines[1]).toContain('"Front, Shelf"');
    expect(lines[1]).toContain('"Widget ""Large"""');
    expect(lines[1]).toContain('"7"');
    expect(lines[2]).toContain('"999999999999"');
    expect(lines[2]).toContain('"3"');
    expect(lines[2]).toContain('"UNKNOWN_UPC"');

    const exportedQuantities = lines.slice(1).map((line) => {
      const cells = line.match(/(?:^|,)("(?:[^"]|"")*")/g) ?? [];
      const quantityCell = cells[13]?.replace(/^,?"|"$/g, "");
      return Number(quantityCell);
    });
    expect(exportedQuantities.reduce((sum, value) => sum + value, 0)).toBe(10);
  });
});
