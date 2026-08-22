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
    .map((token) => (token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token));
}

/**
 * Picks only from categories that already exist. It never invents or creates a category.
 * Returns null when the external category is too weak to make a safe match.
 */
export function matchExistingCategory(
  externalCategory: string | undefined,
  categories: CategoryCandidate[],
): CategoryCandidate | null {
  if (!externalCategory?.trim()) return null;
  const externalTokens = new Set(tokens(externalCategory));
  if (externalTokens.size === 0) return null;

  let best: { category: CategoryCandidate; score: number } | null = null;

  for (const category of categories) {
    if (category.isActive === false) continue;
    const categoryTokens = tokens(category.name);
    if (categoryTokens.length === 0) continue;

    const matches = categoryTokens.filter((token) => externalTokens.has(token)).length;
    const score = matches / categoryTokens.length;
    if (score < 0.6) continue;

    if (!best || score > best.score || (score === best.score && category.name.length > best.category.name.length)) {
      best = { category, score };
    }
  }

  return best?.category ?? null;
}
