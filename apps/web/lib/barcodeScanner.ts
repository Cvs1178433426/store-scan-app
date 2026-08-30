import type { BarcodeSymbology } from "./types";

const FORMAT_EAN_13 = 7;
const FORMAT_UPC_A = 14;
const FORMAT_CODE_128 = 4;
const FORMAT_QR_CODE = 11;

export const SCAN_VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: "environment",
  width: { ideal: 1280 },
  height: { ideal: 720 },
  advanced: [{ focusMode: "continuous" }] as unknown as MediaTrackConstraintSet[],
};

export function getScannerFocusRegion(width: number, height: number) {
  const sw = Math.max(1, Math.round(width * 0.8));
  const sh = Math.max(1, Math.round(height * 0.5));
  const sx = Math.max(0, Math.round((width - sw) / 2));
  const sy = Math.max(0, Math.round((height - sh) / 2));
  return {
    sx,
    sy,
    sw,
    sh,
    outputWidth: Math.max(1, Math.round(sw * 1.25)),
    outputHeight: Math.max(1, Math.round(sh * 1.25)),
  };
}

export async function createScanHints(): Promise<Map<number, unknown>> {
  const { BarcodeFormat, DecodeHintType } = await import("@zxing/library");
  return new Map<number, unknown>([
    [DecodeHintType.TRY_HARDER, true],
    [
      DecodeHintType.POSSIBLE_FORMATS,
      [
        BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8,
        BarcodeFormat.UPC_A,
        BarcodeFormat.UPC_E,
        BarcodeFormat.CODE_128,
        BarcodeFormat.QR_CODE,
      ],
    ],
  ]);
}

export function symbologyFromScanFormat(format: number): BarcodeSymbology {
  switch (format) {
    case FORMAT_EAN_13:
      return "EAN13";
    case FORMAT_UPC_A:
      return "UPCA";
    case FORMAT_CODE_128:
      return "CODE128";
    case FORMAT_QR_CODE:
      return "QR";
    default:
      return "OTHER";
  }
}

export function isQrScanFormat(format: number): boolean {
  return format === FORMAT_QR_CODE;
}
