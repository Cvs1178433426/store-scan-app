"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { apiJson } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { useToast } from "../../lib/toast-context";
import { createScanHints, SCAN_VIDEO_CONSTRAINTS } from "../../lib/barcodeScanner";
import { playBeep, unlockBeepAudio } from "../../lib/beep";

type LookupResult = {
  found: boolean;
  name?: string;
  brand?: string;
  description?: string;
  size?: string;
  category?: string;
  imageUrl?: string;
  provider: string;
};

type Category = {
  id: string;
  name: string;
  parentId: string | null;
  isActive?: boolean;
};

type Product = {
  id: string;
  barcodeValue: string | null;
  name: string;
  manufacturer: string | null;
  description: string | null;
  packageSize: string | null;
  imageUrl: string | null;
  categoryId: string | null;
  isActive: boolean;
};

type ProductDraft = {
  barcode: string;
  productId: string | null;
  name: string;
  manufacturer: string;
  description: string;
  packageSize: string;
  imageUrl: string;
  externalCategory: string;
  categoryId: string;
  provider: string;
  lookupFound: boolean;
};

const DUPLICATE_COOLDOWN_MS = 2500;

function normalizeWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word));
}

function suggestCategory(externalCategory: string, categories: Category[]): string {
  if (!externalCategory.trim()) return "";
  const external = new Set(normalizeWords(externalCategory));
  let best: { id: string; score: number; length: number } | null = null;

  for (const category of categories) {
    if (category.isActive === false) continue;
    const words = normalizeWords(category.name);
    if (words.length === 0) continue;
    const hits = words.filter((word) => external.has(word)).length;
    const score = hits / words.length;
    if (score < 0.6) continue;
    if (!best || score > best.score || (score === best.score && category.name.length > best.length)) {
      best = { id: category.id, score, length: category.name.length };
    }
  }

  return best?.id ?? "";
}

export default function StoreScanPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const { show } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const lastScanRef = useRef<{ value: string; at: number } | null>(null);
  const busyRef = useRef(false);
  const reviewRef = useRef(false);

  const [cameraError, setCameraError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [draft, setDraft] = useState<ProductDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [manualBarcode, setManualBarcode] = useState("");
  const [savedCount, setSavedCount] = useState(0);
  const [lastSaved, setLastSaved] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  useEffect(() => {
    if (!user) return;
    apiJson<Category[]>("/api/categories")
      .then((rows) => setCategories(rows.filter((row) => row.isActive !== false)))
      .catch(() => setCategories([]));
  }, [user]);

  useEffect(() => {
    window.addEventListener("pointerdown", unlockBeepAudio, { once: true });
    return () => window.removeEventListener("pointerdown", unlockBeepAudio);
  }, []);

  useEffect(() => {
    reviewRef.current = Boolean(draft);
  }, [draft]);

  useEffect(() => {
    if (!user || !videoRef.current) return;
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
            if (!result || cancelled || reviewRef.current || busyRef.current) return;
            void handleBarcode(result.getText());
          },
        );
        if (cancelled) controls.stop();
        else controlsRef.current = controls;
      } catch {
        if (!cancelled) setCameraError("Camera access failed. You can still enter a UPC manually below.");
      }
    })();

    return () => {
      cancelled = true;
      controlsRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function handleBarcode(rawValue: string) {
    const barcode = rawValue.trim();
    if (!barcode || busyRef.current || reviewRef.current) return;

    const now = Date.now();
    if (lastScanRef.current?.value === barcode && now - lastScanRef.current.at < DUPLICATE_COOLDOWN_MS) return;
    lastScanRef.current = { value: barcode, at: now };

    busyRef.current = true;
    setBusy(true);
    playBeep();
    if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(60);

    try {
      const [lookup, products] = await Promise.all([
        apiJson<LookupResult>(`/api/lookup/${encodeURIComponent(barcode)}`),
        apiJson<Product[]>(`/api/products?q=${encodeURIComponent(barcode)}&includeInactive=true`),
      ]);

      const existing = products.find((product) => product.barcodeValue === barcode) ?? null;
      const externalCategory = lookup.category ?? "";
      const recommendedCategory = suggestCategory(externalCategory, categories);

      setDraft({
        barcode,
        productId: existing?.id ?? null,
        name: existing?.name || lookup.name || "",
        manufacturer: existing?.manufacturer || lookup.brand || "",
        description: existing?.description || lookup.description || "",
        packageSize: existing?.packageSize || lookup.size || "",
        imageUrl: existing?.imageUrl || lookup.imageUrl || "",
        externalCategory,
        categoryId: existing?.categoryId || recommendedCategory,
        provider: lookup.provider,
        lookupFound: lookup.found,
      });
    } catch (error) {
      show(error instanceof Error ? error.message : "Product lookup failed.", "error");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function saveProduct() {
    if (!draft || busyRef.current) return;
    if (!draft.name.trim()) {
      show("Product name is required.", "error");
      return;
    }

    busyRef.current = true;
    setBusy(true);
    try {
      const body = {
        barcodeValue: draft.barcode,
        name: draft.name.trim(),
        manufacturer: draft.manufacturer.trim() || null,
        description: draft.description.trim() || null,
        packageSize: draft.packageSize.trim() || null,
        imageUrl: draft.imageUrl.trim() || null,
        categoryId: draft.categoryId || null,
        isActive: true,
      };

      if (draft.productId) {
        await apiJson(`/api/products/${draft.productId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      } else {
        await apiJson("/api/products", {
          method: "POST",
          body: JSON.stringify(body),
        });
      }

      setSavedCount((count) => count + 1);
      setLastSaved(draft.name.trim());
      show(`${draft.name.trim()} saved`, "success");
      setDraft(null);
      lastScanRef.current = null;
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not save product.", "error");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function makeInactive() {
    if (!draft?.productId || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await apiJson(`/api/products/${draft.productId}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: false }),
      });
      show(`${draft.name || "Product"} marked inactive`, "success");
      setDraft(null);
      lastScanRef.current = null;
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not make product inactive.", "error");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function cancelReview() {
    setDraft(null);
    lastScanRef.current = null;
  }

  async function handleManualSubmit(event: FormEvent) {
    event.preventDefault();
    const value = manualBarcode.trim();
    if (!value) return;
    setManualBarcode("");
    await handleBarcode(value);
  }

  if (loading || !user) return null;

  return (
    <main className="container" style={{ maxWidth: 680, paddingBottom: 40 }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "end", marginBottom: 14 }}>
        <div>
          <p style={{ margin: 0, opacity: 0.65, fontSize: 13, fontWeight: 700, letterSpacing: ".08em" }}>STORE SURVEY</p>
          <h1 style={{ margin: "3px 0 0" }}>Scan a Product</h1>
        </div>
        <div style={{ textAlign: "right", fontSize: 14 }}>
          <strong>{savedCount}</strong> saved
        </div>
      </header>

      {!draft && (
        <>
          <div className="scanner-frame" style={{ minHeight: 300, borderRadius: 18, overflow: "hidden" }}>
            {cameraError ? (
              <div style={{ minHeight: 300, display: "grid", placeItems: "center", padding: 24, textAlign: "center" }}>{cameraError}</div>
            ) : (
              <video ref={videoRef} muted playsInline style={{ width: "100%", minHeight: 300, objectFit: "cover" }} />
            )}
            {!cameraError && (
              <div className="scanner-overlay">
                <div className="scan-box">
                  <span className="corner tl" />
                  <span className="corner tr" />
                  <span className="corner bl" />
                  <span className="corner br" />
                  <span className="scan-line" />
                </div>
              </div>
            )}
          </div>

          <div style={{ textAlign: "center", margin: "12px 0 18px", minHeight: 22 }}>
            {busy ? <strong>Looking up product…</strong> : lastSaved ? <span>Saved: <strong>{lastSaved}</strong> · Ready for next scan</span> : <span>Point the camera at a UPC barcode</span>}
          </div>

          <form onSubmit={handleManualSubmit} style={{ display: "flex", gap: 8 }}>
            <input
              inputMode="numeric"
              value={manualBarcode}
              onChange={(event) => setManualBarcode(event.target.value)}
              placeholder="Or enter UPC manually"
              aria-label="UPC barcode"
              style={{ flex: 1 }}
            />
            <button type="submit" disabled={busy || !manualBarcode.trim()}>Look up</button>
          </form>
        </>
      )}

      {draft && (
        <section className="card" style={{ padding: 18, borderRadius: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: draft.imageUrl ? "104px 1fr" : "1fr", gap: 16, alignItems: "start" }}>
            {draft.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={draft.imageUrl} alt="" style={{ width: 104, height: 104, objectFit: "contain", borderRadius: 12, background: "white" }} />
            )}
            <div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                <span style={{ fontSize: 12, padding: "3px 8px", borderRadius: 999, background: "rgba(127,127,127,.16)" }}>UPC {draft.barcode}</span>
                <span style={{ fontSize: 12, padding: "3px 8px", borderRadius: 999, background: draft.productId ? "rgba(70,160,90,.18)" : "rgba(80,120,220,.18)" }}>
                  {draft.productId ? "Existing product" : "New product"}
                </span>
              </div>
              <strong style={{ fontSize: 18 }}>{draft.name || "Product name needed"}</strong>
              <div style={{ marginTop: 5, opacity: 0.7, fontSize: 13 }}>
                {draft.lookupFound ? `Matched by ${draft.provider}` : "No reliable external match — please enter details"}
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gap: 10, marginTop: 18 }}>
            <label>
              <span style={{ display: "block", fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Product name *</span>
              <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </label>
            <label>
              <span style={{ display: "block", fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Manufacturer / Brand</span>
              <input value={draft.manufacturer} onChange={(event) => setDraft({ ...draft, manufacturer: event.target.value })} />
            </label>
            <label>
              <span style={{ display: "block", fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Description</span>
              <textarea rows={3} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
            </label>
            <label>
              <span style={{ display: "block", fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Size / Pack</span>
              <input value={draft.packageSize} onChange={(event) => setDraft({ ...draft, packageSize: event.target.value })} placeholder="Example: 12 fl oz, 12 pack" />
            </label>
            <label>
              <span style={{ display: "block", fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Category</span>
              <select value={draft.categoryId} onChange={(event) => setDraft({ ...draft, categoryId: event.target.value })}>
                <option value="">Choose category</option>
                {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
              </select>
            </label>
            {draft.externalCategory && (
              <div style={{ fontSize: 12, opacity: 0.65 }}>External category: {draft.externalCategory}</div>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 18 }}>
            <button type="button" onClick={saveProduct} disabled={busy || !draft.name.trim()} style={{ minHeight: 48 }}>
              {busy ? "Saving…" : "Save & Scan Next"}
            </button>
            <button type="button" className="secondary" onClick={cancelReview} disabled={busy} style={{ minHeight: 48 }}>Cancel</button>
          </div>

          {draft.productId && (
            <button type="button" className="secondary" onClick={makeInactive} disabled={busy} style={{ width: "100%", marginTop: 8 }}>
              Make This Product Inactive
            </button>
          )}
        </section>
      )}
    </main>
  );
}
