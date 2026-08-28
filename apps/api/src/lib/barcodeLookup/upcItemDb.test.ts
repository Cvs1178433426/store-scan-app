import { describe, expect, it } from "vitest";
import { extractPackageSize, normalizeUpcItem } from "./upcItemDb.js";

describe("UPCItemDB normalization", () => {
  it("extracts the useful Store Scan fields from a retail product", () => {
    const result = normalizeUpcItem({
      ean: "0049000028911",
      upc: "049000028911",
      title: "Diet Coke Soda Soft Drink, 12 fl oz, 12 Pack",
      description: "Diet Coke is a crisp tasting sparkling cola with zero sugar and zero calories.",
      brand: "Diet Coke",
      size: "",
      category: "Food, Beverages & Tobacco > Beverages > Soda",
      images: ["https://example.com/diet-coke.jpg"],
    });

    expect(result.found).toBe(true);
    expect(result.name).toBe("Diet Coke Soda Soft Drink, 12 fl oz, 12 Pack");
    expect(result.brand).toBe("Diet Coke");
    expect(result.description).toContain("crisp tasting");
    expect(result.size).toBe("12 fl oz, 12 Pack");
    expect(result.category).toBe("Food, Beverages & Tobacco > Beverages > Soda");
    expect(result.imageUrl).toBe("https://example.com/diet-coke.jpg");
  });

  it("prefers an explicit API size when present", () => {
    expect(extractPackageSize({ title: "Example 6 Pack", size: "16 oz" })).toBe("16 oz");
  });

  it("returns undefined rather than junk when no package size exists", () => {
    expect(extractPackageSize({ title: "Generic Retail Product" })).toBeUndefined();
  });
});
