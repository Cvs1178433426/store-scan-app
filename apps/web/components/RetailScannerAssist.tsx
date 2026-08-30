"use client";

import { useEffect, useRef } from "react";
import { loadRetailScanner, retailDecodeConfig } from "../lib/scannerEngine";

const FRAME_INTERVAL_MS = 280;
const REARM_AFTER_MISSING_MS = 1500;
const FRAME_MAX_WIDTH = 960;
const CAMERA_SCAN_EVENT = "continuix:camera-scan";
const RETAIL_SCANNER_READY_EVENT = "continuix:retail-scanner-ready";

type ScannerWindow = Window & { __continuixRetailScannerReady?: boolean };

function emitCameraBarcode(value: string) {
  window.dispatchEvent(new CustomEvent(CAMERA_SCAN_EVENT, { detail: { value } }));
}

function markRetailScannerReady() {
  (window as ScannerWindow).__continuixRetailScannerReady = true;
  window.dispatchEvent(new Event(RETAIL_SCANNER_READY_EVENT));
}

function captureFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth < 2 || video.videoHeight < 2) return null;

  const scale = Math.min(1, FRAME_MAX_WIDTH / video.videoWidth);
  const width = Math.max(2, Math.round(video.videoWidth * scale));
  const height = Math.max(2, Math.round(video.videoHeight * scale));
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;

  context.drawImage(video, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", 0.9);
}

export function RetailScannerAssist() {
  const decodingRef = useRef(false);
  const lastSeenRef = useRef<{ value: string; at: number } | null>(null);
  const armedValueRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let readyMarked = false;
    const canvas = document.createElement("canvas");

    void (async () => {
      let quagga;
      try {
        quagga = await loadRetailScanner();
      } catch {
        // The existing ZXing path remains the fallback if the retail decoder cannot load.
        return;
      }
      if (cancelled) return;

      timer = setInterval(() => {
        if (cancelled || decodingRef.current || window.location.pathname !== "/store-count") return;
        const video = document.querySelector<HTMLVideoElement>(".scanner-frame video");
        if (!video || !video.srcObject) return;

        const frame = captureFrame(video, canvas);
        if (!frame) return;
        decodingRef.current = true;

        quagga.decodeSingle(retailDecodeConfig(frame), (result) => {
          decodingRef.current = false;
          if (cancelled) return;

          const now = Date.now();
          const value = result?.codeResult?.code?.trim() ?? "";
          if (!value) {
            if (lastSeenRef.current && now - lastSeenRef.current.at >= REARM_AFTER_MISSING_MS) {
              armedValueRef.current = null;
              lastSeenRef.current = null;
            }
            return;
          }

          if (!readyMarked) {
            markRetailScannerReady();
            readyMarked = true;
          }
          lastSeenRef.current = { value, at: now };
          if (armedValueRef.current === value) return;
          armedValueRef.current = value;
          emitCameraBarcode(value);
        });
      }, FRAME_INTERVAL_MS);
    })();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      decodingRef.current = false;
      lastSeenRef.current = null;
      armedValueRef.current = null;
      (window as ScannerWindow).__continuixRetailScannerReady = false;
    };
  }, []);

  return null;
}
