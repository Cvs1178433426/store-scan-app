import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BRAND_NAME = "ContinuiXai";
const TAGLINE = "Start simple. Stay in control. Grow with confidence.";
const OLD_VISIBLE_BRAND = /Continuixai Ops|CONTINUIXAI OPS|ContinuixAI Ops|CONTINUIXAI|ContinuixAI/g;

function source(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("official ContinuiXai brand standard", () => {
  it("uses the exact official name and tagline in application metadata", () => {
    const layout = source("app/layout.tsx");
    const manifest = source("app/manifest.ts");
    expect(layout).toContain(BRAND_NAME);
    expect(layout).toContain(TAGLINE);
    expect(layout).not.toMatch(OLD_VISIBLE_BRAND);
    expect(manifest).toContain("BRAND_NAME");
    expect(manifest).toContain("BRAND_TAGLINE");
    expect(manifest).not.toMatch(OLD_VISIBLE_BRAND);
  });

  it("uses one shared brand lockup on the primary employee-facing screens", () => {
    for (const path of ["app/login/page.tsx", "app/register/page.tsx", "app/my-work/page.tsx", "app/store-count/page.tsx"]) {
      const text = source(path);
      expect(text, path).toContain("BrandLockup");
      expect(text, path).not.toMatch(OLD_VISIBLE_BRAND);
    }
  });

  it("ships the approved official logo, PWA icons, and approved brand colors", () => {
    for (const path of [
      "public/brand/continuixai-mark.svg",
      "public/icons/icon.svg",
      "public/icons/icon-192.png",
      "public/icons/icon-512.png",
      "public/icons/icon-maskable-512.png",
      "public/icons/apple-touch-icon.png",
    ]) expect(existsSync(resolve(process.cwd(), path)), path).toBe(true);

    const mark = source("public/brand/continuixai-mark.svg");
    expect(mark).toContain("#16235A");
    expect(mark).toContain("#18B5C9");
    expect(mark).toContain("#F5A623");

    const css = source("app/brand.css");
    expect(css).toContain("--brand-navy: #16235a;");
    expect(css).toContain("--brand-teal: #18b5c9;");
    expect(css).toContain("--brand-amber: #f5a623;");
  });
});
