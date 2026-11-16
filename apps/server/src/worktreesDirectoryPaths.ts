import * as Path from "node:path";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { Effect } from "effect";
import type { ServerSettings } from "@t3tools/contracts";
import { expandHomePath } from "./pathExpansion.ts";
import { canonicalWorktreePath } from "./git/worktreePaths.ts";

type WorktreesSettings = Pick<
  ServerSettings,
  "worktreesDirectory" | "previousWorktreesDirectories"
>;
export const DEFAULT_WORKTREES_SETTINGS: WorktreesSettings = {
  worktreesDirectory: "",
  previousWorktreesDirectories: [],
};

export function isFilesystemRoot(directory: string): boolean {
  return Path.dirname(directory) === directory;
}

export function resolveWorktreesDirectory(setting: string, defaultDir: string): string | null {
  const expanded = expandHomePath(setting || defaultDir);
  if (!Path.isAbsolute(expanded)) return null;
  const resolved = Path.resolve(expanded);
  return isFilesystemRoot(resolved) ? null : resolved;
}

/** A shared parent never grants ownership of its contents to a profile. */
export function customWorktreesDirectory(directory: string, defaultDir: string): string {
  return Path.join(
    directory,
    ".f5-" + createHash("sha256").update(Path.resolve(defaultDir)).digest("hex").slice(0, 12),
  );
}

export function allocationWorktreesDirectory(setting: string, defaultDir: string): string | null {
  const directory = resolveWorktreesDirectory(setting, defaultDir);
  return directory === null || !setting || directory === Path.resolve(defaultDir)
    ? directory
    : customWorktreesDirectory(directory, defaultDir);
}

export function managedWorktreesDirectories(
  settings: WorktreesSettings,
  defaultDir: string,
): string[] {
  return [
    ...new Set(
      [defaultDir, settings.worktreesDirectory, ...settings.previousWorktreesDirectories]
        .map((setting) =>
          allocationWorktreesDirectory(setting === defaultDir ? "" : setting, defaultDir),
        )
        .filter((directory): directory is string => directory !== null),
    ),
  ];
}

async function safeCanonicalDirectory(directory: string) {
  if (
    Path.basename(directory).startsWith(".f5-") &&
    isFilesystemRoot(await canonicalWorktreePath(Path.dirname(directory)))
  )
    return null;
  const canonical = await canonicalWorktreePath(directory);
  return isFilesystemRoot(canonical) ? null : canonical;
}

// Resolve ancestors even for missing worktrees, while rejecting links to a drive root.
export const validManagedWorktreesDirectories = (settings: WorktreesSettings, defaultDir: string) =>
  Effect.forEach(managedWorktreesDirectories(settings, defaultDir), (directory) =>
    Effect.tryPromise(async () => {
      const canonical = await safeCanonicalDirectory(directory);
      if (canonical === null) return null;
      try {
        // Scanners never follow arbitrary links. A configured root is checked above
        // and scanned at its real location; spelling of ordinary paths stays stable.
        return (await lstat(directory)).isSymbolicLink() ? canonical : directory;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    }).pipe(Effect.orElseSucceed(() => null)),
  ).pipe(
    Effect.map((roots) => [
      ...new Set(roots.filter((root): root is string => root !== null && !isFilesystemRoot(root))),
    ]),
  );

export const canonicalManagedWorktreesDirectories = (
  settings: WorktreesSettings,
  defaultDir: string,
) =>
  Effect.forEach(managedWorktreesDirectories(settings, defaultDir), (directory) =>
    Effect.tryPromise(() => safeCanonicalDirectory(directory)).pipe(
      Effect.orElseSucceed(() => null),
    ),
  ).pipe(
    Effect.map((roots) => [
      ...new Set(roots.filter((root): root is string => root !== null && !isFilesystemRoot(root))),
    ]),
  );
