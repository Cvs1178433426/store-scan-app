import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Store Count camera location binding", () => {
  it("reads the current location through a live ref so a running camera callback cannot keep a stale location", () => {
    const source = readFileSync(resolve(process.cwd(), "app/store-count/page.tsx"), "utf8");

    expect(source).toContain("const locationIdRef = useRef");
    expect(source).toContain("locationIdRef.current = locationId");
    expect(source).toContain("const activeLocationId = locationIdRef.current");
    expect(source).toContain("locationId: activeLocationId");
  });
});
