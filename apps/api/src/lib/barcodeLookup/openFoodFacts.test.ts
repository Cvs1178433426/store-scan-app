import { describe, expect, it } from "vitest";
import { normalizeOpenFoodFactsProduct } from "./openFoodFacts.js";

describe("Open Food Facts normalization", () => {
  it("maps product data into Store Scan fields", () => {
    const result = normalizeOpenFoodFactsProduct({
      product_name: "Sparkling Water",
      brands: "Example Brand",
      generic_name: "Carbonated mineral water",
      quantity: "12 x 355 mL",
      categories: "Beverages, Waters, Sparkling waters",
      image_front_url: "https://example.com/water.jpg",
    });

    expect(result.name).toBe("Sparkling Water");
    expect(result.brand).toBe("Example Brand");
    expect(result.description).toBe("Carbonated mineral water");
    expect(result.size).toBe("12 x 355 mL");
    expect(result.category).toContain("Beverages");
    expect(result.imageUrl).toBe("https://example.com/water.jpg");
  });

  it("falls back to English names and category tags", () => {
    const result = normalizeOpenFoodFactsProduct({
      product_name: " ",
      product_name_en: "Fallback Product",
      categories_tags: ["en:snacks"],
    });

    expect(result.name).toBe("Fallback Product");
    expect(result.category).toBe("en:snacks");
  });
});
