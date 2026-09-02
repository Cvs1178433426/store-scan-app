import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const BRAND_NAME = "ContinuiXai";
const TAGLINE = "Start simple. Stay in control. Grow with confidence.";
const OLD_VISIBLE_BRAND = /Continuixai Ops|CONTINUIXAI OPS|ContinuixAI Ops|CONTINUIXAI|ContinuixAI/g;

function source(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

function tsxFiles(relativeDir: string): string[] {
  const root = resolve(process.cwd(), relativeDir);
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const absolute = resolve(root, entry);
    const relative = `${relativeDir}/${entry}`;
    if (statSync(absolute).isDirectory()) files.push(...tsxFiles(relative));
    else if (/\.tsx$/.test(entry)) files.push(relative);
  }
  return files;
}

type DecodedPng = {
  width: number;
  height: number;
  colorType: number;
  paletteEntries: number;
  pixels: Buffer;
};

function paeth(left: number, above: number, upperLeft: number) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function decodePng(relativePath: string): DecodedPng {
  const png = readFileSync(resolve(process.cwd(), relativePath));
  expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), relativePath).toBe(true);

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let paletteEntries = 0;
  let sawEnd = false;
  const compressed: Buffer[] = [];

  while (offset < png.length) {
    expect(offset + 12, `${relativePath} has a complete chunk header`).toBeLessThanOrEqual(png.length);
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    expect(dataEnd + 4, `${relativePath} ${type} chunk is complete`).toBeLessThanOrEqual(png.length);
    const data = png.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      expect(data[12], `${relativePath} is not interlaced`).toBe(0);
    } else if (type === "PLTE") {
      paletteEntries = length / 3;
    } else if (type === "IDAT") {
      compressed.push(data);
    } else if (type === "IEND") {
      sawEnd = true;
      offset = dataEnd + 4;
      break;
    }
    offset = dataEnd + 4;
  }

  expect(sawEnd, `${relativePath} contains IEND`).toBe(true);
  expect(offset, `${relativePath} has no trailing partial data`).toBe(png.length);
  expect(bitDepth, `${relativePath} uses 8-bit channels`).toBe(8);
  expect([2, 3, 6], `${relativePath} uses supported RGB, indexed, or RGBA pixels`).toContain(colorType);

  const bytesPerPixel = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const rowLength = width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(compressed));
  expect(inflated.length, `${relativePath} has complete pixel rows`).toBe((rowLength + 1) * height);
  const pixels = Buffer.alloc(rowLength * height);

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[y * (rowLength + 1)];
    expect(filter, `${relativePath} row ${y} uses a valid PNG filter`).toBeLessThanOrEqual(4);
    for (let x = 0; x < rowLength; x += 1) {
      const encoded = inflated[y * (rowLength + 1) + 1 + x];
      const left = x >= bytesPerPixel ? pixels[y * rowLength + x - bytesPerPixel] : 0;
      const above = y > 0 ? pixels[(y - 1) * rowLength + x] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel ? pixels[(y - 1) * rowLength + x - bytesPerPixel] : 0;
      const predictor = filter === 1 ? left
        : filter === 2 ? above
          : filter === 3 ? Math.floor((left + above) / 2)
            : filter === 4 ? paeth(left, above, upperLeft)
              : 0;
      pixels[y * rowLength + x] = (encoded + predictor) & 0xff;
    }
  }

  if (colorType === 3) {
    expect(paletteEntries, `${relativePath} includes a palette`).toBeGreaterThan(0);
    for (const index of pixels) expect(index, `${relativePath} has valid palette indexes`).toBeLessThan(paletteEntries);
  }

  return { width, height, colorType, paletteEntries, pixels };
}

describe("official ContinuiXai brand standard", () => {
  it("defines the exact official name and tagline and wires them into application metadata", () => {
    const brand = source("lib/brand.ts");
    const layout = source("app/layout.tsx");
    const manifest = source("app/manifest.ts");
    expect(brand).toContain(`BRAND_NAME = "${BRAND_NAME}"`);
    expect(brand).toContain(`BRAND_TAGLINE = "${TAGLINE}"`);
    expect(layout).toContain("BRAND_NAME");
    expect(layout).toContain("BRAND_TAGLINE");
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

  it("does not reintroduce an obsolete visible brand name anywhere in rendered web UI source", () => {
    const offenders = [...tsxFiles("app"), ...tsxFiles("components")]
      .filter((path) => {
        OLD_VISIBLE_BRAND.lastIndex = 0;
        return OLD_VISIBLE_BRAND.test(source(path));
      });
    expect(offenders).toEqual([]);
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

  it("ships complete, decodable PWA icons at their declared dimensions", () => {
    const icons = [
      ["public/icons/apple-touch-icon.png", 180],
      ["public/apple-touch-icon.png", 180],
      ["public/icons/icon-192.png", 192],
      ["public/icons/icon-512.png", 512],
      ["public/icons/icon-maskable-512.png", 512],
    ] as const;

    for (const [path, size] of icons) {
      const decoded = decodePng(path);
      expect(decoded.width, path).toBe(size);
      expect(decoded.height, path).toBe(size);
    }

    expect(readFileSync(resolve(process.cwd(), icons[0][0]))).toEqual(
      readFileSync(resolve(process.cwd(), icons[1][0])),
    );
  });

  it("publishes generated brand images atomically", () => {
    const generator = source("scripts/generate-brand-assets.mjs");
    expect(generator).toContain("rename(temporaryPath, outputPath)");
    expect(generator).not.toContain(".toFile(outputPath)");
  });

  it("uses the same branded vector master for manifest and generated icons", () => {
    const icon = source("public/icons/icon.svg");
    const generator = source("scripts/generate-brand-assets.mjs");
    expect(icon).toContain('viewBox="0 0 1024 1024"');
    expect(icon).toContain('linearGradient id="background"');
    expect(generator).toContain('public/icons/icon.svg');
    expect(generator).not.toContain("icon-master.svg");
  });

  it("ships a navy, branded launch experience for current iPhone viewport families", () => {
    const manifest = source("app/manifest.ts");
    const layout = source("app/layout.tsx");
    expect(manifest).toContain('background_color: "#16235A"');
    expect(layout).toContain('statusBarStyle: "black-translucent"');

    const startupImages = [
      ["continuixai-launch-1320x2868.png", 1320, 2868, "440px", "956px", "3"],
      ["continuixai-launch-1206x2622.png", 1206, 2622, "402px", "874px", "3"],
      ["continuixai-launch-1290x2796.png", 1290, 2796, "430px", "932px", "3"],
      ["continuixai-launch-1179x2556.png", 1179, 2556, "393px", "852px", "3"],
      ["continuixai-launch-1242x2688.png", 1242, 2688, "414px", "896px", "3"],
      ["continuixai-launch-828x1792.png", 828, 1792, "414px", "896px", "2"],
      ["continuixai-launch-1125x2436.png", 1125, 2436, "375px", "812px", "3"],
      ["continuixai-launch-750x1334.png", 750, 1334, "375px", "667px", "2"],
    ] as const;

    for (const [filename, width, height, deviceWidth, deviceHeight, ratio] of startupImages) {
      expect(layout, filename).toContain(`/launch/${filename}`);
      expect(layout, filename).toContain(`(device-width: ${deviceWidth}) and (device-height: ${deviceHeight}) and (-webkit-device-pixel-ratio: ${ratio})`);
      const decoded = decodePng(`public/launch/${filename}`);
      expect(decoded.width, filename).toBe(width);
      expect(decoded.height, filename).toBe(height);
    }
  });
});
