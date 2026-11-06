import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import rootPackageJson from "../package.json" with { type: "json" };
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };
import { stagedDesktopDependencies, type DesktopStagePlatform } from "./lib/desktop-stage.ts";
import { seedStagedLockfile, verifyStagedLockfile } from "./verify-staged-lockfile.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const rootLock = readFileSync(new URL("../bun.lock", import.meta.url), "utf8");
const parse = (text: string) =>
  ts.parseConfigFileTextToJson("bun.lock", text).config as {
    packages: Record<string, [string, ...unknown[]]>;
  };

// The release builds' desktop targets. Resolution must come from the seeded root
// lock alone: an unreachable registry fails the test instead of drifting.
describe.each([
  ["mac", "arm64"],
  ["mac", "x64"],
  ["win", "x64"],
  ["linux", "x64"],
] as const)("staged %s-%s desktop dependencies", (platform, arch) => {
  it("resolve offline to exactly the root-locked versions", { timeout: 120_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "f5-desktop-stage-"));
    roots.push(dir);
    const manifest = {
      name: "f5-desktop",
      version: "0.0.0",
      private: true,
      dependencies: stagedDesktopDependencies({
        platform: platform as DesktopStagePlatform,
        arch,
        serverDependencies: serverPackageJson.dependencies,
        desktopDependencies: desktopPackageJson.dependencies,
        catalog: rootPackageJson.workspaces.catalog,
      }),
      devDependencies: { electron: desktopPackageJson.dependencies.electron },
      overrides: rootPackageJson.overrides,
    };
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "bun.lock"), seedStagedLockfile(rootLock, manifest));
    const result = spawnSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        BUN_CONFIG_REGISTRY: "http://127.0.0.1:9/",
        NPM_CONFIG_REGISTRY: "http://127.0.0.1:9/",
      },
      shell: process.platform === "win32",
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const staged = readFileSync(join(dir, "bun.lock"), "utf8");
    verifyStagedLockfile(rootLock, staged);
    const root = parse(rootLock).packages;
    const resolved = parse(staged).packages;
    if (platform === "linux") {
      expect(manifest.dependencies["dbus-next"]).toBe(desktopPackageJson.dependencies["dbus-next"]);
      expect(resolved["dbus-next"]).toBeDefined();
      expect(resolved.usocket).toBeDefined();
    } else {
      expect(manifest.dependencies).not.toHaveProperty("dbus-next");
      expect(
        Object.keys(resolved).filter((name) => /(^|\/)(dbus-next|usocket)(\/|$)/.test(name)),
      ).toEqual([]);
    }
    for (const name of Object.keys(manifest.dependencies))
      expect(resolved[name]?.[0], name).toBe(root[name]?.[0]);
  });
});
