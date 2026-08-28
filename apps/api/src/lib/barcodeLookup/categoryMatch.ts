export interface CategoryCandidate {
  id: string;
  name: string;
  isActive?: boolean;
}

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => (token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token));
}

/**
 * Picks only from categories that already exist. It never invents or creates a category.
 * Uses a conservative overlap score normalized by the larger token set, which prevents
 * a one-word local category from scoring 100% merely because its word appeared once in
 * a long, unrelated external category string.
 */
export function matchExistingCategory(
  externalCategory: string | undefined,
  categories: CategoryCandidate[],
): CategoryCandidate | null {
  if (!externalCategory?.trim()) return null;
  const external = [...new Set(tokens(externalCategory))];
  if (external.length === 0) return null;

  let best: { category: CategoryCandidate; score: number; matches: number } | null = null;

  for (const category of categories) {
    if (category.isActive === false) continue;
    const local = [...new Set(tokens(category.name))];
    if (local.length === 0) continue;

    const externalSet = new Set(external);
    const matches = local.filter((token) => externalSet.has(token)).length;
    if (matches === 0) continue;

    const score = matches / Math.max(local.length, external.length);
    const exactSingleWord = local.length === 1 && external.length === 1 && matches === 1;
    const safeMultiWord = matches >= 2 && score >= 0.5;
    if (!exactSingleWord && !safeMultiWord) continue;

    if (!best || score > best.score || (score === best.score && matches > best.matches)) {
      best = { category, score, matches };
    }
  }

  return best?.category ?? null;
}
