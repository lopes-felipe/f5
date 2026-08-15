import { Schema } from "effect";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString, TurnId } from "./baseSchemas";
import { ProviderKind } from "./orchestration";
import { ProviderInstanceId } from "./providerInstance";

export const AGENTS_WS_METHODS = {
  getSnapshot: "agents.getSnapshot",
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
  status: BackgroundWorkStatus,
  active: Schema.Boolean,
  model: Schema.NullOr(TrimmedNonEmptyString),
  phase: Schema.NullOr(TrimmedNonEmptyString),
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

export const AgentsGetSnapshotInput = Schema.Struct({});
export type AgentsGetSnapshotInput = typeof AgentsGetSnapshotInput.Type;
