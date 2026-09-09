import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(scriptDir, "..");
const iconMaster = resolve(webDir, "public/icons/icon.svg");

async function writeAtomically(outputPath, data) {
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, data);
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function generatePng(sourcePath, outputPath, width, height, fit = "fill") {
  const png = await sharp(sourcePath, { density: 192 })
    .resize(width, height, { fit, position: "centre" })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
  const metadata = await sharp(png).metadata();
  if (metadata.width !== width || metadata.height !== height || metadata.format !== "png") {
    throw new Error(`Invalid generated PNG for ${outputPath}`);
  }
  await writeAtomically(outputPath, png);
}

const appleIcon = resolve(webDir, "public/icons/apple-touch-icon.png");
await generatePng(iconMaster, appleIcon, 180, 180);
await writeAtomically(resolve(webDir, "public/apple-touch-icon.png"), await readFile(appleIcon));
await generatePng(iconMaster, resolve(webDir, "public/icons/icon-192.png"), 192, 192);
await generatePng(iconMaster, resolve(webDir, "public/icons/icon-512.png"), 512, 512);
await generatePng(iconMaster, resolve(webDir, "public/icons/icon-maskable-512.png"), 512, 512);

const launchMaster = resolve(webDir, "public/launch/continuixai-launch.svg");
const launchSizes = [
  [1320, 2868],
  [1206, 2622],
  [1290, 2796],
  [1179, 2556],
  [1242, 2688],
  [828, 1792],
  [1125, 2436],
  [750, 1334],
];

for (const [width, height] of launchSizes) {
  await generatePng(
    launchMaster,
    resolve(webDir, `public/launch/continuixai-launch-${width}x${height}.png`),
    width,
    height,
    "cover",
  );
}
