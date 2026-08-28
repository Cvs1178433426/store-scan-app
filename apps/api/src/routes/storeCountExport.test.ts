import { describe, expect, it } from "vitest";
import { parseCsv } from "../lib/csv.js";
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

    const parsed = parseCsv(csv);
    expect(parsed).toHaveLength(3);
    const header = parsed[0];
    const dataRows = parsed.slice(1);
    const index = (name: string) => {
      const column = header.indexOf(name);
      expect(column).toBeGreaterThanOrEqual(0);
      return column;
    };

    const sessionName = index("session_name");
    const upc = index("upc");
    const description = index("description");
    const locationName = index("location_name");
    const quantity = index("quantity");
    const exception = index("exception");

    expect(dataRows[0][sessionName]).toBe("Aisle 1, Final");
    expect(dataRows[0][locationName]).toBe("Front, Shelf");
    expect(dataRows[0][description]).toBe('Widget "Large"');
    expect(dataRows[0][upc]).toBe("012345678905");
    expect(Number(dataRows[0][quantity])).toBe(7);

    expect(dataRows[1][upc]).toBe("999999999999");
    expect(Number(dataRows[1][quantity])).toBe(3);
    expect(dataRows[1][exception]).toBe("UNKNOWN_UPC");

    const exportedQuantities = dataRows.map((row) => Number(row[quantity]));
    expect(exportedQuantities.reduce((sum, value) => sum + value, 0)).toBe(10);
  });
});
