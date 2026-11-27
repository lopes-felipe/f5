import { isManualRemovalIgnoredBlocker } from "./cleanupSafety.ts";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
export type IgnoredFilesRemovalPolicy =
  | { readonly kind: "protect" }
  /** Storage and automatic cleanup: well-known build and cache outputs may be deleted too. */
  | { readonly kind: "rebuildable" }
  | {
      readonly kind: "manual";
      readonly approvedEntries?: ReadonlyArray<string> | undefined;
    };

export function scopeIgnoredFilesRemovalPolicy(
  relativePath: string,
  policy: IgnoredFilesRemovalPolicy | undefined,
): IgnoredFilesRemovalPolicy | undefined {
  if (policy?.kind !== "manual") return policy;
  const prefix = relativePath.replaceAll("\\", "/") + "/";
  return {
    kind: "manual",
    approvedEntries: policy.approvedEntries?.flatMap((entry) =>
      entry.startsWith(prefix) ? [entry.slice(prefix.length)] : [],
    ),
  };
}

/** Ignored directory names that hold regenerated build, test, or cache output. */
const REBUILDABLE_IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".turbo",
  ".next",
  ".nuxt",
  ".astro",
  ".svelte-kit",
  ".build",
  "target",
  "coverage",
  ".cache",
  ".parcel-cache",
  ".vite",
  ".playwright",
  ".vitest-attachments",
  "playwright-report",
  "test-results",
  "__pycache__",
  ".pytest_cache",
  ".gradle",
]);

/** True for an ignored entry that a build or test run recreates. */
export function isRebuildableIgnoredEntry(entry: string): boolean {
  const name = entry.replace(/\/+$/, "").split("/").pop() ?? "";
  return (
    /^(?:apps\/desktop\/(?:dist-electron|dist-native|\.electron-runtime)|\.performance)\/?$/.test(
      entry,
    ) ||
    REBUILDABLE_IGNORED_DIRECTORIES.has(name) ||
    name.endsWith(".tsbuildinfo") ||
    name === ".DS_Store"
  );
}

/**
 * Local files nobody can rebuild: environment files, databases, keys and
 * credentials. A build directory is trusted by its name, and these are what
 * that trust must not cover when one of them sits inside it.
 */
export function isProtectedLocalFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === ".env" ||
    lower.startsWith(".env.") ||
    /\.(?:sqlite3?|pem|key|p12|pfx|jks|keystore)$/.test(lower) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(lower) ||
    /^credentials(?:\.[a-z0-9]+)?$/.test(lower)
  );
}

/** Installed packages: their contents are a registry's, not the user's, and far too many to read. */
const UNSCANNED_REBUILDABLE_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules"]);
/** Directory entries read per build directory before it counts as unchecked. */
const PROTECTED_FILE_SCAN_LIMIT = 200_000;

/**
 * Whether a build directory holds a protected local file, or cannot be
 * checked: too large, unreadable, or not a plain directory inside the
 * checkout. Links are not followed, as removal does not follow them.
 */
async function holdsProtectedLocalFile(root: string, entry: string): Promise<boolean> {
  const target = Path.resolve(root, entry);
  const relative = Path.relative(root, target);
  if (!relative || relative.startsWith("..") || Path.isAbsolute(relative)) return true;
  try {
    const stat = await FS.lstat(target);
    // A file or a link trusted by its name alone holds nothing to look into.
    if (!stat.isDirectory()) return false;
    let read = 0;
    const pending = [target];
    for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
      for (const child of await FS.readdir(directory, { withFileTypes: true })) {
        if (++read > PROTECTED_FILE_SCAN_LIMIT) return true;
        if (isProtectedLocalFile(child.name)) return true;
        if (child.isDirectory() && !UNSCANNED_REBUILDABLE_DIRECTORIES.has(child.name))
          pending.push(Path.join(directory, child.name));
      }
    }
    return false;
  } catch (error) {
    // Gone since it was listed: nothing is left in it to lose.
    return (error as NodeJS.ErrnoException)?.code !== "ENOENT";
  }
}

/** Recheck actual empty directories at every gate, including Git's final removal gate. */
export async function blockingIgnoredEntriesOnDisk(
  root: string,
  entries: ReadonlyArray<string>,
  policy: IgnoredFilesRemovalPolicy = { kind: "protect" },
): Promise<ReadonlyArray<string>> {
  const blocked = blockingIgnoredEntries(entries, policy);
  if (policy.kind !== "rebuildable") return blocked;
  // A build directory is accepted by its name. Before it is deleted without
  // anyone being asked, look inside it: `dist/.env` is not build output.
  const refused = new Set(blocked);
  const guarded = (
    await Promise.all(
      entries.map(async (entry) => {
        if (refused.has(entry) || !entry.endsWith("/")) return null;
        const name = entry.replace(/\/+$/, "").split("/").pop() ?? "";
        if (UNSCANNED_REBUILDABLE_DIRECTORIES.has(name)) return null;
        return (await holdsProtectedLocalFile(root, entry)) ? entry : null;
      }),
    )
  ).filter((entry): entry is string => entry !== null);
  const checked = await Promise.all(
    blocked.map(async (entry) => {
      // Environment paths remain protected even if currently empty.
      if (
        !entry.endsWith("/") ||
        entry.split("/").some((part) => part === ".env" || part.startsWith(".env."))
      )
        return entry;
      const target = Path.resolve(root, entry);
      const relative = Path.relative(root, target);
      if (!relative || relative.startsWith("..") || Path.isAbsolute(relative)) return entry;
      try {
        const stat = await FS.lstat(target);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return entry;
        // Resolve ancestors as well: an ignored directory may sit below a symlink.
        const [realRoot, realTarget] = await Promise.all([FS.realpath(root), FS.realpath(target)]);
        const realRelative = Path.relative(realRoot, realTarget);
        if (realRelative.startsWith("..") || Path.isAbsolute(realRelative)) return entry;
        return (await FS.readdir(target)).length === 0 ? null : entry;
      } catch {
        return entry;
      }
    }),
  );
  return [...checked.filter((entry): entry is string => entry !== null), ...guarded];
}

/** Approval covers exactly the listed file or directory, never other paths. */
export function blockingIgnoredEntries(
  entries: ReadonlyArray<string>,
  policy: IgnoredFilesRemovalPolicy = { kind: "protect" },
): ReadonlyArray<string> {
  const approved = new Set(policy.kind === "manual" ? policy.approvedEntries : []);
  return entries.filter((entry) => {
    if (policy.kind === "manual") return !approved.has(entry);
    if (policy.kind === "rebuildable") return !isRebuildableIgnoredEntry(entry);
    return isManualRemovalIgnoredBlocker(entry);
  });
}
