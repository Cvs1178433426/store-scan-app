import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "app/store-count/page.tsx"), "utf8");

describe("Store Count rapid camera reliability", () => {
  it("queues a camera barcode detected while another count request is in flight", () => {
    const start = source.indexOf("async function handleCameraBarcode");
    const end = source.indexOf("async function handleBarcode", start);
    const handler = source.slice(start, end);

    expect(source).toContain("const pendingCameraScansRef = useRef<string[]>([])");
    expect(handler).toContain("if (busyRef.current)");
    expect(handler).toContain("pendingCameraScansRef.current.push(barcode)");
    expect(source).toContain("const nextCameraBarcode = pendingCameraScansRef.current.shift()");
  });

  it("uses the normal beep only after the server confirms persistence", () => {
    const start = source.indexOf("async function handleBarcode");
    const end = source.indexOf("async function toggleTorch", start);
    const handler = source.slice(start, end);
    const request = handler.indexOf("const entry = await apiJson<CountEntry>");
    const beep = handler.indexOf("playBeep()", request);

    expect(request).toBeGreaterThanOrEqual(0);
    expect(beep).toBeGreaterThan(request);
  });
});
