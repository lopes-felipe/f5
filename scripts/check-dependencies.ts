import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

interface PackageManifest {
  readonly name?: string;
  readonly workspaces?: ReadonlyArray<string> | { readonly packages: ReadonlyArray<string> };
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

export interface MissingDependency {
  readonly manifest: string;
  readonly dependency: string;
}

export type EnsureDependenciesResult =
  | { readonly status: "ready"; readonly installed: boolean }
  | { readonly status: "install-failed"; readonly missing: ReadonlyArray<MissingDependency> }
  | { readonly status: "missing"; readonly missing: ReadonlyArray<MissingDependency> };

const INSTALL_COMMAND = "bun install --frozen-lockfile";
const INSTALL_STAMP = Path.join("node_modules", ".f5-install-stamp");
const ROOT_WORKSPACE = "@t3tools/monorepo";

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

function isInstalled(root: string, directory: string, dependency: string): boolean {
  // Check manifests directly: asset-only packages need no JavaScript entry point,
  // and package exports may hide package.json from require.resolve.
  for (let current = directory; ; current = Path.dirname(current)) {
    if (existsSync(Path.join(current, "node_modules", dependency, "package.json"))) return true;
    if (current === root || Path.dirname(current) === current) return false;
  }
}

/** Resolve the requested workspaces and their local dependency closure. */
function workspaceManifests(root: string, requested: readonly string[]): readonly string[] {
  const manifest = readManifest(Path.join(root, "package.json"));
  const workspaces = manifest.workspaces;
  const patterns =
    workspaces && "packages" in workspaces ? workspaces.packages : (workspaces ?? []);
  const manifests = [
    "package.json",
    ...globSync(
      patterns.map((pattern) => `${pattern}/package.json`),
      { cwd: root },
    )
      .map((path) => path.split(Path.sep).join("/"))
      .sort(),
  ];
  if (requested.length === 0) return manifests;

  const byName = new Map(manifests.map((path) => [readManifest(Path.join(root, path)).name, path]));
  const selected = new Set<string>();
  function include(name: string): void {
    const path = byName.get(name);
    if (path === undefined) throw new Error(`Unknown workspace: ${name}`);
    if (selected.has(path)) return;
    selected.add(path);
    const manifest = readManifest(Path.join(root, path));
    for (const [dependency, version] of Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })) {
      if (version.startsWith("workspace:")) include(dependency);
    }
  }
  for (const name of requested) include(name);
  return [...selected].sort();
}

export function findMissingDependencies(
  repositoryRoot: string,
  requested: readonly string[] = [],
): ReadonlyArray<MissingDependency> {
  const root = Path.resolve(repositoryRoot);
  const missing: MissingDependency[] = [];
  for (const relativePath of workspaceManifests(root, requested)) {
    const absolutePath = Path.join(root, relativePath);
    const workspace = readManifest(absolutePath);
    const dependencies = { ...workspace.dependencies, ...workspace.devDependencies };
    for (const dependency of Object.keys(dependencies).sort()) {
      if (!isInstalled(root, Path.dirname(absolutePath), dependency)) {
        missing.push({ manifest: relativePath, dependency });
      }
    }
  }
  return missing;
}

export function lockfileFingerprint(repositoryRoot: string): string | undefined {
  const lockfile = Path.join(repositoryRoot, "bun.lock");
  if (!existsSync(lockfile)) return undefined;
  return createHash("sha256").update(readFileSync(lockfile)).digest("hex");
}

// Presence checks miss version bumps of packages that are already installed, so
// the stamp records which lockfile the current node_modules was installed from.
// The root postinstall script refreshes it after every `bun install`, including
// ones run by hand.
export function isInstallStale(repositoryRoot: string, requested: readonly string[] = []): boolean {
  const fingerprint = lockfileFingerprint(repositoryRoot);
  if (fingerprint === undefined) return false;
  const stamp = Path.join(repositoryRoot, INSTALL_STAMP);
  if (!existsSync(stamp)) return true;
  const [installedFingerprint, ...manifests] = readFileSync(stamp, "utf8").trim().split("\n");
  if (installedFingerprint !== fingerprint) return true;
  const installed = new Set(manifests);
  return workspaceManifests(repositoryRoot, requested).some((path) => !installed.has(path));
}

export function recordInstall(repositoryRoot: string, requested: readonly string[] = []): void {
  const fingerprint = lockfileFingerprint(repositoryRoot);
  if (fingerprint === undefined) return;
  const stamp = Path.join(repositoryRoot, INSTALL_STAMP);
  mkdirSync(Path.dirname(stamp), { recursive: true });
  const manifests = workspaceManifests(repositoryRoot, requested);
  writeFileSync(stamp, [fingerprint, ...manifests, ""].join("\n"));
}

function formatMissing(missing: ReadonlyArray<MissingDependency>): string {
  return missing.map(({ manifest, dependency }) => `${manifest}: ${dependency}`).join(", ");
}

function missingForInstall(root: string, requested: readonly string[], requireElectron: boolean) {
  const missing = findMissingDependencies(root, requested);
  if (!requireElectron) return missing;
  const electron = Path.join(root, "apps/desktop/node_modules/electron");
  const executable = Path.join(electron, "path.txt");
  const entry = existsSync(executable) ? readFileSync(executable, "utf8").trim() : "";
  const override = process.env.ELECTRON_OVERRIDE_DIST_PATH;
  if (override && existsSync(Path.join(override, entry || "electron"))) return missing;
  if (!override && entry && existsSync(Path.join(electron, "dist", entry))) return missing;
  return [...missing, { manifest: "apps/desktop/package.json", dependency: "Electron executable" }];
}

export function ensureDependencies(
  repositoryRoot: string,
  options: {
    readonly install: () => boolean;
    readonly log?: (message: string) => void;
    readonly workspaces?: readonly string[];
    readonly requireElectron?: boolean;
  },
): EnsureDependenciesResult {
  const root = Path.resolve(repositoryRoot);
  const log = options.log ?? console.log;
  const requested = options.workspaces ?? [];
  const missing = missingForInstall(root, requested, options.requireElectron === true);
  if (missing.length === 0 && !isInstallStale(root, requested)) {
    return { status: "ready", installed: false };
  }
  const reason =
    missing.length > 0
      ? `missing: ${formatMissing(missing)}`
      : "the install stamp does not cover the current bun.lock and requested workspaces";
  log(`Dependencies are out of date (${reason}). Running \`${INSTALL_COMMAND}\`...`);
  // A failed install can leave a partial tree behind, so drop the stamp until one succeeds.
  rmSync(Path.join(root, INSTALL_STAMP), { force: true });
  const succeeded = options.install();
  const remaining = missingForInstall(root, requested, options.requireElectron === true);
  if (!succeeded) return { status: "install-failed", missing: remaining };
  if (remaining.length > 0) return { status: "missing", missing: remaining };
  recordInstall(root, requested);
  return { status: "ready", installed: true };
}

function reportMissing(missing: ReadonlyArray<MissingDependency>): void {
  console.error("Dependencies are missing from the local installation:");
  for (const { manifest, dependency } of missing) {
    console.error(`  ${manifest}: ${dependency}`);
  }
  console.error(`\nRun \`${INSTALL_COMMAND}\` from the repository root, then retry.`);
}

function bunExecutable(): string {
  const execPath = process.env.npm_execpath;
  return execPath && Path.basename(execPath).startsWith("bun") ? execPath : "bun";
}

function runBunInstall(root: string, requested: readonly string[]): boolean {
  const bun = bunExecutable();
  const windows = process.platform === "win32";
  const filters = workspaceManifests(root, requested).flatMap((path) => {
    if (requested.length === 0) return [];
    const name = readManifest(Path.join(root, path)).name;
    return name === undefined ? [] : [`--filter=${name}`];
  });
  const result = spawnSync(
    windows ? `"${bun}"` : bun,
    ["install", "--frozen-lockfile", ...filters],
    {
      cwd: root,
      stdio: "inherit",
      // Windows needs shell mode to resolve .cmd shims (e.g. bun.cmd).
      shell: windows,
      env: { ...process.env, F5_INSTALL_WORKSPACES: requested.join(",") },
    },
  );
  if (result.error) console.error(`Could not run ${bun}: ${result.error.message}`);
  return result.status === 0;
}

function isCi(): boolean {
  const value = process.env.CI?.trim().toLowerCase();
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

if (import.meta.main) {
  const root = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), "..");
  const requireElectron =
    process.argv.includes("--require-electron") && process.env.F5_SKIP_ELECTRON_INSTALL !== "1";
  const requested = process.argv
    .filter((arg) => arg.startsWith("--workspace="))
    .map((arg) => arg.slice("--workspace=".length));
  if (process.argv.includes("--postinstall") || process.argv.includes("--record-install")) {
    const installed = (process.env.F5_INSTALL_WORKSPACES ?? "").split(",").filter(Boolean);
    if (
      process.argv.includes("--postinstall") &&
      process.env.F5_SKIP_ELECTRON_INSTALL !== "1" &&
      existsSync(Path.join(root, "apps/desktop/node_modules/electron/install.js")) &&
      workspaceManifests(root, installed).includes("apps/desktop/package.json")
    ) {
      const result = spawnSync(
        process.execPath,
        ["apps/desktop/node_modules/electron/install.js"],
        {
          cwd: root,
          stdio: "inherit",
        },
      );
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
    // Runs as the root postinstall script, so it must never fail an install.
    try {
      recordInstall(root, installed);
    } catch (error) {
      console.warn(`Could not record the dependency install: ${String(error)}`);
    }
  } else if (process.argv.includes("--install") && !isCi()) {
    const workspaces = requested.length === 0 ? [] : [ROOT_WORKSPACE, ...requested];
    const result = ensureDependencies(root, {
      workspaces,
      requireElectron,
      install: () => runBunInstall(root, workspaces),
    });
    if (result.status === "install-failed" && result.missing.length === 0) {
      // Nothing is missing, so keep working with the existing install (offline,
      // registry errors, or local package.json edits that bun.lock doesn't match yet).
      console.warn(
        `\n\`${INSTALL_COMMAND}\` failed. Continuing with the existing installation, which may not match bun.lock.`,
      );
    } else if (result.status === "install-failed") {
      console.error(`\n\`${INSTALL_COMMAND}\` failed. Fix the error above, then retry.`);
      reportMissing(result.missing);
      process.exitCode = 1;
    } else if (result.status === "missing") {
      reportMissing(result.missing);
      process.exitCode = 1;
    }
  } else {
    const missing = missingForInstall(
      root,
      requested.length === 0 ? [] : [ROOT_WORKSPACE, ...requested],
      requireElectron,
    );
    if (missing.length > 0) {
      reportMissing(missing);
      process.exitCode = 1;
    }
  }
}
