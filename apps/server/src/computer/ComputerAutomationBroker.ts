import { selectComputerApp, appTier } from "@t3tools/shared/computerApps";
import { automationEventSanitizer } from "@t3tools/shared/automationActivitySanitizer";
import { createHash, randomUUID } from "node:crypto";
import { Effect, FileSystem, Layer, Option, Path, Schema, ServiceMap } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  ComputerGrant,
  type ComputerAutomationRequest,
  type ComputerAuthorization,
  type ComputerLeaseHolder,
  type ComputerAccessRequested,
  type ComputerActivity,
  type DesktopComputerHostMessage,
} from "@t3tools/contracts";
import {
  ComputerControlError,
  computerRequestPayload,
  isComputerMutation,
} from "@t3tools/shared/computerControl";
import { ServerConfig } from "../config";
import { ServerSettingsService } from "../serverSettings";
import { writeFileStringAtomically } from "../atomicWrite";
import { resolveAgentBrowserPolicy, type AgentBrowserPolicy } from "../mcp/browserAccess";
import { AutomationQueue } from "../mcp/automationQueue";
import { AgentControlPause, AgentControlPauseService } from "../mcp/agentControlPause";
import { DesktopComputerHost } from "./DesktopComputerHost";
import { ComputerAccessService } from "./ComputerAccessService";

export interface ComputerInvocationContext {
  readonly threadId: string;
  readonly sessionGeneration: string;
  readonly projectId: string;
  readonly turnId: string;
  readonly runtimeMode: string;
  readonly interactionMode: string;
  readonly provider: "claude" | "codex";
  readonly threadTitle: string;
  readonly policy: AgentBrowserPolicy;
}
export type ComputerBrokerEvent =
  | {
      channel: "computer.access.requested";
      data: ComputerAccessRequested & { backendIncarnation: string };
    }
  | {
      channel: "computer.access.settled";
      data: { requestId: string; threadId: string; allowed: boolean };
    }
  | {
      channel: "computer.access.grantsChanged";
      data: { threadId: string; grants: ReadonlyArray<ComputerGrant>; grantVersion: number };
    }
  | { channel: "computer.activity"; data: ComputerActivity }
  | { channel: "computer.host"; data: DesktopComputerHostMessage };
export class ComputerAutomationBroker extends ServiceMap.Service<
  ComputerAutomationBroker,
  ComputerAutomationBrokerRuntime
>()("t3/computer/ComputerAutomationBroker") {}
export class ComputerAutomationBrokerRuntime {
  readonly pause: AgentControlPause;
  readonly access: ComputerAccessService;
  private readonly bindings = new Map<
    string,
    {
      generation: string;
      provider: "claude" | "codex";
      holder?: ComputerLeaseHolder;
      turnId?: string;
    }
  >();
  private readonly queue = new AutomationQueue<ComputerControlError>({
    capacity: 16,
    busy: () => new ComputerControlError({ _tag: "Busy", holder: "same-profile" }),
    cancelled: () => new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" }),
    expired: () =>
      new ComputerControlError({
        _tag: "Execution",
        message: "Computer request expired before execution.",
      }),
  });
  private readonly inFlight = new Map<
    string,
    { threadId: string; generation: string; turnId: string }
  >();
  private readonly listeners = new Set<(event: ComputerBrokerEvent) => void>();
  private readonly endedTurns = new Set<string>();
  private mainHolder: ComputerLeaseHolder | null = null;
  private otherProfile = false;
  private readonly offHost: () => void;
  private readonly offPause: () => void;
  constructor(
    readonly host: DesktopComputerHost,
    private readonly options: {
      resolve: (
        threadId: string,
        sessionGeneration: string,
        provider: "claude" | "codex",
      ) => Promise<ComputerInvocationContext>;
      storage: ConstructorParameters<typeof ComputerAccessService>[0]["storage"];
      platform: "darwin" | "win32";
      pause?: AgentControlPause;
    },
  ) {
    this.pause = options.pause ?? new AgentControlPause();
    this.offPause = this.pause.subscribe((threadId, paused) => {
      const binding = this.bindings.get(threadId);
      if (paused && binding) {
        this.host.send({ type: "pauseChanged", threadId, paused });
        this.cancelTurn(threadId, binding.generation, binding.turnId, "paused");
      }
    });
    this.access = new ComputerAccessService({
      platform: options.platform,
      backendIncarnation: host.backendIncarnation,
      storage: options.storage,
      request: (request) => {
        this.publish({
          channel: "computer.access.requested",
          data: { ...request, backendIncarnation: host.backendIncarnation },
        });
        host.send({ type: "accessRequested", request });
      },
      settled: (requestId, threadId, allowed) => {
        host.send({ type: "cancel", requestId });
        this.publish({
          channel: "computer.access.settled",
          data: { requestId, threadId, allowed },
        });
      },
      changed: (threadId) => {
        const binding = this.bindings.get(threadId);
        if (!binding) return;
        this.pushGrants(
          threadId,
          binding.generation,
          binding.turnId ?? "observation",
          binding.holder?.executionGeneration ?? 1,
        );
        this.publish({
          channel: "computer.access.grantsChanged",
          data: {
            threadId,
            grants: this.access.grants(threadId),
            grantVersion: this.access.version(threadId),
          },
        });
      },
    });
    this.offHost = host.onMessage((message) => {
      if (
        message.type === "killSwitch" &&
        !this.matchesTurn(message.threadId, message.sessionGeneration, message.turnId)
      )
        return;
      if (message.type === "leaseChanged") {
        this.mainHolder = message.holder;
        this.otherProfile = message.otherProfile ?? false;
      }
      if (
        message.type === "status" &&
        !message.status.available &&
        message.status.reason === "no-host"
      ) {
        this.mainHolder = null;
        this.otherProfile = false;
        for (const [threadId, binding] of this.bindings)
          this.releaseSession(threadId, binding.generation);
        this.publish({ channel: "computer.host", data: { type: "leaseChanged", holder: null } });
      }
      if (message.type === "accessAnswer")
        void this.access.answerFromHost(message.answer).catch(() => undefined);
      if (message.type === "pauseChanged") {
        this.pause.set(message.threadId, message.paused);
        const binding = this.bindings.get(message.threadId);
        if (binding && message.paused)
          this.cancelTurn(message.threadId, binding.generation, binding.turnId, "paused");
      }
      if (message.type === "activity")
        this.publish({ channel: "computer.activity", data: message.activity });
      else if (message.type !== "response" && message.type !== "accessAnswer")
        this.publish({ channel: "computer.host", data: message });
    });
  }
  initialize(): Promise<void> {
    return this.access.initialize();
  }
  bindSession(threadId: string, generation: string, provider: "claude" | "codex"): void {
    const previous = this.bindings.get(threadId);
    if (previous?.generation === generation) return;
    if (previous) this.releaseSession(threadId, previous.generation);
    this.bindings.set(threadId, { generation, provider });
  }
  generation(threadId: string): string | undefined {
    return this.bindings.get(threadId)?.generation;
  }
  matchesTurn(threadId: string, generation: string, turnId: string): boolean {
    const binding = this.bindings.get(threadId);
    return (
      binding?.generation === generation &&
      binding.turnId === turnId &&
      !this.endedTurns.has(`${generation}\0${turnId}`)
    );
  }
  snapshot() {
    return {
      holder: this.mainHolder,
      otherProfile: this.otherProfile,
      pausedThreads: this.pause.list(),
      pending: this.access
        .pendingRequests()
        .map((request) => ({ ...request, backendIncarnation: this.host.backendIncarnation })),
      grants: [...this.bindings.keys()].map((threadId) => ({
        threadId,
        grants: this.access.grants(threadId),
        grantVersion: this.access.version(threadId),
      })),
    };
  }
  async context(threadId: string, sessionGeneration: string): Promise<ComputerInvocationContext> {
    const binding = this.bindings.get(threadId);
    if (!binding || binding.generation !== sessionGeneration)
      throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
    const ctx = await this.options.resolve(threadId, sessionGeneration, binding.provider);
    this.access.bind(threadId, ctx.projectId, sessionGeneration);
    return ctx;
  }
  private authorization(
    ctx: ComputerInvocationContext,
    executionGeneration: number,
  ): ComputerAuthorization {
    return {
      profileId: this.host.profileId,
      threadId: ctx.threadId,
      sessionGeneration: ctx.sessionGeneration,
      turnId: ctx.turnId,
      executionGeneration,
      grantVersion: this.access.version(ctx.threadId),
      grants: this.access.grants(ctx.threadId),
    };
  }
  private pushGrants(
    threadId: string,
    generation: string,
    turnId: string,
    executionGeneration: number,
  ): void {
    this.host.send({
      type: "grantsChanged",
      authorization: {
        profileId: this.host.profileId,
        threadId,
        sessionGeneration: generation,
        turnId,
        executionGeneration,
        grantVersion: this.access.version(threadId),
        grants: this.access.grants(threadId),
      },
    });
  }
  async invoke(
    threadId: string,
    generation: string,
    input: Record<string, unknown> & { op: ComputerAutomationRequest["op"] },
    timeoutMs = 30_000,
  ): Promise<unknown> {
    const ctx = await this.context(threadId, generation);
    if (!ctx.policy.computerUse)
      throw new ComputerControlError({ _tag: "Unavailable", reason: "disabled" });
    const status = this.host.status();
    if (!status.available) {
      if (input.op === "status") return status;
      throw new ComputerControlError({
        _tag: "Unavailable",
        reason: status.reason,
        ...(status.missing ? { missing: status.missing } : {}),
      });
    }
    if (input.op === "status") return status;
    const mutation = isComputerMutation(input.op);
    const binding = this.bindings.get(threadId)!;
    if (ctx.turnId !== "observation") binding.turnId = ctx.turnId;
    if (mutation) {
      if (ctx.turnId === "observation" || this.endedTurns.has(`${generation}\0${ctx.turnId}`))
        throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
      if (this.pause.has(threadId))
        throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
      if (ctx.interactionMode === "plan")
        throw new ComputerControlError({
          _tag: "Execution",
          message: "Computer control is unavailable in plan mode.",
        });
      if (ctx.runtimeMode !== "full-access" && !this.access.actionsApproved(threadId)) {
        await this.access.requestAccess(
          threadId,
          ctx.turnId,
          [],
          "Allow this agent session to control apps you approve?",
          "session-actions",
        );
        if (!this.access.actionsApproved(threadId))
          throw new ComputerControlError({ _tag: "NotGranted", needed: "click" });
      }
    }
    const requestId = randomUUID();
    const controller = new AbortController();
    const slot = mutation
      ? await this.queue.acquire(threadId, controller.signal, Math.min(60_000, timeoutMs))
      : { release: () => undefined };
    try {
      const live = await this.context(threadId, generation);
      if (!live.policy.computerUse)
        throw new ComputerControlError({ _tag: "Unavailable", reason: "disabled" });
      if (
        mutation &&
        (this.pause.has(threadId) ||
          live.turnId !== ctx.turnId ||
          this.endedTurns.has(`${generation}\0${ctx.turnId}`))
      )
        throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
      if (mutation && live.interactionMode === "plan")
        throw new ComputerControlError({
          _tag: "Execution",
          message: "Computer control is unavailable in plan mode.",
        });
      if (mutation && live.runtimeMode !== "full-access" && !this.access.actionsApproved(threadId))
        throw new ComputerControlError({ _tag: "NotGranted", needed: "click" });
      if (typeof input.appId === "string")
        this.access.require(
          threadId,
          input.appId,
          !mutation ? "view" : input.action === "setValue" ? "type" : "click",
        );
      let executionGeneration = binding.holder?.executionGeneration ?? 1;
      if (mutation) {
        const holder = (await this.host.correlated(
          {
            type: "leaseAcquire",
            requestId: randomUUID(),
            holder: {
              ...this.authorization(live, executionGeneration),
              backend: "native",
              threadTitle: live.threadTitle,
            },
          },
          2000,
          false,
        )) as ComputerLeaseHolder;
        // Cancellation during acquire must release the exact returned holder.
        if (
          this.bindings.get(threadId) !== binding ||
          this.pause.has(threadId) ||
          this.endedTurns.has(`${generation}\0${ctx.turnId}`)
        ) {
          this.host.send({ type: "leaseRelease", requestId: randomUUID(), holder });
          throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
        }
        binding.holder = holder;
        executionGeneration = holder.executionGeneration;
      }
      this.pushGrants(threadId, generation, live.turnId, executionGeneration);
      const envelope = {
        ...input,
        requestId,
        authorization: this.authorization(live, executionGeneration),
        deadlineAtMs: Date.now() + Math.min(60_000, Math.max(1, timeoutMs)),
        agent: { provider: live.provider, threadTitle: live.threadTitle.slice(0, 200) },
      };
      const payloadHash = createHash("sha256")
        .update(computerRequestPayload(envelope as Omit<ComputerAutomationRequest, "payloadHash">))
        .digest("hex");
      const request = Schema.decodeUnknownSync(
        (await import("@t3tools/contracts")).ComputerAutomationRequest,
      )({ ...envelope, payloadHash });
      this.inFlight.set(requestId, { threadId, generation, turnId: live.turnId });
      return await this.host.request(request);
    } finally {
      this.inFlight.delete(requestId);
      slot.release();
    }
  }
  async requestAccess(
    threadId: string,
    generation: string,
    queries: ReadonlyArray<string>,
    reason: string,
  ): Promise<unknown> {
    const ctx = await this.context(threadId, generation);
    const apps = (await this.invoke(threadId, generation, {
      op: "resolveApps",
      queries,
    })) as ReadonlyArray<import("@t3tools/contracts").ComputerApp>;
    const before = this.access.grants(threadId);
    const resolutions = queries.map((query) => {
      const matches = selectComputerApp(apps, query);
      const app = matches.length === 1 ? matches[0] : undefined;
      return { query, matches, app };
    });
    const candidates = resolutions.flatMap(({ app }) => (app ? [app] : []));
    await this.access.requestAccess(threadId, ctx.turnId, candidates, reason);
    const grants = this.access.grants(threadId);
    return {
      grants,
      apps: resolutions.map(({ query, matches, app }) => ({
        query,
        ...(app ? { appId: app.appId, name: app.name } : {}),
        status: !matches.length
          ? "not-found"
          : !app
            ? "ambiguous"
            : app.tier === "blocked" || appTier(app.appId, this.options.platform) === "blocked"
              ? "blocked"
              : before.some((grant) => grant.appId === app.appId)
                ? "already-granted"
                : grants.some((grant) => grant.appId === app.appId)
                  ? "allowed"
                  : "denied",
        ...(!app && matches.length
          ? { matches: matches.map(({ appId, name }) => ({ appId, name })) }
          : {}),
      })),
    };
  }
  setPaused(threadId: string, paused: boolean): void {
    if (paused) {
      this.pause.set(threadId, true);
      this.host.send({ type: "pauseChanged", threadId, paused });
      const binding = this.bindings.get(threadId);
      if (binding) this.cancelTurn(threadId, binding.generation, binding.turnId, "paused");
    } else this.host.send({ type: "resumeRequested", threadId });
  }
  private cancelTurn(
    threadId: string,
    generation: string,
    turnId: string | undefined,
    cause: "paused" | "turn-ended",
  ): void {
    const binding = this.bindings.get(threadId);
    if (!binding || binding.generation !== generation || (turnId && binding.turnId !== turnId))
      return;
    this.queue.flush(threadId, new ComputerControlError({ _tag: "Interrupted", cause }));
    for (const [requestId, pending] of this.inFlight)
      if (
        pending.threadId === threadId &&
        pending.generation === generation &&
        (!turnId || pending.turnId === turnId)
      )
        this.host.send({ type: "cancel", requestId });
    if (binding.holder) {
      this.host.send({ type: "leaseRelease", requestId: randomUUID(), holder: binding.holder });
      delete binding.holder;
    }
    if (turnId) this.access.endTurn(threadId, turnId);
  }
  endTurn(threadId: string, turnId: string, generation?: string): void {
    const binding = this.bindings.get(threadId);
    if (
      binding &&
      (!generation || binding.generation === generation) &&
      binding.turnId === turnId
    ) {
      this.endedTurns.add(`${binding.generation}\0${turnId}`);
      this.cancelTurn(threadId, binding.generation, turnId, "turn-ended");
    }
  }
  releaseSession(threadId: string, generation: string): void {
    const binding = this.bindings.get(threadId);
    if (!binding || binding.generation !== generation) return;
    this.cancelTurn(threadId, generation, undefined, "turn-ended");
    automationEventSanitizer.clear(threadId);
    const grantVersion = this.access.version(threadId) + 1;
    this.host.send({
      type: "grantsChanged",
      authorization: {
        profileId: this.host.profileId,
        threadId,
        sessionGeneration: generation,
        turnId: binding.turnId ?? "observation",
        executionGeneration: binding.holder?.executionGeneration ?? 1,
        grantVersion,
        grants: [],
      },
    });
    this.publish({
      channel: "computer.access.grantsChanged",
      data: { threadId, grantVersion, grants: [] },
    });
    this.access.clearSession(threadId, generation);
    this.bindings.delete(threadId);
    for (const key of this.endedTurns)
      if (key.startsWith(`${generation}\0`)) this.endedTurns.delete(key);
  }
  async refreshPolicies(): Promise<void> {
    for (const [threadId, binding] of this.bindings) {
      try {
        const context = await this.options.resolve(threadId, binding.generation, binding.provider);
        if (context.policy.computerUse) continue;
      } catch {
        /* An unreadable policy removes execution permission. */
      }
      if (this.bindings.get(threadId) !== binding) continue;
      this.cancelTurn(threadId, binding.generation, undefined, "turn-ended");
      this.access.policyChanged(threadId);
    }
  }
  subscribe(listener: (event: ComputerBrokerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish(event: ComputerBrokerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* UI failure never widens access. */
      }
    }
  }
  close(): void {
    for (const [threadId, binding] of this.bindings)
      this.releaseSession(threadId, binding.generation);
    this.offHost();
    this.offPause();
    this.access.close();
    this.host.close();
  }
}

export const ComputerAutomationBrokerLive = Layer.effect(
  ComputerAutomationBroker,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    type Dependencies =
      | FileSystem.FileSystem
      | Path.Path
      | SqlClient.SqlClient
      | ServerSettingsService;
    const services = yield* Effect.services<Dependencies>();
    const run = <A, E>(effect: Effect.Effect<A, E, Dependencies>) =>
      Effect.runPromise(effect.pipe(Effect.provide(services)));
    const file = path.join(config.stateDir, "computer-access.json");
    const Stored = Schema.Array(
      Schema.Struct({ ...ComputerGrant.fields, projectId: Schema.String }),
    );
    const host = DesktopComputerHost.fromEnvironment(config.profile?.id ?? "default");
    const pause = yield* Effect.serviceOption(AgentControlPauseService);
    const broker = new ComputerAutomationBrokerRuntime(host, {
      ...(Option.isSome(pause) ? { pause: pause.value } : {}),
      platform: process.platform === "win32" ? "win32" : "darwin",
      storage: {
        load: async () => {
          if (!(await run(fs.exists(file)))) return [];
          return Schema.decodeUnknownSync(Stored)(JSON.parse(await run(fs.readFileString(file))));
        },
        save: (grants) =>
          run(writeFileStringAtomically({ filePath: file, contents: JSON.stringify(grants) })),
      },
      resolve: async (threadId, sessionGeneration, provider) => {
        const rows = await run(
          sql<{
            projectId: string;
            title: string;
            runtimeMode: string;
            interactionMode: string;
            turnId: string | null;
          }>`SELECT t.project_id AS "projectId", t.title, t.runtime_mode AS "runtimeMode", t.interaction_mode AS "interactionMode", s.active_turn_id AS "turnId" FROM projection_threads t LEFT JOIN projection_thread_sessions s ON s.thread_id=t.thread_id WHERE t.thread_id=${threadId}`,
        );
        const row = rows[0];
        if (!row) throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
        return {
          threadId,
          sessionGeneration,
          provider,
          projectId: row.projectId,
          threadTitle: row.title,
          turnId: row.turnId ?? "observation",
          runtimeMode: row.runtimeMode,
          interactionMode: row.interactionMode,
          policy: await run(
            resolveAgentBrowserPolicy(threadId as import("@t3tools/contracts").ThreadId),
          ),
        };
      },
    });
    yield* Effect.promise(() => broker.initialize());
    yield* Effect.addFinalizer(() => Effect.sync(() => broker.close()));
    return broker;
  }),
);
