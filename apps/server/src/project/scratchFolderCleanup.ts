import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import type { OrchestrationReadModel, ThreadId } from "@t3tools/contracts";
import { isScratchProject, isScratchThreadFolder } from "@t3tools/shared/scratchProject";

export type ScratchFolderCleanupResult =
  | { kind: "removed" | "missing" | "none" }
  | { kind: "refused"; reason: string };

/** Removes only a terminal thread's recorded folder, never untracked scratch-root children. */
export async function removeScratchThreadFolder(input: {
  readModel: OrchestrationReadModel;
  threadId: ThreadId;
  allowArchived?: boolean;
  remove?: (folder: string) => Promise<void>;
}): Promise<ScratchFolderCleanupResult> {
  const thread = input.readModel.threads.find((entry) => entry.id === input.threadId);
  if (!thread) return { kind: "refused", reason: "Thread metadata is missing." };
  const folder = thread.scratchPath;
  if (!folder) return { kind: "none" };
  if (thread.deletedAt === null && !(input.allowArchived && thread.archivedAt != null)) {
    return { kind: "refused", reason: "The thread is still live." };
  }
  const project = input.readModel.projects.find((entry) => entry.id === thread.projectId);
  if (
    !project ||
    !isScratchProject(project) ||
    !isScratchThreadFolder(project.workspaceRoot, folder)
  ) {
    return { kind: "refused", reason: "The folder is not owned by a scratch thread." };
  }
  const owners = input.readModel.threads.filter(
    (entry) => entry.id !== thread.id && entry.deletedAt === null && entry.scratchPath,
  );
  if (owners.some((entry) => NodePath.resolve(entry.scratchPath!) === NodePath.resolve(folder))) {
    return { kind: "refused", reason: "Another live thread owns the folder." };
  }
  try {
    const stat = await NodeFS.lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { kind: "refused", reason: "The scratch folder is not a real directory." };
    }
    const [rootReal, folderReal] = await Promise.all([
      NodeFS.realpath(project.workspaceRoot),
      NodeFS.realpath(folder),
    ]);
    if (NodePath.dirname(folderReal) !== rootReal) {
      return { kind: "refused", reason: "The scratch folder resolves outside its root." };
    }
    await (input.remove ?? ((path) => NodeFS.rm(path, { recursive: true, force: true })))(folder);
    return { kind: "removed" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
}
