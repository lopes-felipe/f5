import { cp, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { cleanEnvironment } from "./process";

export const ELECTRON_FIXTURE_BUNDLE = "ChromiumFixture.app";
export const ELECTRON_FIXTURE_FILES = ["fixture.cjs", "preload.cjs", "fixture.html"] as const;

/** Copies a development runtime into a separate synthetic app, never the F5 app.
 * No Electron process, window, accessibility request or input is started here. */
export async function prepareElectronFixture(repo: string, directory: string) {
  if (process.platform === "win32") {
    const runtime: unknown = createRequire(join(repo, "apps/desktop/package.json"))("electron");
    if (typeof runtime !== "string") return false;
    const bundle = join(directory, "ChromiumFixture");
    await cp(dirname(runtime), bundle, { recursive: true, errorOnExist: true, force: false });
    await copyFile(runtime, join(bundle, "f5-chromium-fixture.exe"));
    const app = join(bundle, "resources/app");
    await mkdir(app, { recursive: true });
    for (const name of ELECTRON_FIXTURE_FILES)
      await cp(join(repo, "apps/desktop/native/electron", name), join(app, name), {
        errorOnExist: true,
        force: false,
      });
    await writeFile(
      join(app, "package.json"),
      JSON.stringify({
        name: "computer-certification-fixture",
        version: "1.0.0",
        main: "fixture.cjs",
      }),
      { flag: "wx" },
    );
    await writeFile(
      join(directory, "electron-fixture.json"),
      JSON.stringify({
        version: 1,
        platform: "win32",
        appId: "f5-chromium-fixture.exe",
        bundle: "ChromiumFixture",
      }),
      { flag: "wx" },
    );
    return true;
  }
  if (process.platform !== "darwin") return false;
  const runtime: unknown = createRequire(join(repo, "apps/desktop/package.json"))("electron");
  if (typeof runtime !== "string") return false;
  const bundle = join(directory, ELECTRON_FIXTURE_BUNDLE);
  const contents = join(bundle, "Contents");
  const exec = promisify(execFile);
  await cp(resolve(dirname(runtime), "../.."), bundle, {
    recursive: true,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true,
  });
  const id = "org.example.chromium-computer-fixture." + randomUUID();
  // Only this copied, suite-owned development bundle is edited and ad-hoc
  // signed. This is neither installed-candidate signing nor TCC evidence.
  for (const [key, value] of [
    ["CFBundleIdentifier", id],
    ["CFBundleName", "Chromium Computer Control Fixture"],
    ["CFBundleDisplayName", "Chromium Computer Control Fixture"],
  ])
    await exec(
      "/usr/bin/plutil",
      ["-replace", key!, "-string", value!, join(contents, "Info.plist")],
      {
        env: cleanEnvironment(),
        timeout: 5000,
        maxBuffer: 4096,
      },
    );
  const app = join(contents, "Resources/app");
  await mkdir(app, { recursive: true });
  for (const name of ELECTRON_FIXTURE_FILES)
    await cp(join(repo, "apps/desktop/native/electron", name), join(app, name), {
      errorOnExist: true,
      force: false,
    });
  await writeFile(
    join(app, "package.json"),
    JSON.stringify({
      name: "computer-certification-fixture",
      version: "1.0.0",
      main: "fixture.cjs",
    }),
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(
    join(directory, "electron-fixture.json"),
    JSON.stringify({
      version: 1,
      appId: id,
      bundle: ELECTRON_FIXTURE_BUNDLE,
    }),
    { flag: "wx", mode: 0o600 },
  );
  await exec("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle], {
    env: cleanEnvironment(),
    timeout: 60000,
    maxBuffer: 4096,
  });
  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], {
    env: cleanEnvironment(),
    timeout: 10000,
    maxBuffer: 4096,
  });
  // Syntax-only checks use Node, never launch the Electron fixture.
  for (const name of ["fixture.cjs", "preload.cjs"])
    await exec("node", ["--check", join(app, name)], {
      env: cleanEnvironment(),
      timeout: 5000,
      maxBuffer: 4096,
    });
  return (await readFile(join(contents, "Info.plist"), "utf8")).includes(id);
}
