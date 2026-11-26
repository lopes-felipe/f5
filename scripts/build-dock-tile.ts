import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { APP_ICON_FILE_BY_PLATFORM, BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { DOCK_TILE_EXECUTABLE, DOCK_TILE_PLUGIN } from "./lib/desktop-mac-info.ts";

/**
 * Builds the macOS Dock tile plug-in: the bundle the Dock loads from the app's
 * `Contents/PlugIns` to show the chosen app icon while F5 is not running.
 *
 *   node scripts/build-dock-tile.ts --arch arm64|x64|universal --output <dir> [--check]
 *
 * `--check` also loads the result the way the Dock does and checks that it follows the
 * app's preference (apps/desktop/native/dock-tile/F5DockTileCheck.m).
 */

/** Matches the computer helper (apps/desktop/native/macos/Package.swift). */
const MINIMUM_MACOS = "14.0";

export type DockTileArch = "arm64" | "x64" | "universal";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceDir = join(repoRoot, "apps/desktop/native/dock-tile");
const iconsDir = join(repoRoot, BRAND_ASSET_PATHS.productionAppIconsDir);

/**
 * The default choice (`DEFAULT_APP_ICON_ID`). It has no image in the plug-in: the Dock
 * draws the icon built into the app. Repeated here because this script runs under plain
 * Node, which cannot load the contracts package; build-dock-tile.test.ts compares them.
 */
export const BUILT_IN_CHOICE = "lines";

/** Every generated choice except the default, in a stable order. */
export function dockTileChoices(): string[] {
  return readdirSync(iconsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== BUILT_IN_CHOICE)
    .map((entry) => entry.name)
    .toSorted();
}

function run(step: string, command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`Dock tile plug-in ${step} failed.`);
}

function clangArchFlags(arch: DockTileArch): string[] {
  const targets = arch === "universal" ? ["arm64", "x86_64"] : [arch === "x64" ? "x86_64" : arch];
  return targets.flatMap((target) => ["-arch", target]);
}

const COMPILE_FLAGS = [
  "-fobjc-arc",
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-Wno-unused-parameter",
  `-mmacosx-version-min=${MINIMUM_MACOS}`,
  "-framework",
  "AppKit",
];

/** Writes `<outputDir>/F5DockTile.docktileplugin`, replacing an earlier build, and returns it. */
export function buildDockTile(options: {
  readonly arch: DockTileArch;
  readonly outputDir: string;
}): string {
  if (process.platform !== "darwin")
    throw new Error("The Dock tile plug-in can only be built on macOS.");
  mkdirSync(options.outputDir, { recursive: true });
  // Built aside and renamed, so a failed build never leaves half a bundle behind.
  const work = mkdtempSync(join(options.outputDir, ".f5-dock-tile-build-"));
  try {
    const contents = join(work, DOCK_TILE_PLUGIN, "Contents");
    mkdirSync(join(contents, "MacOS"), { recursive: true });
    mkdirSync(join(contents, "Resources"));
    run("build", "xcrun", [
      "clang",
      "-bundle",
      ...COMPILE_FLAGS,
      ...clangArchFlags(options.arch),
      "-o",
      join(contents, "MacOS", DOCK_TILE_EXECUTABLE),
      join(sourceDir, "F5DockTile.m"),
    ]);
    copyFileSync(join(sourceDir, "Info.plist"), join(contents, "Info.plist"));
    for (const id of dockTileChoices())
      copyFileSync(
        join(iconsDir, id, APP_ICON_FILE_BY_PLATFORM.mac),
        join(contents, "Resources", `${id}.png`),
      );
    const plugIn = join(options.outputDir, DOCK_TILE_PLUGIN);
    rmSync(plugIn, { recursive: true, force: true });
    renameSync(join(work, DOCK_TILE_PLUGIN), plugIn);
    return plugIn;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Loads a built plug-in from a stand-in app, as the Dock would, and exercises it. */
export function checkDockTile(plugIn: string): void {
  const work = mkdtempSync(join(resolve(plugIn, ".."), ".f5-dock-tile-check-"));
  try {
    const app = join(work, "F5DockTileCheck.app");
    mkdirSync(join(app, "Contents/PlugIns"), { recursive: true });
    cpSync(plugIn, join(app, "Contents/PlugIns", DOCK_TILE_PLUGIN), { recursive: true });
    // The check writes a preference under the stand-in app's identifier. Preferences treat
    // an identifier that is an absolute path as the file to use, so naming one in the work
    // folder keeps the check out of ~/Library/Preferences.
    const identifier = join(work, "preferences");
    const xml = (text: string) =>
      text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    writeFileSync(
      join(app, "Contents/Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${xml(identifier)}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>NSDockTilePlugIn</key>
  <string>${DOCK_TILE_PLUGIN}</string>
</dict>
</plist>
`,
    );
    const harness = join(work, "F5DockTileCheck");
    run("check build", "xcrun", [
      "clang",
      ...COMPILE_FLAGS,
      "-o",
      harness,
      join(sourceDir, "F5DockTileCheck.m"),
    ]);
    const [choice, other] = dockTileChoices();
    run("check", harness, [app, choice!, other!]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main(args: readonly string[]): void {
  const value = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const arch = value("--arch") ?? process.arch;
  const outputDir = value("--output");
  if (!outputDir || !["arm64", "x64", "universal"].includes(arch))
    throw new Error("Expected --arch arm64|x64|universal --output <dir> [--check]");
  const plugIn = buildDockTile({ arch: arch as DockTileArch, outputDir: resolve(outputDir) });
  if (!existsSync(join(plugIn, "Contents/MacOS", DOCK_TILE_EXECUTABLE)))
    throw new Error(`The build produced no plug-in at ${plugIn}`);
  if (args.includes("--check")) checkDockTile(plugIn);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
