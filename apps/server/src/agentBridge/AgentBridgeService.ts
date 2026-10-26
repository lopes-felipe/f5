import { makeScheduleTools } from "./scheduleTools.ts";
import type { ScheduledTaskServiceShape } from "../scheduledTasks/Service.ts";
/**
 * Owns the Agent Bridge lifecycle: starts and stops the local listener as
 * settings change, answers `agentBridge.getState`, and publishes coalesced
 * `agentBridge.stateChanged` invalidations.
 *
 * @module agentBridge/AgentBridgeService
 */
import {
  AGENT_BRIDGE_ACTIVATION_VERSION,
  AGENT_BRIDGE_LOCAL_CLIENT_ID,
  AgentBridgeSettings as AgentBridgeSettingsSchema,
  ProjectId,
  type AgentBridgeClient,
  type AgentBridgeListenerState,
  type AgentBridgeSettings,
  type AgentBridgeState,
  type AgentBridgeStateChanged,
  type AgentBridgeStdioSetup,
  type OrchestrationEvent,
  type ServerSettings,
} from "@t3tools/contracts";
import { Clock, Duration, Effect, Schedule, Schema, Scope, Semaphore, Stream } from "effect";

import type { AgentBridgeHostShape } from "./AgentBridgeHost.ts";
import { startLocalListener, type LocalListener } from "./AgentBridgeListeners.ts";
import type { AgentBridgeClientRecord, AgentBridgeStore } from "./AgentBridgeStore.ts";
import type { BotTaskStore } from "./BotTaskStore.ts";
import { agentBridgeLocalCredentialsPath } from "./localCredentials.ts";
import { makeAgentBridgeLimiters } from "./rateLimits.ts";
import {
  makeTaskOperator,
  progressRetentionBoundary,
  type TaskOperatorShape,
} from "./taskOperator.ts";
import { makeTaskTools } from "./taskTools.ts";
import { makeThreadTools, type AgentBridgeCaller } from "./threadTools.ts";

export const AGENT_BRIDGE_STATE_COALESCE_MS = 400;
const TOUCH_INTERVAL_MS = 60_000;
const PRUNE_INTERVAL = Duration.hours(6);
// Local connections require a fresh authenticated activation; remote listeners remain disabled.
export const AGENT_BRIDGE_LISTENER_AVAILABLE = true;

/**
 * Deletes task progress and completed retry receipts past the 30-day
 * retention. The cutoff comes from the clock on every run.
 */
export const pruneAgentBridgeHistory = (input: {
  readonly tasks: BotTaskStore;
  readonly store: AgentBridgeStore;
}) =>
  Effect.gen(function* () {
    const before = progressRetentionBoundary(new Date(yield* Clock.currentTimeMillis));
    const progress = yield* input.tasks.pruneProgress(before);
    const receipts = yield* input.store.pruneCompletedRequests(before);
    return { progress, receipts };
  });

export interface AgentBridgeServiceShape {
  readonly getState: Effect.Effect<AgentBridgeState>;
  readonly setSchedulingGrant: (
    input: import("@t3tools/contracts").AgentBridgeSchedulingGrantInput,
  ) => Effect.Effect<void, { readonly message: string }>;
  readonly tasks: TaskOperatorShape;
}

export interface AgentBridgeStdioSetups {
  readonly desktop: AgentBridgeStdioSetup | null;
  readonly cli: AgentBridgeStdioSetup;
}

/**
 * The values a user pastes into an MCP client's STDIO form. Inside the desktop
 * app the backend runs as `ELECTRON_RUN_AS_NODE=1 <F5 executable> <entry>`.
 */
export function agentBridgeStdioSetups(input: {
  readonly profileId: string | undefined;
  readonly isDefaultProfile: boolean;
  readonly defaultStateDir: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly entry?: string | undefined;
}): AgentBridgeStdioSetups {
  const env = input.env ?? process.env;
  const execPath = input.execPath ?? process.execPath;
  const entry = input.entry ?? process.argv[1];
  const profileArgs =
    input.profileId !== undefined && !input.isDefaultProfile ? ["--profile", input.profileId] : [];
  const desktop =
    env.ELECTRON_RUN_AS_NODE === "1" && entry
      ? {
          command: execPath,
          args: [
            entry,
            "agent-bridge-stdio",
            ...(input.defaultStateDir ? ["--state-dir", input.defaultStateDir] : []),
            ...(input.profileId !== undefined ? ["--profile", input.profileId] : []),
          ],
          env: { ELECTRON_RUN_AS_NODE: "1" },
        }
      : null;
  return {
    desktop,
    cli: { command: "t3", args: ["agent-bridge-stdio", ...profileArgs], env: {} },
  };
}

/** Projects a client may see: the exposed projects, narrowed by its allowlist. */
export function visibleProjectIdsFor(
  client: AgentBridgeClientRecord,
  settings: AgentBridgeSettings,
): ReadonlySet<string> {
  const exposed = new Set<string>(settings.exposedProjectIds);
  if (client.id === AGENT_BRIDGE_LOCAL_CLIENT_ID) return exposed;
  return new Set(client.projectIds.filter((id) => exposed.has(id)));
}

export const makeAgentBridgeService = (input: {
  readonly host: AgentBridgeHostShape;
  readonly schedules?: ScheduledTaskServiceShape;
  readonly store: AgentBridgeStore;
  readonly tasks: BotTaskStore;
  readonly settingsChanges: Stream.Stream<ServerSettings>;
  readonly stateDir: string;
  readonly serverVersion: string;
  readonly stdio: AgentBridgeStdioSetups;
  readonly publish: (payload: AgentBridgeStateChanged) => Effect.Effect<void>;
}): Effect.Effect<AgentBridgeServiceShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { host, store } = input;
    const credentialsPath = agentBridgeLocalCredentialsPath(input.stateDir);
    yield* store.ensureLocalClient.pipe(
      Effect.catch((error) =>
        Effect.logWarning("agentBridge.store.init.failed", { detail: error.message }),
      ),
    );

    let settings: AgentBridgeSettings =
      (yield* host.getSettings.pipe(
        Effect.map((value) => value.agentBridge),
        Effect.orElseSucceed(() => null),
      )) ?? Schema.decodeSync(AgentBridgeSettingsSchema)({});
    let listener: LocalListener | null = null;
    let localState: AgentBridgeListenerState = { status: "stopped", port: null, detail: null };
    const lifecycle = yield* Semaphore.make(1);

    // ── coalesced invalidations ──
    const pendingIds = new Set<string>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      const affectedIds = [...pendingIds];
      pendingIds.clear();
      void Effect.runPromise(
        store.getRevision.pipe(
          Effect.orElseSucceed(() => 0),
          Effect.flatMap((revision) => input.publish({ revision, affectedIds })),
        ),
      );
    };
    const invalidate = (affectedIds: ReadonlyArray<string>) => {
      for (const id of affectedIds) pendingIds.add(id);
      flushTimer ??= setTimeout(flush, AGENT_BRIDGE_STATE_COALESCE_MS);
    };
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (flushTimer) clearTimeout(flushTimer);
      }),
    );

    // ── callers ──
    const lastTouch = new Map<string, number>();
    const touch = (clientId: string) => {
      const at = Date.now();
      if ((lastTouch.get(clientId) ?? 0) > at - TOUCH_INTERVAL_MS) return;
      lastTouch.set(clientId, at);
      void Effect.runPromise(
        store.touchClient(clientId, new Date(at).toISOString()).pipe(
          Effect.tap(() => Effect.sync(() => invalidate([clientId]))),
          Effect.ignore,
        ),
      );
    };
    const resolveLocalCaller = async (): Promise<AgentBridgeCaller | null> => {
      if (!settings.enabled || settings.activationVersion !== AGENT_BRIDGE_ACTIVATION_VERSION)
        return null;
      const client = await Effect.runPromise(
        store.getClient(AGENT_BRIDGE_LOCAL_CLIENT_ID).pipe(Effect.orElseSucceed(() => null)),
      );
      if (!client || client.revokedAt !== null) return null;
      touch(client.id);
      return { client, visibleProjectIds: visibleProjectIdsFor(client, settings) };
    };

    const limiters = makeAgentBridgeLimiters();
    const onWorkspaceChanged = (_revision: number, affectedIds: ReadonlyArray<string>) =>
      invalidate(affectedIds);
    const tools = [
      ...makeThreadTools({ host, store, limiters, onWorkspaceChanged }),
      ...(input.schedules
        ? makeScheduleTools({ host, store, limiters, service: input.schedules })
        : []),
      ...makeTaskTools({ host, tasks: input.tasks, limiters, onWorkspaceChanged }),
    ];
    const taskOperator = makeTaskOperator({
      host,
      store,
      tasks: input.tasks,
      settings: () => settings,
      visibleProjectIds: (client) => visibleProjectIdsFor(client, settings),
      onWorkspaceChanged,
    });

    // ── task fencing and retention ──
    const onDomainEvent = (event: OrchestrationEvent) => {
      const changed = (ids: ReadonlyArray<string>) =>
        Effect.sync(() => {
          if (ids.length > 0) invalidate(ids);
        });
      if (event.type === "project.deleted")
        return input.tasks
          .fenceTasks({
            projectId: event.payload.projectId,
            reason: "The project was deleted.",
            at: new Date().toISOString(),
          })
          .pipe(Effect.flatMap(changed));
      if (event.type === "thread.deleted")
        return input.tasks.clearSourceThread(event.payload.threadId).pipe(Effect.flatMap(changed));
      return Effect.void;
    };
    yield* host.domainEvents.pipe(
      Stream.runForEach((event) =>
        onDomainEvent(event).pipe(
          Effect.catch((error) =>
            Effect.logWarning("agentBridge.tasks.fence.failed", { detail: error.message }),
          ),
        ),
      ),
      Effect.forkScoped,
    );
    yield* pruneAgentBridgeHistory({ tasks: input.tasks, store }).pipe(
      Effect.tap(({ progress, receipts }) =>
        progress > 0 || receipts > 0
          ? Effect.logInfo("agentBridge.pruned", { progress, receipts })
          : Effect.void,
      ),
      Effect.catch((error) =>
        Effect.logWarning("agentBridge.prune.failed", { detail: error.message }),
      ),
      Effect.repeat(Schedule.spaced(PRUNE_INTERVAL)),
      Effect.forkScoped,
    );

    // ── local listener lifecycle ──
    const stopLocal = Effect.promise(async () => {
      const current = listener;
      listener = null;
      if (current) await current.close();
      localState = { status: "stopped", port: null, detail: null };
    });
    const startLocal = Effect.promise(async () => {
      if (listener) return;
      try {
        listener = await startLocalListener({
          credentialsPath,
          resolveLocalCaller,
          tools: () => tools,
          serverVersion: input.serverVersion,
        });
        localState = { status: "running", port: listener.port, detail: null };
      } catch (cause) {
        localState = {
          status: "failed",
          port: null,
          detail: cause instanceof Error ? cause.message : String(cause),
        };
      }
    });
    const apply = (next: AgentBridgeSettings) =>
      lifecycle.withPermits(1)(
        Effect.gen(function* () {
          const previous = settings;
          settings = next;
          const shouldRun =
            AGENT_BRIDGE_LISTENER_AVAILABLE &&
            next.enabled &&
            next.activationVersion === AGENT_BRIDGE_ACTIVATION_VERSION;
          if (input.schedules)
            yield* input.schedules.revalidateAuthorities.pipe(
              Effect.catchCause((cause) => Effect.logError("agentBridge.schedules.fence", cause)),
            );
          if (shouldRun && !listener) yield* startLocal;
          if (!shouldRun && listener) yield* stopLocal;
          if (localState.status === "failed")
            yield* Effect.logWarning("agentBridge.local.start.failed", {
              detail: localState.detail,
            });
          if (
            previous.enabled !== next.enabled ||
            JSON.stringify(previous.exposedProjectIds) !== JSON.stringify(next.exposedProjectIds) ||
            JSON.stringify(previous.remote) !== JSON.stringify(next.remote)
          )
            invalidate(["settings"]);
        }),
      );

    yield* Effect.addFinalizer(() => stopLocal);
    yield* apply(settings);
    yield* input.settingsChanges.pipe(
      Stream.runForEach((next) => apply(next.agentBridge)),
      Effect.forkScoped,
    );

    const toClient = (record: AgentBridgeClientRecord): AgentBridgeClient => ({
      id: record.id,
      kind: record.kind,
      name: record.name,
      label: record.label,
      scopes: [...record.scopes],
      projectIds: [...visibleProjectIdsFor(record, settings)].map((id) => ProjectId.makeUnsafe(id)),
      grantGeneration: record.grantGeneration,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
      revokedAt: record.revokedAt,
    });

    return {
      getState: Effect.gen(function* () {
        const [revision, clients] = yield* Effect.all([
          store.getRevision.pipe(Effect.orElseSucceed(() => 0)),
          store.listClients.pipe(Effect.orElseSucceed(() => [])),
        ]);
        return {
          revision,
          enabled:
            settings.enabled && settings.activationVersion === AGENT_BRIDGE_ACTIVATION_VERSION,
          local: localState,
          stdio: input.stdio,
          clients: clients.map(toClient),
        } satisfies AgentBridgeState;
      }),
      setSchedulingGrant: (grant) =>
        store.setSchedulingGrant(grant).pipe(
          Effect.andThen(input.schedules?.revalidateAuthorities ?? Effect.void),
          Effect.tap(() => Effect.sync(() => invalidate([grant.clientId]))),
        ),
      tasks: taskOperator,
    };
  });
