import {
  CommandId,
  type NextTurnQueueSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadDetails,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { Effect } from "effect";
import type {
  ProjectionTurnState,
  ProjectionTurn,
} from "../persistence/Services/ProjectionTurns.ts";
import type { NextTurnQueueSubmissionRecord } from "./Services/NextTurnQueueStore.ts";

export interface TurnSubmissionStatusDeps<E> {
  readonly getQueueSnapshot: (threadId: ThreadId) => Effect.Effect<NextTurnQueueSnapshot, E>;
  readonly getSubmission: (
    submissionId: CommandId,
  ) => Effect.Effect<NextTurnQueueSubmissionRecord | null, E>;
  /** Projected details bind user messages to their accepted turn, even for turnId:null sends. */
  readonly getThreadDetails: (threadId: ThreadId) => Effect.Effect<OrchestrationThreadDetails, E>;
  readonly getTurnState: (input: {
    threadId: ThreadId;
    turnId: TurnId;
  }) => Effect.Effect<ProjectionTurnState | null, E>;
}

export interface TurnSubmissionStatus {
  readonly status:
    | "queued"
    | "preparing-worktree"
    | "blocked"
    | "rejected"
    | "running"
    | "awaiting-input"
    | "awaiting-approval"
    | "completed"
    | "interrupted"
    | "failed";
  readonly turnId?: TurnId;
  readonly reason?: string;
}

/** Normal sends deliberately store a null message turnId; accepted turn rows own this binding. */
export function bindSubmissionTurnIds(
  details: OrchestrationThreadDetails,
  turns: ReadonlyArray<Pick<ProjectionTurn, "pendingMessageId" | "turnId">>,
): OrchestrationThreadDetails {
  const byMessage = new Map(
    turns
      .filter((turn) => turn.pendingMessageId && turn.turnId)
      .map((turn) => [turn.pendingMessageId, turn.turnId]),
  );
  return {
    ...details,
    messages: details.messages.map((message) => ({
      ...message,
      turnId: byMessage.get(message.id) ?? message.turnId,
    })),
  };
}

function hasPendingApproval(thread: OrchestrationThread): boolean {
  const open = new Set<string>();
  for (const activity of [...thread.activities].toSorted(
    (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.createdAt.localeCompare(b.createdAt),
  )) {
    const payload = activity.payload as { requestId?: unknown } | null;
    if (typeof payload?.requestId !== "string") continue;
    if (activity.kind === "approval.requested") open.add(payload.requestId);
    else if (activity.kind === "approval.resolved") open.delete(payload.requestId);
  }
  return open.size > 0;
}

export function resolveTurnSubmissionStatus<E>(
  deps: TurnSubmissionStatusDeps<E>,
  input: {
    readonly thread: OrchestrationThread;
    readonly submissionId: string;
    readonly knownTurnId?: TurnId | null | undefined;
  },
): Effect.Effect<TurnSubmissionStatus, E> {
  return Effect.gen(function* () {
    const { thread, submissionId } = input;
    const queue = yield* deps.getQueueSnapshot(thread.id);
    const item = queue.items.find((entry) => entry.submissionId === submissionId);
    if (item) {
      if (queue.reasonCode === "worktree_setup") return { status: "preparing-worktree" };
      if (
        item.status === "failed" ||
        queue.blockedKind === "paused" ||
        queue.blockedKind === "error"
      )
        return {
          status: "blocked",
          reason: queue.reasonDetail ?? queue.reasonCode ?? item.lastErrorDetail ?? "Blocked.",
        };
      return { status: "queued" };
    }
    const record = yield* deps.getSubmission(CommandId.makeUnsafe(submissionId));
    if (!record || record.disposition === "pending" || record.disposition === "queued")
      return { status: "queued" };
    if (
      record.disposition === "canceled" ||
      record.disposition === "cleared" ||
      record.disposition === "rejected"
    )
      return { status: "rejected", reason: record.reasonCode ?? record.disposition };
    const turnId =
      input.knownTurnId ??
      (yield* deps.getThreadDetails(thread.id)).messages.find(
        (message) => message.id === record.messageId,
      )?.turnId;
    if (!turnId) return { status: "running" };
    const state = yield* deps.getTurnState({ threadId: thread.id, turnId });
    switch (state) {
      case "completed":
        return { status: "completed", turnId };
      case "interrupted":
        return { status: "interrupted", turnId };
      case "error":
        return {
          status: "failed",
          turnId,
          ...(thread.latestTurn?.turnId === turnId && thread.session?.lastError
            ? { reason: thread.session.lastError }
            : {}),
        };
      default:
        if (thread.latestTurn?.turnId === turnId) {
          if ((thread.pendingUserInputs?.length ?? 0) > 0)
            return { status: "awaiting-input", turnId };
          if (hasPendingApproval(thread)) return { status: "awaiting-approval", turnId };
        }
        return { status: "running", turnId };
    }
  });
}
