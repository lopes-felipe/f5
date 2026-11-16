import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Widths of the images in an ICO directory; a stored 0 means 256. */
function icoImageWidths(file: string): number[] {
  const bytes = readFileSync(join(root, file));
  expect(bytes.readUInt16LE(2)).toBe(1);
  return Array.from({ length: bytes.readUInt16LE(4) }, (_, index) => bytes[6 + 16 * index] || 256);
}

describe("Windows icons", () => {
  // electron-builder 26 rejects Windows icons whose largest image is under 256x256.
  it.each([
    BRAND_ASSET_PATHS.productionWindowsIconIco,
    BRAND_ASSET_PATHS.developmentWindowsIconIco,
  ])("%s includes a 256x256 image", (file) => {
    expect(Math.max(...icoImageWidths(file))).toBeGreaterThanOrEqual(256);
  });
});
