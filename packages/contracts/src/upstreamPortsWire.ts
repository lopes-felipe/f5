/**
 * The upstream-ports contracts that startup code needs: the settings schema,
 * RPC method and push channel names, and the push payload. Kept apart from
 * `upstreamPorts.ts` so the web app's initial bundle does not pull in the
 * ledger and RPC schemas, which only the lazy Upstream page uses.
 */
import { Schema } from "effect";

import { NonNegativeInt, ProjectId } from "./baseSchemas";
import { ModelSelection } from "./orchestration";
import { WorkflowModelSlot } from "./planningWorkflow";

// ── Local-only settings ─────────────────────────────────────────────────

export const UpstreamScheduleMode = Schema.Literals(["off", "daily", "weekly"]);
export type UpstreamScheduleMode = typeof UpstreamScheduleMode.Type;

const UpstreamScheduleHour = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 }));
const UpstreamScheduleWeekday = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }));

export const UpstreamSchedule = Schema.Struct({
  mode: UpstreamScheduleMode.pipe(Schema.withDecodingDefault(() => "off" as const)),
  hour: UpstreamScheduleHour.pipe(Schema.withDecodingDefault(() => 7)),
  /** 0 is Sunday; used only by the weekly mode. */
  weekday: UpstreamScheduleWeekday.pipe(Schema.withDecodingDefault(() => 1)),
});
export type UpstreamSchedule = typeof UpstreamSchedule.Type;

export const UpstreamReviewerSlot = Schema.Struct({
  provider: WorkflowModelSlot.fields.provider,
  model: WorkflowModelSlot.fields.model,
  modelOptions: WorkflowModelSlot.fields.modelOptions,
});
export type UpstreamReviewerSlot = typeof UpstreamReviewerSlot.Type;

export const UpstreamPortReviewSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  reviewerA: Schema.NullOr(UpstreamReviewerSlot).pipe(Schema.withDecodingDefault(() => null)),
  reviewerB: Schema.NullOr(UpstreamReviewerSlot).pipe(Schema.withDecodingDefault(() => null)),
  consolidation: Schema.NullOr(UpstreamReviewerSlot).pipe(Schema.withDecodingDefault(() => null)),
});
export type UpstreamPortReviewSettings = typeof UpstreamPortReviewSettings.Type;

/** How features in an area reach the user; unlisted areas are `fixes-only`. */
export const UpstreamAreaPolicy = Schema.Literals(["follow", "fixes-only", "ignore"]);
export type UpstreamAreaPolicy = typeof UpstreamAreaPolicy.Type;

export const UPSTREAM_SHORTLIST_SIZE_MIN = 5;
export const UPSTREAM_SHORTLIST_SIZE_MAX = 50;
export const UPSTREAM_EXPIRE_AFTER_DAYS_OPTIONS = [7, 14, 30] as const;
const UpstreamShortlistSize = Schema.Int.check(
  Schema.isBetween({ minimum: UPSTREAM_SHORTLIST_SIZE_MIN, maximum: UPSTREAM_SHORTLIST_SIZE_MAX }),
);
const UpstreamExpireAfterDays = Schema.NullOr(Schema.Literals(UPSTREAM_EXPIRE_AFTER_DAYS_OPTIONS));
const UpstreamKeepScore = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }));

export const UpstreamBudgetSettings = Schema.Struct({
  shortlistSize: UpstreamShortlistSize.pipe(Schema.withDecodingDefault(() => 15)),
  /** `null` turns automatic expiry off (the default: new automatic behavior ships off). */
  expireAfterDays: UpstreamExpireAfterDays.pipe(Schema.withDecodingDefault(() => null)),
  /** Topics scoring at least this get twice the expiry window. */
  keepScore: UpstreamKeepScore.pipe(Schema.withDecodingDefault(() => 70)),
});
export type UpstreamBudgetSettings = typeof UpstreamBudgetSettings.Type;

export const UpstreamAutoPortMode = Schema.Literals(["off", "security", "security-and-bugs"]);
export type UpstreamAutoPortMode = typeof UpstreamAutoPortMode.Type;
const UpstreamAutoPortDailyLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }));

export const UpstreamAutoPortSettings = Schema.Struct({
  mode: UpstreamAutoPortMode.pipe(Schema.withDecodingDefault(() => "off" as const)),
  dailyLimit: UpstreamAutoPortDailyLimit.pipe(Schema.withDecodingDefault(() => 5)),
});
export type UpstreamAutoPortSettings = typeof UpstreamAutoPortSettings.Type;

export const UpstreamPortsSettings = Schema.Struct({
  portConcurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })).pipe(
    Schema.withDecodingDefault(() => 5),
  ),
  autoRecordOutcomes: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  schedule: UpstreamSchedule.pipe(Schema.withDecodingDefault(() => ({}))),
  triageModelSelection: Schema.NullOr(ModelSelection).pipe(Schema.withDecodingDefault(() => null)),
  portModelSelection: Schema.NullOr(ModelSelection).pipe(Schema.withDecodingDefault(() => null)),
  portReview: UpstreamPortReviewSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  budget: UpstreamBudgetSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  areaPolicy: Schema.Record(Schema.String, UpstreamAreaPolicy).pipe(
    Schema.withDecodingDefault(() => ({})),
  ),
  autoPort: UpstreamAutoPortSettings.pipe(Schema.withDecodingDefault(() => ({}))),
});
export type UpstreamPortsSettings = typeof UpstreamPortsSettings.Type;

/**
 * A partial settings update with no decoding defaults: omitted fields keep
 * their current values, schedule fields merge, and a model selection given
 * (or null) replaces the current one.
 */
export const UpstreamPortsSettingsPatch = Schema.Struct({
  portConcurrency: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  ),
  autoRecordOutcomes: Schema.optionalKey(Schema.Boolean),
  schedule: Schema.optionalKey(
    Schema.Struct({
      mode: Schema.optionalKey(UpstreamScheduleMode),
      hour: Schema.optionalKey(UpstreamScheduleHour),
      weekday: Schema.optionalKey(UpstreamScheduleWeekday),
    }),
  ),
  triageModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  portModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  portReview: Schema.optionalKey(UpstreamPortReviewSettings),
  /** Fields merge like `schedule`. */
  budget: Schema.optionalKey(
    Schema.Struct({
      shortlistSize: Schema.optionalKey(UpstreamShortlistSize),
      expireAfterDays: Schema.optionalKey(UpstreamExpireAfterDays),
      keepScore: Schema.optionalKey(UpstreamKeepScore),
    }),
  ),
  /** Replaces the whole map. */
  areaPolicy: Schema.optionalKey(Schema.Record(Schema.String, UpstreamAreaPolicy)),
  /** Fields merge like `schedule`. */
  autoPort: Schema.optionalKey(
    Schema.Struct({
      mode: Schema.optionalKey(UpstreamAutoPortMode),
      dailyLimit: Schema.optionalKey(UpstreamAutoPortDailyLimit),
    }),
  ),
});
export type UpstreamPortsSettingsPatch = typeof UpstreamPortsSettingsPatch.Type;

// ── RPC names and push payload ──────────────────────────────────────────

export const UPSTREAM_PORTS_WS_METHODS = {
  listProjects: "upstreamPorts.listProjects",
  getOverview: "upstreamPorts.getOverview",
  listTopics: "upstreamPorts.listTopics",
  listTopicIds: "upstreamPorts.listTopicIds",
  getTopic: "upstreamPorts.getTopic",
  getTopicFiles: "upstreamPorts.getTopicFiles",
  decide: "upstreamPorts.decide",
  acceptSuggestions: "upstreamPorts.acceptSuggestions",
  undoDecisions: "upstreamPorts.undoDecisions",
  expireBacklog: "upstreamPorts.expireBacklog",
  run: "upstreamPorts.run",
  startPort: "upstreamPorts.startPort",
  previewPortGroups: "upstreamPorts.previewPortGroups",
  enqueuePort: "upstreamPorts.enqueuePort",
  getPortQueue: "upstreamPorts.getPortQueue",
  dequeuePort: "upstreamPorts.dequeuePort",
  controlPortQueue: "upstreamPorts.controlPortQueue",
  unlinkPort: "upstreamPorts.unlinkPort",
  retryPortReview: "upstreamPorts.retryPortReview",
  getPortPrompt: "upstreamPorts.getPortPrompt",
  resolvePublication: "upstreamPorts.resolvePublication",
  addRemote: "upstreamPorts.addRemote",
  takeOverWriter: "upstreamPorts.takeOverWriter",
} as const;

export const UPSTREAM_PORTS_WS_CHANNELS = {
  changed: "upstreamPorts.changed",
} as const;

export const UpstreamChangedReason = Schema.Literals([
  "run-started",
  "run-finished",
  "ledger-updated",
  "ports-updated",
  "queue-updated",
  "links-updated",
  "publication-updated",
  "feature-digest",
]);
export type UpstreamChangedReason = typeof UpstreamChangedReason.Type;

export const UpstreamPortsChanged = Schema.Struct({
  projectId: ProjectId,
  reason: UpstreamChangedReason,
  newInboxCount: Schema.optionalKey(NonNegativeInt),
  /** Set on `run-finished` when the run queued ports automatically. */
  autoQueuedCount: Schema.optionalKey(NonNegativeInt),
  /** Set on `feature-digest`: Inbox features created in the last seven days. */
  digest: Schema.optionalKey(Schema.Struct({ followed: NonNegativeInt, other: NonNegativeInt })),
});
export type UpstreamPortsChanged = typeof UpstreamPortsChanged.Type;
