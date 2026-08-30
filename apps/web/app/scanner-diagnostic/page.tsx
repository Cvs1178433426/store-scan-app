"use client";

import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { createScanHints, SCAN_VIDEO_CONSTRAINTS } from "../../lib/barcodeScanner";

type DiagnosticState = {
  status: string;
  resolution: string;
  attempts: number;
  lastError: string;
  lastValue: string;
};

export default function ScannerDiagnosticPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const attemptsRef = useRef(0);
  const [diagnostic, setDiagnostic] = useState<DiagnosticState>({
    status: "Starting camera...",
    resolution: "waiting",
    attempts: 0,
    lastError: "none",
    lastValue: "none",
  });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (!videoRef.current) return;
      try {
        const hints = await createScanHints();
        if (cancelled || !videoRef.current) return;

        const reader = new BrowserMultiFormatReader(hints);
        const controls = await reader.decodeFromConstraints(
          { video: SCAN_VIDEO_CONSTRAINTS },
          videoRef.current,
          (result, error) => {
            if (cancelled) return;
            attemptsRef.current += 1;
            const video = videoRef.current;
            const resolution = video?.videoWidth && video?.videoHeight
              ? `${video.videoWidth} x ${video.videoHeight}`
              : "video active, dimensions pending";
            const errorName = error instanceof Error ? `${error.name}: ${error.message}` : error ? String(error) : "none";
            const value = result?.getText() ?? "none";

            setDiagnostic({
              status: result ? "BARCODE DECODED" : "Camera active; decoder running",
              resolution,
              attempts: attemptsRef.current,
              lastError: errorName,
              lastValue: value,
            });
          },
        );

        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
        const video = videoRef.current;
        setDiagnostic((current) => ({
          ...current,
          status: "Camera active; waiting for barcode",
          resolution: video?.videoWidth && video?.videoHeight
            ? `${video.videoWidth} x ${video.videoHeight}`
            : "video active, dimensions pending",
        }));
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        setDiagnostic((current) => ({ ...current, status: "SCANNER FAILED TO START", lastError: message }));
      }
    })();

    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, []);

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: 24 }}>
      <h1>Scanner Diagnostic</h1>
      <p>Hold a retail UPC/EAN barcode centered and steady in the camera for 5–10 seconds.</p>

      <video
        ref={videoRef}
        muted
        playsInline
        style={{ width: "100%", maxHeight: 420, background: "#111", borderRadius: 12, objectFit: "cover" }}
      />

      <div style={{ marginTop: 20, padding: 16, border: "1px solid #666", borderRadius: 12 }}>
        <p><strong>Status:</strong> {diagnostic.status}</p>
        <p><strong>Camera resolution:</strong> {diagnostic.resolution}</p>
        <p><strong>Decoder callbacks:</strong> {diagnostic.attempts}</p>
        <p><strong>Last decoder error:</strong> {diagnostic.lastError}</p>
        <p><strong>Last decoded value:</strong> {diagnostic.lastValue}</p>
      </div>
    </main>
  );
}
