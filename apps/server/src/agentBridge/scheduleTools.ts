import { Clock, Effect, Schema, Semaphore } from "effect";
import {
  AGENT_BRIDGE_ACTIVATION_VERSION,
  TrimmedNonEmptyString,
  ScheduledTaskId,
  ScheduledTaskRunId,
  ProjectId,
  ProviderInstanceId,
  ScheduledWorkspace,
  RuntimeMode,
  ProviderOptionSelection,
  type ScheduledTask,
  type ScheduledTaskConfiguration,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { previewCronSchedule } from "@t3tools/shared/cronSchedule";
import { scheduledExecutionConfiguration } from "@t3tools/shared/scheduledTasks";
import { canonicalJsonHash } from "../canonicalJsonHash.ts";
import type { ScheduledTaskServiceShape, ScheduleActor } from "../scheduledTasks/Service.ts";
import type { AgentBridgeStore } from "./AgentBridgeStore.ts";
import type { AgentBridgeHostShape } from "./AgentBridgeHost.ts";
import type { AgentBridgeLimiters } from "./rateLimits.ts";
import {
  AgentBridgeToolError,
  decodeAgentBridgeArgs,
  resolveBridgeProvider,
  type AgentBridgeCaller,
  type AgentBridgeToolDefinition,
} from "./threadTools.ts";
import { toJsonSchemaObject } from "../git/Utils.ts";

const RequestId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const Configuration = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(32768)),
  cron: Schema.String,
  timezone: Schema.String,
  providerInstanceId: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  modelOptions: Schema.optional(Schema.Array(ProviderOptionSelection)),
  runtimeMode: Schema.optional(RuntimeMode),
  workspace: Schema.optional(ScheduledWorkspace),
  notify: Schema.optional(Schema.Literals(["all", "failures_and_attention", "none"])),
  enabled: Schema.optional(Schema.Boolean),
  maxRuns: Schema.optional(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))),
});
const Create = Schema.Struct({
  clientRequestId: RequestId,
  projectId: ProjectId,
  ...Configuration.fields,
});
const Update = Schema.Struct({
  clientRequestId: RequestId,
  taskId: ScheduledTaskId,
  expectedVersion: Schema.Int,
  configuration: Configuration,
});
const Delete = Schema.Struct({
  clientRequestId: RequestId,
  taskId: ScheduledTaskId,
  expectedVersion: Schema.Int,
});
const Run = Schema.Struct({ clientRequestId: RequestId, taskId: ScheduledTaskId });
const List = Schema.Struct({ projectId: Schema.optional(ProjectId) });
const History = Schema.Struct({
  taskId: ScheduledTaskId,
  before: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
const fail = (message: string) => new AgentBridgeToolError({ message });
const actorFor = (caller: AgentBridgeCaller): ScheduleActor => ({
  kind: "agent",
  clientId: caller.client.id,
  grantGeneration: caller.client.grantGeneration,
  visibleProjectIds: caller.visibleProjectIds,
});
interface Reservation {
  taskId: string;
  projectId: string;
  requestedAt: string;
  runId: string;
  configuration?: ScheduledTaskConfiguration;
}
export const makeScheduleTools = (deps: {
  service: ScheduledTaskServiceShape;
  store: AgentBridgeStore;
  host: AgentBridgeHostShape;
  limiters: AgentBridgeLimiters;
}): ReadonlyArray<AgentBridgeToolDefinition> => {
  const publicRun = (run: import("@t3tools/contracts").ScheduledTaskRun | null) =>
    run
      ? { ...run, error: run.error ? "Open the conversation in F5 for failure details." : null }
      : null;
  const echo = (task: ScheduledTask, now: string) => {
    const { authority: _authority, ...publicTask } = task;
    return {
      task: publicTask,
      schedule: previewCronSchedule(task.cron, task.timezone, new Date(now)),
    };
  };
  const configure = (
    input: typeof Configuration.Type,
    projectId: ProjectId,
    requestedAt: string,
    previous?: ScheduledTaskConfiguration,
  ) =>
    Effect.gen(function* () {
      if (input.runtimeMode !== undefined && input.runtimeMode !== "approval-required")
        return yield* fail("Agent schedules require approval-required mode.");
      if (previous) {
        const kept =
          !input.providerInstanceId ||
          input.providerInstanceId === previous.modelSelection.instanceId;
        const candidate: ScheduledTaskConfiguration = {
          scheduleSource: previous.scheduleSource,
          oneShotAt: previous.oneShotAt,
          name: input.name,
          prompt: input.prompt,
          cron: input.cron,
          timezone: input.timezone,
          runtimeMode: input.runtimeMode ?? previous.runtimeMode,
          workspace: input.workspace ?? previous.workspace,
          modelSelection: createModelSelection(
            ProviderInstanceId.makeUnsafe(
              input.providerInstanceId ?? previous.modelSelection.instanceId,
            ),
            input.model ?? previous.modelSelection.model,
            input.modelOptions ?? (kept ? previous.modelSelection.options : undefined),
          ),
          maxRuns: input.maxRuns === undefined ? previous.maxRuns : input.maxRuns,
          enabled: input.enabled ?? previous.enabled,
          notify: input.notify ?? previous.notify,
        };
        if (
          !(candidate.enabled && !previous.enabled) &&
          canonicalJsonHash(scheduledExecutionConfiguration(candidate)) ===
            canonicalJsonHash(scheduledExecutionConfiguration(previous))
        )
          return candidate;
      }
      const instanceId = input.providerInstanceId ?? previous?.modelSelection.instanceId;
      const keptInstance =
        !input.providerInstanceId ||
        input.providerInstanceId === previous?.modelSelection.instanceId;
      const requestedModel =
        input.model ?? (keptInstance ? previous?.modelSelection.model : undefined);
      const { provider, model } = yield* resolveBridgeProvider(
        yield* deps.host.listProviderInstances,
        yield* deps.host.getSettings,
        {
          ...(instanceId ? { instanceId } : {}),
          ...(requestedModel ? { model: requestedModel } : {}),
        },
      );
      const project = (yield* deps.host.readSnapshot).projects.find(
        (p) => p.id === projectId && p.deletedAt === null,
      );
      if (!project) return yield* fail("Project not found.");
      const selectedWorkspace = input.workspace ?? previous?.workspace;
      const branch = selectedWorkspace
        ? null
        : yield* deps.host.getProjectGitBranch(project.workspaceRoot);
      if (!selectedWorkspace && !branch)
        return yield* fail(
          "Select an explicit worktree base branch or explicitly choose projectRoot for this project.",
        );
      const preview = yield* Effect.try({
        try: () => previewCronSchedule(input.cron, input.timezone, new Date(requestedAt)),
        catch: () => fail("Invalid cron expression or timezone."),
      });
      if (!preview.nextFireTimes.length) return yield* fail("This schedule has no future fires.");
      return {
        name: input.name,
        prompt: input.prompt,
        modelSelection: createModelSelection(
          provider.instanceId,
          model,
          input.modelOptions ??
            (keptInstance && (!input.model || input.model === previous?.modelSelection.model)
              ? previous?.modelSelection.options
              : undefined),
        ),
        runtimeMode: "approval-required" as const,
        workspace: selectedWorkspace ?? { kind: "worktree" as const, baseBranch: branch! },
        cron: preview.cron,
        timezone: preview.timezone,
        scheduleSource: "Agent Bridge cron",
        oneShotAt: preview.oneShotAt,
        maxRuns: preview.oneShotAt
          ? 1
          : input.maxRuns === undefined
            ? (previous?.maxRuns ?? null)
            : input.maxRuns,
        notify: input.notify ?? previous?.notify ?? "all",
        enabled: input.enabled ?? previous?.enabled ?? true,
      } satisfies ScheduledTaskConfiguration;
    });
  const mutation = (
    name: string,
    args: { clientRequestId: string },
    caller: AgentBridgeCaller,
    reserve: (at: string) => Effect.Effect<Reservation, { readonly message: string }>,
    execute: (r: Reservation, at: string) => Effect.Effect<unknown, { readonly message: string }>,
  ) =>
    Effect.gen(function* () {
      if (!caller.client.scopes.includes("f5.schedules"))
        return yield* new AgentBridgeToolError({
          message: "Scheduling permission has not been granted.",
          requiredScope: "f5.schedules",
        });
      const namespace = `schedules:${caller.client.id}`;
      const hash = canonicalJsonHash(args);
      const at = new Date(yield* Clock.currentTimeMillis).toISOString();
      let existing = yield* deps.store.getRequest(namespace, args.clientRequestId);
      if (existing && (existing.tool !== name || existing.argsHash !== hash))
        return yield* fail("This request identifier was already used for different arguments.");
      if (existing && Date.parse(at) - Date.parse(existing.createdAt) > 86400000)
        return yield* fail("This scheduling request expired. Use a new identifier.");
      if (!existing) {
        const limit = deps.limiters.schedulingWrites.take(caller.client.id);
        if (limit) return yield* new AgentBridgeToolError(limit);
        if (name === "run_scheduled_task") {
          const createLimit = deps.limiters.createThread.check(caller.client.id);
          if (createLimit) return yield* new AgentBridgeToolError(createLimit);
        }
        const reservation = yield* reserve(at);
        const receipt = yield* deps.store.insertPendingRequest({
          namespace,
          requestId: args.clientRequestId,
          tool: name,
          argsHash: hash,
          command: reservation,
          relatedIds: {
            taskId: reservation.taskId,
            runId: reservation.runId,
            projectId: reservation.projectId,
          },
          at,
        });
        if (receipt.inserted && name === "run_scheduled_task")
          deps.limiters.createThread.consume(caller.client.id);
        existing = yield* deps.store.getRequest(namespace, args.clientRequestId);
        if (!existing) return yield* fail("Scheduling receipt could not be read.");
        if (existing.tool !== name || existing.argsHash !== hash)
          return yield* fail("Scheduling request conflict.");
      }
      const reservation = existing.command as Reservation;
      if (!caller.visibleProjectIds.has(reservation.projectId))
        return yield* fail("Project not found.");
      if (existing.status === "completed") {
        const prior = existing.result as { scheduleToolFailure?: string } | null;
        if (prior?.scheduleToolFailure) return yield* fail(prior.scheduleToolFailure);
        return existing.result;
      }
      const result = yield* execute(reservation, at).pipe(
        Effect.catch((error) =>
          deps.store
            .completeRequest({
              namespace,
              requestId: args.clientRequestId,
              result: { scheduleToolFailure: error.message },
              at,
            })
            .pipe(Effect.andThen(Effect.fail(error))),
        ),
      );
      yield* deps.store.completeRequest({ namespace, requestId: args.clientRequestId, result, at });
      return result;
    }).pipe(Effect.mapError((e) => (e instanceof AgentBridgeToolError ? e : fail(e.message))));
  // Domain operations serialize in SQL; this lock also avoids duplicate wrapper side effects/limiter consumption.
  const lock = Semaphore.makeUnsafe(1);
  const serialized = <A, E>(op: Effect.Effect<A, E>) => lock.withPermits(1)(op);
  const authorize = (caller: AgentBridgeCaller, read: boolean) =>
    Effect.gen(function* () {
      const client = yield* deps.store.getClient(caller.client.id);
      const settings = (yield* deps.host.getSettings).agentBridge;
      const scope = read ? "f5.read" : "f5.schedules";
      if (!client || client.revokedAt || !client.scopes.includes(scope))
        return yield* new AgentBridgeToolError({
          message: "This connection has no current scheduling permission.",
          requiredScope: scope,
        });
      if (!settings.enabled || settings.activationVersion !== AGENT_BRIDGE_ACTIVATION_VERSION)
        return yield* fail("The local Agent Bridge must be activated by the user.");
      const visibleProjectIds = new Set<string>(
        settings.exposedProjectIds.filter(
          (id) => client.id === "local" || client.projectIds.includes(id),
        ),
      );
      return { client, visibleProjectIds } satisfies AgentBridgeCaller;
    });
  const definition = <S extends Schema.Top & { readonly DecodingServices: never }>(
    name: string,
    title: string,
    schema: S,
    read: boolean,
    run: (
      input: S["Type"],
      caller: AgentBridgeCaller,
    ) => Effect.Effect<unknown, { readonly message: string }>,
  ): AgentBridgeToolDefinition => ({
    name,
    title,
    description: `${title} in F5. Schedules run only while the local server runs. Cron and IANA timezone are required; automatic work is supervised. Mutations require an explicit f5.schedules grant.`,
    scope: read ? "f5.read" : "f5.schedules",
    inputSchema: toJsonSchemaObject(schema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: read,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: (args, caller) =>
      decodeAgentBridgeArgs(schema)(args).pipe(
        Effect.flatMap((input) =>
          authorize(caller, read).pipe(
            Effect.flatMap((fresh) => (read ? run(input, fresh) : serialized(run(input, fresh)))),
          ),
        ),
        Effect.mapError((e) => (e instanceof AgentBridgeToolError ? e : fail(e.message))),
      ),
  });
  return [
    definition("list_scheduled_tasks", "List scheduled tasks", List, true, (input, caller) =>
      Effect.gen(function* () {
        const list = yield* deps.service.list(input, actorFor(caller));
        const at = new Date(yield* Clock.currentTimeMillis).toISOString();
        return {
          revision: list.revision,
          tasks: list.tasks.map((row) => ({
            ...echo(row.task, at),
            latestRun: publicRun(row.latestRun),
            activeRun: publicRun(row.activeRun),
          })),
        };
      }),
    ),
    definition("create_scheduled_task", "Create scheduled task", Create, false, (input, caller) =>
      mutation(
        "create_scheduled_task",
        input,
        caller,
        (at) =>
          Effect.gen(function* () {
            if (!caller.visibleProjectIds.has(input.projectId))
              return yield* fail("Project not found.");
            return {
              taskId: crypto.randomUUID(),
              runId: crypto.randomUUID(),
              projectId: input.projectId,
              requestedAt: at,
              configuration: yield* configure(input, input.projectId, at),
            };
          }),
        (r, at) =>
          deps.service
            .create(
              {
                id: ScheduledTaskId.makeUnsafe(r.taskId),
                projectId: ProjectId.makeUnsafe(r.projectId),
                requestedAt: r.requestedAt,
                configuration: r.configuration!,
              },
              actorFor(caller),
            )
            .pipe(
              Effect.map((result) => ({ ...echo(result.task, at), warnings: result.warnings })),
            ),
      ),
    ),
    definition("update_scheduled_task", "Update scheduled task", Update, false, (input, caller) =>
      mutation(
        "update_scheduled_task",
        input,
        caller,
        (at) =>
          Effect.gen(function* () {
            const current = yield* deps.service.get({ id: input.taskId }, actorFor(caller));
            return {
              taskId: input.taskId,
              runId: "",
              projectId: current.task.projectId,
              requestedAt: at,
              configuration: yield* configure(
                input.configuration,
                current.task.projectId,
                at,
                current.task,
              ),
            };
          }),
        (r, at) =>
          Effect.gen(function* () {
            const current = yield* deps.service.get({ id: input.taskId }, actorFor(caller));
            const config = r.configuration!;
            const keys = Object.keys(config) as Array<keyof ScheduledTaskConfiguration>;
            const replay =
              current.task.version === input.expectedVersion + 1 &&
              current.task.authority.kind === "agent" &&
              current.task.authority.clientId === caller.client.id &&
              current.task.authority.grantGeneration === caller.client.grantGeneration &&
              keys.every(
                (key) => canonicalJsonHash(current.task[key]) === canonicalJsonHash(config[key]),
              );
            const result = replay
              ? { task: current.task, warnings: [] }
              : yield* deps.service.update(
                  {
                    id: input.taskId,
                    expectedVersion: input.expectedVersion,
                    configuration: config,
                  },
                  actorFor(caller),
                );
            return { ...echo(result.task, at), warnings: result.warnings };
          }),
      ),
    ),
    definition("delete_scheduled_task", "Delete scheduled task", Delete, false, (input, caller) =>
      mutation(
        "delete_scheduled_task",
        input,
        caller,
        (at) =>
          deps.service.get({ id: input.taskId }, actorFor(caller)).pipe(
            Effect.map((r) => ({
              taskId: input.taskId,
              runId: "",
              projectId: r.task.projectId,
              requestedAt: at,
            })),
          ),
        () =>
          deps.service
            .delete({ id: input.taskId, expectedVersion: input.expectedVersion }, actorFor(caller))
            .pipe(
              Effect.catchTag("ScheduledTaskError", (e) =>
                e.code === "not_found" ? Effect.void : Effect.fail(e),
              ),
              Effect.as({ deleted: input.taskId }),
            ),
      ),
    ),
    definition("run_scheduled_task", "Run scheduled task now", Run, false, (input, caller) =>
      mutation(
        "run_scheduled_task",
        input,
        caller,
        (at) =>
          deps.service.get({ id: input.taskId }, actorFor(caller)).pipe(
            Effect.map((r) => ({
              taskId: input.taskId,
              runId: crypto.randomUUID(),
              projectId: r.task.projectId,
              requestedAt: at,
            })),
          ),
        (r, at) =>
          Effect.gen(function* () {
            const run = yield* deps.service.runNow(
              {
                taskId: input.taskId,
                runId: ScheduledTaskRunId.makeUnsafe(r.runId),
                requestedAt: r.requestedAt,
              },
              actorFor(caller),
            );
            const current = yield* deps.service.get({ id: input.taskId }, actorFor(caller));
            return { run: publicRun(run), ...echo(current.task, at) };
          }),
      ),
    ),
    definition(
      "list_scheduled_task_runs",
      "List scheduled task runs",
      History,
      true,
      (input, caller) =>
        deps.service
          .listRuns(input, actorFor(caller))
          .pipe(Effect.map((page) => ({ ...page, runs: page.runs.map((run) => publicRun(run)) }))),
    ),
  ];
};
