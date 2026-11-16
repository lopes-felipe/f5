import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureDependencies,
  findMissingDependencies,
  isInstallStale,
  lockfileFingerprint,
  recordInstall,
} from "./check-dependencies.ts";

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

  it("keeps --install check-only in CI", () => {
    const root = fixture();
    writeManifest(root, "apps/web/package.json", { dependencies: { react: "^19" } });
    writeFileSync(Path.join(root, "bun.lock"), "lock-v1");
    const script = Path.join(root, "scripts/check-dependencies.ts");
    mkdirSync(Path.dirname(script), { recursive: true });
    copyFileSync(Path.join(import.meta.dirname, "check-dependencies.ts"), script);
    const result = spawnSync(process.execPath, [script, "--install"], {
      cwd: OS.tmpdir(),
      encoding: "utf8",
      env: { ...process.env, CI: "1" },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("Running");
    expect(result.stderr).toContain("apps/web/package.json: react");
    expect(existsSync(Path.join(root, STAMP))).toBe(false);
  });
});

const STAMP = "node_modules/.f5-install-stamp";

describe("dependency auto-install", () => {
  function installedFixture() {
    const root = fixture();
    writeManifest(root, "apps/web/package.json", { dependencies: { react: "^19" } });
    writeFileSync(Path.join(root, "bun.lock"), "lock-v1");
    return root;
  }

  function installReact(root: string) {
    writeManifest(root, "node_modules/react/package.json", { name: "react", version: "19.0.0" });
  }

  it("installs missing dependencies and records the lockfile it installed from", () => {
    const root = installedFixture();
    const install = vi.fn(() => {
      installReact(root);
      return true;
    });
    const log = vi.fn();
    expect(ensureDependencies(root, { install, log })).toEqual({
      status: "ready",
      installed: true,
    });
    expect(install).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toContain("missing: apps/web/package.json: react");
    expect(readFileSync(Path.join(root, STAMP), "utf8").trim()).toBe(lockfileFingerprint(root));
    expect(isInstallStale(root)).toBe(false);
  });

  it("reinstalls when bun.lock changes even though every package is present", () => {
    const root = installedFixture();
    installReact(root);
    const install = vi.fn(() => true);
    ensureDependencies(root, { install, log: () => {} });
    expect(install).toHaveBeenCalledOnce();

    expect(ensureDependencies(root, { install, log: () => {} })).toEqual({
      status: "ready",
      installed: false,
    });
    expect(install).toHaveBeenCalledOnce();

    writeFileSync(Path.join(root, "bun.lock"), "lock-v2");
    expect(isInstallStale(root)).toBe(true);
    const log = vi.fn();
    expect(ensureDependencies(root, { install, log })).toEqual({
      status: "ready",
      installed: true,
    });
    expect(install).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]?.[0]).toContain("bun.lock changed since last install");
  });

  it("does not record the install when it fails or leaves packages missing", () => {
    const root = installedFixture();
    expect(ensureDependencies(root, { install: () => false, log: () => {} })).toEqual({
      status: "install-failed",
      missing: [{ manifest: "apps/web/package.json", dependency: "react" }],
    });
    expect(existsSync(Path.join(root, STAMP))).toBe(false);

    expect(ensureDependencies(root, { install: () => true, log: () => {} })).toEqual({
      status: "missing",
      missing: [{ manifest: "apps/web/package.json", dependency: "react" }],
    });
    expect(existsSync(Path.join(root, STAMP))).toBe(false);
  });

  it("drops a current stamp when a repair fails so the next run retries", () => {
    const root = installedFixture();
    recordInstall(root);
    expect(isInstallStale(root)).toBe(false);
    // The install restores the package manifests, then fails partway through.
    const failing = vi.fn(() => {
      installReact(root);
      return false;
    });
    expect(ensureDependencies(root, { install: failing, log: () => {} })).toEqual({
      status: "install-failed",
      missing: [],
    });
    expect(existsSync(Path.join(root, STAMP))).toBe(false);

    const install = vi.fn(() => true);
    ensureDependencies(root, { install, log: () => {} });
    expect(install).toHaveBeenCalledOnce();
  });

  it("tracks installs run outside the preflight through the postinstall record", () => {
    const root = installedFixture();
    installReact(root);
    const install = vi.fn(() => true);
    ensureDependencies(root, { install, log: () => {} });
    expect(install).toHaveBeenCalledOnce();

    // Switch to branch B and install by hand: postinstall records B's lockfile.
    writeFileSync(Path.join(root, "bun.lock"), "lock-branch-b");
    recordInstall(root);
    expect(ensureDependencies(root, { install, log: () => {} })).toEqual({
      status: "ready",
      installed: false,
    });

    // Back on branch A, node_modules still holds B's versions.
    writeFileSync(Path.join(root, "bun.lock"), "lock-v1");
    expect(isInstallStale(root)).toBe(true);
    ensureDependencies(root, { install, log: () => {} });
    expect(install).toHaveBeenCalledTimes(2);
  });
});

describe.skipIf(process.platform === "win32")("dependency auto-install CLI", () => {
  function cliFixture(stub: string) {
    const root = fixture();
    writeManifest(root, "apps/web/package.json", { dependencies: { react: "^19" } });
    writeFileSync(Path.join(root, "bun.lock"), "lock-v1");
    const script = Path.join(root, "scripts/check-dependencies.ts");
    mkdirSync(Path.dirname(script), { recursive: true });
    copyFileSync(Path.join(import.meta.dirname, "check-dependencies.ts"), script);
    const bun = Path.join(root, "bin/bun");
    mkdirSync(Path.dirname(bun), { recursive: true });
    writeFileSync(bun, `#!/bin/sh\necho "$@" > bun-args\n${stub}\n`);
    chmodSync(bun, 0o755);
    const run = (args: string[], env: Record<string, string> = {}) =>
      spawnSync(process.execPath, [script, ...args], {
        cwd: OS.tmpdir(),
        encoding: "utf8",
        env: { ...process.env, CI: "false", npm_execpath: bun, ...env },
      });
    return { root, run };
  }

  const installReactStub =
    'mkdir -p node_modules/react && echo \'{"name":"react"}\' > node_modules/react/package.json';

  it("runs a frozen install with the bun that started the script", () => {
    const { root, run } = cliFixture(installReactStub);
    const result = run(["--install"]);
    expect(result.status).toBe(0);
    expect(readFileSync(Path.join(root, "bun-args"), "utf8").trim()).toBe(
      "install --frozen-lockfile",
    );
    expect(isInstallStale(root)).toBe(false);
  });

  it("continues with a warning when the install fails but nothing is missing", () => {
    const { root, run } = cliFixture("exit 1");
    writeManifest(root, "node_modules/react/package.json", { name: "react" });
    const result = run(["--install"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Continuing with the existing installation");
    expect(existsSync(Path.join(root, STAMP))).toBe(false);
  });

  it("fails when the install fails and packages are missing", () => {
    const { run } = cliFixture("exit 1");
    const result = run(["--install"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("apps/web/package.json: react");
  });

  it("reports why bun could not be started", () => {
    const { root, run } = cliFixture("exit 0");
    const result = run(["--install"], { npm_execpath: Path.join(root, "bin/bun-missing") });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not run");
    expect(result.stderr).toContain("ENOENT");
  });

  it("records the lockfile from the postinstall hook", () => {
    const { root, run } = cliFixture("exit 1");
    const result = run(["--record-install"]);
    expect(result.status).toBe(0);
    expect(readFileSync(Path.join(root, STAMP), "utf8").trim()).toBe(lockfileFingerprint(root));
    expect(existsSync(Path.join(root, "bun-args"))).toBe(false);
  });
});
