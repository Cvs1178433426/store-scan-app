import { getSetting } from "../settings.js";
import type { ProductLookupProvider, ProductLookupResult } from "./types.js";

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function extractPackageSize(item: Record<string, unknown>): string | undefined {
  const explicit = cleanString(item.size);
  if (explicit) return explicit;

  const text = [cleanString(item.title), cleanString(item.description)].filter(Boolean).join(" ");
  if (!text) return undefined;

  // Common US retail formats: "12 fl oz, 12 Pack", "16.9 oz 6-pack", "100 count".
  const amount = text.match(/\b\d+(?:\.\d+)?\s*(?:fl\s*oz|oz|lb|lbs|g|kg|mg|ml|l)\b/i)?.[0];
  const pack = text.match(/\b\d+\s*(?:pack|pk|ct|count)\b/i)?.[0];
  if (amount && pack) return `${amount}, ${pack}`;
  return amount || pack || undefined;
}

export function normalizeUpcItem(item: Record<string, any>): ProductLookupResult {
  return {
    found: true,
    name: cleanString(item.title),
    brand: cleanString(item.brand),
    description: cleanString(item.description) || cleanString(item.title),
    size: extractPackageSize(item),
    category: cleanString(item.category),
    imageUrl: Array.isArray(item.images) ? cleanString(item.images[0]) : undefined,
    provider: "upcitemdb",
    raw: item,
  };
}

export const upcItemDbProvider: ProductLookupProvider = {
  name: "upcitemdb",
  async lookup(barcodeValue: string): Promise<ProductLookupResult | null> {
    const apiKey = await getSetting("UPCITEMDB_API_KEY", process.env.UPCITEMDB_API_KEY);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) headers["user_key"] = apiKey;

    const res = await fetch(
      `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(barcodeValue)}`,
      { headers },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const item = data.items?.[0];
    if (!item) return { found: false, provider: "upcitemdb" };

    return normalizeUpcItem(item);
  },
};
