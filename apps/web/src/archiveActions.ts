import {
  useWorktreeRemovalDialogStore,
  type WorktreeRemovalRow,
} from "./worktreeRemovalDialogStore";
import { recordThreadUndo } from "./threadUndo";
import { cleanupDeletedThread } from "./lib/deletedThreadCleanup";
import { useComposerMentionHistoryStore } from "./composerMentionHistoryStore";
import {
  type CodeReviewWorkflowId,
  type InvestigationWorkflowId,
  type PlanningWorkflowId,
  type ThreadId,
  type OrchestrationDeleteWorkflowResult,
} from "@t3tools/contracts";

import { survivingThreadAfterDeletion } from "./lib/threadOrdering";
import { normalizeProjectPathForComparison } from "./lib/projectPaths";
import { newCommandId } from "./lib/utils";
import { readNativeApi } from "./nativeApi";
import type { Project, Thread } from "./types";
import { toastManager } from "./components/ui/toast";
import { getOrphanedWorktreePathForThread } from "./worktreeCleanup";
import { useStore } from "./store";

function offerOrphanedWorktreeCleanup(
  deletedThreads: ReadonlyArray<Thread>,
  survivors: ReadonlyArray<Thread>,
  projects: ReadonlyArray<Project>,
) {
  const checkedPaths = new Set<string>();
  const removalRows: WorktreeRemovalRow[] = [];
  for (const thread of deletedThreads) {
    const project = projects.find((entry) => entry.id === thread.projectId);
    const orphanedPath = getOrphanedWorktreePathForThread([...survivors, thread], thread.id);
    if (!project || !orphanedPath) continue;
    const pathKey = normalizeProjectPathForComparison(orphanedPath);
    if (checkedPaths.has(pathKey)) continue;
    checkedPaths.add(pathKey);
    removalRows.push({ projectId: project.id, path: orphanedPath });
  }
  if (removalRows.length) void useWorktreeRemovalDialogStore.getState().request(removalRows);
}

export type WorkflowArchiveKind = "planning" | "codeReview" | "investigation";
export type WorkflowArchiveId = PlanningWorkflowId | CodeReviewWorkflowId | InvestigationWorkflowId;

export async function dispatchThreadArchive(input: {
  readonly threadId: ThreadId;
  readonly archived: boolean;
}) {
  const api = readNativeApi();
  if (!api) throw new Error("Thread actions are unavailable.");
  await api.orchestration.dispatchCommand({
    type: input.archived ? "thread.archive" : "thread.unarchive",
    commandId: newCommandId(),
    threadId: input.threadId,
    createdAt: new Date().toISOString(),
  });
  if (input.archived)
    recordThreadUndo("Thread archived", async () => {
      await api.orchestration.dispatchCommand({
        type: "thread.unarchive",
        commandId: newCommandId(),
        threadId: input.threadId,
        createdAt: new Date().toISOString(),
      });
    });
}

export async function setThreadArchived(input: {
  readonly threadId: ThreadId;
  readonly archived: boolean;
}) {
  const api = readNativeApi();
  if (!api) return;

  try {
    await dispatchThreadArchive(input);
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
    const confirmed = await api.dialogs.confirm(
      `Archive workflow "${input.workflowTitle ?? ""}" and its threads? Running agents will stop and queued work will pause.`,
    );
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
        "This permanently deletes the workflow and all its associated threads, including their conversation history. Running agents will stop.",
      ].join("\n"),
    );
    if (!confirmed) {
      return;
    }
  }

  // Domain events may remove the children before the RPC resolves.
  const beforeDeletion = useStore.getState();
  const threadsBeforeDeletion = [...beforeDeletion.threads];
  const projectsBeforeDeletion = [...beforeDeletion.projects];
  try {
    let result: OrchestrationDeleteWorkflowResult;
    if (input.workflowType === "planning") {
      result = await api.orchestration.deleteWorkflow({
        workflowId: input.workflowId as PlanningWorkflowId,
        deleteThreads: true,
      });
    } else if (input.workflowType === "codeReview") {
      result = await api.orchestration.deleteCodeReviewWorkflow({
        workflowId: input.workflowId as CodeReviewWorkflowId,
        deleteThreads: true,
      });
    } else {
      result = await api.orchestration.deleteInvestigationWorkflow({
        workflowId: input.workflowId as InvestigationWorkflowId,
        deleteThreads: true,
      });
    }
    if (result && useStore.getState().backendGeneration === beforeDeletion.backendGeneration) {
      const deletedIds = new Set(result.deletedThreadIds);
      await Promise.all([...deletedIds].map(cleanupDeletedThread));
      offerOrphanedWorktreeCleanup(
        threadsBeforeDeletion.filter((thread) => deletedIds.has(thread.id)),
        useStore.getState().threads.filter((thread) => !deletedIds.has(thread.id)),
        projectsBeforeDeletion,
      );
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
      useComposerMentionHistoryStore.getState().forgetThread(threadId);
      succeeded.push(threadId);
    } catch (error) {
      failures.push({ threadId, error });
      continue;
    }
    // Local state and terminal history are cleared only after deletion is accepted.
    await cleanupDeletedThread(threadId);
    input.clearComposerDraftForThread(threadId);
    input.clearProjectDraftThreadById(thread.projectId, threadId);
    input.clearTerminalState(threadId);
  }
  const deletedIds = new Set(succeeded);
  const survivors = () =>
    (input.getThreads?.() ?? input.threads).filter((thread) => !deletedIds.has(thread.id));
  if (input.activeThreadId && deletedIds.has(input.activeThreadId)) {
    // Match the thread lifecycle checks in getVisibleThreads (lib/threadOrdering).
    // Keep deletion's existing global fallback scope, including Scheduled-folder threads.
    const fallback = survivingThreadAfterDeletion(survivors());
    if (fallback) input.navigateToThread(fallback.id);
    else input.navigateHome();
  }
  offerOrphanedWorktreeCleanup(
    input.threads.filter((thread) => deletedIds.has(thread.id)),
    survivors(),
    input.projects,
  );
  return { succeeded, failures };
}
