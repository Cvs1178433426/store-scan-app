import { describe, expect, it } from "vitest";
import { matchExistingCategory } from "./categoryMatch.js";

const categories = [
  { id: "1", name: "Soft Drinks", isActive: true },
  { id: "2", name: "OTC Health", isActive: true },
  { id: "3", name: "Snacks", isActive: true },
  { id: "4", name: "Soda", isActive: false },
];

describe("matchExistingCategory", () => {
  it("matches a strong multi-word provider category to an existing active category", () => {
    const match = matchExistingCategory("Soft Drinks", categories);
    expect(match?.name).toBe("Soft Drinks");
  });

  it("never chooses an inactive category", () => {
    expect(matchExistingCategory("Soda", categories)).toBeNull();
  });

  it("does not over-match a one-word category buried in a long provider string", () => {
    expect(matchExistingCategory("Food Beverages Snacks Energy Drinks Mixers", categories)).toBeNull();
  });

  it("does not corrupt words ending in ss while normalizing plurals", () => {
    expect(matchExistingCategory("Glass Cleaners", [{ id: "g", name: "Glass Cleaner", isActive: true }])?.id).toBe("g");
  });

  it("returns null instead of inventing a category", () => {
    expect(matchExistingCategory("Automotive Engine Oil", categories)).toBeNull();
  });
});
