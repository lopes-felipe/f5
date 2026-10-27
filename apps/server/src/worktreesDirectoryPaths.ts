import * as Path from "node:path";
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

export function managedWorktreesDirectories(
  settings: WorktreesSettings,
  defaultDir: string,
): string[] {
  return [
    ...new Set(
      [defaultDir, settings.worktreesDirectory, ...settings.previousWorktreesDirectories]
        .map((setting) => resolveWorktreesDirectory(setting, defaultDir))
        .filter((directory): directory is string => directory !== null),
    ),
  ];
}

// Resolve ancestors even for missing worktrees, while rejecting links to a drive root.
export const validManagedWorktreesDirectories = (settings: WorktreesSettings, defaultDir: string) =>
  Effect.forEach(managedWorktreesDirectories(settings, defaultDir), (directory) =>
    Effect.tryPromise(async () => {
      const canonical = await canonicalWorktreePath(directory);
      if (isFilesystemRoot(canonical)) return null;
      try {
        // Scanners never follow arbitrary links. A configured root is checked above
        // and scanned at its real location; spelling of ordinary paths stays stable.
        return (await lstat(directory)).isSymbolicLink() ? canonical : directory;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return directory;
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
    Effect.tryPromise(() => canonicalWorktreePath(directory)).pipe(
      Effect.orElseSucceed(() => null),
    ),
  ).pipe(
    Effect.map((roots) => [
      ...new Set(roots.filter((root): root is string => root !== null && !isFilesystemRoot(root))),
    ]),
  );
