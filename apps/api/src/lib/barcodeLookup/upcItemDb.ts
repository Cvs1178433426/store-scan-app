import { getSetting } from "../settings.js";
import type { ProductLookupProvider, ProductLookupResult } from "./types.js";

function normalizeDescription(item: any): string | undefined {
  const value = item.description || item.title;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

    return {
      found: true,
      name: item.title || undefined,
      brand: item.brand || undefined,
      description: normalizeDescription(item),
      size: item.size || undefined,
      category: item.category || undefined,
      imageUrl: item.images?.[0] || undefined,
      provider: "upcitemdb",
      raw: item,
    };
  },
};
