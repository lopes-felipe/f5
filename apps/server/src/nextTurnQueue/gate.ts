import type { NextTurnQueueItem, QueueReasonCode } from "@t3tools/contracts";

import type { ProjectionThreadSession } from "../persistence/Services/ProjectionThreadSessions.ts";
import type {
  ProjectionPendingTurnStart,
  ProjectionTurnById,
} from "../persistence/Services/ProjectionTurns.ts";
import type { ProjectionThread } from "../persistence/Services/ProjectionThreads.ts";
import type { NextTurnQueueState } from "./Services/NextTurnQueueStore.ts";
import { QUIESCENCE_WAIT_TIMEOUT_MS, STALE_PENDING_TURN_MS } from "./constants.ts";

export type NextTurnQueueGate =
  | { readonly kind: "ready" }
  | { readonly kind: "wait"; readonly reasonCode: QueueReasonCode; readonly detail?: string }
  | { readonly kind: "autoPause"; readonly reasonCode: QueueReasonCode; readonly detail?: string }
  | { readonly kind: "drop"; readonly reasonCode: QueueReasonCode };

function isNewerThan(value: string, watermark: string | null): boolean {
  return watermark === null || value > watermark;
}

export function resolveNextTurnQueueGate(input: {
  readonly item: NextTurnQueueItem;
  readonly state: NextTurnQueueState;
  readonly thread: ProjectionThread | null;
  readonly session: ProjectionThreadSession | null;
  readonly pendingTurnStart: ProjectionPendingTurnStart | null;
  readonly runningTurn: ProjectionTurnById | null;
  readonly terminalTurn?: ProjectionTurnById | null | undefined;
  readonly hasDispatchingItem: boolean;
  readonly automaticCompaction: boolean;
  readonly worktreeExists: boolean | null;
  readonly nowMs?: number | undefined;
}): NextTurnQueueGate {
  if (input.thread === null || input.thread.deletedAt !== null) {
    return { kind: "drop", reasonCode: "thread_deleted" };
  }
  if (input.state.paused) {
    return {
      kind: "wait",
      reasonCode: input.state.pauseReasonCode ?? "manual_pause",
      ...(input.state.pauseDetail ? { detail: input.state.pauseDetail } : {}),
    };
  }
  if (input.thread.archivedAt !== null) {
    return { kind: "autoPause", reasonCode: "thread_archived" };
  }
  if (input.thread.worktreePath !== null && input.worktreeExists === false) {
    return {
      kind: "autoPause",
      reasonCode: "worktree_missing",
      detail: `Worktree '${input.thread.worktreePath}' is missing.`,
    };
  }
  if (
    input.session !== null &&
    (input.session.status === "error" || input.session.lastError !== null) &&
    isNewerThan(input.session.updatedAt, input.state.resumedAt)
  ) {
    return {
      kind: "autoPause",
      reasonCode: "turn_failed",
      ...(input.session.lastError ? { detail: input.session.lastError } : {}),
    };
  }
  if (
    input.pendingTurnStart !== null &&
    input.session?.status !== "running" &&
    (input.nowMs ?? Date.now()) - Date.parse(input.pendingTurnStart.requestedAt) >=
      STALE_PENDING_TURN_MS
  ) {
    return { kind: "autoPause", reasonCode: "turn_never_started" };
  }
  if (input.hasDispatchingItem) {
    return { kind: "wait", reasonCode: "dispatch_in_flight" };
  }
  if (
    input.item.notBefore !== null &&
    Date.parse(input.item.notBefore) > (input.nowMs ?? Date.now())
  ) {
    return { kind: "wait", reasonCode: "delivery_retrying" };
  }
  if (input.automaticCompaction) {
    return { kind: "wait", reasonCode: "thread_compacting" };
  }
  if (input.pendingTurnStart !== null) {
    return { kind: "wait", reasonCode: "turn_starting" };
  }
  if (
    input.runningTurn !== null ||
    (input.session !== null &&
      (input.session.activeTurnId !== null ||
        input.session.status === "starting" ||
        input.session.status === "running"))
  ) {
    return { kind: "wait", reasonCode: "active_turn" };
  }
  const terminalTurn = input.terminalTurn ?? null;
  if (terminalTurn !== null && terminalTurn.processingQuiescedAt === null) {
    const terminalAt =
      terminalTurn.completedAt ?? terminalTurn.startedAt ?? terminalTurn.requestedAt;
    if ((input.nowMs ?? Date.now()) - Date.parse(terminalAt) >= QUIESCENCE_WAIT_TIMEOUT_MS) {
      return { kind: "autoPause", reasonCode: "post_processing_stalled" };
    }
    return { kind: "wait", reasonCode: "turn_post_processing" };
  }
  return { kind: "ready" };
}
