import type { ThreadHistoryState } from "../types";

export const EMPTY_THREAD_HISTORY_STATE: ThreadHistoryState = Object.freeze({
  stage: "empty",
  hasOlderMessages: false,
  hasOlderCheckpoints: false,
  hasOlderCommandExecutions: false,
  oldestLoadedMessageCursor: null,
  oldestLoadedCheckpointTurnCount: null,
  oldestLoadedCommandExecutionCursor: null,
  generation: 0,
});

export function createEmptyThreadHistoryState(generation = 0): ThreadHistoryState {
  if (generation === 0) {
    return EMPTY_THREAD_HISTORY_STATE;
  }
  return {
    ...EMPTY_THREAD_HISTORY_STATE,
    generation,
  };
}

export function ensureThreadHistoryState(
  history: ThreadHistoryState | undefined,
  generation = 0,
): ThreadHistoryState {
  return history ?? createEmptyThreadHistoryState(generation);
}
