import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import { createHash } from "node:crypto";

import type {
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  ThreadId,
} from "@t3tools/contracts";
import { isScratchProject, isScratchThreadFolder } from "@t3tools/shared/scratchProject";
import { threadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";

export type ScratchFolderCleanupResult =
  | { kind: "removed" | "missing" | "none" | "staged" }
  | { kind: "refused"; reason: string; permanent?: true };

/** Derived only from retained thread metadata; recovery never scans scratch-root children. */
export function scratchThreadCleanupPath(folder: string, threadId: ThreadId): string {
  const identity = createHash("sha256").update(threadId).digest("hex");
  return NodePath.join(
    NodePath.dirname(folder),
    `.${NodePath.basename(folder)}.deleted-${identity}`,
  );
}

const containsPath = (root: string, path: string) => {
  const relative = NodePath.relative(root, path);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(".." + NodePath.sep) &&
      !NodePath.isAbsolute(relative))
  );
};

async function lstatIfPresent(path: string) {
  try {
    return await NodeFS.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Removes only a terminal thread's recorded folder, never untracked scratch-root children. */
export async function removeScratchThreadFolder(input: {
  readModel: OrchestrationReadModel;
  threadId: ThreadId;
  /** Storage maintenance may retain SQL rows after deleted metadata leaves the read model. */
  persisted?: {
    thread: Pick<
      OrchestrationThread,
      "id" | "projectId" | "scratchPath" | "deletedAt" | "archivedAt"
    >;
    project: Pick<OrchestrationProject, "id" | "kind" | "workspaceRoot"> | undefined;
  };
  allowArchived?: boolean;
  /** Validate ownership and atomically rename only; recursive removal runs after releasing the gate. */
  stageOnly?: boolean;
  remove?: (folder: string) => Promise<void>;
}): Promise<ScratchFolderCleanupResult> {
  const persisted = input.persisted?.thread.id === input.threadId ? input.persisted : undefined;
  // Current metadata always wins, including a live thread or a changed project root.
  const thread =
    input.readModel.threads.find((entry) => entry.id === input.threadId) ?? persisted?.thread;
  if (!thread) return { kind: "refused", reason: "Thread metadata is missing.", permanent: true };
  const folder = thread.scratchPath;
  if (!folder) return { kind: "none" };
  if (thread.deletedAt === null && !(input.allowArchived && thread.archivedAt != null)) {
    return { kind: "refused", reason: "The thread is still live." };
  }
  const project =
    input.readModel.projects.find((entry) => entry.id === thread.projectId) ??
    (persisted?.project?.id === thread.projectId ? persisted.project : undefined);
  if (
    !project ||
    !isScratchProject(project) ||
    !isScratchThreadFolder(project.workspaceRoot, folder)
  ) {
    return {
      kind: "refused",
      reason: "The folder is not owned by a scratch thread.",
      permanent: true,
    };
  }
  const tombstone = scratchThreadCleanupPath(folder, thread.id);
  try {
    const staged = await lstatIfPresent(tombstone);
    const candidate = staged ? tombstone : folder;
    const stat = staged ?? (await lstatIfPresent(folder));
    if (!stat) return { kind: "missing" };
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return {
        kind: "refused",
        reason: "The scratch folder is not a real directory.",
        permanent: true,
      };
    }
    const [rootReal, folderReal] = await Promise.all([
      NodeFS.realpath(project.workspaceRoot),
      NodeFS.realpath(candidate),
    ]);
    if (NodePath.dirname(folderReal) !== rootReal) {
      return {
        kind: "refused",
        reason: "The scratch folder resolves outside its root.",
        permanent: true,
      };
    }
    const originalReal = NodePath.join(rootReal, NodePath.basename(folder));
    const canonicalPaths = new Map<string, Promise<string>>();
    const canonical = (path: string) => {
      let value = canonicalPaths.get(path);
      if (!value) {
        value = NodeFS.realpath(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return NodePath.resolve(path);
          throw error;
        });
        canonicalPaths.set(path, value);
      }
      return value;
    };
    const isProtected = async (paths: ReadonlyArray<string>) =>
      (await Promise.all([...new Set(paths)].map(canonical))).some(
        (path) => containsPath(originalReal, path) || containsPath(folderReal, path),
      );
    const projects = new Map(input.readModel.projects.map((entry) => [entry.id, entry]));
    const ownerRoots = input.readModel.threads.flatMap((entry) => {
      if (entry.id === thread.id || entry.deletedAt !== null) return [];
      const cwd = threadWorkspaceCwd(entry, projects.get(entry.projectId));
      return cwd ? [cwd] : [];
    });
    if (await isProtected(ownerRoots)) {
      return { kind: "refused", reason: "Another live thread owns the folder." };
    }
    if (
      await isProtected(
        input.readModel.projects
          .filter((entry) => entry.deletedAt == null)
          .map((entry) => entry.workspaceRoot),
      )
    ) {
      return { kind: "refused", reason: "Another live project owns the folder." };
    }
    if (!staged) {
      await NodeFS.rename(folder, tombstone);
    }
    if (input.stageOnly) return { kind: "staged" };
    await (input.remove ?? ((path) => NodeFS.rm(path, { recursive: true, force: true })))(
      tombstone,
    );
    return { kind: "removed" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
}
