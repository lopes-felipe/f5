import type {
  CommandId,
  NextTurnQueueItem,
  NextTurnQueueSummary,
  QueueReasonCode,
  ThreadId,
  ThreadTurnStartCommand,
  TurnSubmissionResult,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { NextTurnQueueError } from "../Errors.ts";

export interface NextTurnQueueState {
  readonly threadId: ThreadId;
  readonly paused: boolean;
  readonly pauseReasonCode: QueueReasonCode | null;
  readonly pauseDetail: string | null;
  readonly resumedAt: string | null;
  readonly interruptSuppressionCommandId: CommandId | null;
  readonly worktreeBlockToken: string | null;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface NextTurnQueueSubmissionRecord {
  readonly submissionId: CommandId;
  readonly threadId: ThreadId;
  readonly requestHash: string;
  readonly itemId: CommandId | null;
  readonly messageId: string;
  readonly disposition: "pending" | "started" | "queued" | "canceled" | "cleared" | "rejected";
  readonly resultSequence: number | null;
  readonly reasonCode: string | null;
  readonly createdAt: string;
  readonly settledAt: string | null;
}

export interface NextTurnQueueThreadData {
  readonly items: ReadonlyArray<NextTurnQueueItem>;
  readonly state: NextTurnQueueState;
  readonly quarantinedCount: number;
}

export interface NextTurnQueueClaim {
  readonly item: NextTurnQueueItem;
  readonly leaseOwner: string;
}

export interface NextTurnQueueStoreShape {
  readonly listByThread: (
    threadId: ThreadId,
  ) => Effect.Effect<NextTurnQueueThreadData, NextTurnQueueError>;
  readonly listActionableThreadIds: Effect.Effect<ReadonlyArray<ThreadId>, NextTurnQueueError>;
  readonly getItem: (
    itemId: CommandId,
  ) => Effect.Effect<NextTurnQueueItem | null, NextTurnQueueError>;
  readonly getByCommandId: (
    commandId: CommandId,
  ) => Effect.Effect<NextTurnQueueItem | null, NextTurnQueueError>;
  readonly getBySubmissionId: (
    submissionId: CommandId,
  ) => Effect.Effect<NextTurnQueueSubmissionRecord | null, NextTurnQueueError>;
  readonly insertSubmission: (input: {
    readonly submissionId: CommandId;
    readonly requestHash: string;
    readonly itemId: CommandId;
    readonly command: ThreadTurnStartCommand;
    readonly atHead: boolean;
  }) => Effect.Effect<
    | { readonly kind: "created"; readonly item: NextTurnQueueItem }
    | { readonly kind: "replay"; readonly submission: NextTurnQueueSubmissionRecord },
    NextTurnQueueError
  >;
  readonly settleSubmission: (input: {
    readonly submissionId: CommandId;
    readonly result: TurnSubmissionResult;
  }) => Effect.Effect<void, NextTurnQueueError>;
  readonly updateCommand: (input: {
    readonly itemId: CommandId;
    readonly expectedUpdatedAt: string;
    readonly update: (command: ThreadTurnStartCommand) => ThreadTurnStartCommand;
  }) => Effect.Effect<NextTurnQueueItem, NextTurnQueueError>;
  readonly retry: (input: {
    readonly itemId: CommandId;
    readonly expectedUpdatedAt?: string | undefined;
  }) => Effect.Effect<NextTurnQueueItem, NextTurnQueueError>;
  readonly replacePositions: (input: {
    readonly threadId: ThreadId;
    readonly orderedItemIds: ReadonlyArray<CommandId>;
    readonly expectedRevision: number;
  }) => Effect.Effect<void, NextTurnQueueError>;
  readonly setPaused: (input: {
    readonly threadId: ThreadId;
    readonly paused: boolean;
    readonly reasonCode?: QueueReasonCode | null | undefined;
    readonly detail?: string | null | undefined;
    readonly expectedRevision?: number | undefined;
  }) => Effect.Effect<void, NextTurnQueueError>;
  readonly setInterruptSuppression: (input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId | null;
  }) => Effect.Effect<void, NextTurnQueueError>;
  readonly claim: (input: {
    readonly itemId: CommandId;
    readonly leaseOwner: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
  }) => Effect.Effect<NextTurnQueueClaim | null, NextTurnQueueError>;
  readonly releaseLease: (input: {
    readonly itemId: CommandId;
    readonly leaseOwner: string;
    readonly notBefore: string;
    readonly errorCode: string;
    readonly errorDetail: string;
    readonly clearDispatchStartedAt: boolean;
    readonly consumeAttempt: boolean;
  }) => Effect.Effect<void, NextTurnQueueError>;
  readonly markFailed: (input: {
    readonly itemId: CommandId;
    readonly leaseOwner: string | null;
    readonly errorCode: string;
    readonly errorDetail: string;
  }) => Effect.Effect<void, NextTurnQueueError>;
  readonly complete: (input: {
    readonly itemId: CommandId;
    readonly leaseOwner?: string | undefined;
    readonly sequence?: number | undefined;
  }) => Effect.Effect<void, NextTurnQueueError>;
  readonly markAwaitingDelivery: (input: {
    readonly itemId: CommandId;
    readonly leaseOwner: string;
    readonly sequence: number;
  }) => Effect.Effect<void, NextTurnQueueError>;
  readonly completeDelivery: (input: {
    readonly commandId: CommandId;
  }) => Effect.Effect<void, NextTurnQueueError>;
  readonly markDeliveryFailed: (input: {
    readonly commandId: CommandId;
    readonly errorCode: "delivery_rejected" | "delivery_ambiguous";
    readonly errorDetail: string;
  }) => Effect.Effect<void, NextTurnQueueError>;
  readonly retryDelivery: (input: {
    readonly commandId: CommandId;
  }) => Effect.Effect<void, NextTurnQueueError>;
  readonly discardDelivery: (input: {
    readonly commandId: CommandId;
  }) => Effect.Effect<NextTurnQueueItem | null, NextTurnQueueError>;
  readonly softDelete: (input: {
    readonly itemId: CommandId;
    readonly expectedUpdatedAt?: string | undefined;
  }) => Effect.Effect<NextTurnQueueItem, NextTurnQueueError>;
  readonly clear: (input: {
    readonly threadId: ThreadId;
    readonly scope: "all" | "failed";
    readonly expectedRevision: number;
  }) => Effect.Effect<ReadonlyArray<NextTurnQueueItem>, NextTurnQueueError>;
  readonly restore: (input: {
    readonly threadId: ThreadId;
    readonly itemIds: ReadonlyArray<CommandId>;
    readonly expectedRevision: number;
  }) => Effect.Effect<ReadonlyArray<NextTurnQueueItem>, NextTurnQueueError>;
  readonly duplicate: (input: {
    readonly itemId: CommandId;
    readonly expectedUpdatedAt?: string | undefined;
  }) => Effect.Effect<NextTurnQueueItem, NextTurnQueueError>;
  readonly reclaimStaleLeases: (
    liveItemIds: ReadonlySet<CommandId>,
  ) => Effect.Effect<ReadonlyArray<ThreadId>, NextTurnQueueError>;
  readonly hardDeleteExpired: Effect.Effect<ReadonlyArray<ThreadId>, NextTurnQueueError>;
  readonly deleteForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<NextTurnQueueItem>, NextTurnQueueError>;
  readonly deleteOrphans: Effect.Effect<ReadonlyArray<ThreadId>, NextTurnQueueError>;
  readonly drainOrphanedAttachments: Effect.Effect<void, NextTurnQueueError>;
  readonly purgeSettledSubmissions: Effect.Effect<void, NextTurnQueueError>;
  readonly summary: Effect.Effect<NextTurnQueueSummary, NextTurnQueueError>;
}

export class NextTurnQueueStore extends ServiceMap.Service<
  NextTurnQueueStore,
  NextTurnQueueStoreShape
>()("t3/nextTurnQueue/Services/NextTurnQueueStore") {}
