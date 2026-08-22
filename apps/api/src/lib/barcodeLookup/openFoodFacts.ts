import type { ProductLookupProvider, ProductLookupResult } from "./types.js";

export const openFoodFactsProvider: ProductLookupProvider = {
  name: "openfoodfacts",
  async lookup(barcodeValue: string): Promise<ProductLookupResult | null> {
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcodeValue}.json`, {
      headers: { "User-Agent": "stash-app" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    if (data.status !== 1 || !data.product) return { found: false, provider: "openfoodfacts" };

    const product = data.product;
    return {
      found: true,
      name: product.product_name || product.product_name_en || product.product_name_ko || undefined,
      brand: product.brands || undefined,
      description: product.generic_name || product.generic_name_en || undefined,
      size: product.quantity || product.product_quantity_with_unit || undefined,
      category: product.categories || product.categories_tags?.[0] || undefined,
      imageUrl: product.image_front_url || product.image_url || undefined,
      provider: "openfoodfacts",
      raw: product,
    };
  },
};
