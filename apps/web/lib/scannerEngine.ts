export type QuaggaResult = {
  codeResult?: { code?: string; format?: string };
};

export type QuaggaApi = {
  decodeSingle: (config: Record<string, unknown>, callback: (result: QuaggaResult | null) => void) => void;
};

declare global {
  interface Window {
    Quagga?: QuaggaApi;
  }
}

let loadPromise: Promise<QuaggaApi> | null = null;

export type ScannerStatus = "starting" | "ready" | "retail" | "fallback";
export type RetailScannerStatus = Extract<ScannerStatus, "retail" | "fallback">;
type RetailScannerStatusTarget = EventTarget & { __continuixRetailScannerStatus?: RetailScannerStatus };

export function publishRetailScannerStatus(target: RetailScannerStatusTarget, status: RetailScannerStatus) {
  target.__continuixRetailScannerStatus = status;
  target.dispatchEvent(new Event(`continuix:retail-scanner-${status === "retail" ? "loaded" : "failed"}`));
}

export function readRetailScannerStatus(target: RetailScannerStatusTarget) {
  return target.__continuixRetailScannerStatus;
}

export function markCameraReady(status: ScannerStatus): ScannerStatus {
  return status === "starting" ? "ready" : status;
}

export function describeScannerStatus(state: ScannerStatus, locationCode?: string) {
  const location = locationCode ? ` at ${locationCode}` : "";
  if (state === "starting") return `Starting camera${location}…`;
  if (state === "retail") return `Retail scanner ready${location} · aim the barcode inside the box`;
  if (state === "fallback") return `Backup scanner active${location} · aim the barcode inside the box`;
  return `Camera ready${location} · aim the barcode inside the box`;
}

export function retailDecodeConfig(src: string) {
  return {
    src,
    numOfWorkers: 0,
    locate: true,
    inputStream: {
      size: 800,
      singleChannel: false,
    },
    locator: {
      patchSize: "medium",
      halfSample: true,
    },
    decoder: {
      readers: ["upc_reader", "ean_reader", "ean_8_reader", "upc_e_reader", "code_128_reader"],
      multiple: false,
    },
  };
}

export function preferredScannerEngine(quaggaAvailable: boolean) {
  return quaggaAvailable ? "quagga" : "zxing";
}

export function shouldEmitRetailScan(
  value: string,
  previous: { value: string; at: number } | null,
  now: number,
  quietMs = 1200,
) {
  if (!value) return false;
  return !previous || previous.value !== value || now - previous.at >= quietMs;
}

export function loadRetailScanner(): Promise<QuaggaApi> {
  if (typeof window === "undefined") return Promise.reject(new Error("Scanner requires a browser"));
  if (window.Quagga) return Promise.resolve(window.Quagga);
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const scannerBundle = await import("@ericblade/quagga2");
    const scanner = (scannerBundle.default ?? scannerBundle) as unknown as QuaggaApi;
    if (typeof scanner.decodeSingle !== "function") throw new Error("Retail scanner loaded without its decode API");
    window.Quagga = scanner;
    return scanner;
  })();

  return loadPromise;
}
