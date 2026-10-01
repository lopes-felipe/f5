import type {
  CommandId,
  ThreadId,
  ThreadTurnStartCommand,
  TurnSubmissionResult,
  WorktreeSetupSnapshot,
  WorktreeSetupUpdatedPayload,
} from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Scope, Stream } from "effect";

export class WorktreeSetupError extends Schema.TaggedErrorClass<WorktreeSetupError>()(
  "WorktreeSetupError",
  {
    message: Schema.String,
    code: Schema.optional(Schema.String),
  },
) {}

export interface WorktreeSetupStartInput {
  /** A first send with `bootstrap.createThread` and `bootstrap.prepareWorktree`. */
  readonly command: ThreadTurnStartCommand;
  readonly submissionId: CommandId;
  readonly requestHash: string;
  /** Persists prepared attachment ingress once the thread exists. */
  readonly persistAttachments: Effect.Effect<void, { readonly message: string }>;
  readonly discardAttachments: Effect.Effect<void>;
}

export type WorktreeSetupStartResult =
  | { readonly kind: "queued"; readonly result: TurnSubmissionResult }
  /** Preflight found no usable repository or base; the caller falls back or rejects. */
  | { readonly kind: "unavailable"; readonly detail: string };

export interface WorktreeSetupShape {
  /** Preflight, create the thread, queue its first turn at the head, and fork setup. */
  readonly start: (
    input: WorktreeSetupStartInput,
  ) => Effect.Effect<WorktreeSetupStartResult, WorktreeSetupError>;
  readonly get: (threadId: ThreadId) => Effect.Effect<WorktreeSetupSnapshot | null>;
  /**
   * Running and the agent has not started: stop setup and remove what it
   * created when that is provably safe. Agent started: stop the turn, remove
   * nothing. Already settled: discard the setup, its queued turn and the
   * still-empty thread under the same preservation rules.
   */
  readonly cancel: (
    threadId: ThreadId,
  ) => Effect.Effect<WorktreeSetupSnapshot | null, WorktreeSetupError>;
  readonly retry: (
    threadId: ThreadId,
  ) => Effect.Effect<WorktreeSetupSnapshot | null, WorktreeSetupError>;
  /** Run the queued first turn in the project checkout instead. */
  readonly workLocally: (
    threadId: ThreadId,
  ) => Effect.Effect<WorktreeSetupSnapshot | null, WorktreeSetupError>;
  readonly changes: Stream.Stream<WorktreeSetupUpdatedPayload>;
  /** Startup reconciliation: a setup that was running when the server stopped becomes failed. */
  readonly startup: Effect.Effect<void, never, Scope.Scope>;
}

export class WorktreeSetup extends ServiceMap.Service<WorktreeSetup, WorktreeSetupShape>()(
  "t3/project/Services/WorktreeSetup",
) {}
