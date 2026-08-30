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
    expect(layout).toContain(BRAND_NAME);
    expect(layout).toContain(TAGLINE);
    expect(layout).not.toMatch(OLD_VISIBLE_BRAND);
  });

  it("uses one shared brand lockup on the primary employee-facing screens", () => {
    for (const path of ["app/login/page.tsx", "app/register/page.tsx", "app/my-work/page.tsx", "app/store-count/page.tsx"]) {
      const text = source(path);
      expect(text, path).toContain("BrandLockup");
      expect(text, path).not.toMatch(OLD_VISIBLE_BRAND);
    }
  });

  it("ships the approved official logo and approved brand colors", () => {
    expect(existsSync(resolve(process.cwd(), "public/brand/continuixai-mark.svg"))).toBe(true);
    const css = source("app/globals.css");
    expect(css).toContain("--brand-navy: #16235a;");
    expect(css).toContain("--brand-teal: #18b5c9;");
    expect(css).toContain("--brand-amber: #f5a623;");
  });
});
