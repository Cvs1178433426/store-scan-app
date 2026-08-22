import { prisma } from "../prisma.js";
import { getSetting } from "../settings.js";
import { openFoodFactsProvider } from "./openFoodFacts.js";
import { upcItemDbProvider } from "./upcItemDb.js";
import { naverShoppingProvider } from "./naverShopping.js";
import type { ProductLookupProvider, ProductLookupResult } from "./types.js";

export const LOOKUP_PROVIDER_REGISTRY: Record<string, ProductLookupProvider> = {
  openfoodfacts: openFoodFactsProvider,
  upcitemdb: upcItemDbProvider,
  naver: naverShoppingProvider,
};

export const DEFAULT_LOOKUP_PROVIDER_IDS = ["openfoodfacts", "upcitemdb"];

export function parseEnabledProviderIds(raw: string | undefined): string[] {
  if (raw === "none") return [];
  if (!raw) return DEFAULT_LOOKUP_PROVIDER_IDS;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function getEnabledProviders(): Promise<ProductLookupProvider[]> {
  const raw = await getSetting("LOOKUP_PROVIDERS");
  return parseEnabledProviderIds(raw)
    .map((id) => LOOKUP_PROVIDER_REGISTRY[id])
    .filter((p): p is ProductLookupProvider => Boolean(p));
}

function enrichCachedResult(provider: string | null, rawPayload: unknown): Partial<ProductLookupResult> {
  if (!rawPayload || typeof rawPayload !== "object") return {};
  const raw = rawPayload as Record<string, any>;

  if (provider === "upcitemdb") {
    return {
      description: raw.description || raw.title || undefined,
      size: raw.size || undefined,
      category: raw.category || undefined,
      raw,
    };
  }

  if (provider === "openfoodfacts") {
    return {
      description: raw.generic_name || raw.generic_name_en || undefined,
      size: raw.quantity || raw.product_quantity_with_unit || undefined,
      category: raw.categories || raw.categories_tags?.[0] || undefined,
      raw,
    };
  }

  return { raw };
}

export async function resolveProduct(barcodeValue: string): Promise<ProductLookupResult> {
  const providers = await getEnabledProviders();
  if (providers.length === 0) return { found: false, provider: "none" };

  const cached = await prisma.productLookupCache.findUnique({ where: { barcodeValue } });
  if (cached) {
    return {
      found: Boolean(cached.name),
      name: cached.name ?? undefined,
      brand: cached.brand ?? undefined,
      imageUrl: cached.imageUrl ?? undefined,
      provider: cached.provider ?? "cache",
      ...enrichCachedResult(cached.provider, cached.rawPayload),
    };
  }

  for (const provider of providers) {
    try {
      const result = await provider.lookup(barcodeValue);
      if (result?.found) {
        await prisma.productLookupCache.upsert({
          where: { barcodeValue },
          create: {
            barcodeValue,
            name: result.name,
            brand: result.brand,
            imageUrl: result.imageUrl,
            provider: result.provider,
            rawPayload: result.raw as any,
          },
          update: {
            name: result.name,
            brand: result.brand,
            imageUrl: result.imageUrl,
            provider: result.provider,
            rawPayload: result.raw as any,
          },
        });
        return result;
      }
    } catch {
      // One provider failing must not block the remaining lookup sources.
    }
  }

  return { found: false, provider: "none" };
}
