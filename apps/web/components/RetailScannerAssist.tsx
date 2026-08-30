"use client";

import { useEffect, useRef } from "react";
import { loadRetailScanner, retailDecodeConfig } from "../lib/scannerEngine";

const FRAME_INTERVAL_MS = 280;
const REARM_AFTER_MISSING_MS = 1500;
const FRAME_MAX_WIDTH = 960;

function emitAsScannerWedge(value: string) {
  for (const character of value) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: character, bubbles: true }));
  }
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
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

          lastSeenRef.current = { value, at: now };
          if (armedValueRef.current === value) return;
          armedValueRef.current = value;
          emitAsScannerWedge(value);
        });
      }, FRAME_INTERVAL_MS);
    })();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      decodingRef.current = false;
      lastSeenRef.current = null;
      armedValueRef.current = null;
    };
  }, []);

  return null;
}
