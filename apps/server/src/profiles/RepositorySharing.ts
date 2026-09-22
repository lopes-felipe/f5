import * as FS from "node:fs/promises";
import * as Path from "node:path";
import type { ProfileSummary } from "@t3tools/contracts";
import { executionDirectoryIssue } from "./executionDirectory";

export async function invalidExecutionDirectories(stateDir: string) {
  const file = Path.join(stateDir, "state.sqlite");
  if (!(await FS.stat(file).catch(() => null))?.isFile()) return [];
  const database = process.versions.bun
    ? new (await import("bun:sqlite")).Database(file, { readonly: true })
    : new (await import("node:sqlite")).DatabaseSync(file, { readOnly: true });
  let directories: string[];
  try {
    directories = (
      database
        .prepare(
          "SELECT workspace_root AS directory FROM projection_projects WHERE deleted_at IS NULL UNION SELECT worktree_path AS directory FROM projection_threads WHERE deleted_at IS NULL AND worktree_path IS NOT NULL",
        )
        .all() as { directory: string }[]
    ).map((row) => row.directory);
  } finally {
    database.close();
  }
  return (
    await Promise.all(
      directories.map(async (directory) => ({
        directory,
        reason: await executionDirectoryIssue(directory),
      })),
    )
  ).filter((entry): entry is { directory: string; reason: string } => entry.reason !== null);
}

/** Resolve linked worktrees to their canonical common Git directory without running hooks. */
export async function canonicalGitCommonDirectory(workspaceRoot: string): Promise<string | null> {
  try {
    const marker = Path.join(workspaceRoot, ".git");
    const stat = await FS.stat(marker);
    const gitDir = stat.isDirectory()
      ? marker
      : Path.resolve(
          workspaceRoot,
          (await FS.readFile(marker, "utf8")).replace(/^gitdir:\s*/i, "").trim(),
        );
    const common = await FS.readFile(Path.join(gitDir, "commondir"), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return ".";
        throw error;
      },
    );
    return await FS.realpath(Path.resolve(gitDir, common.trim()));
  } catch {
    return null;
  }
}

async function projectRoots(stateDir: string): Promise<string[]> {
  const file = Path.join(stateDir, "state.sqlite");
  if (!(await FS.stat(file).catch(() => null))?.isFile()) return [];
  const database = process.versions.bun
    ? new (await import("bun:sqlite")).Database(file, { readonly: true })
    : new (await import("node:sqlite")).DatabaseSync(file, { readOnly: true });
  try {
    return (
      database
        .prepare("SELECT workspace_root FROM projection_projects WHERE deleted_at IS NULL")
        .all() as { workspace_root: string }[]
    ).map((row) => row.workspace_root);
  } finally {
    database.close();
  }
}

/** Only project roots are read from siblings; no account or conversation data leaves its profile. */
export async function repositorySharingWarnings(
  profiles: readonly ProfileSummary[],
  activeId: string,
) {
  const entries = await Promise.all(
    profiles
      .filter((profile) => profile.status === "ready")
      .map(async (profile) => ({
        profile,
        roots: await Promise.all(
          (await projectRoots(profile.stateDir).catch(() => [])).map(async (workspaceRoot) => ({
            workspaceRoot,
            common: await canonicalGitCommonDirectory(workspaceRoot),
          })),
        ),
      })),
  );
  const active = entries.find((entry) => entry.profile.id === activeId);
  return (active?.roots ?? []).flatMap((root) => {
    if (!root.common) return [];
    const otherProfiles = entries
      .filter(
        (entry) =>
          entry.profile.id !== activeId &&
          entry.roots.some((other) => other.common === root.common),
      )
      .map((entry) => entry.profile.name);
    return otherProfiles.length ? [{ workspaceRoot: root.workspaceRoot, otherProfiles }] : [];
  });
}
