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
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function parseEnabledProviderIds(raw: string | undefined): string[] {
  if (raw === "none") return [];
  if (!raw) return DEFAULT_LOOKUP_PROVIDER_IDS;
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

async function getEnabledProviders(): Promise<ProductLookupProvider[]> {
  const raw = await getSetting("LOOKUP_PROVIDERS");
  return parseEnabledProviderIds(raw)
    .map((id) => LOOKUP_PROVIDER_REGISTRY[id])
    .filter((provider): provider is ProductLookupProvider => Boolean(provider));
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

function completenessScore(result: ProductLookupResult): number {
  if (!result.found || !result.name?.trim()) return 0;
  let score = 10; // a named exact-barcode hit is the baseline requirement
  if (result.brand?.trim()) score += 3;
  if (result.description?.trim()) score += 1;
  if (result.size?.trim()) score += 2;
  if (result.category?.trim()) score += 1;
  if (result.imageUrl?.trim()) score += 3;
  return score;
}

export async function resolveProduct(barcodeValue: string): Promise<ProductLookupResult> {
  const providers = await getEnabledProviders();
  if (providers.length === 0) return { found: false, provider: "none" };

  const cached = await prisma.productLookupCache.findUnique({ where: { barcodeValue } });
  if (cached && Date.now() - cached.fetchedAt.getTime() < CACHE_MAX_AGE_MS) {
    return {
      found: Boolean(cached.name),
      name: cached.name ?? undefined,
      brand: cached.brand ?? undefined,
      imageUrl: cached.imageUrl ?? undefined,
      provider: cached.provider ?? "cache",
      ...enrichCachedResult(cached.provider, cached.rawPayload),
    };
  }

  // Query enabled exact-barcode sources together and select the richest reliable result
  // instead of blindly accepting whichever provider happens to be first in the list.
  const candidates = await Promise.all(
    providers.map(async (provider) => {
      try {
        return await provider.lookup(barcodeValue);
      } catch {
        return null;
      }
    }),
  );

  const best = candidates
    .filter((candidate): candidate is ProductLookupResult => Boolean(candidate?.found && candidate.name?.trim()))
    .sort((a, b) => completenessScore(b) - completenessScore(a))[0];

  if (!best) return { found: false, provider: "none" };

  await prisma.productLookupCache.upsert({
    where: { barcodeValue },
    create: {
      barcodeValue,
      name: best.name,
      brand: best.brand,
      imageUrl: best.imageUrl,
      provider: best.provider,
      rawPayload: best.raw as any,
      fetchedAt: new Date(),
    },
    update: {
      name: best.name,
      brand: best.brand,
      imageUrl: best.imageUrl,
      provider: best.provider,
      rawPayload: best.raw as any,
      fetchedAt: new Date(),
    },
  });

  return best;
}
