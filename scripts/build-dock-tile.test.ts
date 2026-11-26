import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { APP_ICON_IDS, DEFAULT_APP_ICON_ID } from "@t3tools/contracts";

import { BUILT_IN_CHOICE, buildDockTile, dockTileChoices } from "./build-dock-tile.ts";
import { DOCK_TILE_EXECUTABLE, DOCK_TILE_PLUGIN } from "./lib/desktop-mac-info.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = (file: string) =>
  readFileSync(join(root, "apps/desktop/native/dock-tile", file), "utf8");

it("gives the plug-in an image for every choice except the built-in one", () => {
  expect(BUILT_IN_CHOICE).toBe(DEFAULT_APP_ICON_ID);
  expect(dockTileChoices()).toEqual(
    APP_ICON_IDS.filter((id) => id !== DEFAULT_APP_ICON_ID).toSorted(),
  );
});

it("lets every choice through the plug-in's id rule", () => {
  const plugIn = source("F5DockTile.m");
  const characters = /F5ChoiceCharacters = @"([^"]+)"/.exec(plugIn)?.[1];
  const maxLength = Number(/F5ChoiceMaxLength = (\d+);/.exec(plugIn)?.[1]);
  expect(characters).toBeDefined();
  // Path separators and dots must never reach the plug-in's file lookup.
  expect(characters).not.toMatch(/[./\\]/);
  for (const id of APP_ICON_IDS) {
    expect(
      [...id].every((character) => characters!.includes(character)),
      id,
    ).toBe(true);
    expect(id.length, id).toBeLessThanOrEqual(maxLength);
  }
});

it("names the plug-in's executable and principal class as the bundle declares them", () => {
  const info = source("Info.plist").replace(/>\s+</g, "><");
  expect(info).toContain(`<key>CFBundleExecutable</key><string>${DOCK_TILE_EXECUTABLE}</string>`);
  expect(info).toContain("<key>CFBundlePackageType</key><string>BNDL</string>");
  expect(info).toContain("<key>NSPrincipalClass</key><string>F5DockTile</string>");
  expect(source("F5DockTile.m")).toContain("@interface F5DockTile : NSObject <NSDockTilePlugIn>");
});

// Needs Apple's toolchain. CI also runs `build-dock-tile.ts --check` on its macOS runner.
describe.runIf(process.platform === "darwin")("building the Dock tile plug-in", () => {
  it("writes a loadable bundle for both architectures with its Info.plist and images", () => {
    const output = mkdtempSync(join(tmpdir(), "f5-dock-tile-"));
    try {
      const plugIn = buildDockTile({ arch: "universal", outputDir: output });
      expect(plugIn).toBe(join(output, DOCK_TILE_PLUGIN));
      expect(readdirSync(output)).toEqual([DOCK_TILE_PLUGIN]);
      expect(readdirSync(join(plugIn, "Contents")).toSorted()).toEqual([
        "Info.plist",
        "MacOS",
        "Resources",
      ]);
      expect(readFileSync(join(plugIn, "Contents/Info.plist"), "utf8")).toBe(source("Info.plist"));
      expect(readdirSync(join(plugIn, "Contents/Resources")).toSorted()).toEqual(
        dockTileChoices().map((id) => `${id}.png`),
      );
      for (const id of dockTileChoices())
        expect(readFileSync(join(plugIn, "Contents/Resources", `${id}.png`))).toEqual(
          readFileSync(join(root, "assets/prod/app-icons", id, "macos.png")),
        );

      const executable = join(plugIn, "Contents/MacOS", DOCK_TILE_EXECUTABLE);
      const kind = spawnSync("file", [executable], { encoding: "utf8" }).stdout;
      expect(kind).toContain("Mach-O 64-bit bundle arm64");
      expect(kind).toContain("Mach-O 64-bit bundle x86_64");

      // A second build replaces the first instead of nesting or failing.
      buildDockTile({ arch: "arm64", outputDir: output });
      expect(readdirSync(output)).toEqual([DOCK_TILE_PLUGIN]);
      const rebuilt = spawnSync("file", [executable], { encoding: "utf8" }).stdout;
      expect(rebuilt).toContain("Mach-O 64-bit bundle arm64");
      expect(rebuilt).not.toContain("x86_64");
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  }, 120_000);
});
