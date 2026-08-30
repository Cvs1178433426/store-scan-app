import { describe, expect, it } from "vitest";
import { preferredScannerEngine, retailDecodeConfig, shouldEmitRetailScan } from "./scannerEngine";

describe("retail scanner engine", () => {
  it("uses Quagga when the retail scanner is available and ZXing only as fallback", () => {
    expect(preferredScannerEngine(true)).toBe("quagga");
    expect(preferredScannerEngine(false)).toBe("zxing");
  });

  it("limits decoding to the retail formats used by store products", () => {
    const config = retailDecodeConfig("data:image/jpeg;base64,frame") as {
      locate: boolean;
      decoder: { readers: string[] };
    };
    expect(config.locate).toBe(true);
    expect(config.decoder.readers).toEqual([
      "upc_reader",
      "ean_reader",
      "ean_8_reader",
      "upc_e_reader",
      "code_128_reader",
    ]);
  });

  it("suppresses repeated reads of the same barcode until the quiet period passes", () => {
    expect(shouldEmitRetailScan("123456789012", null, 1000)).toBe(true);
    expect(shouldEmitRetailScan("123456789012", { value: "123456789012", at: 1000 }, 1500)).toBe(false);
    expect(shouldEmitRetailScan("123456789012", { value: "123456789012", at: 1000 }, 2300)).toBe(true);
    expect(shouldEmitRetailScan("999999999999", { value: "123456789012", at: 1000 }, 1100)).toBe(true);
  });
});
