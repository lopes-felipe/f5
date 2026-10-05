import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findMissingDependencies } from "./check-dependencies.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeManifest(root: string, relativePath: string, manifest: object): void {
  const path = Path.join(root, relativePath);
  mkdirSync(Path.dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest));
}

function fixture(
  workspaces: object | string[] = { packages: ["apps/*", "packages/*", "scripts"] },
) {
  const root = mkdtempSync(Path.join(OS.tmpdir(), "f5-dependencies-"));
  roots.push(root);
  writeManifest(root, "package.json", {
    type: "module",
    workspaces,
    devDependencies: { turbo: "^2.9.5" },
  });
  writeManifest(root, "node_modules/turbo/package.json", { name: "turbo", version: "2.9.5" });
  return root;
}

describe("dependency preflight", () => {
  it("exits before building with the install command, then succeeds after dependencies are restored", () => {
    const root = fixture();
    writeManifest(root, "apps/web/package.json", {
      dependencies: { "@fontsource-variable/inter": "^5.3.0" },
    });
    const script = Path.join(root, "scripts/check-dependencies.ts");
    mkdirSync(Path.dirname(script), { recursive: true });
    copyFileSync(Path.join(import.meta.dirname, "check-dependencies.ts"), script);
    const run = () => spawnSync(process.execPath, [script], { cwd: OS.tmpdir(), encoding: "utf8" });
    const missing = run();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("apps/web/package.json: @fontsource-variable/inter");
    expect(missing.stderr).toContain("bun install --frozen-lockfile");
    writeManifest(root, "apps/web/node_modules/@fontsource-variable/inter/package.json", {
      name: "@fontsource-variable/inter",
      version: "5.3.0",
    });
    const restored = run();
    expect(restored.status).toBe(0);
    expect(restored.stderr).toBe("");
  });

  it("reports a newly declared asset package before the build and discovers every workspace", () => {
    const root = fixture();
    writeManifest(root, "apps/web/package.json", {
      dependencies: { "@fontsource-variable/inter": "^5.3.0" },
    });
    writeManifest(root, "packages/shared/package.json", { devDependencies: { typescript: "^5" } });
    writeManifest(root, "scripts/package.json", { dependencies: { effect: "catalog:" } });
    expect(findMissingDependencies(root)).toEqual([
      { manifest: "apps/web/package.json", dependency: "@fontsource-variable/inter" },
      { manifest: "packages/shared/package.json", dependency: "typescript" },
      { manifest: "scripts/package.json", dependency: "effect" },
    ]);
  });

  it("accepts an installed CSS-only package even when exports hide package.json", () => {
    const root = fixture();
    writeManifest(root, "apps/web/package.json", {
      dependencies: { "@fontsource-variable/inter": "^5.3.0" },
    });
    writeManifest(root, "apps/web/node_modules/@fontsource-variable/inter/package.json", {
      name: "@fontsource-variable/inter",
      version: "5.3.0",
      exports: { "./index.css": "./index.css" },
    });
    expect(findMissingDependencies(root)).toEqual([]);
  });

  it("supports hoisted dependencies, workspace links, and array workspace declarations", () => {
    const root = fixture(["apps/*", "packages/*"]);
    writeManifest(root, "apps/web/package.json", {
      dependencies: { "@t3tools/shared": "workspace:*", react: "^19" },
    });
    writeManifest(root, "packages/shared/package.json", { name: "@t3tools/shared" });
    writeManifest(root, "node_modules/react/package.json", { name: "react", version: "19.0.0" });
    const scope = Path.join(root, "apps/web/node_modules/@t3tools");
    mkdirSync(scope, { recursive: true });
    symlinkSync(Path.join(root, "packages/shared"), Path.join(scope, "shared"), "junction");
    expect(findMissingDependencies(root)).toEqual([]);
  });

  it("reports broken links and root tools, but permits absent optional dependencies", () => {
    const root = fixture();
    writeManifest(root, "package.json", {
      workspaces: { packages: ["apps/*"] },
      devDependencies: { vite: "^8" },
    });
    writeManifest(root, "apps/web/package.json", {
      dependencies: { react: "^19" },
      optionalDependencies: { "platform-specific-package": "1.0.0" },
    });
    const directory = Path.join(root, "apps/web/node_modules");
    mkdirSync(directory, { recursive: true });
    symlinkSync(Path.join(root, "missing-react"), Path.join(directory, "react"), "junction");
    expect(findMissingDependencies(root)).toEqual([
      { manifest: "package.json", dependency: "vite" },
      { manifest: "apps/web/package.json", dependency: "react" },
    ]);
  });
});
