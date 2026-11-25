import fs from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import os from "node:os";
import path from "node:path";

export class WorkspaceSearchRestrictedError extends Error {
  readonly code = "WorkspaceSearchRestricted";
}

/** Checks a canonical workspace path before starting a recursive index. */
export async function assertWorkspaceSearchRootAllowed(
  rootPath: string,
  workspaceStat?: BigIntStats,
): Promise<void> {
  if (path.dirname(rootPath) === rootPath) {
    throw new WorkspaceSearchRestrictedError(
      "Workspace search is unavailable at the filesystem root.",
    );
  }

  const home = os.homedir();
  // Mount aliases can share a directory's identity while realpath returns different paths.
  const [root, homeStat] = await Promise.all([
    workspaceStat ?? fs.stat(rootPath, { bigint: true }),
    fs.stat(home, { bigint: true }).catch(() => null),
  ]);
  if (
    path.relative(home, rootPath) === "" ||
    (homeStat && root.dev === homeStat.dev && root.ino !== 0n && root.ino === homeStat.ino)
  ) {
    throw new WorkspaceSearchRestrictedError(
      "Workspace search is unavailable in the home directory.",
    );
  }
}
