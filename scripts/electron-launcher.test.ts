import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "f5-electron-launcher-")));
  roots.push(root);
  const desktop = join(root, "apps/desktop");
  const source = join(root, "electron/Electron.app");
  const binary = join(source, "Contents/MacOS/Electron");
  const framework = "Contents/Frameworks/Electron Framework.framework";
  const resources = `${framework}/Versions/A/Resources`;
  const write = (path: string, value: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  };
  write(binary, "electron");
  mkdirSync(join(source, "Contents/Resources"), { recursive: true });
  write(join(source, resources, "icudtl.dat"), "icu-data");
  write(
    join(source, "Contents/Info.plist"),
    '<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>',
  );
  symlinkSync("A", join(source, framework, "Versions/Current"));
  symlinkSync("Versions/Current/Resources", join(source, framework, "Resources"));
  const icon = join(desktop, "resources/icon.icns");
  write(icon, "old-icon");
  write(
    join(desktop, "node_modules/electron/index.js"),
    `module.exports=${JSON.stringify(binary)}`,
  );
  const launcher = join(desktop, "scripts/electron-launcher.mjs");
  mkdirSync(dirname(launcher), { recursive: true });
  copyFileSync(
    resolve(import.meta.dirname, "../apps/desktop/scripts/electron-launcher.mjs"),
    launcher,
  );
  const launch = (development = false) => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {resolveElectronPath} from ${JSON.stringify(launcher)}; console.log(resolveElectronPath());`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, VITE_DEV_SERVER_URL: development ? "http://localhost:5733" : "" },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    return resolve(result.stdout.trim(), "../../..");
  };
  return { desktop, source, binary, framework, resources, icon, launch };
}

describe.skipIf(process.platform !== "darwin")("macOS Electron launcher", () => {
  it("keeps framework links relative and ICU data inside the copied app under Node", () => {
    const h = fixture();
    const app = h.launch();
    expect(readlinkSync(join(app, h.framework, "Versions/Current"))).toBe("A");
    expect(readlinkSync(join(app, h.framework, "Resources"))).toBe("Versions/Current/Resources");
    renameSync(h.source, `${h.source}.moved`);
    expect(readFileSync(join(app, h.framework, "Resources/icudtl.dat"), "utf8")).toBe("icu-data");
  });

  it("rebuilds a cached launcher made with the old symlink copy behavior", () => {
    const h = fixture();
    const app = join(h.desktop, ".electron-runtime/F5.app");
    mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
    writeFileSync(join(app, "Contents/MacOS/Electron"), "stale-binary");
    writeFileSync(
      join(h.desktop, ".electron-runtime/metadata.json"),
      JSON.stringify({
        launcherVersion: 2,
        sourceAppBundlePath: h.source,
        sourceAppMtimeMs: statSync(h.source).mtimeMs,
        iconMtimeMs: statSync(h.icon).mtimeMs,
      }),
    );
    expect(h.launch()).toBe(app);
    expect(readFileSync(join(app, "Contents/MacOS/Electron"), "utf8")).toBe("electron");
    expect(readlinkSync(join(app, h.framework, "Resources"))).toBe("Versions/Current/Resources");
  });

  it("does not let the development cache hide a stale start launcher", () => {
    const h = fixture();
    const app = h.launch();
    const mtime = statSync(h.icon).mtimeMs + 2000;
    writeFileSync(h.icon, "updated-icon");
    utimesSync(h.icon, mtime / 1000, mtime / 1000);
    h.launch(true);
    h.launch();
    expect(readFileSync(join(app, "Contents/Resources/icon.icns"), "utf8")).toBe("updated-icon");
  });
});
