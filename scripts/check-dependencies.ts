import { existsSync, globSync, readFileSync } from "node:fs";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

interface PackageManifest {
  readonly workspaces?: ReadonlyArray<string> | { readonly packages: ReadonlyArray<string> };
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

export interface MissingDependency {
  readonly manifest: string;
  readonly dependency: string;
}

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

export function findMissingDependencies(repositoryRoot: string): ReadonlyArray<MissingDependency> {
  const root = Path.resolve(repositoryRoot);
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
  const missing: MissingDependency[] = [];
  for (const relativePath of manifests) {
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

if (import.meta.main) {
  const root = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), "..");
  const missing = findMissingDependencies(root);
  if (missing.length > 0) {
    console.error("Dependencies are missing from the local installation:");
    for (const { manifest, dependency } of missing) {
      console.error(`  ${manifest}: ${dependency}`);
    }
    console.error("\nRun `bun install --frozen-lockfile` from the repository root, then retry.");
    process.exitCode = 1;
  }
}
