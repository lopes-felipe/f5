import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ICON_IDS } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { APP_ICON_FILE_BY_PLATFORM, BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const desktopAppIconDirs = [
  BRAND_ASSET_PATHS.productionAppIconsDir,
  BRAND_ASSET_PATHS.developmentAppIconsDir,
];

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
    ...desktopAppIconDirs.flatMap((dir) =>
      APP_ICON_IDS.map((id) => `${dir}/${id}/${APP_ICON_FILE_BY_PLATFORM.win}`),
    ),
  ])("%s includes a 256x256 image", (file) => {
    expect(Math.max(...icoImageWidths(file))).toBeGreaterThanOrEqual(256);
  });
});

describe("app icon choices", () => {
  // The recipe's Python table draws the files; the ids people can pick live in TypeScript.
  it("have one folder of desktop files per id, and no others", () => {
    for (const dir of desktopAppIconDirs) {
      expect(readdirSync(join(root, dir)).toSorted()).toEqual(APP_ICON_IDS.toSorted());
      for (const id of APP_ICON_IDS)
        expect(readdirSync(join(root, dir, id)).toSorted()).toEqual(
          Object.values(APP_ICON_FILE_BY_PLATFORM).toSorted(),
        );
    }
  });

  it("have a sidebar image and a tab icon per id, and no others", () => {
    expect(readdirSync(join(root, BRAND_ASSET_PATHS.webAppIconsDir)).toSorted()).toEqual(
      APP_ICON_IDS.flatMap((id) => [`${id}.png`, `${id}-32.png`]).toSorted(),
    );
  });

  it("keep the restored classic artwork they are drawn from", () => {
    expect(existsSync(join(root, "assets/icon-classic.png"))).toBe(true);
  });
});
