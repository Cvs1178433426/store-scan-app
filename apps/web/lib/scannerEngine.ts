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

const QUAGGA_URLS = [
  "https://cdn.jsdelivr.net/npm/@ericblade/quagga2@1.12.1/dist/quagga.min.js",
  "https://unpkg.com/@ericblade/quagga2@1.12.1/dist/quagga.min.js",
] as const;

let loadPromise: Promise<QuaggaApi> | null = null;

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

async function loadFrom(url: string): Promise<QuaggaApi> {
  if (window.Quagga) return window.Quagga;
  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-continuix-quagga="${url}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Quagga script failed to load")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.dataset.continuixQuagga = url;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Quagga script failed to load"));
    document.head.appendChild(script);
  });
  if (!window.Quagga) throw new Error("Quagga loaded without exposing its API");
  return window.Quagga;
}

export function loadRetailScanner(): Promise<QuaggaApi> {
  if (typeof window === "undefined") return Promise.reject(new Error("Scanner requires a browser"));
  if (window.Quagga) return Promise.resolve(window.Quagga);
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    let lastError: unknown;
    for (const url of QUAGGA_URLS) {
      try {
        return await loadFrom(url);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Retail scanner could not load");
  })();

  return loadPromise;
}
