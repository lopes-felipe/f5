import { WorkspaceRequiresNewWorktreeError } from "../git/workspaceSwitch.ts";
import { stripPathTerminator } from "../git/worktreeList.ts";
import { canonicalWorktreePath } from "../git/worktreePaths.ts";
import { pathContains } from "../project/Layers/WorktreeLifecycleCoordinator.ts";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { ServerSettings, type ProfileSummary } from "@t3tools/contracts";
import { Schema } from "effect";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { managedWorktreesDirectories, isFilesystemRoot } from "../worktreesDirectoryPaths.ts";
import { profileStateDir } from "@t3tools/shared/profilePaths";
import { executionDirectoryIssue } from "./executionDirectory";
import { ProfileRegistryStore } from "./ProfileRegistryStore.ts";

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
          stripPathTerminator(await FS.readFile(marker, "utf8")).replace(/^gitdir: /i, ""),
        );
    const common = await FS.readFile(Path.join(gitDir, "commondir"), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return ".";
        throw error;
      },
    );
    return await FS.realpath(Path.resolve(gitDir, stripPathTerminator(common)));
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

/** Read-only cross-profile guard for in-place checkout. Unknown ownership fails closed. */
export async function assertExclusiveProfileCheckout(
  config: Pick<import("../config.ts").ServerConfigShape, "defaultStateDir" | "profile">,
  checkout: string,
): Promise<void> {
  if (!config.defaultStateDir || !config.profile) return;
  const registry = await new ProfileRegistryStore(config.defaultStateDir).read();
  if (!registry.ok) throw new Error("Other-profile checkout ownership could not be established.");
  const target = await canonicalWorktreePath(checkout);
  for (const profile of registry.registry.profiles) {
    if (profile.id === config.profile.id) continue;
    const stateDir = profileStateDir(config.defaultStateDir, profile);
    const file = Path.join(stateDir, "state.sqlite");
    const stat = await FS.stat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && profile.status === "provisioning") return null;
      throw error;
    });
    if (!stat) continue;
    const database = process.versions.bun
      ? new (await import("bun:sqlite")).Database(file, { readonly: true })
      : new (await import("node:sqlite")).DatabaseSync(file, { readOnly: true });
    try {
      const rows = database
        .prepare(`SELECT workspace_root AS path FROM projection_projects WHERE deleted_at IS NULL
        UNION SELECT COALESCE(t.worktree_path,p.workspace_root) AS path FROM projection_threads t
        LEFT JOIN projection_projects p ON p.project_id=t.project_id WHERE t.deleted_at IS NULL`)
        .all() as { path: string | null }[];
      for (const row of rows) {
        if (!row.path)
          throw new Error("Other-profile checkout ownership could not be established.");
        if ((await canonicalWorktreePath(row.path)) === target)
          throw new WorkspaceRequiresNewWorktreeError(
            "Another profile references this checkout. Create a new worktree instead.",
          );
      }
    } finally {
      database.close();
    }
  }
}

/** Read ownership once per inventory; an unreadable registry fails closed. */
export async function readOtherProfileManagedRoots(
  config: Pick<import("../config.ts").ServerConfigShape, "defaultStateDir" | "profile" | "baseDir">,
): Promise<string[]> {
  if (!config.defaultStateDir || !config.profile) return [];
  const registry = await new ProfileRegistryStore(config.defaultStateDir).read();
  if (!registry.ok) throw new Error("Managed workspace ownership could not be established.");
  const roots = await Promise.all(
    registry.registry.profiles
      .filter((profile) => profile.id !== config.profile!.id)
      .map(async (profile) => {
        const stateDir = profileStateDir(config.defaultStateDir!, profile);
        let raw = "{}";
        try {
          raw = await FS.readFile(Path.join(stateDir, "settings.json"), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const settings = Schema.decodeUnknownOption(
          fromLenientJson(
            Schema.Struct({
              worktreesDirectory: ServerSettings.fields.worktreesDirectory,
              previousWorktreesDirectories: ServerSettings.fields.previousWorktreesDirectories,
            }),
          ),
        )(raw);
        if (settings._tag === "None")
          throw new Error("Managed workspace ownership could not be established.");
        const directories = managedWorktreesDirectories(
          settings.value,
          Path.join(profile.isDefault ? config.baseDir : stateDir, "worktrees"),
        );
        return (await Promise.all(directories.map(canonicalWorktreePath))).filter(
          (root) => !isFilesystemRoot(root),
        );
      }),
  );
  return [...new Set(roots.flat())];
}

/** A project root cannot turn another profile's managed checkout into an attachable target. */
export async function assertNotOtherProfileManagedCheckout(
  config: Pick<import("../config.ts").ServerConfigShape, "defaultStateDir" | "profile" | "baseDir">,
  checkout: string,
): Promise<void> {
  if (!config.defaultStateDir || !config.profile) return;
  const roots = await readOtherProfileManagedRoots(config);
  const target = await canonicalWorktreePath(checkout);
  if (roots.some((root) => pathContains(root, target)))
    throw new Error("Another profile owns this managed checkout. It is inspect-only.");
}
