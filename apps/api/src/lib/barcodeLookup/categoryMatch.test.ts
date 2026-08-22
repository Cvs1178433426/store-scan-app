import { describe, expect, it } from "vitest";
import { matchExistingCategory } from "./categoryMatch.js";

const categories = [
  { id: "1", name: "Beverages", isActive: true },
  { id: "2", name: "OTC/Health", isActive: true },
  { id: "3", name: "Snacks", isActive: true },
  { id: "4", name: "Soda", isActive: false },
];

describe("matchExistingCategory", () => {
  it("matches a provider category to an existing active category", () => {
    const match = matchExistingCategory("Food, Beverages & Tobacco > Beverages > Soda", categories);
    expect(match?.name).toBe("Beverages");
  });

  it("never chooses an inactive category", () => {
    const match = matchExistingCategory("Soda", categories);
    expect(match).toBeNull();
  });

  it("returns null instead of inventing a category", () => {
    expect(matchExistingCategory("Automotive > Engine Oil", categories)).toBeNull();
  });
});
