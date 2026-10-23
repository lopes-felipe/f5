import { Schema } from "effect";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString, TurnId } from "./baseSchemas";
import { ProviderKind } from "./orchestration";
import { ProviderInstanceId } from "./providerInstance";

export const AGENTS_WS_METHODS = {
  getSnapshot: "agents.getSnapshot",
  dismiss: "agents.dismiss",
} as const;

export const AGENTS_WS_CHANNELS = {
  snapshotUpdated: "agents.snapshotUpdated",
} as const;

export const MAX_AGENTS_SNAPSHOT_ENTRIES = 200;
export const MAX_BACKGROUND_WORK_OUTPUT_BYTES = 8 * 1024;

export const BackgroundWorkClassification = Schema.Literals(["working", "monitoring", "inert"]);
export type BackgroundWorkClassification = typeof BackgroundWorkClassification.Type;

export const BackgroundWorkOwnership = Schema.Literals(["direct-subagent", "workflow"]);
export type BackgroundWorkOwnership = typeof BackgroundWorkOwnership.Type;

/** What the work is: a delegated agent, a background shell/monitor, or workflow work. */
export const BackgroundWorkKind = Schema.Literals(["agent", "shell", "workflow"]);
export type BackgroundWorkKind = typeof BackgroundWorkKind.Type;

export const BackgroundWorkStatus = Schema.Literals([
  "running",
  "monitoring",
  "idle",
  "completed",
  "failed",
  "stopped",
  "interrupted",
]);
export type BackgroundWorkStatus = typeof BackgroundWorkStatus.Type;

export const ThreadBackgroundWorkEntry = Schema.Struct({
  threadId: ThreadId,
  workItemId: TrimmedNonEmptyString,
  provider: ProviderKind,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  providerSessionIdentity: Schema.NullOr(TrimmedNonEmptyString),
  turnId: Schema.NullOr(TurnId),
  classification: BackgroundWorkClassification,
  ownership: BackgroundWorkOwnership,
  // Identity fields decode with defaults so snapshots from servers that predate
  // them still load.
  kind: BackgroundWorkKind.pipe(Schema.withDecodingDefault(() => "agent" as const)),
  status: BackgroundWorkStatus,
  active: Schema.Boolean,
  model: Schema.NullOr(TrimmedNonEmptyString),
  effort: Schema.optional(Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(64)))),
  /** Task or subagent type, fixed at start. */
  phase: Schema.NullOr(TrimmedNonEmptyString),
  /** Human-readable title, fixed at start. */
  title: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(() => null)),
  /**
   * Original instructions given to the work, bounded. Only thread-scoped
   * snapshots carry it; global snapshots and pushes leave it null.
   */
  prompt: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(() => null)),
  /** Most recent tool the work used. */
  lastTool: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => null)),
  latestOutput: Schema.NullOr(Schema.String),
  outputTruncated: Schema.Boolean,
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type ThreadBackgroundWorkEntry = typeof ThreadBackgroundWorkEntry.Type;

export const AgentsSnapshot = Schema.Struct({
  entries: Schema.Array(ThreadBackgroundWorkEntry),
  generatedAt: IsoDateTime,
});
export type AgentsSnapshot = typeof AgentsSnapshot.Type;

export const AgentsGetSnapshotInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
});
export type AgentsGetSnapshotInput = typeof AgentsGetSnapshotInput.Type;

/**
 * Hide settled work from the agents panel. Specific work items, every settled
 * item in one thread, or every settled item when both fields are omitted.
 * Active work is never dismissed.
 */
export const AgentsDismissInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  workItemIds: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(500))),
});
export type AgentsDismissInput = typeof AgentsDismissInput.Type;

export const AgentsDismissResult = Schema.Struct({
  dismissedCount: Schema.Number,
});
export type AgentsDismissResult = typeof AgentsDismissResult.Type;
