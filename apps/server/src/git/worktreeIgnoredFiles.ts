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

/** Recheck actual empty directories at every gate, including Git's final removal gate. */
export async function blockingIgnoredEntriesOnDisk(
  root: string,
  entries: ReadonlyArray<string>,
  policy: IgnoredFilesRemovalPolicy = { kind: "protect" },
): Promise<ReadonlyArray<string>> {
  const blocked = blockingIgnoredEntries(entries, policy);
  if (policy.kind !== "rebuildable") return blocked;
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
  return checked.filter((entry): entry is string => entry !== null);
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
