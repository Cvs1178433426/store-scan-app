"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { BrowserCodeReader, BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { apiFetch, apiJson, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { useToast } from "../../lib/toast-context";
import { createScanHints, SCAN_VIDEO_CONSTRAINTS } from "../../lib/barcodeScanner";
import { playBeep, unlockBeepAudio } from "../../lib/beep";
import { TorchButton } from "../../components/TorchButton";
import {
  clearCountQueueForSession,
  createCountScanId,
  enqueueCountScan,
  getCountQueue,
  getFailedCountQueue,
  getPendingCountQueue,
  markCountScanFailed,
  removeFromCountQueue,
  retryFailedCountScan,
  type QueuedCountScan,
} from "../../lib/storeCountQueue";

const SAME_VALUE_DEBOUNCE_MS = 350;
const WEDGE_TIMEOUT_MS = 80;

type StoreLocation = { id: string; code: string; name: string | null; isActive: boolean };
type Product = { id: string; name: string; manufacturer: string | null; packageSize: string | null } | null;
type CountEntry = {
  id: string;
  barcodeValue: string;
  locationId: string;
  quantity: number;
  product: Product;
  location: { id: string; code: string };
};
type CountSession = {
  id: string;
  name: string | null;
  status: "ACTIVE" | "COMPLETED" | "CANCELLED";
  startedAt: string;
  entries: CountEntry[];
};
type SummaryRow = {
  productId: string | null;
  barcodeValue: string;
  productName: string | null;
  packageSize: string | null;
  total: number;
  byLocation: Record<string, { locationCode: string; quantity: number }>;
};
type SummaryResponse = {
  session: { id: string; name: string | null; status: string };
  distinctProducts: number;
  totalUnits: number;
  locations: string[];
  rows: SummaryRow[];
};

export default function StoreCountPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const { show } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const lastScanRef = useRef<{ value: string; at: number } | null>(null);
  const busyRef = useRef(false);
  const flushingRef = useRef(false);
  const wedgeBufferRef = useRef("");
  const wedgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [session, setSession] = useState<CountSession | null>(null);
  const [locations, setLocations] = useState<StoreLocation[]>([]);
  const [locationId, setLocationId] = useState("");
  const [view, setView] = useState<"count" | "summary">("count");
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [manualValue, setManualValue] = useState("");
  const [manualQuantity, setManualQuantity] = useState("1");
  const [pendingCount, setPendingCount] = useState(0);
  const [failedScans, setFailedScans] = useState<QueuedCountScan[]>([]);
  const [flash, setFlash] = useState<{ kind: "known" | "unknown" | "queued" | "error"; text: string } | null>(null);
  const [exporting, setExporting] = useState(false);

  function refreshQueueState() {
    setPendingCount(getPendingCountQueue(user?.id).length);
    setFailedScans(getFailedCountQueue(user?.id));
  }

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      try {
        const [locs, active] = await Promise.all([
          apiJson<StoreLocation[]>("/api/store-locations"),
          apiJson<CountSession | null>("/api/store-count/sessions/active"),
        ]);
        setLocations(locs);
        if (active) {
          setSession(active);
          setLocationId(active.entries[0]?.locationId ?? locs[0]?.id ?? "");
        } else {
          setLocationId(locs[0]?.id ?? "");
        }
      } catch (error) {
        show(error instanceof Error ? error.message : "Could not load Store Count.", "error");
      } finally {
        setInitializing(false);
      }
    })();
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refreshQueueState();
    void flushQueue();
    window.addEventListener("online", flushQueue);
    return () => window.removeEventListener("online", flushQueue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  useEffect(() => {
    window.addEventListener("pointerdown", unlockBeepAudio, { once: true });
    return () => window.removeEventListener("pointerdown", unlockBeepAudio);
  }, []);

  useEffect(() => {
    if (!session || session.status !== "ACTIVE" || view !== "count") return;
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.key === "Enter") {
        const value = wedgeBufferRef.current.trim();
        wedgeBufferRef.current = "";
        if (wedgeTimerRef.current) clearTimeout(wedgeTimerRef.current);
        wedgeTimerRef.current = null;
        if (value.length >= 4) {
          event.preventDefault();
          void handleBarcode(value);
        }
        return;
      }
      if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
      wedgeBufferRef.current += event.key;
      if (wedgeTimerRef.current) clearTimeout(wedgeTimerRef.current);
      wedgeTimerRef.current = setTimeout(() => {
        wedgeBufferRef.current = "";
        wedgeTimerRef.current = null;
      }, WEDGE_TIMEOUT_MS);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (wedgeTimerRef.current) clearTimeout(wedgeTimerRef.current);
      wedgeBufferRef.current = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, session?.status, locationId, view]);

  useEffect(() => {
    if (!session || session.status !== "ACTIVE" || !videoRef.current || view !== "count") return;
    let cancelled = false;
    void (async () => {
      const hints = await createScanHints();
      if (cancelled || !videoRef.current) return;
      const reader = new BrowserMultiFormatReader(hints);
      try {
        const controls = await reader.decodeFromConstraints(
          { video: SCAN_VIDEO_CONSTRAINTS },
          videoRef.current,
          (result) => {
            if (!result || cancelled || busyRef.current) return;
            void handleBarcode(result.getText());
          },
        );
        if (cancelled) return controls.stop();
        controlsRef.current = controls;
        const stream = videoRef.current?.srcObject;
        if (stream instanceof MediaStream) setTorchSupported(BrowserCodeReader.mediaStreamIsTorchCompatible(stream));
      } catch (error) {
        if (!cancelled) {
          const name = error instanceof DOMException ? error.name : "";
          if (name === "NotAllowedError") setCameraError("Camera permission is blocked. Allow camera access in browser settings, or use a handheld scanner/manual UPC entry.");
          else if (name === "NotReadableError") setCameraError("The camera is busy in another app or tab. Close it there, or use a handheld scanner/manual UPC entry.");
          else setCameraError("Camera unavailable. Handheld scanner and manual UPC entry still work.");
        }
      }
    })();
    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
      setTorchOn(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, session?.status, view]);

  async function flushQueue() {
    if (flushingRef.current) return;
    flushingRef.current = true;
    try {
      let synced = 0;
      let newlyFailed = 0;
      if (!user) return;
      for (const queued of getPendingCountQueue(user.id)) {
        try {
          await apiJson(`/api/store-count/sessions/${queued.sessionId}/scan`, {
            method: "POST",
            body: JSON.stringify({ barcodeValue: queued.barcodeValue, locationId: queued.locationId, quantityDelta: queued.quantityDelta, clientScanId: queued.id }),
          });
          removeFromCountQueue(queued.id);
          synced++;
        } catch (error) {
          if (error instanceof ApiError && [400, 404, 409].includes(error.status)) {
            markCountScanFailed(queued.id, error.message || `Server rejected queued scan (${error.status})`);
            newlyFailed++;
            continue;
          }
          // A temporary failure for one scan must not block independent queued
          // scans behind it. Leave this entry pending and continue the pass.
          continue;
        }
      }
      refreshQueueState();
      if (synced && session) void refreshSession(session.id);
      if (synced) show(`${synced} queued scan${synced === 1 ? "" : "s"} synced.`, "success");
      if (newlyFailed) show(`${newlyFailed} scan${newlyFailed === 1 ? " needs" : "s need"} review — nothing was discarded.`, "error");
    } finally {
      flushingRef.current = false;
    }
  }

  async function retryFailedScan(id: string) {
    retryFailedCountScan(id);
    refreshQueueState();
    await flushQueue();
  }

  async function startSession() {
    try {
      const created = await apiJson<CountSession>("/api/store-count/sessions", { method: "POST" });
      const full = await apiJson<CountSession>(`/api/store-count/sessions/${created.id}`);
      setSession(full);
      setView("count");
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not start count.", "error");
    }
  }

  async function refreshSession(id: string) {
    try { setSession(await apiJson<CountSession>(`/api/store-count/sessions/${id}`)); } catch { /* best-effort */ }
  }

  async function handleBarcode(rawValue: string, quantityDelta = 1) {
    const barcode = rawValue.trim();
    if (!barcode || !session || !locationId || busyRef.current || quantityDelta < 1 || quantityDelta > 999) return;
    const now = Date.now();
    if (quantityDelta === 1 && lastScanRef.current?.value === barcode && now - lastScanRef.current.at < SAME_VALUE_DEBOUNCE_MS) return;
    lastScanRef.current = { value: barcode, at: now };
    busyRef.current = true;
    const clientScanId = createCountScanId();
    playBeep();
    if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(45);
    try {
      const entry = await apiJson<CountEntry>(`/api/store-count/sessions/${session.id}/scan`, {
        method: "POST",
        body: JSON.stringify({ barcodeValue: barcode, locationId, quantityDelta, clientScanId }),
      });
      setSession((current) => current ? { ...current, entries: [entry, ...current.entries.filter((existing) => existing.id !== entry.id)] } : current);
      setFlash({ kind: entry.product ? "known" : "unknown", text: entry.product ? `${entry.product.name} — added ${quantityDelta}, ${entry.quantity} here` : `Unknown UPC ${barcode} counted (${quantityDelta}) — add product details later` });
    } catch (error) {
      enqueueCountScan({ ownerUserId: user.id, sessionId: session.id, locationId, barcodeValue: barcode, quantityDelta }, clientScanId);
      if (error instanceof ApiError && [400, 404, 409].includes(error.status)) {
        markCountScanFailed(clientScanId, error.message || `Server rejected scan (${error.status})`);
        refreshQueueState();
        setFlash({ kind: "error", text: `Count captured but needs review: ${barcode} × ${quantityDelta}` });
      } else {
        refreshQueueState();
        setFlash({ kind: "queued", text: `Offline — count safely queued: ${barcode} × ${quantityDelta}` });
      }
    } finally {
      busyRef.current = false;
      window.setTimeout(() => setFlash(null), 1600);
    }
  }

  async function toggleTorch() {
    const next = !torchOn;
    try {
      await controlsRef.current?.switchTorch?.(next);
      setTorchOn(next);
    } catch { show("Flash is not available on this device.", "error"); }
  }

  async function showSummary() {
    if (!session) return;
    try {
      setSummary(await apiJson<SummaryResponse>(`/api/store-count/sessions/${session.id}/summary`));
      setView("summary");
    } catch (error) { show(error instanceof Error ? error.message : "Could not load summary.", "error"); }
  }

  async function downloadCsv() {
    if (!session || exporting) return;
    setExporting(true);
    try {
      const response = await apiFetch(`/api/store-count/sessions/${session.id}/export.csv`);
      if (!response.ok) throw new Error(`Export failed (${response.status})`);
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
      const filename = filenameMatch?.[1] || `count-${session.id}.csv`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      show("CSV export downloaded.", "success");
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not download CSV export.", "error");
    } finally {
      setExporting(false);
    }
  }

  async function finishSession() {
    const unresolvedCount = pendingCount + failedScans.length;
    if (!session || unresolvedCount > 0) {
      if (unresolvedCount > 0) show("Resolve or sync every captured scan before finishing this count.", "error");
      return;
    }
    if (!window.confirm("Complete and lock this count? After completion, counted quantities cannot be edited.")) return;
    try {
      await apiJson(`/api/store-count/sessions/${session.id}/complete`, { method: "POST" });
      await showSummary();
      setSession((current) => current ? { ...current, status: "COMPLETED" } : current);
    } catch (error) { show(error instanceof Error ? error.message : "Could not finish count.", "error"); }
  }

  async function cancelSession() {
    if (!session) return;
    const unresolvedForSession = getCountQueue().filter((entry) => entry.sessionId === session.id && entry.ownerUserId === user?.id).length;
    const warning = unresolvedForSession > 0 ? `Cancel this count session? This will deliberately discard ${unresolvedForSession} locally captured unresolved scan${unresolvedForSession === 1 ? "" : "s"}.` : "Cancel this count session?";
    if (!window.confirm(warning)) return;
    try {
      await apiJson(`/api/store-count/sessions/${session.id}/cancel`, { method: "POST" });
      clearCountQueueForSession(session.id, user?.id);
      refreshQueueState();
      setSession(null);
      setSummary(null);
      setView("count");
    } catch (error) { show(error instanceof Error ? error.message : "Could not cancel count.", "error"); }
  }

  async function handleManualSubmit(event: FormEvent) {
    event.preventDefault();
    const value = manualValue.trim();
    const quantity = Number.parseInt(manualQuantity, 10);
    if (!value || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      show("Enter a UPC and a quantity from 1 to 999.", "error");
      return;
    }
    setManualValue("");
    setManualQuantity("1");
    await handleBarcode(value, quantity);
  }

  if (loading || !user || initializing) return null;
  const currentLocation = locations.find((location) => location.id === locationId);
  const entriesHere = session?.entries.filter((entry) => entry.locationId === locationId) ?? [];
  const unitsHere = entriesHere.reduce((sum, entry) => sum + entry.quantity, 0);
  const unresolvedCount = pendingCount + failedScans.length;

  return (
    <main className="container" style={{ maxWidth: 680, paddingBottom: 48 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "end", marginBottom: 14, gap: 12 }}>
        <div><p style={{ margin: 0, opacity: 0.65, fontSize: 12, fontWeight: 800, letterSpacing: ".08em" }}>CONTINUIXAI OPS</p><h1 style={{ margin: "3px 0 0" }}>Count</h1></div>
        {session && <button type="button" className="secondary" onClick={() => view === "count" ? void showSummary() : setView("count")}>{view === "count" ? "Summary" : "Count"}</button>}
      </header>

      {!session && <section className="card" style={{ padding: 24, textAlign: "center" }}><h2 style={{ marginTop: 0 }}>Ready to count?</h2><p style={{ opacity: 0.75 }}>Start a session, pick a location, then scan continuously.</p><button type="button" onClick={() => void startSession()} style={{ minHeight: 52, width: "100%" }}>Start Count</button></section>}

      {session && view === "count" && <>
        <section className="card" style={{ padding: 12, marginBottom: 12 }}>
          <label style={{ display: "block", fontSize: 12, fontWeight: 800, marginBottom: 5 }}>CURRENT LOCATION</label>
          <select value={locationId} onChange={(event) => { setLocationId(event.target.value); event.currentTarget.blur(); }} style={{ width: "100%", fontSize: 19, fontWeight: 800, minHeight: 50 }}>
            {locations.length === 0 && <option value="">No active locations configured</option>}
            {locations.map((location) => <option key={location.id} value={location.id}>{location.code}{location.name ? ` — ${location.name}` : ""}</option>)}
          </select>
          <div style={{ marginTop: 6, fontSize: 13, opacity: 0.72 }}>{entriesHere.length} products · {unitsHere} units here</div>
        </section>

        {session.status === "ACTIVE" && <>
          <div className="scanner-frame" style={{ minHeight: 260, borderRadius: 18, overflow: "hidden", position: "relative" }}>
            {cameraError ? <div style={{ minHeight: 260, display: "grid", placeItems: "center", padding: 24, textAlign: "center" }}>{cameraError}</div> : <video ref={videoRef} muted playsInline style={{ width: "100%", minHeight: 260, objectFit: "cover" }} />}
            {!cameraError && <div className="scanner-overlay"><div className="scan-box"><span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" /><span className="scan-line" /></div></div>}
            {torchSupported && <TorchButton active={torchOn} onClick={() => void toggleTorch()} label={torchOn ? "Turn flash off" : "Turn flash on"} />}
          </div>
          <div style={{ textAlign: "center", margin: "10px 0 12px", minHeight: 42, fontWeight: flash ? 800 : 500 }}>{flash ? flash.text : currentLocation ? `Ready at ${currentLocation.code} · camera or handheld trigger` : "Configure and select a location first"}</div>
          <form onSubmit={handleManualSubmit} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 88px auto", gap: 8 }}>
            <input inputMode="numeric" value={manualValue} onChange={(event) => setManualValue(event.target.value)} placeholder="Manual UPC" aria-label="Manual UPC" style={{ minWidth: 0, minHeight: 48 }} />
            <input inputMode="numeric" type="number" min={1} max={999} step={1} value={manualQuantity} onChange={(event) => setManualQuantity(event.target.value)} aria-label="Quantity" title="Quantity" style={{ minWidth: 0, minHeight: 48, textAlign: "center" }} />
            <button type="submit" disabled={!manualValue.trim() || !locationId}>Add Qty</button>
          </form>
          <div style={{ fontSize: 12, opacity: 0.68, marginTop: 5 }}>Use quantity for multiple identical units; camera and handheld scans continue to add one each.</div>
          {pendingCount > 0 && <div className="card" style={{ marginTop: 10, padding: 12, textAlign: "center", fontWeight: 800 }}>{pendingCount} scan{pendingCount === 1 ? "" : "s"} safely queued — waiting to sync</div>}
          {failedScans.length > 0 && <section className="card" style={{ marginTop: 10, padding: 12, border: "2px solid rgba(220, 80, 80, .55)" }}><strong>{failedScans.length} captured scan{failedScans.length === 1 ? " needs" : "s need"} review</strong><p style={{ margin: "5px 0 10px", fontSize: 13 }}>These scans were not discarded. Resolve them before finishing the count.</p><div style={{ display: "grid", gap: 8 }}>{failedScans.map((scan) => <div key={scan.id} style={{ paddingTop: 8, borderTop: "1px solid rgba(127,127,127,.25)" }}><div><strong>{scan.barcodeValue}</strong> · {locations.find((location) => location.id === scan.locationId)?.code ?? "unknown location"}</div><div style={{ fontSize: 12, opacity: 0.75, margin: "3px 0 6px" }}>{scan.failureReason ?? "Server rejected this queued scan."}</div><button type="button" className="secondary" onClick={() => void retryFailedScan(scan.id)} style={{ minHeight: 40 }}>Retry</button></div>)}</div></section>}
          {entriesHere.length > 0 && <section style={{ marginTop: 18 }}><h2 style={{ fontSize: 14 }}>Counted here</h2><div style={{ display: "grid", gap: 6 }}>{entriesHere.slice(0, 20).map((entry) => <div key={entry.id} className="card" style={{ padding: 10, display: "flex", justifyContent: "space-between", gap: 12 }}><span>{entry.product?.name ?? entry.barcodeValue}</span><strong>{entry.quantity}</strong></div>)}</div></section>}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 20 }}><button type="button" onClick={() => void finishSession()} disabled={unresolvedCount > 0} style={{ minHeight: 50 }}>Finish</button><button type="button" className="secondary" onClick={() => void cancelSession()} style={{ minHeight: 50 }}>Cancel</button></div>
        </>}
      </>}

      {session && view === "summary" && summary && <section>
        <div className="card" style={{ padding: 14, marginBottom: 12 }}><strong>{summary.distinctProducts} products · {summary.totalUnits} units</strong><div style={{ fontSize: 13, opacity: 0.7 }}>{summary.locations.length} locations</div></div>
        <button type="button" className="secondary" onClick={() => void downloadCsv()} disabled={exporting} style={{ width: "100%", minHeight: 46, marginBottom: 12 }}>{exporting ? "Preparing CSV…" : "Download CSV"}</button>
        <div style={{ display: "grid", gap: 8 }}>{summary.rows.map((row) => <div key={row.productId ?? row.barcodeValue} className="card" style={{ padding: 12 }}><div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><strong>{row.productName ?? row.barcodeValue}</strong><strong>{row.total}</strong></div><div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>{Object.values(row.byLocation).map((location) => <span key={location.locationCode} style={{ fontSize: 12, padding: "2px 8px", borderRadius: 999, background: "rgba(127,127,127,.16)" }}>{location.locationCode}: {location.quantity}</span>)}</div></div>)}</div>
      </section>}
    </main>
  );
}
