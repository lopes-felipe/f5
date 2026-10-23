import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, realpath, lstat, readlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, isAbsolute, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { readCodeSignature } from "@t3tools/shared/codeSignature";
import type { Identity } from "./model";
import type { Platform } from "./catalog";

const exec = promisify(execFile);
export const hashFile = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
export async function hashTree(root: string, allowBundleLinks = false): Promise<string> {
  const hash = createHash("sha256");
  const canonicalRoot = await realpath(root);
  const field = (value: string) => {
    const bytes = Buffer.from(value);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  };
  async function walk(path: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    )) {
      const full = join(path, entry.name);
      field(relative(root, full));
      if (entry.isSymbolicLink()) {
        if (!allowBundleLinks) throw new Error("Unexpected symbolic link in certification payload");
        const destination = relative(canonicalRoot, await realpath(full));
        if (destination === ".." || destination.startsWith(".." + sep) || isAbsolute(destination))
          throw new Error("Certification bundle link escaped its root");
        // Framework aliases are recorded but not traversed twice or allowed to
        // create cycles. Their real files are hashed at their ordinary paths.
        field("link");
        field(await readlink(full));
      } else if (entry.isDirectory()) {
        field("directory");
        await walk(full);
      } else if (entry.isFile()) {
        field("file");
        field(await hashFile(full));
      } else throw new Error("Unsupported certification payload entry");
    }
  }
  await walk(root);
  return hash.digest("hex");
}
export interface Target {
  readonly repo: string;
  readonly platform: Platform;
  readonly arch?: "arm64" | "x64";
  readonly app?: string;
  readonly helper?: string;
  readonly fixtureDirectory?: string;
}
export function helperPath(target: Target) {
  return (
    target.helper ??
    (target.app
      ? target.platform === "darwin"
        ? join(target.app, "Contents/Resources/native/f5-computer-helper")
        : join(target.app, "resources/native/f5-computer-helper.exe")
      : join(
          target.repo,
          "apps/desktop/dist-native",
          (target.platform === "darwin" ? "mac-" : "win-") + (target.arch ?? process.arch),
          target.platform === "darwin" ? "f5-computer-helper" : "f5-computer-helper.exe",
        ))
  );
}
export async function identify(target: Target): Promise<Identity> {
  if (target.app && target.helper) throw new Error("Installed target cannot replace its helper");
  const files: Record<string, string> = {};
  if (process.platform === target.platform || target.app || target.helper)
    files.helper = await hashFile(helperPath(target));
  if (target.app) {
    const resourceRoot = join(
      target.app,
      target.platform === "darwin" ? "Contents/Resources" : "resources",
    );
    const helper = await realpath(helperPath(target));
    const rel = relative(await realpath(resourceRoot), helper);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("Installed helper escaped resources");
    files["installed-payload"] = await hashTree(target.app, true);
    const executableRoot =
      target.platform === "darwin" ? join(target.app, "Contents/MacOS") : target.app;
    for (const name of (await readdir(executableRoot)).sort()) {
      if (name.endsWith(".exe") || target.platform === "darwin") {
        const file = join(executableRoot, name);
        if ((await lstat(file)).isFile())
          files["app-" + Object.keys(files).length] = await hashFile(file);
      }
    }
  } else if (process.platform === target.platform) {
    files["desktop-main"] = await hashFile(join(target.repo, "apps/desktop/dist-electron/main.js"));
    files["server-bundle"] = await hashFile(join(target.repo, "apps/server/dist/index.mjs"));
    // Hash the served client, including every JS/CSS asset, not only web/dist/index.html.
    files["served-client"] = await hashTree(join(target.repo, "apps/server/dist/client"));
    files["desktop-preload"] = await hashTree(join(target.repo, "apps/desktop/dist-electron"));
    const runtime: unknown = createRequire(join(target.repo, "apps/desktop/package.json"))(
      "electron",
    );
    if (typeof runtime !== "string") throw new Error("Invalid Electron runtime");
    files["electron-runtime"] = await hashTree(
      target.platform === "darwin" ? resolve(dirname(runtime), "../..") : dirname(runtime),
      true,
    );
  }
  files["suite-source"] = await hashTree(join(target.repo, "scripts/computer-certification"));
  if (target.fixtureDirectory && process.platform === target.platform)
    files["prepared-fixtures"] = await hashTree(target.fixtureDirectory, true);
  files["chromium-fixture-source"] = await hashTree(
    join(target.repo, "apps/desktop/native/electron"),
  );
  files["windows-fixture-source"] = await hashTree(
    join(target.repo, "apps/desktop/native/windows/fixture/src"),
  );
  for (const name of ["Cargo.toml", "Cargo.lock"])
    files["windows-fixture-" + name.replace(".", "-")] = await hashFile(
      join(target.repo, "apps/desktop/native/windows/fixture", name),
    );
  files["electron-runner"] = await hashFile(
    join(target.repo, "apps/desktop/scripts/rehearse-computer-electron.mjs"),
  );
  files["profile-isolation-runner"] = await hashFile(
    join(target.repo, "apps/desktop/scripts/rehearse-computer-profile-isolation.mjs"),
  );
  // These development observer modules are loaded directly, outside the app bundles.
  for (const name of [
    "rehearsalExternalClient",
    "rehearsalElectronObservation",
    "rehearsalMcpTransport",
    "rehearsalFixture",
    "rehearsalResponses",
    "rehearsalProfileIsolation",
  ])
    files[name] = await hashFile(join(target.repo, "apps/desktop/src/computer", name + ".ts"));
  files["profile-limits"] = await hashFile(
    join(target.repo, "packages/shared/src/computerRehearsalProfiles.ts"),
  );
  files["native-fixtures"] = await hashTree(
    join(
      target.repo,
      "apps/desktop/native",
      target.platform === "darwin" ? "macos/Fixtures" : "windows/src",
    ),
  );
  const commit = (await exec("git", ["rev-parse", "HEAD"], { cwd: target.repo })).stdout.trim();
  const dirty = Boolean(
    (await exec("git", ["status", "--porcelain"], { cwd: target.repo })).stdout.trim(),
  );
  // A boolean dirty flag cannot detect edits made between two observations.
  // Pin tracked source changes, not just the compiled artifacts.
  files["tracked-code-diff"] = createHash("sha256")
    .update(
      (
        await exec("git", ["diff", "HEAD", "--binary", "--", ".", ":!docs"], {
          cwd: target.repo,
          maxBuffer: 16 * 1024 * 1024,
        })
      ).stdout,
    )
    .digest("hex");
  return {
    platform: target.platform,
    arch: target.arch ?? process.arch,
    commit,
    dirty,
    target: target.app ? "installed" : "development",
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b, "en"))),
  };
}
export async function signature(path: string, platform: Platform): Promise<boolean> {
  if (process.platform !== platform) return false;
  if (platform === "darwin") return (await readCodeSignature(resolve(path))).ok;
  try {
    await exec("signtool", ["verify", "/pa", resolve(path)], { timeout: 10000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
