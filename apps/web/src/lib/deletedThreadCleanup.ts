import { useComposerDraftStore } from "../composerDraftStore";
import { useComposerMentionHistoryStore } from "../composerMentionHistoryStore";
import { useRightPanelStore } from "../rightPanelStore";
import { useTerminalStateStore } from "../terminalStateStore";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import type { OrchestrationThread, ThreadId } from "@t3tools/contracts";

function newCleanupState(generation: number | undefined) {
  return {
    generation,
    completed: new Set<ThreadId>(),
    pending: new Map<ThreadId, Promise<void>>(),
    failed: new Set<ThreadId>(),
  };
}
let cleanupState = newCleanupState(undefined);
function currentCleanupState() {
  const generation = useStore.getState().backendGeneration;
  if (generation !== cleanupState.generation) cleanupState = newCleanupState(generation);
  return cleanupState;
}

/** Only authoritative tombstones or committed result IDs may call this helper. */
export function cleanupDeletedThread(threadId: ThreadId): Promise<void> {
  const state = currentCleanupState();
  const composer = useComposerDraftStore.getState();
  if (composer.draftsByThreadId[threadId]) composer.clearThreadDraft(threadId);
  if (
    composer.draftThreadsByThreadId[threadId] ||
    Object.values(composer.projectDraftThreadIdByProjectId).includes(threadId)
  )
    composer.clearDraftThread(threadId);
  const mentions = useComposerMentionHistoryStore.getState();
  if (mentions.entries.some((entry) => entry.threadId === threadId))
    mentions.forgetThread(threadId);
  const panels = useRightPanelStore.getState();
  if (
    panels.byThreadId[threadId] ||
    panels.userActionRevisionByThreadId[threadId] !== undefined ||
    panels.proactiveTurnBaselineByThreadId[threadId] ||
    panels.proactiveDiffTurnIdByThreadId[threadId] ||
    panels.proactivePullRequestKeyByThreadId[threadId] ||
    panels.pendingProactiveDiffNavigationByThreadId[threadId] ||
    panels.tabMenuThreadId === threadId ||
    panels.closedHistory.some((entry) => entry.threadId === threadId)
  )
    panels.removeThread(threadId);
  const terminals = useTerminalStateStore.getState();
  if (terminals.terminalStateByThreadId[threadId]) terminals.clearTerminalState(threadId);
  if (state.completed.has(threadId)) return Promise.resolve();
  const pending = state.pending.get(threadId);
  if (pending) return pending;
  const work = (async () => {
    try {
      await readNativeApi()?.terminal.close({ threadId, deleteHistory: true });
      state.completed.add(threadId);
      state.failed.delete(threadId);
    } catch (error) {
      state.failed.add(threadId);
      console.warn("Failed to clean terminal history for deleted thread", { threadId, error });
    }
  })();
  state.pending.set(threadId, work);
  void work.finally(() => state.pending.delete(threadId));
  return work;
}

/** Historical tombstones with no retained client state need no cleanup RPC. */
export async function cleanupDeletedThreadsFromSnapshot(
  threads: ReadonlyArray<Pick<OrchestrationThread, "id" | "deletedAt">>,
): Promise<void> {
  const state = currentCleanupState();
  const composer = useComposerDraftStore.getState();
  const panels = useRightPanelStore.getState();
  const retained = new Set<string>([
    ...Object.keys(composer.draftsByThreadId),
    ...Object.keys(composer.draftThreadsByThreadId),
    ...Object.values(composer.projectDraftThreadIdByProjectId),
    ...Object.keys(panels.byThreadId),
    ...Object.keys(panels.proactiveTurnBaselineByThreadId),
    ...Object.keys(panels.proactiveDiffTurnIdByThreadId),
    ...Object.keys(panels.proactivePullRequestKeyByThreadId),
    ...Object.keys(panels.pendingProactiveDiffNavigationByThreadId),
    ...(panels.tabMenuThreadId ? [panels.tabMenuThreadId] : []),
    ...panels.closedHistory.map((entry) => entry.threadId),
    ...Object.keys(useTerminalStateStore.getState().terminalStateByThreadId),
    ...useComposerMentionHistoryStore.getState().entries.map((entry) => entry.threadId),
    ...state.failed,
  ]);
  const deleted = threads.filter((thread) => thread.deletedAt !== null && retained.has(thread.id));
  for (let index = 0; index < deleted.length; index += 8) {
    if (currentCleanupState() !== state) return;
    await Promise.all(
      deleted.slice(index, index + 8).map((thread) => cleanupDeletedThread(thread.id)),
    );
  }
}
