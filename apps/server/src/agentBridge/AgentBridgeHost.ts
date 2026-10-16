/**
 * The narrow slice of the F5 server the Agent Bridge may use. Built in
 * `createServer` so bridge turns go through the same admission path as the
 * WS route, stamped as `automation`.
 *
 * @module agentBridge/AgentBridgeHost
 */
import type {
  CommandId,
  NextTurnQueueSnapshot,
  NextTurnQueueSubmitInput,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThreadDetails,
  ServerProvider,
  ServerSettings,
  ThreadId,
  TurnId,
  TurnSubmissionResult,
} from "@t3tools/contracts";
import { Data, type Effect, type Stream } from "effect";

import type { NextTurnQueueSubmissionRecord } from "../nextTurnQueue/Services/NextTurnQueueStore.ts";
import type { ProjectionTurnState } from "../persistence/Services/ProjectionTurns.ts";

export class AgentBridgeHostError extends Data.TaggedError("AgentBridgeHostError")<{
  readonly message: string;
  readonly code?: string;
}> {}

export type ThreadActivityAppendCommand = Extract<
  OrchestrationCommand,
  { type: "thread.activity.append" }
>;

export interface AgentBridgeHostShape {
  readonly readSnapshot: Effect.Effect<OrchestrationReadModel, AgentBridgeHostError>;
  readonly getThreadDetails: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationThreadDetails, AgentBridgeHostError>;
  /** The lifecycle state of one turn, or null when F5 has no record of it. */
  readonly getTurnState: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) => Effect.Effect<ProjectionTurnState | null, AgentBridgeHostError>;
  /** Whole-thread diff up to `toTurnCount`, or one turn when `fromTurnCount` is given. */
  readonly getThreadDiff: (input: {
    readonly threadId: ThreadId;
    readonly fromTurnCount?: number;
    readonly toTurnCount: number;
  }) => Effect.Effect<string, AgentBridgeHostError>;
  readonly getQueueSnapshot: (
    threadId: ThreadId,
  ) => Effect.Effect<NextTurnQueueSnapshot, AgentBridgeHostError>;
  readonly getSubmission: (
    submissionId: CommandId,
  ) => Effect.Effect<NextTurnQueueSubmissionRecord | null, AgentBridgeHostError>;
  /** Wakes waiters; the queue publishes a thread id whenever its state changes. */
  readonly queueChanges: Stream.Stream<ThreadId>;
  readonly domainEvents: Stream.Stream<OrchestrationEvent>;
  /** Persisted events after a sequence (exclusive), in bounded pages; drives event delivery. */
  readonly readEventsAfter: (
    sequenceExclusive: number,
  ) => Stream.Stream<OrchestrationEvent, AgentBridgeHostError>;
  readonly listProviderInstances: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly getSettings: Effect.Effect<ServerSettings, AgentBridgeHostError>;
  /** Current branch of a project checkout, or null when it is not a git repository. */
  readonly getProjectGitBranch: (cwd: string) => Effect.Effect<string | null>;
  readonly submitTurnSubmission: (
    body: NextTurnQueueSubmitInput,
    options: { readonly submissionSource: "automation" },
  ) => Effect.Effect<TurnSubmissionResult | null, AgentBridgeHostError>;
  /** The bridge dispatches only activity rows. */
  readonly dispatch: (
    command: ThreadActivityAppendCommand,
  ) => Effect.Effect<void, AgentBridgeHostError>;
}
