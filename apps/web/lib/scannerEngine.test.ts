import { describe, expect, it } from "vitest";
import { preferredScannerEngine } from "./scannerEngine";

describe("preferredScannerEngine", () => {
  it("uses the browser-native detector when retail barcode detection is supported", () => {
    expect(preferredScannerEngine(true)).toBe("native");
  });

  it("falls back to ZXing when native barcode detection is unavailable", () => {
    expect(preferredScannerEngine(false)).toBe("zxing");
  });
});
