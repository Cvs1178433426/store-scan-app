import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("professional home experience", () => {
  it("makes Count the primary action while preserving the existing work destinations", () => {
    const page = source("app/page.tsx");
    expect(page).toContain('import styles from "./home.module.css"');
    expect(page).toContain("Start or resume Count");
    expect(page).toContain('className={styles.primaryAction}');
    expect(page).toContain('className={styles.secondaryAction}');
    for (const route of ["/store-count", "/my-work", "/store-products", "/store-locations"]) {
      expect(page, route).toContain(`href: "${route}"`);
    }
    expect(page).not.toContain("style={{");
  });

  it("provides coherent accessible loading and signed-out opening states", () => {
    const page = source("app/page.tsx");
    expect(page).toContain('aria-live="polite"');
    expect(page).toContain("Preparing your workspace");
    expect(page).toContain("Inventory confidence starts here.");
    expect(page).toContain("Inventory, counting, and team operations—organized in one place.");
    expect(page).toContain('href="/login"');
  });

  it("uses accessible decorative glyphs without adding an icon dependency", () => {
    const glyphPath = resolve(process.cwd(), "components/HomeGlyph.tsx");
    expect(existsSync(glyphPath)).toBe(true);
    if (!existsSync(glyphPath)) return;
    const glyph = source("components/HomeGlyph.tsx");
    expect(glyph).toContain('aria-hidden="true"');
    expect(glyph).toContain("focusable=\"false\"");
    expect(glyph).toContain('viewBox="0 0 24 24"');
  });

  it("does not show protected navigation on the signed-out opening screen", () => {
    const navigation = source("components/BottomNav.tsx");
    expect(navigation).toContain("if (!user || PUBLIC_AUTH_ROUTES.has(pathname)");
  });

  it("honors explicit light and dark theme choices independently of the system theme", () => {
    const css = source("app/home.module.css");
    expect(css).toContain(':global(:root[data-theme="light"]) .welcomeScreen');
    expect(css).toContain(':global(:root[data-theme="dark"]) .welcomeScreen');
  });
});
