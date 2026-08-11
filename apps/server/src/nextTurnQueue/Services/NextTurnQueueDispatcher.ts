import type {
  CommandId,
  NextTurnQueueSnapshot,
  NextTurnQueueSummary,
  ThreadId,
  TurnSubmissionResult,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Scope, Stream } from "effect";

import type { NextTurnQueueError } from "../Errors.ts";
import type { ProviderTurnDeliveryOutcome } from "../../orchestration/Services/ProviderTurnDeliveryWorker.ts";

export interface NextTurnQueueDispatcherShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly notify: (threadId: ThreadId) => Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;
  readonly submitAndSettle: (input: {
    readonly threadId: ThreadId;
    readonly itemId: CommandId;
    readonly submissionId: CommandId;
  }) => Effect.Effect<TurnSubmissionResult, NextTurnQueueError>;
  readonly getSnapshot: (
    threadId: ThreadId,
  ) => Effect.Effect<NextTurnQueueSnapshot, NextTurnQueueError>;
  readonly getSummary: Effect.Effect<NextTurnQueueSummary, NextTurnQueueError>;
  readonly promote: (input: {
    readonly itemId: CommandId;
    readonly interruptActive: boolean;
    readonly expectedRevision: number;
  }) => Effect.Effect<NextTurnQueueSnapshot, NextTurnQueueError>;
  readonly refreshGate: (
    threadId: ThreadId,
  ) => Effect.Effect<NextTurnQueueSnapshot, NextTurnQueueError>;
  readonly handleDeliveryOutcome: (
    outcome: ProviderTurnDeliveryOutcome,
  ) => Effect.Effect<void, NextTurnQueueError>;
  readonly changes: Stream.Stream<ThreadId>;
  readonly summaryChanges: Stream.Stream<void>;
}

export class NextTurnQueueDispatcher extends ServiceMap.Service<
  NextTurnQueueDispatcher,
  NextTurnQueueDispatcherShape
>()("t3/nextTurnQueue/Services/NextTurnQueueDispatcher") {}
