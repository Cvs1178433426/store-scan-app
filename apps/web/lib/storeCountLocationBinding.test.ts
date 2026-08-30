import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Store Count camera location binding", () => {
  it("reads the current location through a live ref so a running camera callback cannot keep a stale location", () => {
    const pagePath = fileURLToPath(new URL("../app/store-count/page.tsx", import.meta.url));
    const source = readFileSync(pagePath, "utf8");

    expect(source).toContain("const locationIdRef = useRef");
    expect(source).toContain("locationIdRef.current = locationId");
    expect(source).toContain("const activeLocationId = locationIdRef.current");
    expect(source).toContain("locationId: activeLocationId");
  });
});
