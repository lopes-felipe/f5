// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
type BunLock = { packages: Record<string, unknown[]> } & Record<string, unknown>;
function parseBunLock(text: string): BunLock {
  const parsed = ts.parseConfigFileTextToJson("bun.lock", text);
  if (parsed.error || !parsed.config?.packages) throw new Error("Invalid Bun lockfile");
  return parsed.config as BunLock;
}
const isLocalPackage = (entry: unknown[]) =>
  typeof entry[0] === "string" && /@(workspace:|file:)/.test(entry[0]);

/**
 * Turns the root lockfile into a lockfile for a single staged package. Bun keeps
 * every locked resolution that still satisfies the staged ranges, including nested
 * duplicate versions, so the stage resolves to root-locked packages instead of the
 * newest registry versions. Workspace packages cannot exist in the stage.
 */
export function seedStagedLockfile(
  rootText: string,
  manifest: {
    readonly name: string;
    readonly dependencies: Record<string, unknown>;
    readonly devDependencies?: Record<string, unknown>;
    readonly overrides?: Record<string, string>;
    readonly patchedDependencies?: Record<string, string>;
  },
): string {
  const root = parseBunLock(rootText);
  return `${JSON.stringify(
    {
      lockfileVersion: root.lockfileVersion,
      ...(root.configVersion === undefined ? {} : { configVersion: root.configVersion }),
      workspaces: {
        "": {
          name: manifest.name,
          dependencies: manifest.dependencies,
          ...(manifest.devDependencies ? { devDependencies: manifest.devDependencies } : {}),
        },
      },
      ...(manifest.patchedDependencies
        ? { patchedDependencies: manifest.patchedDependencies }
        : {}),
      ...(manifest.overrides ? { overrides: manifest.overrides } : {}),
      packages: Object.fromEntries(
        Object.entries(root.packages).filter(([, entry]) => !isLocalPackage(entry)),
      ),
    },
    null,
    2,
  )}\n`;
}

export function verifyStagedLockfile(rootText: string, stagedText: string): void {
  const entries = (text: string) => Object.values(parseBunLock(text).packages);
  const key = (entry: unknown[]) =>
    JSON.stringify([
      entry[0],
      entry.find((value) => typeof value === "string" && /^sha(256|512)-/.test(value)) ?? null,
    ]);
  const allowed = new Set(entries(rootText).map(key));
  for (const entry of entries(stagedText)) {
    if (isLocalPackage(entry)) continue;
    if (!allowed.has(key(entry)))
      throw new Error(`Staged dependency is absent from root lockfile: ${entry[0]}`);
  }
}
/** `@scope/name@<version or URL>` → `@scope/name`. */
const patchedPackageName = (specifier: string) =>
  specifier.slice(0, specifier.indexOf("@", specifier.startsWith("@") ? 1 : 0));

/**
 * Fails unless every line a patch adds is present in the installed package. Bun
 * applies `patchedDependencies` silently, and a missing key or patch file leaves
 * the stock package in place with identical lockfile integrity.
 */
export function verifyAppliedPatches(
  installRoot: string,
  patchedDependencies: Record<string, string>,
  readText: (path: string) => string = (path) => readFileSync(path, "utf8"),
): void {
  for (const [specifier, patchFile] of Object.entries(patchedDependencies)) {
    const packageDir = join(installRoot, "node_modules", patchedPackageName(specifier));
    let target: string | undefined;
    const added = new Map<string, string[]>();
    for (const line of readText(join(installRoot, patchFile)).split("\n")) {
      const header = /^\+\+\+ b\/(.+)$/.exec(line);
      if (header) {
        target = header[1]!;
        added.set(target, []);
      } else if (target && line.startsWith("+") && line.slice(1).trim())
        added.get(target)!.push(line.slice(1));
    }
    if (!added.size) throw new Error(`Patch ${patchFile} changes no files`);
    for (const [file, lines] of added) {
      const installed = readText(join(packageDir, file));
      const missing = lines.find((line) => !installed.includes(line));
      if (missing !== undefined)
        throw new Error(
          `Patch ${patchFile} is not applied to ${specifier} ${file}: ${missing.trim()}`,
        );
    }
  }
}

if (process.argv[1]?.endsWith("verify-staged-lockfile.ts")) {
  const [root, staged] = process.argv.slice(2);
  if (!root || !staged) throw new Error("Usage: verify-staged-lockfile.ts ROOT STAGED");
  verifyStagedLockfile(readFileSync(root, "utf8"), readFileSync(staged, "utf8"));
}
