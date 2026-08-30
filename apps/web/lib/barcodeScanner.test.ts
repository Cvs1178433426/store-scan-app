import { describe, expect, it } from "vitest";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { createScanHints, isQrScanFormat, symbologyFromScanFormat } from "./barcodeScanner";

// Guard hard-coded format mappings against library enum changes.
describe("barcodeScanner format constants vs @zxing/library", () => {
  it("maps BarcodeFormat enum values to the expected symbology", () => {
    expect(symbologyFromScanFormat(BarcodeFormat.EAN_13)).toBe("EAN13");
    expect(symbologyFromScanFormat(BarcodeFormat.UPC_A)).toBe("UPCA");
    expect(symbologyFromScanFormat(BarcodeFormat.CODE_128)).toBe("CODE128");
    expect(symbologyFromScanFormat(BarcodeFormat.QR_CODE)).toBe("QR");
    expect(symbologyFromScanFormat(BarcodeFormat.EAN_8)).toBe("OTHER");
    expect(symbologyFromScanFormat(BarcodeFormat.UPC_E)).toBe("OTHER");
  });

  it("detects QR via the library enum value", () => {
    expect(isQrScanFormat(BarcodeFormat.QR_CODE)).toBe(true);
    expect(isQrScanFormat(BarcodeFormat.EAN_13)).toBe(false);
  });

  it("enables aggressive decoding for live retail UPC/EAN camera scans", async () => {
    const hints = await createScanHints();
    expect(hints.get(DecodeHintType.TRY_HARDER)).toBe(true);
    expect(hints.get(DecodeHintType.POSSIBLE_FORMATS)).toEqual([
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A,
      BarcodeFormat.UPC_E,
      BarcodeFormat.CODE_128,
      BarcodeFormat.QR_CODE,
    ]);
  });
});
