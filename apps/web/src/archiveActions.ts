import {
  type CodeReviewWorkflowId,
  type InvestigationWorkflowId,
  type PlanningWorkflowId,
  type ThreadId,
} from "@t3tools/contracts";

import { isArchivedThread, sortThreadsByActivity } from "./lib/threadOrdering";
import { newCommandId } from "./lib/utils";
import { readNativeApi } from "./nativeApi";
import { useRightPanelStore } from "./rightPanelStore";
import type { Project, Thread } from "./types";
import { toastManager } from "./components/ui/toast";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "./worktreeCleanup";

export type WorkflowArchiveKind = "planning" | "codeReview" | "investigation";
export type WorkflowArchiveId = PlanningWorkflowId | CodeReviewWorkflowId | InvestigationWorkflowId;

export async function setThreadArchived(input: {
  readonly threadId: ThreadId;
  readonly archived: boolean;
}) {
  const api = readNativeApi();
  if (!api) return;

  try {
    await api.orchestration.dispatchCommand({
      type: input.archived ? "thread.archive" : "thread.unarchive",
      commandId: newCommandId(),
      threadId: input.threadId,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: input.archived ? "Failed to archive thread" : "Failed to unarchive thread",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
}

export async function setWorkflowArchived(input: {
  readonly workflowId: WorkflowArchiveId;
  readonly workflowType: WorkflowArchiveKind;
  readonly archived: boolean;
  readonly workflowTitle?: string | undefined;
  readonly confirm?: boolean | undefined;
}) {
  const api = readNativeApi();
  if (!api) {
    toastManager.add({
      type: "error",
      title: "Workflow actions are unavailable.",
    });
    return;
  }

  if (input.archived && input.confirm !== false) {
    const confirmed = await api.dialogs.confirm(`Archive workflow "${input.workflowTitle ?? ""}"?`);
    if (!confirmed) {
      return;
    }
  }

  try {
    if (input.workflowType === "planning") {
      const payload = { workflowId: input.workflowId as PlanningWorkflowId };
      if (input.archived) {
        await api.orchestration.archiveWorkflow(payload);
      } else {
        await api.orchestration.unarchiveWorkflow(payload);
      }
    } else if (input.workflowType === "codeReview") {
      const payload = { workflowId: input.workflowId as CodeReviewWorkflowId };
      if (input.archived) {
        await api.orchestration.archiveCodeReviewWorkflow(payload);
      } else {
        await api.orchestration.unarchiveCodeReviewWorkflow(payload);
      }
    } else {
      const payload = { workflowId: input.workflowId as InvestigationWorkflowId };
      if (input.archived) {
        await api.orchestration.archiveInvestigationWorkflow(payload);
      } else {
        await api.orchestration.unarchiveInvestigationWorkflow(payload);
      }
    }
  } catch (error) {
    toastManager.add({
      type: "error",
      title: input.archived ? "Failed to archive workflow" : "Failed to unarchive workflow",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
}

export async function deleteWorkflow(input: {
  readonly workflowId: WorkflowArchiveId;
  readonly workflowType: WorkflowArchiveKind;
  readonly workflowTitle: string;
  readonly confirm?: boolean | undefined;
}) {
  const api = readNativeApi();
  if (!api) return;

  if (input.confirm !== false) {
    const confirmed = await api.dialogs.confirm(
      [
        `Delete workflow "${input.workflowTitle}"?`,
        "This permanently removes the workflow record. Its threads are not deleted.",
      ].join("\n"),
    );
    if (!confirmed) {
      return;
    }
  }

  try {
    if (input.workflowType === "planning") {
      await api.orchestration.deleteWorkflow({
        workflowId: input.workflowId as PlanningWorkflowId,
      });
    } else if (input.workflowType === "codeReview") {
      await api.orchestration.deleteCodeReviewWorkflow({
        workflowId: input.workflowId as CodeReviewWorkflowId,
      });
    } else {
      await api.orchestration.deleteInvestigationWorkflow({
        workflowId: input.workflowId as InvestigationWorkflowId,
      });
    }
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Failed to delete workflow",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
}

export async function deleteThreadWithCleanup(input: {
  readonly threadId: ThreadId;
  readonly threads: ReadonlyArray<Thread>;
  readonly projects: ReadonlyArray<Project>;
  readonly activeThreadId: ThreadId | null;
  readonly getThreads?: () => ReadonlyArray<Thread>;
  readonly clearComposerDraftForThread: (threadId: ThreadId) => void;
  readonly clearProjectDraftThreadById: (projectId: Project["id"], threadId: ThreadId) => void;
  readonly clearTerminalState: (threadId: ThreadId) => void;
  readonly navigateToThread: (threadId: ThreadId) => void;
  readonly navigateHome: () => void;
  readonly removeWorktree: (input: {
    readonly cwd: string;
    readonly path: string;
    readonly force: boolean;
  }) => Promise<unknown>;
}): Promise<void> {
  const result = await deleteThreadsWithCleanup({ ...input, threadIds: [input.threadId] });
  if (result.failures[0]) throw result.failures[0].error;
}

type DeleteThreadInput = Parameters<typeof deleteThreadWithCleanup>[0];

/** Delete first; cleanup and navigation use confirmed outcomes, never attempted IDs. */
export async function deleteThreadsWithCleanup(
  input: Omit<DeleteThreadInput, "threadId"> & {
    readonly threadIds: ReadonlyArray<ThreadId>;
  },
) {
  const api = readNativeApi();
  if (!api) throw new Error("Thread actions are unavailable.");
  const succeeded: ThreadId[] = [];
  const failures: Array<{ threadId: ThreadId; error: unknown }> = [];
  for (const threadId of input.threadIds) {
    const thread = input.threads.find((entry) => entry.id === threadId);
    if (!thread) continue;
    try {
      if (thread.session && thread.session.status !== "closed") {
        await api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId,
            createdAt: new Date().toISOString(),
          })
          .catch((error) => {
            console.warn("Failed to stop the thread session before deletion", error);
          });
      }
      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId,
      });
      succeeded.push(threadId);
    } catch (error) {
      failures.push({ threadId, error });
      continue;
    }
    // Local state and terminal history are cleared only after deletion is accepted.
    await api.terminal.close({ threadId, deleteHistory: true }).catch(() => undefined);
    useRightPanelStore.getState().removeThread(threadId);
    input.clearComposerDraftForThread(threadId);
    input.clearProjectDraftThreadById(thread.projectId, threadId);
    input.clearTerminalState(threadId);
  }
  const deletedIds = new Set(succeeded);
  const survivors = () =>
    (input.getThreads?.() ?? input.threads).filter((thread) => !deletedIds.has(thread.id));
  if (input.activeThreadId && deletedIds.has(input.activeThreadId)) {
    const fallback = sortThreadsByActivity(
      survivors().filter((thread) => !isArchivedThread(thread)),
    )[0];
    if (fallback) input.navigateToThread(fallback.id);
    else input.navigateHome();
  }
  const checkedPaths = new Set<string>();
  for (const threadId of succeeded) {
    const thread = input.threads.find((entry) => entry.id === threadId)!;
    const project = input.projects.find((entry) => entry.id === thread.projectId);
    const orphanedPath = getOrphanedWorktreePathForThread([...survivors(), thread], threadId);
    if (!project || !orphanedPath || checkedPaths.has(orphanedPath)) continue;
    checkedPaths.add(orphanedPath);
    const displayPath = formatWorktreePathForDisplay(orphanedPath);
    try {
      const confirmed = await api.dialogs.confirm(
        `No surviving thread is linked to this worktree:\n${displayPath}\n\nDelete the worktree too?`,
      );
      // A thread may have been created or linked while the confirmation was open.
      if (!confirmed || !getOrphanedWorktreePathForThread([...survivors(), thread], threadId))
        continue;
      await input.removeWorktree({ cwd: project.cwd, path: orphanedPath, force: false });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Threads deleted, but worktree removal failed",
        description: `Could not remove ${displayPath}. ${error instanceof Error ? error.message : "Unknown error removing worktree."}`,
      });
    }
  }
  return { succeeded, failures };
}
