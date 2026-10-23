import { isManualRemovalIgnoredBlocker } from "./cleanupSafety.ts";
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
    REBUILDABLE_IGNORED_DIRECTORIES.has(name) ||
    name.endsWith(".tsbuildinfo") ||
    name === ".DS_Store"
  );
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
