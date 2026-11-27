import { Schema } from "effect";
import { MoveSnapshot } from "../../git/moveSnapshot.ts";
import type {
  ThreadId,
  WorkspaceTransitionSnapshot,
  WorktreesSwitchWorkspaceInput,
} from "@t3tools/contracts";
import { Effect, ServiceMap } from "effect";

export const WorkspaceMoveData = Schema.Struct({
  snapshot: MoveSnapshot,
  snapshotRef: Schema.NullOr(Schema.String),
  createdBranch: Schema.Boolean,
  createdWorktree: Schema.Boolean,
  copyStarted: Schema.Boolean,
  discarded: Schema.Boolean,
  discardStarted: Schema.Boolean,
});
export type WorkspaceMoveData = typeof WorkspaceMoveData.Type;
export interface WorkspaceTransitionRecord extends WorkspaceTransitionSnapshot {
  readonly moveData?: WorkspaceMoveData | undefined;
  readonly request: WorktreesSwitchWorkspaceInput;
  readonly requestHash: string;
  readonly baseRef?: string | undefined;
  readonly fingerprint: string | null;
  readonly mutationAttempted: boolean;
  readonly commandId: string;
  /** Only setup's work-locally handoff may consume its own durable setup token. */
  readonly setupOwnerToken: string | null;
  readonly setupOwnerOperationId?: string | undefined;
}
/** Phases a running switch passes through. Only these hold a thread. */
export const activeTransitionPhases = ["reserved", "stopping", "applying", "applied"] as const;
export const transitionIsActive = (record: WorkspaceTransitionSnapshot) =>
  (activeTransitionPhases as readonly string[]).includes(record.phase);
/**
 * A row nobody finished. `needs_recovery` is no longer written: it is read only
 * from rows an older version left behind, which are settled like any other.
 */
export const transitionIsUnsettled = (record: WorkspaceTransitionSnapshot) =>
  transitionIsActive(record) || record.phase === "needs_recovery";
export class WorkspaceTransitionError extends Error {
  readonly _tag = "WorkspaceTransitionError";
}
export interface WorkspaceTransitionsShape {
  readonly get: (
    operationId: string,
  ) => Effect.Effect<WorkspaceTransitionRecord | null, WorkspaceTransitionError>;
  readonly forThread: (
    threadId: ThreadId,
    activeOnly?: boolean,
  ) => Effect.Effect<WorkspaceTransitionRecord | null, WorkspaceTransitionError>;
  readonly reserve: (
    record: WorkspaceTransitionRecord,
  ) => Effect.Effect<WorkspaceTransitionRecord, WorkspaceTransitionError>;
  /**
   * Runs an attempt again that ended unfinished without touching Git. Only for a
   * caller that must reuse its operation ID; everyone else starts a new switch.
   */
  readonly reactivate: (
    record: WorkspaceTransitionRecord,
  ) => Effect.Effect<WorkspaceTransitionRecord, WorkspaceTransitionError>;
  readonly update: (
    record: WorkspaceTransitionRecord,
    patch: Partial<
      Pick<
        WorkspaceTransitionRecord,
        | "moveData"
        | "move"
        | "phase"
        | "target"
        | "observed"
        | "fingerprint"
        | "mutationAttempted"
        | "result"
        | "error"
        | "commandId"
        | "checkoutConflict"
        | "errorCode"
      >
    >,
  ) => Effect.Effect<WorkspaceTransitionRecord, WorkspaceTransitionError>;
  readonly unfinishedMoves: Effect.Effect<
    ReadonlyArray<WorkspaceTransitionRecord>,
    WorkspaceTransitionError
  >;
  /** Every row that is not completed, failed or cancelled, oldest first. */
  readonly unsettled: Effect.Effect<
    ReadonlyArray<WorkspaceTransitionRecord>,
    WorkspaceTransitionError
  >;
  /** Completes rows whose metadata write was accepted before a restart. */
  readonly reconcile: Effect.Effect<void, WorkspaceTransitionError>;
  /** Ends a thread's unsettled row without reading it, for records that no longer decode. */
  readonly cancel: (threadId: ThreadId) => Effect.Effect<void, WorkspaceTransitionError>;
}
export class WorkspaceTransitions extends ServiceMap.Service<
  WorkspaceTransitions,
  WorkspaceTransitionsShape
>()("t3/persistence/Services/WorkspaceTransitions") {}

/** Expose only the wire snapshot; ownership capabilities and normalized requests stay server-side. */
export const workspaceTransitionSnapshot = (
  record: WorkspaceTransitionSnapshot,
): WorkspaceTransitionSnapshot => ({
  ...(record.move ? { move: record.move } : {}),
  operationId: record.operationId,
  threadId: record.threadId,
  version: record.version,
  intent: record.intent,
  phase: record.phase,
  source: record.source,
  target: record.target,
  observed: record.observed,
  error: record.error,
  result: record.result,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  ...(record.checkoutConflict ? { checkoutConflict: record.checkoutConflict } : {}),
  ...(record.errorCode ? { errorCode: record.errorCode } : {}),
});
