/**
 * Owns the Agent Bridge lifecycle: starts and stops the local and remote
 * listeners as settings change, runs the remote OAuth server and pairing,
 * manages client grants, answers `agentBridge.getState`, and publishes
 * coalesced `agentBridge.stateChanged` invalidations.
 *
 * @module agentBridge/AgentBridgeService
 */
import {
  AGENT_BRIDGE_LOCAL_CLIENT_ID,
  AGENT_BRIDGE_REMOTE_MIN_PORT,
  AgentBridgeSettings as AgentBridgeSettingsSchema,
  canonicalizeAgentBridgePublicBaseUrl,
  ProjectId,
  type AgentBridgeClient,
  type AgentBridgeDecideAuthorizationInput,
  type AgentBridgeListenerState,
  type AgentBridgeSettings,
  type AgentBridgeState,
  type AgentBridgeStateChanged,
  type AgentBridgeStdioSetup,
  type AgentBridgeUpdateClientGrantInput,
  type OrchestrationEvent,
  type ServerSettings,
} from "@t3tools/contracts";
import { Clock, Data, Duration, Effect, Schedule, Schema, Scope, Semaphore, Stream } from "effect";

import type { AgentBridgeHostShape } from "./AgentBridgeHost.ts";
import {
  startLocalListener,
  startMcpListener,
  type LocalListener,
  type McpListener,
} from "./AgentBridgeListeners.ts";
import type { AgentBridgeClientRecord, AgentBridgeStore } from "./AgentBridgeStore.ts";
import type { BotTaskStore } from "./BotTaskStore.ts";
import { makeAgentBridgeEvents, type SecretVault } from "./events/AgentBridgeEvents.ts";
import type { EventStore } from "./events/EventStore.ts";
import { agentBridgeLocalCredentialsPath } from "./localCredentials.ts";
import {
  makeOAuthServer,
  OAuthDecisionError,
  protectedResourceMetadataUrl,
} from "./oauthServer.ts";
import type { OAuthStore } from "./OAuthStore.ts";
import { makeOutboundHttps, type OutboundHttps } from "./outboundHttps.ts";
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
const SWEEP_INTERVAL = Duration.hours(1);

export class AgentBridgeServiceError extends Data.TaggedError("AgentBridgeServiceError")<{
  readonly message: string;
}> {}

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
  readonly tasks: TaskOperatorShape;
  readonly openPairingWindow: Effect.Effect<AgentBridgeState, AgentBridgeServiceError>;
  readonly decideAuthorization: (
    input: AgentBridgeDecideAuthorizationInput,
  ) => Effect.Effect<AgentBridgeState, AgentBridgeServiceError>;
  readonly updateClientGrant: (
    input: AgentBridgeUpdateClientGrantInput,
  ) => Effect.Effect<AgentBridgeState, AgentBridgeServiceError>;
  readonly revokeClient: (
    clientId: string,
  ) => Effect.Effect<AgentBridgeState, AgentBridgeServiceError>;
  readonly retryNotification: (
    clientId: string,
  ) => Effect.Effect<AgentBridgeState, AgentBridgeServiceError>;
}

/** The remote listener's target: null when off, or why it cannot start. */
export function desiredRemoteListener(
  settings: AgentBridgeSettings,
): { readonly port: number; readonly issuer: string } | { readonly error: string } | null {
  if (!settings.enabled || !settings.remote.enabled) return null;
  const issuer = canonicalizeAgentBridgePublicBaseUrl(settings.remote.publicBaseUrl);
  if (!issuer) return { error: "Set the public https URL of your tunnel." };
  if (settings.remote.port < AGENT_BRIDGE_REMOTE_MIN_PORT)
    return { error: `Choose a port from ${AGENT_BRIDGE_REMOTE_MIN_PORT} to 65535.` };
  return { port: settings.remote.port, issuer };
}

const hostOf = (value: string) => {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
};

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
  readonly store: AgentBridgeStore;
  readonly tasks: BotTaskStore;
  readonly oauth: OAuthStore;
  readonly events: EventStore;
  /** Holds webhook secrets; rows keep only references. */
  readonly secrets: SecretVault;
  readonly outbound?: OutboundHttps;
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
    // Workspace changes also wake the event delivery worker (set once it exists).
    let wakeEvents = () => {};
    const invalidate = (affectedIds: ReadonlyArray<string>) => {
      wakeEvents();
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
      if (!settings.enabled) return null;
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

    // ── remote OAuth ──
    let remoteListener: McpListener | null = null;
    let remoteKey: string | null = null;
    let remoteIssuer: string | null = null;
    let remoteState: AgentBridgeListenerState = { status: "stopped", port: null, detail: null };
    const fenceGrant = (clientId: string) =>
      input.tasks.advanceEpochs(clientId).pipe(
        Effect.tap((ids) => Effect.sync(() => invalidate([clientId, ...ids]))),
        Effect.catch((error) =>
          Effect.logWarning("agentBridge.tasks.fence.failed", { detail: error.message }),
        ),
      );
    const outbound = input.outbound ?? makeOutboundHttps();
    const events = makeAgentBridgeEvents({
      store: input.events,
      clients: store,
      host,
      secrets: input.secrets,
      outbound,
      visibleProjectIds: (client) => visibleProjectIdsFor(client, settings),
      onChanged: invalidate,
    });
    wakeEvents = events.wake;
    yield* events.run.pipe(Effect.forkScoped);
    const oauthServer = makeOAuthServer({
      store: input.oauth,
      clients: store,
      outbound,
      config: () =>
        remoteIssuer === null
          ? null
          : {
              issuer: remoteIssuer,
              allowedRedirectUris: settings.remote.allowedRedirectUris,
              trustedClientMetadataHosts: settings.remote.trustedClientMetadataHosts,
            },
      onChanged: invalidate,
      onGrantChanged: (clientId, reason) =>
        Effect.runPromise(
          Effect.gen(function* () {
            if (reason === "reused")
              yield* Effect.logWarning("agentBridge.oauth.refresh.reused", { clientId });
            yield* fenceGrant(clientId);
          }),
        ),
    });
    const resolveRemoteCaller = async (token: string): Promise<AgentBridgeCaller | null> => {
      if (!settings.enabled) return null;
      const authenticated = await oauthServer.authenticate(token).catch(() => null);
      if (!authenticated) return null;
      const { client, familyId } = authenticated;
      touch(client.id);
      return {
        client,
        visibleProjectIds: visibleProjectIdsFor(client, settings),
        tokenFamilyId: familyId,
      };
    };
    const stopRemote = Effect.promise(async () => {
      const current = remoteListener;
      remoteListener = null;
      remoteKey = null;
      remoteIssuer = null;
      oauthServer.reset();
      if (current) await current.close();
      remoteState = { status: "stopped", port: null, detail: null };
    });
    const startRemote = (target: { readonly port: number; readonly issuer: string }) =>
      Effect.promise(async () => {
        try {
          remoteListener = await startMcpListener({
            port: target.port,
            authenticate: resolveRemoteCaller,
            tools: () => tools,
            serverVersion: input.serverVersion,
            unauthorizedHeaders: {
              "www-authenticate": `Bearer resource_metadata="${protectedResourceMetadataUrl(target.issuer)}"`,
            },
            allowedHosts: () => [new URL(target.issuer).host],
            routes: oauthServer.handleRoute,
            eventsCapability: events.capability,
            events: events.handleMethod,
          });
          remoteKey = `${target.port} ${target.issuer}`;
          remoteIssuer = target.issuer;
          remoteState = { status: "running", port: remoteListener.port, detail: null };
        } catch (cause) {
          remoteState = {
            status: "failed",
            port: null,
            detail: cause instanceof Error ? cause.message : String(cause),
          };
        }
      });
    const applyRemote = (previous: AgentBridgeSettings, next: AgentBridgeSettings) =>
      Effect.gen(function* () {
        const previousIssuer = canonicalizeAgentBridgePublicBaseUrl(previous.remote.publicBaseUrl);
        const nextIssuer = canonicalizeAgentBridgePublicBaseUrl(next.remote.publicBaseUrl);
        if (previousIssuer !== null && previousIssuer !== nextIssuer) {
          // Tokens are bound to the issuer: a new public URL requires reauthorization.
          yield* input.oauth.revokeAllTokens.pipe(
            Effect.catch((error) =>
              Effect.logWarning("agentBridge.oauth.revoke.failed", { detail: error.message }),
            ),
          );
          yield* events.removeAll;
          yield* Effect.logInfo("agentBridge.oauth.issuer.changed");
        }
        const target = desiredRemoteListener(next);
        const key = target && "port" in target ? `${target.port} ${target.issuer}` : null;
        if (remoteListener && remoteKey !== key) yield* stopRemote;
        if (target === null) {
          remoteState = { status: "stopped", port: null, detail: null };
          return;
        }
        if ("error" in target) {
          remoteState = { status: "failed", port: null, detail: target.error };
          return;
        }
        if (!remoteListener) yield* startRemote(target);
        if (remoteState.status === "failed")
          yield* Effect.logWarning("agentBridge.remote.start.failed", {
            detail: remoteState.detail,
          });
      });
    yield* Effect.suspend(() => input.oauth.sweepExpired(Date.now())).pipe(
      Effect.catch((error) =>
        Effect.logWarning("agentBridge.oauth.sweep.failed", { detail: error.message }),
      ),
      Effect.andThen(events.sweep),
      Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
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
          if (next.enabled && !listener) yield* startLocal;
          if (!next.enabled && listener) yield* stopLocal;
          yield* applyRemote(previous, next);
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

    yield* Effect.addFinalizer(() => Effect.andThen(stopLocal, stopRemote));
    // The first application has no previous issuer to compare against.
    yield* apply(settings);
    yield* input.settingsChanges.pipe(
      Stream.runForEach((next) => apply(next.agentBridge)),
      Effect.forkScoped,
    );

    const toClient = (record: AgentBridgeClientRecord): Omit<AgentBridgeClient, "readiness"> => ({
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
      clientIdHost: record.kind === "cimd" ? hostOf(record.id) : null,
      callbackHosts: [...new Set(record.redirectUris.map(hostOf).filter((host) => host !== null))],
    });

    const getState = Effect.gen(function* () {
      const [revision, records] = yield* Effect.all([
        store.getRevision.pipe(Effect.orElseSucceed(() => 0)),
        store.listClients.pipe(Effect.orElseSucceed(() => [])),
      ]);
      const clients = yield* Effect.forEach(records, (record) =>
        events
          .readiness(record)
          .pipe(Effect.map((readiness) => ({ ...toClient(record), readiness }))),
      );
      return {
        revision,
        enabled: settings.enabled,
        local: localState,
        remote: { ...remoteState, issuer: remoteIssuer },
        pairing: oauthServer.pairingState(),
        stdio: input.stdio,
        clients,
      } satisfies AgentBridgeState;
    });

    const serviceError = (message: string) => new AgentBridgeServiceError({ message });
    const storageError = Effect.mapError(() =>
      serviceError("F5 could not update the client. Try again."),
    );
    const requireExposed = (projectIds: ReadonlyArray<string>) => {
      const exposed = new Set<string>(settings.exposedProjectIds);
      return projectIds.every((id) => exposed.has(id))
        ? Effect.void
        : Effect.fail(
            serviceError("Only projects shared in Agent Bridge settings can be granted."),
          );
    };
    const requireOAuthClient = (clientId: string) =>
      Effect.gen(function* () {
        if (clientId === AGENT_BRIDGE_LOCAL_CLIENT_ID)
          return yield* serviceError(
            "The local client always has every permission; turn the bridge off instead.",
          );
        const client = yield* store.getClient(clientId).pipe(storageError);
        if (!client) return yield* serviceError("Client not found.");
        return client;
      });

    return {
      getState,
      tasks: taskOperator,
      openPairingWindow: Effect.gen(function* () {
        if (remoteState.status !== "running")
          return yield* serviceError("Turn on remote access and check its status first.");
        oauthServer.openPairingWindow();
        return yield* getState;
      }),
      decideAuthorization: (decision) =>
        Effect.gen(function* () {
          if (decision.approve) yield* requireExposed(decision.projectIds);
          yield* Effect.tryPromise({
            try: () => oauthServer.decide(decision),
            catch: (cause) =>
              serviceError(
                cause instanceof OAuthDecisionError
                  ? cause.message
                  : "F5 could not record the decision. Try again.",
              ),
          });
          return yield* getState;
        }),
      updateClientGrant: (grant) =>
        Effect.gen(function* () {
          const client = yield* requireOAuthClient(grant.clientId);
          if (client.revokedAt !== null)
            return yield* serviceError("This client is revoked. Connect it again instead.");
          if (grant.scopes.length === 0)
            return yield* serviceError("Grant at least one permission, or revoke the client.");
          yield* requireExposed(grant.projectIds);
          yield* input.oauth
            .setGrant({ clientId: client.id, scopes: grant.scopes, projectIds: grant.projectIds })
            .pipe(storageError);
          yield* fenceGrant(client.id);
          invalidate([client.id]);
          return yield* getState;
        }),
      retryNotification: (clientId) =>
        Effect.gen(function* () {
          const client = yield* requireOAuthClient(clientId);
          const count = yield* events.retryNotification(client.id);
          if (count === 0) return yield* serviceError("This client has no event subscription yet.");
          invalidate([client.id]);
          return yield* getState;
        }),
      revokeClient: (clientId) =>
        Effect.gen(function* () {
          const client = yield* requireOAuthClient(clientId);
          yield* input.oauth.revokeClient(client.id, Date.now()).pipe(storageError);
          yield* events.removeClient(client.id);
          const paused = yield* input.tasks
            .fenceTasks({
              clientId: client.id,
              reason: "The client was revoked.",
              at: new Date().toISOString(),
            })
            .pipe(Effect.orElseSucceed(() => []));
          invalidate([client.id, ...paused]);
          return yield* getState;
        }),
    };
  });
