import type { ProductLookupProvider, ProductLookupResult } from "./types.js";

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeOpenFoodFactsProduct(product: Record<string, any>): ProductLookupResult {
  return {
    found: true,
    name:
      cleanString(product.product_name) ||
      cleanString(product.product_name_en) ||
      cleanString(product.product_name_ko),
    brand: cleanString(product.brands),
    description: cleanString(product.generic_name) || cleanString(product.generic_name_en),
    size: cleanString(product.quantity) || cleanString(product.product_quantity_with_unit),
    category: cleanString(product.categories) ||
      (Array.isArray(product.categories_tags) ? cleanString(product.categories_tags[0]) : undefined),
    imageUrl: cleanString(product.image_front_url) || cleanString(product.image_url),
    provider: "openfoodfacts",
    raw: product,
  };
}

export const openFoodFactsProvider: ProductLookupProvider = {
  name: "openfoodfacts",
  async lookup(barcodeValue: string): Promise<ProductLookupResult | null> {
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcodeValue}.json`, {
      headers: { "User-Agent": "continuixai-ops" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    if (data.status !== 1 || !data.product) return { found: false, provider: "openfoodfacts" };

    return normalizeOpenFoodFactsProduct(data.product);
  },
};
