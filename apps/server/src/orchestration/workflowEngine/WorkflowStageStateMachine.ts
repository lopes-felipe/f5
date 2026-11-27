import type { CommandId, OrchestrationReadModel, ThreadId } from "@t3tools/contracts";

import type { ProviderTurnDelivery } from "../Services/ProviderTurnDeliveryRepository.ts";
import {
  completedTurnEvidenceAt,
  getFinishedConsumableLatestTurn,
  hasActiveRunningTurn,
} from "../workflowSharedUtils.ts";
import {
  stageDispatchAllowsTurn,
  type WorkflowStageDispatchTurn,
} from "../workflowStageDispatch.ts";

/**
 * Minimal structural contract for a stage/slot record participating in the
 * shared workflow stage state machine (`pending | not_started | pending_start | running | completed | error`).
 */
export interface WorkflowStageRecord {
  readonly status: string;
  readonly pinnedTurnId: string | null;
  readonly pinnedAssistantMessageId: string | null;
  readonly dispatchCommandId?: CommandId | null | undefined;
  readonly updatedAt: string;
}

/**
 * Returns true when a finished thread turn can legitimately complete or repair
 * `stage`. Running stages only accept the turn produced by their own dispatch,
 * preventing stale or user-initiated turns on reused threads from hijacking a
 * stage transition. Error and unpinned-completed stages retain recovery rules.
 */
export function canConsumeCompletedStageTurn(
  stage: WorkflowStageRecord,
  thread: OrchestrationReadModel["threads"][number] | null | undefined,
  dispatch: WorkflowStageDispatchTurn,
): boolean {
  const completionEvidenceAt = completedTurnEvidenceAt(thread);
  const completedTurn = getFinishedConsumableLatestTurn(thread);
  if (!completionEvidenceAt || !completedTurn) {
    return false;
  }
  return (
    (stage.status === "running" && stageDispatchAllowsTurn(dispatch, completedTurn.turnId)) ||
    (stage.status === "error" && completionEvidenceAt >= stage.updatedAt) ||
    (stage.status === "completed" &&
      (stage.pinnedTurnId === null || stage.pinnedAssistantMessageId === null))
  );
}

/**
 * Returns true when `thread` currently has an active running turn requested at
 * or after `stageUpdatedAt`.
 */
export function hasNewerActiveStageTurn(
  stageUpdatedAt: string,
  thread: OrchestrationReadModel["threads"][number] | null | undefined,
): boolean {
  return (
    hasActiveRunningTurn(thread) &&
    thread?.latestTurn !== null &&
    thread?.latestTurn !== undefined &&
    thread.latestTurn.requestedAt >= stageUpdatedAt
  );
}

/**
 * Returns true when an accepted turn delivery still corresponds to the active
 * turn (or pre-send snapshot) on `thread`.
 */
export function acceptedDeliveryMatchesCurrentTurn(
  delivery: ProviderTurnDelivery,
  thread: OrchestrationReadModel["threads"][number] | null | undefined,
): boolean {
  if (delivery.state !== "accepted" || delivery.providerTurnId === null) {
    return false;
  }
  const latestTurn = thread?.latestTurn ?? null;
  if (!latestTurn) {
    return true;
  }
  if (latestTurn.turnId === delivery.providerTurnId) {
    return latestTurn.state === "running";
  }
  return delivery.preSendTurnIds.some((turnId) => turnId === latestTurn.turnId);
}

/**
 * Checks whether a stage is already completed with the exact same pinned turn
 * and assistant message (making a completion transition a no-op).
 */
export function isStageAlreadyCompletedWith(
  stage: Pick<WorkflowStageRecord, "status" | "pinnedTurnId" | "pinnedAssistantMessageId">,
  turnId: string | null,
  assistantMessageId: string | null,
): boolean {
  return (
    stage.status === "completed" &&
    stage.pinnedTurnId === turnId &&
    stage.pinnedAssistantMessageId === assistantMessageId
  );
}

type StageStatusAllowed<T extends { readonly status: string }, Target extends string> = [
  Target,
] extends [T["status"]]
  ? unknown
  : { readonly status: Target };

/**
 * Immutable transition to `pending_start` once a stage thread has been created.
 */
export function transitionStagePendingStart<
  T extends {
    readonly threadId: ThreadId | null;
    readonly status: string;
    readonly error: string | null;
    readonly updatedAt: string;
  },
  TThreadId extends T["threadId"] = T["threadId"],
>(
  stage: T & StageStatusAllowed<T, "pending_start">,
  threadId: TThreadId,
  updatedAt: string,
): Omit<T, "threadId" | "status" | "error" | "updatedAt"> & {
  readonly threadId: TThreadId;
  readonly status: "pending_start";
  readonly error: null;
  readonly updatedAt: string;
} {
  return {
    ...stage,
    threadId,
    status: "pending_start",
    error: null,
    updatedAt,
  };
}

/**
 * Immutable transition to `running` when a stage turn is dispatched (or retried).
 */
export function transitionStageRunning<
  T extends {
    readonly status: string;
    readonly error: string | null;
    readonly dispatchCommandId?: CommandId | null | undefined;
    readonly updatedAt: string;
  },
  TDispatch extends CommandId | null = CommandId | null,
>(
  stage: T & StageStatusAllowed<T, "running">,
  updatedAt: string,
  dispatchCommandId: TDispatch,
  extras?: Partial<Omit<T, "status" | "error" | "dispatchCommandId" | "updatedAt">>,
): Omit<T, "status" | "error" | "dispatchCommandId" | "updatedAt"> & {
  readonly status: "running";
  readonly error: null;
  readonly dispatchCommandId: TDispatch;
  readonly updatedAt: string;
} {
  return {
    ...stage,
    ...extras,
    status: "running",
    error: null,
    dispatchCommandId,
    updatedAt,
  };
}

/**
 * Immutable transition to `completed` with pinned turn/message metadata.
 */
export function transitionStageCompleted<
  T extends {
    readonly status: string;
    readonly pinnedTurnId: string | null;
    readonly pinnedAssistantMessageId: string | null;
    readonly error: string | null;
    readonly updatedAt: string;
  },
>(
  stage: T & StageStatusAllowed<T, "completed">,
  input: {
    readonly turnId: string | null;
    readonly assistantMessageId: string | null;
    readonly updatedAt: string;
  },
): Omit<T, "status" | "pinnedTurnId" | "pinnedAssistantMessageId" | "error" | "updatedAt"> & {
  readonly status: "completed";
  readonly pinnedTurnId: string | null;
  readonly pinnedAssistantMessageId: string | null;
  readonly error: null;
  readonly updatedAt: string;
} {
  return {
    ...stage,
    status: "completed",
    pinnedTurnId: input.turnId,
    pinnedAssistantMessageId: input.assistantMessageId,
    error: null,
    updatedAt: input.updatedAt,
  };
}

/**
 * Immutable transition to `error` with an actionable diagnostic message.
 */
export function transitionStageError<
  T extends {
    readonly status: string;
    readonly error: string | null;
    readonly updatedAt: string;
  },
>(
  stage: T & StageStatusAllowed<T, "error">,
  error: string,
  updatedAt: string,
): Omit<T, "status" | "error" | "updatedAt"> & {
  readonly status: "error";
  readonly error: string;
  readonly updatedAt: string;
} {
  return {
    ...stage,
    status: "error",
    error,
    updatedAt,
  };
}
