import type { MessageId, OrchestrationEvent, ThreadId } from "@t3tools/contracts";

/**
 * Pure state transitions for client-side revert ("rewind") UI. See `rewindUi.ts`
 * for the store and the side effects (toasts) built on top of this.
 */

export interface RewindPromptPreview {
  readonly text: string;
  readonly attachments: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly type: "image" | "file";
  }>;
}

export interface PendingRewind {
  readonly operationId: string;
  readonly threadId: ThreadId;
  readonly targetMessageId: MessageId;
  readonly restoreFiles: boolean;
  /** Files the removed turns touched, captured from the popover's impact. */
  readonly changedFileCount?: number | undefined;
  /** The target prompt as it was on screen, so the panel can show it at once. */
  readonly prompt: RewindPromptPreview | null;
  readonly requestedAt: string;
}

export interface LandedRewind extends PendingRewind {
  readonly landedAt: string;
}

export interface RevertReopenRequest {
  readonly messageId: MessageId;
  readonly restoreFiles: boolean;
  readonly nonce: number;
}

export interface RewindUiState {
  readonly pendingByThreadId: Readonly<Record<string, PendingRewind>>;
  readonly landedByThreadId: Readonly<Record<string, LandedRewind>>;
  /** Drafts hidden while their "Prompt discarded" undo toast is showing. */
  readonly hiddenDraftOperationIds: Readonly<Record<string, true>>;
  readonly reopenByThreadId: Readonly<Record<string, RevertReopenRequest>>;
}

export type RewindUiEffect =
  | { readonly kind: "reverted"; readonly rewind: LandedRewind }
  | {
      readonly kind: "failed";
      readonly threadId: ThreadId;
      readonly detail: string;
      /** True when the rewind never started, so no panel will explain it. */
      readonly preflight: boolean;
      readonly targetMessageId: MessageId | null;
      readonly restoreFiles: boolean;
    };

export const EMPTY_REWIND_UI_STATE: RewindUiState = {
  pendingByThreadId: {},
  landedByThreadId: {},
  hiddenDraftOperationIds: {},
  reopenByThreadId: {},
};

export function withoutKey<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Readonly<Record<string, T>> {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function readFailurePayload(payload: unknown): {
  detail: string;
  operationId: string | null;
  targetMessageId: MessageId | null;
  restoreFiles: boolean;
  stage: string | null;
} {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  return {
    detail: typeof record.detail === "string" ? record.detail : "The revert failed.",
    operationId: typeof record.operationId === "string" ? record.operationId : null,
    targetMessageId:
      typeof record.targetMessageId === "string" ? (record.targetMessageId as MessageId) : null,
    restoreFiles: record.restoreFiles === true,
    stage: typeof record.stage === "string" ? record.stage : null,
  };
}

/** The server gives up on a rewind after 30s; past this, a pending entry with no server trace is stale. */
export const PENDING_REWIND_STALE_MS = 45_000;
/** How long a landed revert may wait for its real draft before it is presumed resolved elsewhere. */
export const LANDED_REWIND_STALE_MS = 15_000;

export interface RewindThreadSnapshot {
  readonly threadId: ThreadId;
  readonly messageIds: ReadonlySet<string>;
  readonly drafts: ReadonlyArray<{ readonly operationId: string; readonly inFlight: boolean }>;
}

/**
 * Checks this store against what the server's snapshot says. Live events can be
 * missed (reconnects, a restart mid-rewind, a swallowed failure activity), and
 * without this a pending revert would keep the thread "Reverting" until reload.
 */
export function reconcileRewindUi(
  state: RewindUiState,
  snapshot: RewindThreadSnapshot,
  now: number,
): RewindUiState {
  const { threadId } = snapshot;
  let next = state;
  const pending = state.pendingByThreadId[threadId];
  if (pending) {
    const draft = snapshot.drafts.find((entry) => entry.operationId === pending.operationId);
    if (!snapshot.messageIds.has(pending.targetMessageId)) {
      // The target was pruned, so the revert landed even if we missed the event.
      next = {
        ...next,
        pendingByThreadId: withoutKey(next.pendingByThreadId, threadId),
        landedByThreadId: {
          ...next.landedByThreadId,
          [threadId]: { ...pending, landedAt: new Date(now).toISOString() },
        },
      };
    } else if (
      (draft && !draft.inFlight) ||
      (!draft && now - Date.parse(pending.requestedAt) > PENDING_REWIND_STALE_MS)
    ) {
      // Parked on an error (the panel explains it) or long gone without a trace.
      next = { ...next, pendingByThreadId: withoutKey(next.pendingByThreadId, threadId) };
    }
  }
  const landed = next.landedByThreadId[threadId];
  if (
    landed &&
    (snapshot.drafts.some((entry) => entry.operationId === landed.operationId) ||
      now - Date.parse(landed.landedAt) > LANDED_REWIND_STALE_MS)
  ) {
    // The real draft took over, or it was resolved while we weren't listening.
    next = { ...next, landedByThreadId: withoutKey(next.landedByThreadId, threadId) };
  }
  return next;
}

/** Milliseconds until `reconcileRewindUi` could next change this thread's entries, if ever. */
export function nextRewindUiExpiry(
  state: RewindUiState,
  threadId: ThreadId,
  now: number,
): number | null {
  const deadlines: number[] = [];
  const pending = state.pendingByThreadId[threadId];
  if (pending) deadlines.push(Date.parse(pending.requestedAt) + PENDING_REWIND_STALE_MS);
  const landed = state.landedByThreadId[threadId];
  if (landed) deadlines.push(Date.parse(landed.landedAt) + LANDED_REWIND_STALE_MS);
  if (deadlines.length === 0) return null;
  return Math.max(0, Math.min(...deadlines) - now) + 1;
}

/**
 * Transition for one domain event. `capturePrompt` reads the target message
 * when a revert started elsewhere (another window) and there is no optimistic
 * entry for it yet.
 */
export function applyRewindUiEvent(
  state: RewindUiState,
  event: OrchestrationEvent,
  capturePrompt: (threadId: ThreadId, messageId: MessageId) => RewindPromptPreview | null,
): { state: RewindUiState; effect: RewindUiEffect | null } {
  switch (event.type) {
    case "thread.conversation-revert-requested": {
      const { threadId, operationId, targetMessageId, restoreFiles } = event.payload;
      if (state.pendingByThreadId[threadId]?.operationId === operationId)
        return { state, effect: null };
      return {
        state: {
          ...state,
          pendingByThreadId: {
            ...state.pendingByThreadId,
            [threadId]: {
              operationId,
              threadId,
              targetMessageId,
              restoreFiles,
              prompt: capturePrompt(threadId, targetMessageId),
              requestedAt: event.occurredAt,
            },
          },
        },
        effect: null,
      };
    }
    case "thread.reverted": {
      const { threadId, operationId } = event.payload;
      const pending = state.pendingByThreadId[threadId];
      if (!operationId || pending?.operationId !== operationId) return { state, effect: null };
      const landed: LandedRewind = { ...pending, landedAt: event.occurredAt };
      return {
        state: {
          ...state,
          pendingByThreadId: withoutKey(state.pendingByThreadId, threadId),
          landedByThreadId: { ...state.landedByThreadId, [threadId]: landed },
        },
        effect: { kind: "reverted", rewind: landed },
      };
    }
    case "thread.rewind-draft-resolved": {
      const { threadId, operationId } = event.payload;
      return {
        state: {
          ...state,
          pendingByThreadId:
            state.pendingByThreadId[threadId]?.operationId === operationId
              ? withoutKey(state.pendingByThreadId, threadId)
              : state.pendingByThreadId,
          landedByThreadId:
            state.landedByThreadId[threadId]?.operationId === operationId
              ? withoutKey(state.landedByThreadId, threadId)
              : state.landedByThreadId,
          hiddenDraftOperationIds: withoutKey(state.hiddenDraftOperationIds, operationId),
        },
        effect: null,
      };
    }
    case "thread.activity-appended": {
      if (event.payload.activity.kind !== "conversation.rewind.failed")
        return { state, effect: null };
      const { threadId } = event.payload;
      const failure = readFailurePayload(event.payload.activity.payload);
      const pending = state.pendingByThreadId[threadId];
      const matches =
        pending !== undefined &&
        (failure.operationId === null || failure.operationId === pending.operationId);
      return {
        state: matches
          ? { ...state, pendingByThreadId: withoutKey(state.pendingByThreadId, threadId) }
          : state,
        effect: {
          kind: "failed",
          threadId,
          detail: failure.detail,
          preflight: failure.stage === "preflight",
          targetMessageId: failure.targetMessageId ?? pending?.targetMessageId ?? null,
          restoreFiles: failure.restoreFiles || (pending?.restoreFiles ?? false),
        },
      };
    }
    default:
      return { state, effect: null };
  }
}
