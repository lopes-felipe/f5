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
  readonly deletedThreadIds?: ReadonlySet<ThreadId> | undefined;
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
  const api = readNativeApi();
  if (!api) return;
  const thread = input.threads.find((entry) => entry.id === input.threadId);
  if (!thread) return;
  const threadProject = input.projects.find((project) => project.id === thread.projectId);
  const deletedIds = input.deletedThreadIds;
  const survivingThreads =
    deletedIds && deletedIds.size > 0
      ? input.threads.filter((entry) => entry.id === input.threadId || !deletedIds.has(entry.id))
      : input.threads;
  const orphanedWorktreePath = getOrphanedWorktreePathForThread(survivingThreads, input.threadId);
  const displayWorktreePath = orphanedWorktreePath
    ? formatWorktreePathForDisplay(orphanedWorktreePath)
    : null;
  const canDeleteWorktree = orphanedWorktreePath !== null && threadProject !== undefined;
  const shouldDeleteWorktree =
    canDeleteWorktree &&
    (await api.dialogs.confirm(
      [
        "This thread is the only one linked to this worktree:",
        displayWorktreePath ?? orphanedWorktreePath,
        "",
        "Delete the worktree too?",
      ].join("\n"),
    ));

  if (thread.session && thread.session.status !== "closed") {
    await api.orchestration
      .dispatchCommand({
        type: "thread.session.stop",
        commandId: newCommandId(),
        threadId: input.threadId,
        createdAt: new Date().toISOString(),
      })
      .catch((error) => {
        console.warn("Failed to stop the thread session before deletion", error);
      });
  }

  try {
    await api.terminal.close({ threadId: input.threadId, deleteHistory: true });
  } catch {
    // Terminal may already be closed.
  }

  const allDeletedIds = deletedIds ?? new Set<ThreadId>();
  const shouldNavigateToFallback = input.activeThreadId === input.threadId;
  const fallbackThreadId =
    sortThreadsByActivity(
      input.threads.filter(
        (entry) =>
          entry.id !== input.threadId && !allDeletedIds.has(entry.id) && !isArchivedThread(entry),
      ),
    )[0]?.id ?? null;
  await api.orchestration.dispatchCommand({
    type: "thread.delete",
    commandId: newCommandId(),
    threadId: input.threadId,
  });
  useRightPanelStore.getState().removeThread(input.threadId);
  input.clearComposerDraftForThread(input.threadId);
  input.clearProjectDraftThreadById(thread.projectId, thread.id);
  input.clearTerminalState(input.threadId);
  if (shouldNavigateToFallback) {
    if (fallbackThreadId) {
      input.navigateToThread(fallbackThreadId);
    } else {
      input.navigateHome();
    }
  }

  if (!shouldDeleteWorktree || !orphanedWorktreePath || !threadProject) {
    return;
  }

  try {
    await input.removeWorktree({
      cwd: threadProject.cwd,
      path: orphanedWorktreePath,
      force: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error removing worktree.";
    console.error("Failed to remove orphaned worktree after thread deletion", {
      threadId: input.threadId,
      projectCwd: threadProject.cwd,
      worktreePath: orphanedWorktreePath,
      error,
    });
    toastManager.add({
      type: "error",
      title: "Thread deleted, but worktree removal failed",
      description: `Could not remove ${displayWorktreePath ?? orphanedWorktreePath}. ${message}`,
    });
  }
}
