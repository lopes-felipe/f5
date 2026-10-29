import type {
  OrchestrationEvent,
  OrchestrationThreadHistoryPage,
  OrchestrationThreadTailDetails,
  ThreadId,
} from "@t3tools/contracts";
import type { AppState } from "../store";

/** Coverage applies only to replaced detail fields, never to stream or summary state. */
export interface ThreadDetailCoverage {
  readonly tailSequence: number;
  readonly latestMutation: number;
  readonly entities: ReadonlyMap<string, number>;
}

export function detailEntityKey(event: OrchestrationEvent): string | null {
  switch (event.type) {
    case "thread.message-sent":
    case "thread.message-reasoning-tokens-added":
      return `message:${event.payload.messageId}`;
    case "thread.turn-diff-completed":
      return `checkpoint:${event.payload.turnId}`;
    case "thread.command-execution-recorded":
      return `command:${event.payload.commandExecution.id}`;
    case "thread.activity-appended":
      return `activity:${event.payload.activity.id}`;
    case "thread.tasks.updated":
      return "tasks";
    case "thread.session-notes-recorded":
      return "notes";
    default:
      return null;
  }
}

export function detailEventIsCovered(
  state: AppState,
  threadId: ThreadId,
  event: OrchestrationEvent,
): boolean {
  const key = detailEntityKey(event);
  if (key === null) return false;
  const coverage = state.detailCoverageByThreadId?.get(threadId);
  if (!coverage) return false;
  return event.sequence <= Math.max(coverage?.tailSequence ?? 0, coverage?.entities.get(key) ?? 0);
}

export function withHistoryCoverage(
  state: AppState,
  threadId: ThreadId,
  page: OrchestrationThreadHistoryPage,
  previous: AppState,
): AppState {
  const before = previous.threads.find((thread) => thread.id === threadId);
  if (!before) return state;
  const current = state.detailCoverageByThreadId?.get(threadId);
  const entities = new Map(current?.entities);
  // Page merges insert missing rows; already retained rows are not replaced.
  const record = (
    family: string,
    rows: ReadonlyArray<{ readonly id: string }>,
    existing: ReadonlyArray<{ readonly id: string }>,
  ) => {
    const ids = new Set(existing.map((row) => row.id));
    for (const row of rows)
      if (!ids.has(row.id)) entities.set(`${family}:${row.id}`, page.detailSequence);
  };
  record("message", page.messages, before.messages);
  record("activity", page.activities, before.activities);
  record("command", page.commandExecutions, before.commandExecutions);
  const turns = new Set(before.turnDiffSummaries.map((row) => row.turnId));
  for (const row of page.checkpoints)
    if (!turns.has(row.turnId)) entities.set(`checkpoint:${row.turnId}`, page.detailSequence);
  if (entities.size === (current?.entities.size ?? 0)) return state;
  const coverage = new Map(state.detailCoverageByThreadId);
  coverage.set(threadId, {
    tailSequence: current?.tailSequence ?? 0,
    latestMutation: current?.latestMutation ?? 0,
    entities,
  });
  return { ...state, detailCoverageByThreadId: coverage };
}

export function tailEntityKeys(details: {
  readonly messages: ReadonlyArray<{ readonly id: string }>;
  readonly activities: ReadonlyArray<{ readonly id: string }>;
  readonly commandExecutions: ReadonlyArray<{ readonly id: string }>;
  readonly checkpoints: ReadonlyArray<{ readonly turnId: string }>;
}): Set<string> {
  return new Set([
    ...details.messages.map((row) => `message:${row.id}`),
    ...(details.activities ?? []).map((row) => `activity:${row.id}`),
    ...details.commandExecutions.map((row) => `command:${row.id}`),
    ...details.checkpoints.map((row) => `checkpoint:${row.turnId}`),
  ]);
}

export function canHydrateThreadTail(
  state: AppState,
  threadId: ThreadId,
  details: OrchestrationThreadTailDetails,
): boolean {
  const overflowSequence = state.detailEventBufferByThreadId.get(threadId)?.overflowSequence;
  if (overflowSequence !== undefined && details.detailSequence < overflowSequence) return false;
  const coverage = state.detailCoverageByThreadId?.get(threadId);
  if (!coverage) return true;
  if (details.detailSequence < coverage.tailSequence) return false;
  if (
    details.detailSequence < coverage.latestMutation &&
    !state.detailEventBufferByThreadId.has(threadId)
  )
    return false;
  for (const key of tailEntityKeys(details))
    if (details.detailSequence < (coverage.entities.get(key) ?? 0)) return false;
  return true;
}
