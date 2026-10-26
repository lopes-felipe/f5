import { Schema } from "effect";
import { IsoDateTime, ProjectId, ThreadId, TurnId, TrimmedNonEmptyString } from "./baseSchemas";
import { ModelSelection, RuntimeMode } from "./orchestration";

export { ScheduledTaskId, ScheduledTaskRunId, ScheduledOrigin } from "./baseSchemas";
import { ScheduledTaskId, ScheduledTaskRunId } from "./baseSchemas";
export const ScheduledWorkspace = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("worktree"), baseBranch: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("projectRoot") }),
]);
export const ScheduledTaskConfiguration = Schema.Struct({
  name: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  workspace: ScheduledWorkspace,
  cron: TrimmedNonEmptyString,
  timezone: TrimmedNonEmptyString,
  scheduleSource: Schema.String,
  maxRuns: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  oneShotAt: Schema.NullOr(IsoDateTime),
  notify: Schema.Literals(["all", "failures_and_attention", "none"]),
  enabled: Schema.Boolean,
});
export type ScheduledTaskConfiguration = typeof ScheduledTaskConfiguration.Type;
export const ScheduleAuthority = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    clientId: Schema.String,
    grantGeneration: Schema.Int,
  }),
]);
export type ScheduleAuthority = typeof ScheduleAuthority.Type;
export const ScheduledTask = Schema.Struct({
  ...ScheduledTaskConfiguration.fields,
  id: ScheduledTaskId,
  projectId: ProjectId,
  version: Schema.Int,
  createdBy: Schema.Literals(["user", "agent"]),
  authority: ScheduleAuthority,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunAt: Schema.NullOr(IsoDateTime),
  runsConsumed: Schema.Int,
  disabledReason: Schema.optional(
    Schema.NullOr(
      Schema.Literals([
        "authority_revoked",
        "project_missing",
        "invalid_schedule",
        "invalid_state",
      ]),
    ),
  ),
});
export type ScheduledTask = typeof ScheduledTask.Type;
export const ScheduledRunStatus = Schema.Literals([
  "pending",
  "running",
  "needs_attention",
  "succeeded",
  "failed",
  "skipped",
]);
export const ScheduledRunReason = Schema.Literals([
  "overlap",
  "already_pending",
  "project_missing",
  "provider_unavailable",
  "provider_loading",
  "scheduler_disabled",
  "task_disabled",
  "task_deleted",
  "capacity",
  "usage_limit",
  "authority_revoked",
  "budget_exhausted",
  "delivery_unknown",
  "delivery_failed",
  "setup_failed",
  "thread_removed",
  "interrupted",
  "approval",
  "user_input",
  "manual_pause",
  "canceled",
  "recovery_pending",
  "disabled_interval",
]);
export type ScheduledRunReason = typeof ScheduledRunReason.Type;
export const ScheduledTaskRun = Schema.Struct({
  id: ScheduledTaskRunId,
  taskId: ScheduledTaskId,
  scheduledFor: IsoDateTime,
  trigger: Schema.Literals(["schedule", "catch_up", "manual"]),
  status: ScheduledRunStatus,
  reason: Schema.NullOr(ScheduledRunReason),
  threadId: Schema.NullOr(ThreadId),
  error: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  evaluatedThrough: Schema.NullOr(IsoDateTime),
  suppressedCount: Schema.Int,
  turnIds: Schema.optional(Schema.Array(TurnId)),
});
export type ScheduledTaskRun = typeof ScheduledTaskRun.Type;
export const SchedulePreviewInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  timezone: TrimmedNonEmptyString,
  schedule: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("cron"), cron: TrimmedNonEmptyString }),
    Schema.Struct({
      kind: Schema.Literal("preset"),
      preset: Schema.Literals(["hourly", "daily", "weekdays", "weekly"]),
    }),
    Schema.Struct({ kind: Schema.Literal("natural_language"), text: TrimmedNonEmptyString }),
  ]),
});
export type SchedulePreviewInput = typeof SchedulePreviewInput.Type;
export const SchedulePreview = Schema.Struct({
  cron: Schema.String,
  timezone: Schema.String,
  summary: Schema.String,
  nextFireTimes: Schema.Array(IsoDateTime),
  oneShotAt: Schema.NullOr(IsoDateTime),
});
export type SchedulePreview = typeof SchedulePreview.Type;
export const ScheduledTaskCreateInput = Schema.Struct({
  id: ScheduledTaskId,
  projectId: ProjectId,
  requestedAt: IsoDateTime,
  configuration: ScheduledTaskConfiguration,
});
export type ScheduledTaskCreateInput = typeof ScheduledTaskCreateInput.Type;
export const ScheduledTaskUpdateInput = Schema.Struct({
  id: ScheduledTaskId,
  expectedVersion: Schema.Int,
  configuration: ScheduledTaskConfiguration,
});
export type ScheduledTaskUpdateInput = typeof ScheduledTaskUpdateInput.Type;
export const ScheduledTaskVersionInput = Schema.Struct({
  id: ScheduledTaskId,
  expectedVersion: Schema.Int,
});
export const ScheduledTaskEnabledInput = Schema.Struct({
  ...ScheduledTaskVersionInput.fields,
  enabled: Schema.Boolean,
});
export const ScheduledTaskRunNowInput = Schema.Struct({
  taskId: ScheduledTaskId,
  runId: ScheduledTaskRunId,
  requestedAt: IsoDateTime,
});
export type ScheduledTaskRunNowInput = typeof ScheduledTaskRunNowInput.Type;
export const ScheduledTaskGetInput = Schema.Struct({ id: ScheduledTaskId });
export const ScheduledTaskListInput = Schema.Struct({ projectId: Schema.optional(ProjectId) });
export const ScheduledTaskRunsInput = Schema.Struct({
  taskId: ScheduledTaskId,
  runId: Schema.optional(ScheduledTaskRunId),
  before: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type ScheduledTaskRunsInput = typeof ScheduledTaskRunsInput.Type;
export const ScheduledTaskSaveResult = Schema.Struct({
  task: ScheduledTask,
  warnings: Schema.Array(Schema.String),
});
export const ScheduledTaskListResult = Schema.Struct({
  revision: Schema.Int,
  tasks: Schema.Array(
    Schema.Struct({
      task: ScheduledTask,
      latestRun: Schema.NullOr(ScheduledTaskRun),
      activeRun: Schema.NullOr(ScheduledTaskRun),
    }),
  ),
});
export const ScheduledTaskRunsResult = Schema.Struct({
  runs: Schema.Array(ScheduledTaskRun),
  nextCursor: Schema.NullOr(Schema.String),
});
export const ScheduledTasksChanged = Schema.Struct({
  revision: Schema.Int,
  taskIds: Schema.Array(ScheduledTaskId),
  runIds: Schema.Array(ScheduledTaskRunId),
});
export type ScheduledTasksChanged = typeof ScheduledTasksChanged.Type;
export const ScheduledResolveInput = Schema.Struct({
  runId: ScheduledTaskRunId,
  acknowledgeUnknownDelivery: Schema.Boolean,
});
export const ScheduledNotification = Schema.Struct({
  id: Schema.String,
  taskId: ScheduledTaskId,
  runId: ScheduledTaskRunId,
  threadId: Schema.NullOr(ThreadId),
  title: Schema.String,
  body: Schema.String,
});
export type ScheduledNotification = typeof ScheduledNotification.Type;
export const ScheduledClaimInput = Schema.Struct({ owner: TrimmedNonEmptyString });
export const ScheduledAckInput = Schema.Struct({
  owner: TrimmedNonEmptyString,
  ids: Schema.Array(Schema.String),
});
export const ScheduledNotificationBatch = Schema.Struct({
  notifications: Schema.Array(ScheduledNotification),
  leaseExpiresAt: IsoDateTime,
  retryAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export const SCHEDULED_TASK_WS_METHODS = {
  list: "scheduledTasks.list",
  get: "scheduledTasks.get",
  create: "scheduledTasks.create",
  update: "scheduledTasks.update",
  delete: "scheduledTasks.delete",
  setEnabled: "scheduledTasks.setEnabled",
  runNow: "scheduledTasks.runNow",
  listRuns: "scheduledTasks.listRuns",
  previewSchedule: "scheduledTasks.previewSchedule",
  resolveRun: "scheduledTasks.resolveRun",
  claimNotifications: "scheduledTasks.claimNotifications",
  acknowledgeNotifications: "scheduledTasks.acknowledgeNotifications",
} as const;
