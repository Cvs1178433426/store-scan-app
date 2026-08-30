import { describe, expect, it } from "vitest";
import { expandComposition, resolvePackagingQuantity } from "./packagingResolution.js";

describe("resolvePackagingQuantity", () => {
  it("keeps each quantities unchanged", () => {
    expect(resolvePackagingQuantity({ unitsOfEach: 1 }, 7)).toBe(7);
  });

  it("multiplies a standard case pack into eaches", () => {
    expect(resolvePackagingQuantity({ unitsOfEach: 12 }, 3)).toBe(36);
  });

  it("rejects missing or non-positive pack quantities instead of guessing", () => {
    expect(() => resolvePackagingQuantity({ unitsOfEach: 0 }, 1)).toThrow(/pack quantity/i);
    expect(() => resolvePackagingQuantity({ unitsOfEach: 12 }, 0)).toThrow(/requested quantity/i);
  });
});

describe("expandComposition", () => {
  it("expands 100 displays into every component each quantity", () => {
    const components = [
      { productId: "A", quantityPerParent: 4 },
      { productId: "B", quantityPerParent: 6 },
      { productId: "C", quantityPerParent: 3 },
      { productId: "D", quantityPerParent: 8 },
      { productId: "E", quantityPerParent: 2 },
      { productId: "F", quantityPerParent: 5 },
      { productId: "G", quantityPerParent: 7 },
    ];

    expect(expandComposition(components, 100)).toEqual([
      { productId: "A", eachQuantity: 400 },
      { productId: "B", eachQuantity: 600 },
      { productId: "C", eachQuantity: 300 },
      { productId: "D", eachQuantity: 800 },
      { productId: "E", eachQuantity: 200 },
      { productId: "F", eachQuantity: 500 },
      { productId: "G", eachQuantity: 700 },
    ]);
  });

  it("rejects an invalid display component instead of partially expanding", () => {
    expect(() => expandComposition([
      { productId: "A", quantityPerParent: 4 },
      { productId: "B", quantityPerParent: 0 },
    ], 5)).toThrow(/component quantity/i);
  });
});
