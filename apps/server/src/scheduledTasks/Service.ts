import { scheduledRunLeafSubmissions, scheduledRunHasSettledLeaves } from "./submissions.ts";
import { makeShutdownSourceScope, registerShutdown } from "../shutdown.ts";
import { scheduledExecutionConfiguration } from "@t3tools/shared/scheduledTasks";
import { scheduleAuthorityCurrent } from "./authority.ts";
import { toTurnSubmissionError } from "../TurnSubmissionError.ts";
import { encodeScheduledRunCursor } from "./historyCursor.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { fenceScheduledRun } from "./cancellation.ts";
import { retryScheduledOperation } from "./worker.ts";
import { detectScheduledClockJump, scheduledDeadlineDelay } from "./timing.ts";
import { isScheduledRunEvent } from "./projector.ts";
import { scheduledUsageRetryAt } from "./usageGate.ts";
import {
  buildSlashComposerMenuItems,
  rewriteComposerRuntimeSkillInvocationForSend,
} from "@t3tools/shared/slashCommands";
import {
  CommandId,
  MessageId,
  ThreadId,
  ScheduledTaskId,
  ScheduledTaskRunId,
  type ScheduleAuthority,
  type ScheduledTask,
  type ScheduledTaskConfiguration,
  type ScheduledTaskRun,
  type ScheduledTaskCreateInput,
  type ScheduledTaskUpdateInput,
  type ScheduledTaskRunNowInput,
  type ScheduledTaskRunsInput,
  type SchedulePreviewInput,
  type ScheduledTasksChanged,
  type ScheduledNotification,
  isKnownProviderKind,
} from "@t3tools/contracts";
import {
  nextScheduleFires,
  previewCronSchedule,
  SCHEDULE_PRESETS,
  oneShotCron,
} from "@t3tools/shared/cronSchedule";
import { runtimeModeCapabilities } from "@t3tools/shared/runtimeMode";
import { Cause, Clock, Deferred, Duration, Effect, Semaphore, Stream } from "effect";
import type { AgentBridgeHostShape } from "../agentBridge/AgentBridgeHost.ts";
import { isProviderUsable } from "../agentBridge/threadTools.ts";
import type { ServerSettingsShape } from "../serverSettings.ts";
import { canonicalJsonHash } from "../canonicalJsonHash.ts";
import { buildNewThreadSubmission } from "../turnSubmission.ts";
import {
  type ScheduledTaskStoreShape,
  scheduleError,
  storageError,
  type StoredRun,
} from "./Store.ts";

export type ScheduleActor = ScheduleAuthority & {
  readonly visibleProjectIds?: ReadonlySet<string>;
};
export const userScheduleActor: ScheduleActor = { kind: "user" };
const MAX_REQUEST_AGE = 86_400_000;
const executionConfigurationHash = (value: ScheduledTaskConfiguration) =>
  canonicalJsonHash(scheduledExecutionConfiguration(value));
export const makeScheduledTaskService = (deps: {
  store: ScheduledTaskStoreShape;
  host: AgentBridgeHostShape;
  settings: ServerSettingsShape;
  publish: (change: ScheduledTasksChanged) => Effect.Effect<void>;
  usageAccounts?: Effect.Effect<ReadonlyArray<import("@t3tools/contracts").UsageAccount>>;
  wakeQueue?: (threadId: ThreadId) => Effect.Effect<void>;
  monotonic?: () => number;
  naturalLanguage?: (
    input: SchedulePreviewInput,
    now: Date,
  ) => Effect.Effect<
    ReturnType<typeof previewCronSchedule>,
    import("./Store.ts").ScheduledTaskError
  >;
}) =>
  Effect.gen(function* () {
    const { store, host, settings } = deps,
      { sql } = store;
    const mutex = yield* Semaphore.make(1);
    const scope = yield* Effect.scope;
    const sources = yield* makeShutdownSourceScope("scheduled-task-sources");
    let wake = yield* Deferred.make<void>();
    const signal = Effect.suspend(() => Deferred.succeed(wake, undefined)).pipe(Effect.asVoid);
    const now = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()));
    const publishMutex = yield* Semaphore.make(1);
    let publishedRevision = 0;
    const changed = (taskIds: ScheduledTaskId[] = [], runIds: ScheduledTaskRunId[] = []) =>
      publishMutex.withPermits(1)(
        Effect.gen(function* () {
          const revision = yield* store.readRevision;
          if (revision <= publishedRevision) return;
          yield* deps.publish({ revision, taskIds, runIds });
          publishedRevision = revision;
          yield* signal;
        }),
      );
    const validateAge = (requestedAt: string, at: string) =>
      Math.abs(Date.parse(at) - Date.parse(requestedAt)) > MAX_REQUEST_AGE
        ? Effect.fail(scheduleError("conflict", "Request expired. Retry with a new identifier."))
        : Effect.void;
    const visible = (actor: ScheduleActor, task: ScheduledTask) =>
      actor.kind === "user" || actor.visibleProjectIds?.has(task.projectId) === true;
    const requireTask = (id: string, actor: ScheduleActor) =>
      store
        .task(id)
        .pipe(
          Effect.flatMap((row) =>
            row && visible(actor, row.task)
              ? Effect.succeed(row.task)
              : Effect.fail(scheduleError("not_found", "Scheduled task not found.")),
          ),
        );
    const checkActor = (actor: ScheduleActor, task: ScheduledTask) =>
      Effect.gen(function* () {
        if (actor.kind === "user") return;
        if (
          !(yield* scheduleAuthorityCurrent(
            actor,
            task.projectId,
            yield* settings.getSettings,
            sql,
          ))
        )
          return yield* scheduleError("forbidden", "Scheduling permission is no longer valid.");
        if (task.runtimeMode !== "approval-required")
          return yield* scheduleError(
            "forbidden",
            "Agent Bridge can manage only supervised schedules.",
          );
        if (task.authority.kind === "user")
          return yield* scheduleError(
            "forbidden",
            "Only the user can mutate user-owned schedules.",
          );
        if (task.authority.clientId !== actor.clientId)
          return yield* scheduleError("forbidden", "This schedule belongs to another client.");
      });
    const validate = (configuration: ScheduledTaskConfiguration, at: string) =>
      Effect.try({
        try: () => {
          if (!configuration.name.trim() || !configuration.prompt.trim())
            throw new Error("Task name and prompt must not be empty.");
          if (configuration.prompt.length > 32768 || configuration.name.length > 200)
            throw new Error("Task name or prompt is too long.");
          if (/^\s*\/(?:model|plan|default)(?:\s|$)/i.test(configuration.prompt))
            throw new Error(
              "/model, /plan and /default change the interactive composer and cannot be scheduled.",
            );
          const preview = previewCronSchedule(
            configuration.cron,
            configuration.timezone,
            new Date(at),
          );
          if (!preview.nextFireTimes.length) throw new Error("This schedule has no future fires.");
          if (
            preview.oneShotAt &&
            (configuration.maxRuns !== 1 ||
              configuration.oneShotAt !== preview.oneShotAt ||
              oneShotCron(preview.oneShotAt, preview.timezone, new Date(at)) !== preview.cron)
          )
            throw new Error("One-shot schedules require their exact target and maxRuns: 1.");
          if (!preview.oneShotAt && configuration.oneShotAt !== null)
            throw new Error("Recurring schedules cannot have a one-shot target.");
          return {
            ...configuration,
            cron: preview.cron,
            timezone: preview.timezone,
            nextRunAt: configuration.enabled ? preview.nextFireTimes[0]! : null,
          };
        },
        catch: (error) =>
          scheduleError(
            "invalid_schedule",
            error instanceof Error ? error.message : "Invalid schedule.",
          ),
      });
    const validateExecution = (
      projectId: string,
      config: ScheduledTaskConfiguration,
      actor: ScheduleActor,
    ) =>
      Effect.gen(function* () {
        if (
          actor.kind === "agent" &&
          !(yield* scheduleAuthorityCurrent(actor, projectId, yield* settings.getSettings, sql))
        )
          return yield* scheduleError("forbidden", "An active scheduling grant is required.");
        const snapshot = yield* host.readSnapshot.pipe(
          Effect.mapError(() => scheduleError("not_found", "Workspace unavailable.")),
        );
        const project = snapshot.projects.find((p) => p.id === projectId && p.deletedAt === null);
        if (!project || (actor.kind === "agent" && !actor.visibleProjectIds?.has(project.id)))
          return yield* scheduleError("not_found", "Project not found.");
        const provider = (yield* host.listProviderInstances).find(
          (p) => p.instanceId === config.modelSelection.instanceId,
        );
        if (!provider || !isProviderUsable(provider))
          return yield* scheduleError("invalid_schedule", "Select an available provider.");
        if (
          !isKnownProviderKind(provider.driver) ||
          !runtimeModeCapabilities(provider.driver).has(config.runtimeMode)
        )
          return yield* scheduleError(
            "forbidden",
            "This provider does not support the selected runtime mode.",
          );
        if (actor.kind === "agent" && config.runtimeMode !== "approval-required")
          return yield* scheduleError(
            "forbidden",
            "Agent schedules require approval-required mode.",
          );
        if (
          provider.models.length &&
          !provider.models.some((m) => m.slug === config.modelSelection.model)
        )
          return yield* scheduleError("invalid_schedule", "The selected model is unavailable.");
        if (
          config.workspace.kind === "worktree" &&
          (yield* host.getProjectGitBranch(project.workspaceRoot)) === null
        )
          return yield* scheduleError(
            "invalid_schedule",
            "Non-Git projects require explicit project-root execution.",
          );
        const name = /^\s*\/([^\s/]+)(?:\s|$)/.exec(config.prompt)?.[1];
        const catalog = buildSlashComposerMenuItems({
          query: "",
          provider: isKnownProviderKind(provider.driver) ? provider.driver : undefined,
          projectSkills: project.skills,
          providerSkills: provider.skills,
          runtimeSlashCommands: provider.slashCommands?.map((c) => ({
            name: c.name,
            description: c.description ?? c.name,
          })),
        });
        return name && !catalog.some((c) => c.type === "skill" && c.name === name)
          ? [
              `Skill /${name} is not available for the selected provider. The task can still be saved.`,
            ]
          : [];
      });
    const previewSchedule = (input: SchedulePreviewInput) =>
      Effect.gen(function* () {
        const at = yield* now;
        if (input.schedule.kind === "natural_language")
          return deps.naturalLanguage
            ? yield* deps.naturalLanguage(input, new Date(at))
            : yield* scheduleError(
                "natural_language_unavailable",
                "Natural-language scheduling is unavailable. Use a preset or cron.",
              );
        const schedule = input.schedule;
        return yield* Effect.try({
          try: () =>
            previewCronSchedule(
              schedule.kind === "cron" ? schedule.cron : SCHEDULE_PRESETS[schedule.preset],
              input.timezone,
              new Date(at),
            ),
          catch: (e) => scheduleError("invalid_schedule", String(e)),
        });
      });
    const checkAgentCapacity = (actor: ScheduleActor, taskId: ScheduledTaskId) =>
      Effect.gen(function* () {
        if (actor.kind !== "agent") return;
        const owned = (yield* store.tasks()).filter(
          (t) =>
            t.id !== taskId &&
            t.enabled &&
            t.authority.kind === "agent" &&
            t.authority.clientId === actor.clientId,
        );
        const active = (yield* store.active).filter(
          (r) =>
            r.run.taskId !== taskId &&
            r.snapshot.authority.kind === "agent" &&
            r.snapshot.authority.clientId === actor.clientId,
        );
        if (new Set([...owned.map((t) => t.id), ...active.map((r) => r.run.taskId)]).size >= 20)
          return yield* scheduleError("forbidden", "This client already owns 20 active schedules.");
      });
    const create = (input: ScheduledTaskCreateInput, actor: ScheduleActor) =>
      Effect.gen(function* () {
        const at = yield* now;
        yield* validateAge(input.requestedAt, at);
        if (
          actor.kind === "agent" &&
          (!actor.visibleProjectIds?.has(input.projectId) ||
            !(yield* scheduleAuthorityCurrent(
              actor,
              input.projectId,
              yield* settings.getSettings,
              sql,
            )))
        )
          return yield* scheduleError("forbidden", "An active scheduling grant is required.");
        const hash = canonicalJsonHash({ input, actor });
        const prior = yield* store.task(input.id, true);
        if (prior) {
          if (prior.hash !== hash)
            return yield* scheduleError(
              "conflict",
              "Task identifier was reused with different content.",
            );
          return { task: prior.task, warnings: [] as string[] };
        }
        const config = yield* validate(input.configuration, at);
        const warnings = yield* validateExecution(input.projectId, config, actor);
        const task: ScheduledTask = {
          ...config,
          id: input.id,
          projectId: input.projectId,
          version: 1,
          createdBy: actor.kind,
          authority:
            actor.kind === "user"
              ? { kind: "user" }
              : { kind: "agent", clientId: actor.clientId, grantGeneration: actor.grantGeneration },
          createdAt: at,
          updatedAt: at,
          lastRunAt: null,
          runsConsumed: 0,
        };
        yield* store.transaction(
          Effect.gen(function* () {
            const existing = yield* store.task(input.id, true);
            if (existing) {
              if (existing.hash !== hash)
                return yield* scheduleError("conflict", "Task identifier conflict.");
              return;
            }
            if (task.enabled) yield* checkAgentCapacity(actor, task.id);
            yield* store.saveTask(task, hash, input.requestedAt);
            yield* store.revision;
          }),
        );
        yield* changed([task.id]);
        return { task, warnings };
      });
    const cancelUnstarted = (
      taskId: string,
      reason: "task_disabled" | "task_deleted",
      at: string,
    ) =>
      Effect.gen(function* () {
        for (const current of yield* store.active) {
          if (current.run.taskId !== taskId || current.turnId !== null) continue;
          const safe = yield* fenceScheduledRun(current.run.id, at).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          yield* store.transition(
            current.run.id,
            safe ? "skipped" : "needs_attention",
            safe ? reason : "delivery_unknown",
            at,
          );
        }
      });
    const revalidateAuthorities = Effect.gen(function* () {
      const config = yield* settings.getSettings;
      const at = yield* now;
      const invalidTasks = [] as ScheduledTask[];
      for (const task of yield* store.tasks())
        if (
          task.authority.kind === "agent" &&
          (task.enabled || task.disabledReason !== "authority_revoked") &&
          !(yield* scheduleAuthorityCurrent(task.authority, task.projectId, config, sql))
        )
          invalidTasks.push(task);
      for (const task of invalidTasks)
        yield* store.transaction(
          Effect.gen(function* () {
            const live = yield* store.task(task.id);
            if (
              !live ||
              live.task.version !== task.version ||
              (!live.task.enabled && live.task.disabledReason === "authority_revoked")
            )
              return;
            yield* store.saveTask({
              ...live.task,
              enabled: false,
              nextRunAt: null,
              disabledReason: "authority_revoked",
              updatedAt: at,
              version: live.task.version + 1,
            });
            yield* store.revision;
          }),
        );
      for (const run of yield* store.active)
        if (
          run.snapshot.authority.kind === "agent" &&
          !(yield* scheduleAuthorityCurrent(
            run.snapshot.authority,
            run.snapshot.projectId,
            config,
            sql,
          ))
        )
          yield* store.transaction(
            Effect.gen(function* () {
              const safe = yield* fenceScheduledRun(run.run.id, at).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
              );
              if (safe) yield* store.transition(run.run.id, "skipped", "authority_revoked", at);
              else if (!run.turnId)
                yield* store.transition(run.run.id, "needs_attention", "delivery_unknown", at);
            }),
          );
      if (invalidTasks.length) yield* changed(invalidTasks.map((task) => task.id));
    });
    const update = (input: ScheduledTaskUpdateInput, actor: ScheduleActor) =>
      Effect.gen(function* () {
        const at = yield* now;
        const previous = yield* requireTask(input.id, actor);
        yield* checkActor(actor, previous);
        if (!input.configuration.name.trim() || input.configuration.name.length > 200)
          return yield* scheduleError("invalid_schedule", "Task name is too long.");
        const executionChanged =
          executionConfigurationHash(previous) !== executionConfigurationHash(input.configuration);
        const adopting = executionChanged || (!previous.enabled && input.configuration.enabled);
        if (adopting && actor.kind === "agent" && previous.disabledReason === "authority_revoked")
          return yield* scheduleError(
            "forbidden",
            "The user must adopt or re-enable this revoked schedule.",
          );
        const config = adopting
          ? yield* validate(input.configuration, at)
          : { ...input.configuration, nextRunAt: previous.nextRunAt };
        const warnings = adopting
          ? yield* validateExecution(previous.projectId, config, actor)
          : [];
        const scheduleChanged =
          previous.cron !== config.cron ||
          previous.timezone !== config.timezone ||
          previous.oneShotAt !== config.oneShotAt;
        const task = yield* store.transaction(
          Effect.gen(function* () {
            const current = yield* requireTask(input.id, actor);
            if (current.version !== input.expectedVersion)
              return yield* scheduleError("conflict", "Task changed. Reload before saving.");
            const value: ScheduledTask = {
              ...current,
              ...config,
              runsConsumed: current.runsConsumed,
              lastRunAt: current.lastRunAt,
              ...(adopting ? { disabledReason: null } : {}),
              nextRunAt: !config.enabled
                ? null
                : scheduleChanged || !previous.enabled
                  ? config.nextRunAt
                  : current.nextRunAt,
              version: current.version + 1,
              updatedAt: at,
              authority: !adopting
                ? current.authority
                : actor.kind === "user"
                  ? { kind: "user" }
                  : {
                      kind: "agent",
                      clientId: actor.clientId,
                      grantGeneration: actor.grantGeneration,
                    },
            };
            if (
              adopting &&
              value.enabled &&
              value.maxRuns !== null &&
              value.runsConsumed >= value.maxRuns
            )
              return yield* scheduleError("conflict", "This task has exhausted its run budget.");
            if (adopting && value.enabled) yield* checkAgentCapacity(actor, value.id);
            yield* store.saveTask(value);
            if (!value.enabled) yield* cancelUnstarted(value.id, "task_disabled", at);
            yield* store.revision;
            return value;
          }),
        );
        yield* changed([task.id]);
        return { task, warnings };
      });
    const setEnabled = (
      input: { id: ScheduledTaskId; expectedVersion: number; enabled: boolean },
      actor: ScheduleActor,
    ) =>
      Effect.gen(function* () {
        if (input.enabled) {
          const task = yield* requireTask(input.id, actor);
          return (yield* update({ ...input, configuration: { ...task, enabled: true } }, actor))
            .task;
        }
        const at = yield* now;
        const task = yield* store.transaction(
          Effect.gen(function* () {
            const current = yield* requireTask(input.id, actor);
            yield* checkActor(actor, current);
            if (current.version !== input.expectedVersion)
              return yield* scheduleError("conflict", "Task changed. Reload before disabling.");
            const value: ScheduledTask = {
              ...current,
              enabled: false,
              nextRunAt: null,
              version: current.version + 1,
              updatedAt: at,
            };
            yield* store.saveTask(value);
            yield* cancelUnstarted(value.id, "task_disabled", at);
            yield* store.revision;
            return value;
          }),
        );
        yield* changed([task.id]);
        return task;
      });
    const remove = (
      input: { id: ScheduledTaskId; expectedVersion: number },
      actor: ScheduleActor,
    ) =>
      Effect.gen(function* () {
        const at = yield* now;
        yield* store.transaction(
          Effect.gen(function* () {
            const task = yield* requireTask(input.id, actor);
            yield* checkActor(actor, task);
            if (task.version !== input.expectedVersion)
              return yield* scheduleError("conflict", "Task changed. Reload before deleting.");
            yield* store.saveTask({
              ...task,
              enabled: false,
              nextRunAt: null,
              version: task.version + 1,
              updatedAt: at,
            });
            yield* sql`UPDATE scheduled_tasks SET deleted_at=${at} WHERE id=${task.id}`;
            yield* cancelUnstarted(task.id, "task_deleted", at);
            yield* store.revision;
          }),
        );
        yield* changed([input.id]);
      });
    const admit = (
      task: ScheduledTask,
      trigger: ScheduledTaskRun["trigger"],
      scheduledFor: string,
      at: string,
      id = ScheduledTaskRunId.makeUnsafe(crypto.randomUUID()),
      hash: string | null = null,
    ) =>
      store.transaction(
        Effect.gen(function* () {
          // Quarantined evidence may still own execution even when it cannot be decoded.
          const owner = (yield* sql<{
            submission_started: number;
            budget_consumed: number;
            created_at: string;
          }>`SELECT submission_started,budget_consumed,created_at FROM scheduled_task_runs WHERE task_id=${task.id} AND owns_execution=1 LIMIT 1`)[0];
          const reason = owner
            ? owner.submission_started || owner.budget_consumed
              ? "overlap"
              : "already_pending"
            : task.maxRuns !== null && task.runsConsumed >= task.maxRuns
              ? "budget_exhausted"
              : null;
          if (trigger !== "manual" && owner && reason) {
            const summaries = yield* sql<{
              id: string;
            }>`SELECT id FROM scheduled_task_runs WHERE task_id=${task.id} AND reason=${reason} AND created_at>=${owner.created_at} AND trigger!='manual' ORDER BY created_at DESC LIMIT 1`;
            if (summaries[0]) {
              yield* sql`UPDATE scheduled_task_runs SET state_json=json_set(state_json,'$.evaluatedThrough',${at},'$.suppressedCount',json_extract(state_json,'$.suppressedCount')+1) WHERE id=${summaries[0].id}`;
              yield* store.revision;
              return (yield* store.run(summaries[0].id))!.run;
            }
          }
          const run: ScheduledTaskRun = {
            id,
            taskId: task.id,
            trigger,
            scheduledFor,
            status: reason ? "skipped" : "pending",
            reason,
            threadId: null,
            error: null,
            createdAt: at,
            startedAt: null,
            finishedAt: reason ? at : null,
            evaluatedThrough: trigger === "catch_up" ? at : null,
            suppressedCount: reason ? 1 : 0,
          };
          const inserted = yield* store.insertRun(
            run,
            task,
            reason === null,
            hash,
            trigger === "manual" ? at : null,
          );
          if (inserted) {
            yield* store.revision;
            yield* Effect.logInfo("scheduledTasks.fire", {
              taskId: task.id,
              runId: run.id,
              trigger,
              scheduledFor,
              reason,
            });
          }
          return inserted ? run : ((yield* store.run(id))?.run ?? run);
        }),
      );
    const runNow = (input: ScheduledTaskRunNowInput, actor: ScheduleActor) =>
      Effect.gen(function* () {
        const at = yield* now;
        yield* validateAge(input.requestedAt, at);
        const task = yield* requireTask(input.taskId, actor);
        yield* checkActor(actor, task);
        if (actor.kind === "agent" && task.disabledReason === "authority_revoked")
          return yield* scheduleError(
            "forbidden",
            "The user must adopt this schedule before it can run again.",
          );
        if (!(yield* settings.getSettings).scheduledTasks.enabled)
          return yield* scheduleError("disabled", "The scheduler is disabled.");
        const hash = canonicalJsonHash({ input, actor });
        const run = yield* store.transaction(
          Effect.gen(function* () {
            const previous = yield* sql<{
              request_hash: string;
            }>`SELECT request_hash FROM scheduled_task_runs WHERE id=${input.runId}`;
            if (previous[0]) {
              if (previous[0].request_hash !== hash)
                return yield* scheduleError(
                  "conflict",
                  "Run identifier reused with different content.",
                );
              return (yield* store.run(input.runId))!.run;
            }
            return yield* admit(task, "manual", at, at, input.runId, hash);
          }),
        );
        yield* changed([task.id], [run.id]);
        return run;
      });
    const list = (input: { projectId?: string | undefined }, actor: ScheduleActor) =>
      Effect.gen(function* () {
        const tasks = (yield* store.tasks()).filter(
          (t) => visible(actor, t) && (!input.projectId || t.projectId === input.projectId),
        );
        const active = yield* store.active;
        return {
          revision: yield* store.readRevision,
          tasks: yield* Effect.forEach(tasks, (task) =>
            store.history(task.id, undefined, 1).pipe(
              Effect.map((rows) => ({
                task,
                latestRun: rows[0]?.run ?? null,
                activeRun: active.find((r) => r.run.taskId === task.id)?.run ?? null,
              })),
            ),
          ),
        };
      });
    const get = (input: { id: ScheduledTaskId }, actor: ScheduleActor) =>
      Effect.gen(function* () {
        yield* requireTask(input.id, actor);
        return (yield* list({}, actor)).tasks.find((t) => t.task.id === input.id)!;
      });
    const listRuns = (input: ScheduledTaskRunsInput, actor: ScheduleActor) =>
      Effect.gen(function* () {
        if (actor.kind === "user") {
          if (!(yield* store.task(input.taskId, true)))
            return yield* scheduleError("not_found", "Task not found.");
        } else yield* requireTask(input.taskId, actor);
        if (input.runId) {
          const run = yield* store.run(input.runId);
          return { runs: run?.run.taskId === input.taskId ? [run.run] : [], nextCursor: null };
        }
        const rows = yield* store.history(input.taskId, input.before, input.limit ?? 50);
        const last = rows.at(-1)?.run;
        return {
          runs: rows.map((r) => r.run),
          nextCursor:
            rows.length === (input.limit ?? 50) && last
              ? encodeScheduledRunCursor({ createdAt: last.createdAt, id: last.id })
              : null,
        };
      });
    const nextFires = (task: ScheduledTask, at: string) =>
      Effect.try({
        try: () => nextScheduleFires(task.cron, task.timezone, new Date(at), 1),
        catch: (error) => scheduleError("invalid_schedule", String(error)),
      });
    const invalidSchedule = (task: ScheduledTask, at: string, detail: string) =>
      store.transaction(
        Effect.gen(function* () {
          const live = yield* store.task(task.id);
          if (live?.task.version !== task.version) return;
          yield* store.saveTask({
            ...live.task,
            enabled: false,
            nextRunAt: null,
            disabledReason: "invalid_schedule",
            updatedAt: at,
            version: live.task.version + 1,
          });
          yield* store.revision;
          yield* Effect.logError("scheduledTasks.invalidSchedule", { taskId: task.id, detail });
        }),
      );
    const evaluate = (catchUp: boolean) =>
      Effect.gen(function* () {
        const at = yield* now,
          current = (yield* settings.getSettings).scheduledTasks;
        const control = (yield* sql<{
          enabled: number;
          epoch: number;
          cutover_at: string;
        }>`SELECT enabled,epoch,cutover_at FROM scheduled_control WHERE id=1`)[0]!;
        if (Boolean(control.enabled) !== current.enabled || control.epoch !== current.epoch) {
          const cutover =
            current.epoch !== control.epoch && current.cutoverAt ? current.cutoverAt : at;
          for (const task of yield* store.tasks()) {
            if (!task.enabled) continue;
            yield* Effect.gen(function* () {
              const next = (yield* nextFires(task, cutover))[0] ?? null;
              yield* store.transaction(
                Effect.gen(function* () {
                  const live = yield* store.task(task.id);
                  if (!live || live.task.version !== task.version) return;
                  yield* store.saveTask({
                    ...live.task,
                    nextRunAt: next,
                    enabled: next !== null,
                    updatedAt: at,
                  });
                  const summary: ScheduledTaskRun = {
                    id: ScheduledTaskRunId.makeUnsafe(
                      `interval:${task.id}:${current.epoch}:${cutover}`,
                    ),
                    taskId: task.id,
                    scheduledFor: cutover,
                    trigger: "schedule",
                    status: "skipped",
                    reason: "disabled_interval",
                    threadId: null,
                    error: null,
                    createdAt: at,
                    startedAt: null,
                    finishedAt: at,
                    evaluatedThrough: current.enabled ? cutover : null,
                    suppressedCount: 0,
                  };
                  const prior = yield* sql<{
                    id: string;
                  }>`SELECT id FROM scheduled_task_runs WHERE task_id=${task.id} AND reason='disabled_interval' AND json_extract(state_json,'$.evaluatedThrough') IS NULL ORDER BY created_at DESC LIMIT 1`;
                  if (current.enabled && prior[0])
                    yield* sql`UPDATE scheduled_task_runs SET state_json=json_set(state_json,'$.evaluatedThrough',${cutover}) WHERE id=${prior[0].id}`;
                  else yield* store.insertRun(summary, task, false);
                }),
              );
            }).pipe(
              Effect.catch((error) =>
                error.code === "invalid_schedule"
                  ? invalidSchedule(task, at, error.message)
                  : Effect.fail(error),
              ),
            );
          }
          yield* sql`UPDATE scheduled_control SET enabled=${current.enabled ? 1 : 0},epoch=${current.epoch},cutover_at=${cutover} WHERE id=1`;
          yield* store.revision;
        }
        if (!current.enabled) {
          yield* changed();
          return;
        }
        for (const task of yield* store.tasks()) {
          if (!task.enabled || !task.nextRunAt || task.nextRunAt > at) continue;
          yield* Effect.gen(function* () {
            const following = (yield* nextFires(task, task.nextRunAt!))[0] ?? null;
            const next = (yield* nextFires(task, at))[0] ?? null;
            yield* store.transaction(
              Effect.gen(function* () {
                const live = yield* store.task(task.id);
                if (
                  !live ||
                  !live.task.enabled ||
                  live.task.version !== task.version ||
                  live.task.nextRunAt !== task.nextRunAt
                )
                  return;
                yield* admit(
                  task,
                  catchUp || (following !== null && following <= at) ? "catch_up" : "schedule",
                  task.nextRunAt!,
                  at,
                );
                yield* store.saveTask({ ...live.task, nextRunAt: next, updatedAt: at });
              }),
            );
          }).pipe(
            Effect.catch((error) =>
              error.code === "invalid_schedule"
                ? invalidSchedule(task, at, error.message)
                : Effect.fail(error),
            ),
          );
        }
        yield* changed();
      });
    const claim = (candidate: StoredRun) =>
      Effect.gen(function* () {
        const config = (yield* settings.getSettings).scheduledTasks;
        if (!config.enabled) return null;
        const at = yield* now,
          current = yield* store.run(candidate.run.id);
        if (
          !current?.owner ||
          current.started ||
          current.canceled ||
          (current.retryAt !== null && current.retryAt > at)
        )
          return null;
        const task = (yield* store.task(current.run.taskId, true))!.task;
        if (
          !(yield* scheduleAuthorityCurrent(
            current.snapshot.authority,
            current.snapshot.projectId,
            yield* settings.getSettings,
            sql,
          ))
        ) {
          yield* revalidateAuthorities;
          return null;
        }
        const snapshot = yield* host.readSnapshot;
        const project = snapshot.projects.find(
          (p) => p.id === current.snapshot.projectId && p.deletedAt === null,
        );
        if (!project) {
          yield* store.transaction(
            Effect.gen(function* () {
              yield* store.transition(current.run.id, "skipped", "project_missing", at);
              const live = yield* store.task(task.id);
              if (live?.task.version !== task.version) return;
              yield* store.saveTask({
                ...live.task,
                enabled: false,
                nextRunAt: null,
                version: live.task.version + 1,
                updatedAt: at,
                disabledReason: "project_missing",
              });
              yield* store.revision;
            }),
          );
          yield* changed([task.id], [current.run.id]);
          return null;
        }
        const provider = (yield* host.listProviderInstances).find(
          (p) => p.instanceId === current.snapshot.modelSelection.instanceId,
        );
        if (
          provider &&
          (provider.probeOutcome === "loading" || provider.probeOutcome === "transient_failure") &&
          Date.parse(at) - Date.parse(provider.probeOutcomeStartedAt ?? current.run.createdAt) <
            600000
        ) {
          yield* store.transition(current.run.id, "pending", "provider_loading", at);
          yield* sql`UPDATE scheduled_task_runs SET retry_at=${new Date(Date.parse(at) + 30000).toISOString()} WHERE id=${current.run.id}`;
          return null;
        }
        if (!provider || !isProviderUsable(provider)) {
          yield* store.transition(current.run.id, "skipped", "provider_unavailable", at);
          return null;
        }
        const usageRetry = scheduledUsageRetryAt(
          yield* deps.usageAccounts ?? Effect.succeed([]),
          current.snapshot.modelSelection,
          Date.parse(at),
        );
        if (usageRetry) {
          yield* sql`UPDATE scheduled_task_runs SET retry_at=${usageRetry},reason='usage_limit',state_json=json_set(state_json,'$.reason','usage_limit') WHERE id=${current.run.id}`;
          return null;
        }

        return yield* store.transaction(
          Effect.gen(function* () {
            const live = yield* store.run(current.run.id);
            if (!live?.owner || live.started || live.canceled) return null;
            if (live.command && live.submissionId) {
              if (
                canonicalJsonHash(live.command) !==
                (yield* sql<{
                  command_hash: string;
                }>`SELECT command_hash FROM scheduled_task_runs WHERE id=${live.run.id}`)[0]
                  ?.command_hash
              )
                return yield* scheduleError("conflict", "Reserved command hash does not match.");
              return {
                run: live.run,
                command: live.command,
                submissionId: CommandId.makeUnsafe(live.submissionId),
              };
            }
            const liveTask = (yield* store.task(current.run.taskId, true))!.task;
            const counts = yield* sql<{
              n: number;
            }>`SELECT COUNT(*) AS n FROM scheduled_task_runs WHERE capacity=1`;
            if (counts[0]!.n >= config.maxConcurrentRuns) return null;
            if (liveTask.maxRuns !== null && liveTask.runsConsumed >= liveTask.maxRuns) {
              yield* store.transition(live.run.id, "skipped", "budget_exhausted", at);
              return null;
            }
            const threadId = ThreadId.makeUnsafe(crypto.randomUUID()),
              submissionId = CommandId.makeUnsafe(crypto.randomUUID());
            const rewritten = rewriteComposerRuntimeSkillInvocationForSend({
              text: current.snapshot.prompt,
              provider: isKnownProviderKind(provider.driver) ? provider.driver : undefined,
              projectSkills: project.skills,
              providerSkills: provider.skills,
              runtimeSlashCommands: provider.slashCommands?.map((c) => ({
                name: c.name,
                description: c.description ?? c.name,
              })),
            });
            const built = buildNewThreadSubmission({
              project,
              threadId,
              commandId: submissionId,
              messageId: MessageId.makeUnsafe(crypto.randomUUID()),
              prompt: rewritten.text,
              modelSelection: current.snapshot.modelSelection,
              runtimeMode: current.snapshot.runtimeMode,
              createdAt: at,
              title: current.snapshot.name,
              branch:
                current.snapshot.workspace.kind === "worktree"
                  ? current.snapshot.workspace.baseBranch
                  : null,
              useWorktree: current.snapshot.workspace.kind === "worktree",
              requireWorktree: true,
              scheduledOrigin: { taskId: task.id, runId: current.run.id },
              ...(isKnownProviderKind(provider.driver) ? { provider: provider.driver } : {}),
            });
            const command = {
              ...built,
              message: {
                ...built.message,
                ...(rewritten.skillCall ? { skillCall: rewritten.skillCall } : {}),
              },
            };
            const run = { ...current.run, threadId, startedAt: at };
            yield* sql`UPDATE scheduled_task_runs SET capacity=1,budget_consumed=1,submission_started=0,command_json=${JSON.stringify(command)},command_hash=${canonicalJsonHash(command)},thread_id=${threadId},submission_id=${submissionId},state_json=${JSON.stringify(run)} WHERE id=${run.id}`;
            yield* sql`INSERT INTO scheduled_run_submissions(submission_id,run_id,thread_id,message_id,kind) VALUES(${submissionId},${run.id},${threadId},${command.message.messageId},'initial')`;
            const consumed = liveTask.runsConsumed + 1,
              exhausted = liveTask.maxRuns !== null && consumed >= liveTask.maxRuns;
            yield* store.saveTask({
              ...liveTask,
              runsConsumed: consumed,
              lastRunAt: at,
              enabled: exhausted ? false : liveTask.enabled,
              nextRunAt: exhausted ? null : liveTask.nextRunAt,
              version: liveTask.version + (exhausted ? 1 : 0),
              updatedAt: at,
            });
            yield* store.revision;
            return { run, command, submissionId };
          }),
        );
      });
    const inFlight = new Set<string>();
    let dispatchesDone = yield* Deferred.make<void>();
    const drainDispatches = Effect.suspend(() =>
      inFlight.size ? Deferred.await(dispatchesDone) : Effect.void,
    );
    const dispatchCandidate = (candidate: StoredRun) =>
      Effect.gen(function* () {
        if (sources.stopped || inFlight.has(candidate.run.id)) return;
        if (
          candidate.started &&
          !candidate.capacity &&
          !candidate.canceled &&
          candidate.run.reason === "recovery_pending"
        ) {
          const config = (yield* settings.getSettings).scheduledTasks;
          const resumed = yield* store.transaction(
            Effect.gen(function* () {
              const at = yield* now;
              if (!config.enabled || (candidate.retryAt && candidate.retryAt > at)) return false;
              const counts = yield* sql<{
                n: number;
              }>`SELECT COUNT(*) AS n FROM scheduled_task_runs WHERE capacity=1`;
              if (counts[0]!.n >= config.maxConcurrentRuns) return false;
              yield* sql`UPDATE scheduled_task_runs SET capacity=1 WHERE id=${candidate.run.id} AND owns_execution=1 AND canceled=0`;
              return true;
            }),
          );
          if (resumed && candidate.run.threadId && deps.wakeQueue)
            yield* deps.wakeQueue(candidate.run.threadId);
          return;
        }
        const claimed = yield* claim(candidate);
        if (!claimed) return;
        yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            if (sources.stopped) return;
            if (inFlight.size === 0) dispatchesDone = yield* Deferred.make<void>();
            inFlight.add(claimed.run.id);
            yield* restore(
              Effect.gen(function* () {
                const at = yield* now;
                const config = (yield* settings.getSettings).scheduledTasks;
                if (!config.enabled) return;
                const frozen = (yield* store.run(claimed.run.id))!;
                if (
                  !(yield* scheduleAuthorityCurrent(
                    frozen.snapshot.authority,
                    frozen.snapshot.projectId,
                    yield* settings.getSettings,
                    sql,
                  ))
                ) {
                  yield* revalidateAuthorities;
                  return;
                }
                const marked =
                  yield* sql`UPDATE scheduled_task_runs SET submission_started=1,state_json=json_set(state_json,'$.startedAt',${at}) WHERE id=${claimed.run.id} AND submission_started=0 AND owns_execution=1 AND canceled=0 AND capacity=1 RETURNING id`;
                if (!marked.length) return;
                return yield* host.submitTurnSubmission(
                  { submissionId: claimed.submissionId, intent: "auto", command: claimed.command },
                  { submissionSource: "automation" },
                );
              }),
            ).pipe(
              Effect.flatMap((result) =>
                Effect.gen(function* () {
                  return yield* result &&
                  (result.disposition === "rejected" ||
                    result.disposition === "canceled" ||
                    result.disposition === "cleared")
                    ? store.transition(claimed.run.id, "failed", "delivery_failed", yield* now)
                    : Effect.void;
                }),
              ),
              Effect.catch((error) =>
                Effect.gen(function* () {
                  const at = yield* now;
                  // No provider handoff is possible before this durable marker.
                  const deferred = yield* sql`UPDATE scheduled_task_runs
                    SET retry_at=${new Date(Date.parse(at) + 30000).toISOString()}
                    WHERE id=${claimed.run.id} AND submission_started=0 AND owns_execution=1 AND canceled=0 RETURNING id`;
                  if (deferred.length) {
                    yield* signal;
                    yield* Effect.logWarning("scheduledTasks.dispatch.preflightRetry", {
                      runId: claimed.run.id,
                      error,
                    });
                    return;
                  }
                  const failure =
                    error._tag === "AgentBridgeHostError"
                      ? (error.submissionFailure ?? toTurnSubmissionError(error).kind)
                      : "delivery_unknown";
                  const definitive = !["delivery_unknown", "idempotency_conflict"].includes(
                    failure,
                  );
                  if (definitive) {
                    yield* store.transaction(
                      Effect.gen(function* () {
                        const safe = yield* fenceScheduledRun(claimed.run.id, at).pipe(
                          Effect.provideService(SqlClient.SqlClient, sql),
                        );
                        yield* store.transition(
                          claimed.run.id,
                          safe ? "failed" : "needs_attention",
                          safe
                            ? failure === "worktree_unavailable"
                              ? "setup_failed"
                              : "delivery_failed"
                            : "delivery_unknown",
                          at,
                          error.message,
                        );
                      }),
                    );
                  } else
                    yield* store.transition(
                      claimed.run.id,
                      "needs_attention",
                      "delivery_unknown",
                      at,
                      error.message,
                    );
                }),
              ),
              Effect.ensuring(
                Effect.sync(() => inFlight.delete(claimed.run.id)).pipe(
                  Effect.andThen(
                    Effect.suspend(() =>
                      inFlight.size === 0
                        ? Deferred.succeed(dispatchesDone, undefined)
                        : Effect.void,
                    ),
                  ),
                  Effect.andThen(
                    changed([claimed.run.taskId], [claimed.run.id]).pipe(Effect.ignore),
                  ),
                ),
              ),
              Effect.withSpan("scheduledTasks.dispatch", {
                attributes: { taskId: claimed.run.taskId, runId: claimed.run.id },
              }),
              Effect.forkIn(scope),
            );
          }),
        );
      });
    const dispatch = Effect.gen(function* () {
      for (const candidate of yield* store.active)
        yield* dispatchCandidate(candidate).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logError("scheduledTasks.dispatch.failed", {
                runId: candidate.run.id,
                cause,
              });
              const at = yield* Clock.currentTimeMillis;
              yield* sql`UPDATE scheduled_task_runs SET retry_at=${new Date(at + 30000).toISOString()} WHERE id=${candidate.run.id} AND submission_started=0 AND owns_execution=1`;
            }).pipe(Effect.ignore),
          ),
        );
    });
    const reconcileFor = (recovering = false, threadFilter?: string) =>
      Effect.gen(function* () {
        const at = yield* now;
        const snapshot = yield* host.readSnapshot;
        for (const current of yield* store.active) {
          if (
            inFlight.has(current.run.id) ||
            (threadFilter && current.run.threadId !== threadFilter)
          )
            continue;
          yield* Effect.gen(function* () {
            if (current.canceled) {
              yield* store.transaction(
                Effect.gen(function* () {
                  const safe = yield* fenceScheduledRun(current.run.id, at).pipe(
                    Effect.provideService(SqlClient.SqlClient, sql),
                  );
                  if (
                    safe &&
                    (current.run.reason !== "delivery_unknown" ||
                      !current.started ||
                      (yield* scheduledRunHasSettledLeaves(sql, current.run.id)))
                  )
                    yield* store.transition(
                      current.run.id,
                      current.run.reason === "thread_removed" ? "failed" : "skipped",
                      current.run.reason === "thread_removed" ? "thread_removed" : "canceled",
                      at,
                    );
                }),
              );
              return;
            }
            if (!current.started || !current.submissionId) return;
            const submission = (yield* scheduledRunLeafSubmissions(sql, current.run.id)).at(-1);
            const submissionId = submission?.submission_id ?? current.submissionId;
            const rejected = yield* sql<{
              state: string;
              error_detail: string | null;
            }>`SELECT d.state,d.error_detail FROM scheduled_run_submissions s JOIN provider_turn_deliveries d ON d.command_id=s.submission_id WHERE s.run_id=${current.run.id} AND s.submission_id=${submissionId} AND (d.state='abandoned' OR (d.state='rejected' AND d.certainty='not_sent' AND d.usage_limit_json IS NULL)) ORDER BY d.updated_at DESC LIMIT 1`;
            if (rejected.length) {
              yield* store.transaction(
                Effect.gen(function* () {
                  const safe = yield* fenceScheduledRun(current.run.id, at).pipe(
                    Effect.provideService(SqlClient.SqlClient, sql),
                  );
                  yield* store.transition(
                    current.run.id,
                    safe ? "failed" : "needs_attention",
                    safe ? "delivery_failed" : "delivery_unknown",
                    at,
                    rejected[0]!.error_detail,
                  );
                }),
              );
              return;
            }
            const receipt = yield* host.getSubmission(CommandId.makeUnsafe(submissionId));
            const thread = snapshot.threads.find((t) => t.id === current.run.threadId);
            if (
              !receipt &&
              !thread &&
              (recovering ||
                Date.parse(at) - Date.parse(current.run.startedAt ?? current.run.createdAt) >
                  600000)
            )
              yield* store.transition(
                current.run.id,
                "needs_attention",
                "delivery_unknown",
                at,
                "Execution was interrupted during submission. The original prompt will not be resent automatically.",
              );
            else if (
              !receipt &&
              thread &&
              !thread.latestTurn &&
              (recovering ||
                Date.parse(at) - Date.parse(current.run.startedAt ?? current.run.createdAt) >
                  600000)
            )
              yield* store.transition(
                current.run.id,
                "needs_attention",
                "setup_failed",
                at,
                "Submission was interrupted. Inspect the thread and worktree before resolving.",
              );
            if (current.run.threadId) {
              const queue = yield* host.getQueueSnapshot(current.run.threadId);
              const item = queue.items.find((i) => i.submissionId === submissionId);
              if (
                item &&
                (item.status === "failed" ||
                  queue.blockedKind === "error" ||
                  queue.blockedKind === "paused")
              )
                yield* store.transition(
                  current.run.id,
                  "needs_attention",
                  queue.reasonCode === "worktree_setup_failed" ? "setup_failed" : "manual_pause",
                  at,
                  queue.reasonDetail ?? item.lastErrorDetail,
                );
            }
            if (
              receipt &&
              (receipt.disposition === "canceled" ||
                receipt.disposition === "cleared" ||
                receipt.disposition === "rejected")
            ) {
              const safe = yield* store.transaction(
                fenceScheduledRun(current.run.id, at).pipe(
                  Effect.provideService(SqlClient.SqlClient, sql),
                ),
              );
              yield* store.transition(
                current.run.id,
                safe ? "failed" : "needs_attention",
                safe ? "delivery_failed" : "delivery_unknown",
                at,
              );
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                if (Cause.hasInterruptsOnly(cause)) return yield* Effect.interrupt;
                yield* Effect.logError("scheduledTasks.reconcile.runFailed", {
                  runId: current.run.id,
                  cause,
                });
                yield* store.transaction(
                  Effect.gen(function* () {
                    yield* fenceScheduledRun(current.run.id, at).pipe(
                      Effect.provideService(SqlClient.SqlClient, sql),
                    );
                    yield* store.transition(
                      current.run.id,
                      "needs_attention",
                      "delivery_unknown",
                      at,
                      "Recovery failed for this execution. Unsent work was fenced; inspect the conversation before retrying.",
                    );
                  }),
                );
              }),
            ),
          );
        }
      });
    const reconcile = reconcileFor();
    const resolveRun = (
      input: { runId: ScheduledTaskRunId; acknowledgeUnknownDelivery: boolean },
      actor: ScheduleActor,
    ) =>
      Effect.gen(function* () {
        if (actor.kind !== "user")
          return yield* scheduleError("forbidden", "Only the user can resolve runs.");
        const current = yield* store.run(input.runId);
        if (!current) return yield* scheduleError("not_found", "Run not found.");
        if (current.run.status !== "needs_attention")
          return yield* scheduleError("conflict", "Resolve the run only after it needs attention.");
        if (!input.acknowledgeUnknownDelivery)
          return yield* scheduleError(
            "conflict",
            "Explicitly acknowledge unknown delivery before abandoning it.",
          );
        const snapshot = yield* host.readSnapshot;
        const thread = snapshot.threads.find((t) => t.id === current.run.threadId);
        if (thread?.session?.activeTurnId || thread?.latestTurn?.state === "running")
          return yield* scheduleError(
            "conflict",
            "Stop the active turn in its thread before resolving this run.",
          );
        const sending =
          yield* sql`SELECT delivery_id FROM provider_turn_deliveries WHERE thread_id=${current.run.threadId} AND state='sending'`;
        if (sending.length)
          return yield* scheduleError(
            "conflict",
            "A provider handoff is still in flight. Recheck it in the thread before resolving.",
          );
        const at = yield* now;
        yield* store.transaction(
          Effect.gen(function* () {
            // Recheck under the write transaction before abandoning evidence. The
            // cancellation latch also fences bootstrap and every subsequent send.
            const handingOff = yield* sql`SELECT delivery_id FROM provider_turn_deliveries
              WHERE command_id IN(SELECT submission_id FROM scheduled_run_submissions WHERE run_id=${input.runId}) AND state='sending'`;
            if (handingOff.length)
              return yield* scheduleError("conflict", "A provider handoff is still in flight.");
            const active =
              yield* sql`SELECT t.turn_id FROM projection_turns t JOIN scheduled_run_submissions s ON s.thread_id=t.thread_id AND s.turn_id=t.turn_id WHERE s.run_id=${input.runId} AND t.state='running' AND t.processing_quiesced_at IS NULL`;
            if (active.length)
              return yield* scheduleError(
                "conflict",
                "Stop the associated turn before resolving this run.",
              );
            yield* fenceScheduledRun(input.runId, at);
            yield* sql`UPDATE provider_turn_deliveries SET state='abandoned',updated_at=${at},reservation_released_at=${at}
              WHERE command_id IN(SELECT submission_id FROM scheduled_run_submissions WHERE run_id=${input.runId})
              AND state IN('ambiguous','rejected','accepted')`;
            yield* store.transition(input.runId, "failed", "canceled", at);
          }),
        );
        yield* changed([current.run.taskId], [input.runId]);
        return (yield* store.run(input.runId))!.run;
      });
    const claimNotifications = (input: { owner: string }) =>
      store.transaction(
        Effect.gen(function* () {
          const at = yield* now,
            leaseExpiresAt = new Date(Date.parse(at) + 60000).toISOString();
          const rows = yield* sql<{
            payload_json: string;
          }>`UPDATE scheduled_notifications SET owner=${input.owner},lease_until=${leaseExpiresAt} WHERE id IN(SELECT id FROM scheduled_notifications WHERE acknowledged_at IS NULL AND (lease_until IS NULL OR lease_until <= ${at}) ORDER BY created_at LIMIT 20) RETURNING payload_json`;
          const leases = yield* sql<{
            deadline: string | null;
          }>`SELECT MIN(lease_until) AS deadline FROM scheduled_notifications WHERE acknowledged_at IS NULL AND lease_until IS NOT NULL`;
          return {
            retryAt: leases[0]?.deadline ?? null,
            notifications: rows.map((row) => JSON.parse(row.payload_json) as ScheduledNotification),
            leaseExpiresAt,
          };
        }),
      );
    const acknowledgeNotifications = (input: { owner: string; ids: ReadonlyArray<string> }) =>
      Effect.gen(function* () {
        const at = yield* now;
        for (const id of input.ids)
          yield* sql`UPDATE scheduled_notifications SET acknowledged_at=${at} WHERE id=${id} AND owner=${input.owner}`;
      });
    yield* registerShutdown("scheduled-task-work", "drain", () => drainDispatches);
    const start = Effect.gen(function* () {
      if (sources.stopped) return;
      yield* retryScheduledOperation(
        revalidateAuthorities
          .pipe(Effect.andThen(reconcileFor(true)))
          .pipe(
            Effect.andThen(evaluate(true)),
            Effect.andThen(sql`UPDATE scheduled_control SET ready=1 WHERE id=1`),
          ),
        "scheduledTasks.start",
      );
      yield* retryScheduledOperation(
        host.domainEvents.pipe(
          Stream.filter((e) => e.aggregateKind === "thread" && isScheduledRunEvent(e)),
          // The projector commits the revision first. Terminal transitions release
          // ownership, so publishing must use the revision rather than an owner lookup.
          Stream.runForEach(() => changed()),
        ),
        "scheduledTasks.domainEvents",
      ).pipe(Effect.forkIn(sources.scope));
      yield* retryScheduledOperation(
        host.queueChanges.pipe(
          Stream.runForEach((threadId) =>
            reconcileFor(false, threadId).pipe(Effect.andThen(changed())),
          ),
        ),
        "scheduledTasks.queueChanges",
      ).pipe(Effect.forkIn(sources.scope));
      yield* retryScheduledOperation(
        settings.streamChanges.pipe(
          Stream.runForEach(() => revalidateAuthorities.pipe(Effect.andThen(signal))),
        ),
        "scheduledTasks.settingsChanges",
      ).pipe(Effect.forkIn(sources.scope));
      const monotonic = deps.monotonic ?? (() => performance.now());
      let lastWall = yield* Clock.currentTimeMillis,
        lastMono = monotonic();
      const watchdogIteration = Effect.gen(function* () {
        yield* Effect.sleep(Duration.seconds(60));
        const wall = yield* Clock.currentTimeMillis,
          mono = monotonic();
        const drift = detectScheduledClockJump(
          { wall: lastWall, monotonic: lastMono },
          { wall, monotonic: mono },
        );
        lastWall = wall;
        lastMono = mono;
        yield* mutex.withPermits(1)(
          evaluate(drift).pipe(Effect.andThen(revalidateAuthorities), Effect.andThen(reconcile)),
        );
        yield* store.prune(new Date(wall).toISOString());
        yield* signal;
      });
      yield* Effect.gen(function* () {
        for (;;)
          yield* retryScheduledOperation(watchdogIteration, "scheduledTasks.watchdog.iteration");
      }).pipe(Effect.forkIn(sources.scope));
      const engineIteration = Effect.gen(function* () {
        wake = yield* Deferred.make<void>();
        yield* mutex.withPermits(1)(evaluate(false).pipe(Effect.andThen(dispatch)));
        const at = yield* Clock.currentTimeMillis,
          config = (yield* settings.getSettings).scheduledTasks;
        const deadlines = config.enabled
          ? (yield* store.tasks())
              .filter((t) => t.enabled && t.nextRunAt)
              .map((t) => Date.parse(t.nextRunAt!))
          : [];
        for (const r of yield* store.active)
          if ((!r.started || !r.capacity) && r.retryAt && Date.parse(r.retryAt) > at)
            deadlines.push(Date.parse(r.retryAt));
        yield* Deferred.await(wake).pipe(
          Effect.timeoutOption(Duration.millis(scheduledDeadlineDelay(deadlines, at))),
        );
      });
      yield* Effect.gen(function* () {
        for (;;) yield* retryScheduledOperation(engineIteration, "scheduledTasks.engine.iteration");
      }).pipe(Effect.forkIn(sources.scope));
    });
    return {
      create,
      update,
      delete: remove,
      setEnabled,
      runNow,
      list,
      get,
      listRuns,
      previewSchedule,
      resolveRun,
      claimNotifications,
      acknowledgeNotifications,
      start,
      evaluate,
      reserve: claim,
      drainDispatches,
      dispatch,
      reconcile,
      revalidateAuthorities,
      signal,
    };
  });
export type ScheduledTaskServiceShape = Effect.Success<ReturnType<typeof makeScheduledTaskService>>;
