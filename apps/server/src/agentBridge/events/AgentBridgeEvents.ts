/**
 * Agent Bridge MCP Events: the `events/*` methods and the durable webhook
 * delivery worker.
 *
 * - Each subscription keeps two watermarks: the last orchestration event
 *   sequence and the last task workspace revision it handled. The worker
 *   reads forward from both, translates, and delivers one event at a time;
 *   the live domain stream only wakes it, and restarts resume from storage.
 * - Delivery is at least once. An event is serialized once and retried with
 *   the same id; each attempt gets a fresh timestamp and signature.
 * - Before every attempt the subscription, token family, grant generation,
 *   and access to the thread or task are rechecked.
 * - A webhook acknowledgment only means the notification arrived; task state
 *   changes only through task tools.
 *
 * @module agentBridge/events/AgentBridgeEvents
 */
import { createHash, randomBytes } from "node:crypto";

import {
  AGENT_BRIDGE_LOCAL_CLIENT_ID,
  type AgentBridgeClientReadiness,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Deferred, Duration, Effect, Stream } from "effect";

import { canonicalJson } from "../../canonicalJsonHash.ts";
import type { ServerSecretStoreShape } from "../../auth/Services/ServerSecretStore.ts";
import type { AgentBridgeHostShape } from "../AgentBridgeHost.ts";
import type { AgentBridgeClientRecord, AgentBridgeStore } from "../AgentBridgeStore.ts";
import type { McpMethodOutcome } from "../mcpProtocol.ts";
import { validateOutboundUrl, type OutboundHttps } from "../outboundHttps.ts";
import type { AgentBridgeCaller } from "../threadTools.ts";
import {
  MAX_SUBSCRIPTIONS_PER_CLIENT,
  type EventStore,
  type PendingEvent,
  type SubscriptionRecord,
} from "./EventStore.ts";
import {
  decodeWebhookSecret,
  MAX_EVENT_BODY_BYTES,
  postWebhook,
  verifyCallback,
} from "./webhook.ts";

export const THREAD_EVENT_NAMES = [
  "thread.turn_completed",
  "thread.approval_requested",
  "thread.input_requested",
] as const;
export const TASK_EVENT_NAMES = ["tasks.available", "task.updated"] as const;
export const EVENT_NAMES = [...THREAD_EVENT_NAMES, ...TASK_EVENT_NAMES] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export const SUBSCRIPTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_MARGIN_MS = 60 * 60 * 1000;
const CURSOR_MAX_EVENTS = 500;
const CURSOR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DELIVERY_BACKOFF_MS = [1_000, 4_000, 16_000, 64_000] as const;
export const MAX_DELIVERY_ATTEMPTS = 5;
const RETRY_AFTER_MAX_S = 300;
const GLOBAL_DELIVERY_CONCURRENCY = 4;
const IDLE_POLL_MS = 30_000;
const SCAN_PAGE = 200;
const EVENTS_PER_RUN = 25;
const SUMMARY_MAX_CHARS = 500;
const MAX_THREAD_IDS = 50;

/** JSON-RPC error for a failed callback verification. */
export const CALLBACK_VERIFICATION_FAILED = -32015;

const isThreadEvent = (name: string): name is (typeof THREAD_EVENT_NAMES)[number] =>
  (THREAD_EVENT_NAMES as ReadonlyArray<string>).includes(name);
const isEventName = (name: string): name is EventName =>
  (EVENT_NAMES as ReadonlyArray<string>).includes(name);

const sha256 = (...parts: ReadonlyArray<string | number>) =>
  createHash("sha256").update(parts.join("\u0000")).digest("hex");

/** Retry delay for the attempt that just failed (1-based), honoring Retry-After up to 5 min. */
export function deliveryBackoffMs(attempt: number, retryAfterSeconds: number | null): number {
  const base = DELIVERY_BACKOFF_MS[Math.min(attempt, DELIVERY_BACKOFF_MS.length) - 1] ?? 64_000;
  return retryAfterSeconds === null
    ? base
    : Math.max(base, Math.min(retryAfterSeconds, RETRY_AFTER_MAX_S) * 1000);
}

const EVENT_CATALOG: ReadonlyArray<{
  readonly name: EventName;
  readonly description: string;
  readonly arguments: Record<string, unknown>;
}> = [
  {
    name: "thread.turn_completed",
    description: "A turn finished in a thread: {threadId, turnId, status, summary≤500}.",
    arguments: threadArgumentsSchema(),
  },
  {
    name: "thread.approval_requested",
    description:
      "F5 is waiting for the user to approve an action in a thread: {threadId, kind, summary}. Agents cannot answer approvals.",
    arguments: threadArgumentsSchema(),
  },
  {
    name: "thread.input_requested",
    description: "A thread is waiting for the user's answer: {threadId}.",
    arguments: threadArgumentsSchema(),
  },
  {
    name: "tasks.available",
    description:
      "Tasks assigned to you are queued: {tasks: [{taskId, title, status, project}]}. Claim them with claim_task.",
    arguments: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "task.updated",
    description:
      "The user changed one of your tasks (replied, paused, resumed, cancelled): {taskId, status, questionId?}. Read it with get_task.",
    arguments: { type: "object", properties: {}, additionalProperties: false },
  },
];

function threadArgumentsSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      threadIds: {
        type: "array",
        items: { type: "string" },
        maxItems: MAX_THREAD_IDS,
        description: "Threads to watch. Defaults to the threads you created.",
      },
    },
    additionalProperties: false,
  };
}

interface Cursor {
  readonly e: number;
  readonly t: number;
  readonly at: number;
}
const encodeCursor = (cursor: Cursor) =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
const decodeCursor = (value: unknown): Cursor | null => {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    return typeof parsed.e === "number" &&
      typeof parsed.t === "number" &&
      typeof parsed.at === "number"
      ? { e: parsed.e, t: parsed.t, at: parsed.at }
      : null;
  } catch {
    return null;
  }
};

/** The server secret store's surface used for webhook secrets. */
export type SecretVault = Pick<ServerSecretStoreShape, "get" | "set" | "remove">;

function deliveryUrlProblem(url: string): string | null {
  try {
    validateOutboundUrl(url);
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : "Invalid delivery URL.";
  }
}

export interface AgentBridgeEventsDeps {
  readonly store: EventStore;
  readonly clients: AgentBridgeStore;
  readonly host: AgentBridgeHostShape;
  readonly secrets: SecretVault;
  readonly outbound: OutboundHttps;
  readonly visibleProjectIds: (client: AgentBridgeClientRecord) => ReadonlySet<string>;
  readonly onChanged: (affectedIds: ReadonlyArray<string>) => void;
  readonly now?: () => number;
}

export interface AgentBridgeEvents {
  /** The `events` capability for `server/discover`, or undefined when not offered. */
  readonly capability: (caller: AgentBridgeCaller) => Record<string, unknown> | undefined;
  readonly handleMethod: (
    method: string,
    params: Record<string, unknown>,
    caller: AgentBridgeCaller,
  ) => Effect.Effect<McpMethodOutcome> | null;
  /** Runs the delivery worker until interrupted. */
  readonly run: Effect.Effect<never>;
  /** One delivery pass over every due subscription. */
  readonly drain: Effect.Effect<void>;
  readonly wake: () => void;
  readonly readiness: (
    client: AgentBridgeClientRecord,
  ) => Effect.Effect<AgentBridgeClientReadiness | null>;
  readonly retryNotification: (clientId: string) => Effect.Effect<number>;
  /** Deletes a client's subscriptions and secrets (revocation). */
  readonly removeClient: (clientId: string) => Effect.Effect<void>;
  /** Deletes every subscription and secret (the issuer changed). */
  readonly removeAll: Effect.Effect<void>;
  /** Removes expired subscriptions, callbacks, diagnostics, and orphaned secrets. */
  readonly sweep: Effect.Effect<void>;
}

const rpcError = (code: number, message: string, data?: unknown): McpMethodOutcome => ({
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

export function makeAgentBridgeEvents(deps: AgentBridgeEventsDeps): AgentBridgeEvents {
  const { store, host } = deps;
  const now = deps.now ?? Date.now;
  let wakeSignal: Deferred.Deferred<void> | null = null;
  const wake = () => {
    if (wakeSignal) Effect.runSync(Deferred.succeed(wakeSignal, undefined));
  };

  const removeSecrets = (refs: ReadonlyArray<string>) =>
    Effect.forEach(refs, (ref) => deps.secrets.remove(ref).pipe(Effect.ignore), { discard: true });

  const loadSecrets = (subscription: SubscriptionRecord) =>
    Effect.gen(function* () {
      const current = yield* deps.secrets
        .get(subscription.secretRef)
        .pipe(Effect.orElseSucceed(() => null));
      const previous =
        subscription.previousSecretRef &&
        subscription.previousSecretUntil &&
        Date.parse(subscription.previousSecretUntil) > now()
          ? yield* deps.secrets
              .get(subscription.previousSecretRef)
              .pipe(Effect.orElseSucceed(() => null))
          : null;
      return [current, previous].filter((secret): secret is Uint8Array => secret !== null);
    });

  const visibleThread = (
    model: OrchestrationReadModel,
    visible: ReadonlySet<string>,
    threadId: string,
  ) =>
    model.threads.find(
      (thread) =>
        thread.id === threadId && thread.deletedAt === null && visible.has(thread.projectId),
    );

  // ── events/* methods ──

  const subscribe = (params: Record<string, unknown>, caller: AgentBridgeCaller) =>
    Effect.gen(function* () {
      const client = caller.client;
      const familyId = caller.tokenFamilyId;
      if (!familyId) return rpcError(-32601, "Events are available only to remote clients.");
      const name = typeof params.name === "string" ? params.name : "";
      if (!isEventName(name)) return rpcError(-32602, `Unknown event: ${name}`);
      const args =
        params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      let normalizedArgs: Record<string, unknown> = {};
      if (isThreadEvent(name) && args.threadIds !== undefined) {
        if (
          !Array.isArray(args.threadIds) ||
          args.threadIds.length > MAX_THREAD_IDS ||
          args.threadIds.some((id) => typeof id !== "string")
        )
          return rpcError(-32602, `threadIds must be at most ${MAX_THREAD_IDS} thread ids.`);
        const threadIds = [...new Set(args.threadIds as string[])].toSorted();
        const model = yield* host.readSnapshot.pipe(Effect.orElseSucceed(() => null));
        const visible = caller.visibleProjectIds;
        if (!model || threadIds.some((id) => !visibleThread(model, visible, id)))
          return rpcError(-32602, "Thread not found.");
        normalizedArgs = { threadIds };
      }
      const delivery =
        params.delivery && typeof params.delivery === "object"
          ? (params.delivery as Record<string, unknown>)
          : {};
      if (delivery.mode !== "webhook") return rpcError(-32602, 'delivery.mode must be "webhook".');
      const url = typeof delivery.url === "string" ? delivery.url : "";
      const urlProblem = deliveryUrlProblem(url);
      if (urlProblem !== null) return rpcError(-32602, urlProblem);
      const secret = decodeWebhookSecret(
        typeof delivery.secret === "string" ? delivery.secret : "",
      );
      if (!secret)
        return rpcError(-32602, "delivery.secret must be whsec_ followed by 24–64 base64 bytes.");

      const id = sha256(client.id, url, name, canonicalJson(normalizedArgs));
      const existing = yield* store.get(id).pipe(Effect.orElseSucceed(() => null));
      if (existing && existing.clientId !== client.id)
        return rpcError(-32602, "Subscription conflict.");
      if (!existing) {
        const count = yield* store.countForClient(client.id).pipe(Effect.orElseSucceed(() => 0));
        if (count >= MAX_SUBSCRIPTIONS_PER_CLIENT)
          return rpcError(
            -32602,
            `At most ${MAX_SUBSCRIPTIONS_PER_CLIENT} subscriptions per client.`,
          );
      }

      const at = now();
      // Verification is cached per (client, url) for 24 h.
      const verified = yield* store
        .isCallbackVerified(client.id, url, at)
        .pipe(Effect.orElseSucceed(() => false));
      if (!verified) {
        const reason = yield* Effect.promise(() =>
          verifyCallback(deps.outbound, { url, subscriptionId: id, secrets: [secret], now: at }),
        );
        if (reason !== null) {
          yield* Effect.logWarning("agentBridge.subscription.verification.failed", {
            clientId: client.id,
            subscriptionId: id,
            reason,
          });
          return rpcError(CALLBACK_VERIFICATION_FAILED, "Callback verification failed.", {
            reason,
          });
        }
        yield* store.markCallbackVerified(client.id, url, at).pipe(Effect.ignore);
      }

      // Reuse the stored secret when it did not change.
      let secretRef = existing?.secretRef ?? null;
      if (secretRef !== null) {
        const stored = yield* deps.secrets.get(secretRef).pipe(Effect.orElseSucceed(() => null));
        if (!stored || Buffer.compare(Buffer.from(stored), Buffer.from(secret)) !== 0)
          secretRef = null;
      }
      if (secretRef === null) {
        secretRef = `agent-bridge-whsec-${randomBytes(16).toString("hex")}`;
        const saved = yield* deps.secrets.set(secretRef, secret).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (!saved) return rpcError(-32603, "F5 could not store the webhook secret.");
      }

      const ttl = params.ttlSeconds;
      const ttlMs =
        typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0
          ? Math.min(ttl * 1000, SUBSCRIPTION_TTL_MS)
          : SUBSCRIPTION_TTL_MS;
      const expiresAt = at + ttlMs;

      const headSequence = yield* host.readSnapshot.pipe(
        Effect.map((model) => model.snapshotSequence),
        Effect.orElseSucceed(() => 0),
      );
      const headRevision = yield* store.currentTaskRevision.pipe(Effect.orElseSucceed(() => 0));
      const cursor =
        params.cursor === undefined || params.cursor === null ? null : decodeCursor(params.cursor);
      const cursorUsable =
        cursor !== null &&
        at - cursor.at <= CURSOR_MAX_AGE_MS &&
        headSequence - cursor.e <= CURSOR_MAX_EVENTS &&
        cursor.e <= headSequence &&
        cursor.t <= headRevision;
      const truncated = params.cursor !== undefined && params.cursor !== null && !cursorUsable;
      const start = cursorUsable
        ? { e: cursor.e, t: cursor.t }
        : { e: headSequence, t: headRevision };

      const outcome = yield* store
        .upsert({
          id,
          clientId: client.id,
          tokenFamilyId: familyId,
          grantGeneration: client.grantGeneration,
          name,
          arguments: normalizedArgs,
          url,
          secretRef,
          expiresAt: new Date(expiresAt).toISOString(),
          eventWatermark: start.e,
          taskWatermark: start.t,
          // A new subscription, or one that missed events, starts with a backlog event.
          backlog: !isThreadEvent(name) && (!existing || truncated),
          at,
        })
        .pipe(Effect.option);
      if (outcome._tag === "None") return rpcError(-32603, "F5 could not save the subscription.");
      yield* Effect.logInfo("agentBridge.subscription.saved", {
        clientId: client.id,
        subscriptionId: id,
        name,
        created: outcome.value.created,
      });
      deps.onChanged([client.id]);
      wake();
      const current = yield* store.get(id).pipe(Effect.orElseSucceed(() => null));
      return {
        result: {
          id,
          refreshBefore: new Date(expiresAt - REFRESH_MARGIN_MS).toISOString(),
          cursor: encodeCursor({
            e: current?.eventWatermark ?? start.e,
            t: current?.taskWatermark ?? start.t,
            at,
          }),
          truncated,
        },
      } satisfies McpMethodOutcome;
    });

  const unsubscribe = (params: Record<string, unknown>, caller: AgentBridgeCaller) =>
    Effect.gen(function* () {
      const id = typeof params.id === "string" ? params.id : "";
      const existing = yield* store.get(id).pipe(Effect.orElseSucceed(() => null));
      if (!existing || existing.clientId !== caller.client.id)
        return rpcError(-32602, "Subscription not found.");
      const refs = yield* store.remove(id).pipe(Effect.orElseSucceed(() => []));
      yield* removeSecrets(refs);
      deps.onChanged([caller.client.id]);
      return { result: {} } satisfies McpMethodOutcome;
    });

  // ── translation ──

  interface SubscriptionContext {
    readonly subscription: SubscriptionRecord;
    readonly client: AgentBridgeClientRecord;
    readonly visible: ReadonlySet<string>;
  }

  const watchedThreads = (context: SubscriptionContext) =>
    Array.isArray(context.subscription.arguments.threadIds)
      ? Effect.succeed(new Set(context.subscription.arguments.threadIds as string[]))
      : deps.clients.listCreatedThreadIds(context.client.id).pipe(
          Effect.map((ids) => new Set<string>(ids)),
          Effect.orElseSucceed(() => new Set<string>()),
        );

  const envelope = (
    subscription: SubscriptionRecord,
    eventId: string,
    name: string,
    payload: unknown,
    occurredAt: string,
  ) =>
    JSON.stringify({
      type: "event",
      id: eventId,
      subscriptionId: subscription.id,
      name,
      occurredAt,
      payload,
    });

  const translateThreadEvent = (
    context: SubscriptionContext,
    event: OrchestrationEvent,
    model: OrchestrationReadModel,
  ): { readonly payload: unknown; readonly threadId: string } | null => {
    const name = context.subscription.name;
    if (name === "thread.turn_completed" && event.type === "thread.session-set") {
      const turnId = event.payload.settledTurnId;
      if (!turnId) return null;
      const thread = visibleThread(model, context.visible, event.payload.threadId);
      const latest = thread?.latestTurn?.turnId === turnId ? thread.latestTurn.state : null;
      const status = latest ?? (event.payload.session.lastError ? "error" : "completed");
      const summary =
        thread?.messages
          .filter((message) => message.role === "assistant" && message.turnId === turnId)
          .at(-1)
          ?.text.slice(0, SUMMARY_MAX_CHARS) ?? "";
      return {
        threadId: event.payload.threadId,
        payload: { threadId: event.payload.threadId, turnId, status, summary },
      };
    }
    if (event.type !== "thread.activity-appended") return null;
    const activity = event.payload.activity;
    if (name === "thread.approval_requested" && activity.kind === "approval.requested") {
      const detail =
        activity.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : {};
      return {
        threadId: event.payload.threadId,
        payload: {
          threadId: event.payload.threadId,
          kind: typeof detail.requestKind === "string" ? detail.requestKind : "unknown",
          summary: activity.summary.slice(0, SUMMARY_MAX_CHARS),
        },
      };
    }
    if (name === "thread.input_requested" && activity.kind === "user-input.requested")
      return { threadId: event.payload.threadId, payload: { threadId: event.payload.threadId } };
    return null;
  };

  const nextThreadEvent = (context: SubscriptionContext) =>
    Effect.gen(function* () {
      const { subscription } = context;
      const events = yield* host.readEventsAfter(subscription.eventWatermark).pipe(
        Stream.take(SCAN_PAGE),
        Stream.runCollect,
        Effect.orElseSucceed(() => []),
      );
      const list = [...events];
      if (list.length === 0) return null;
      const watched = yield* watchedThreads(context);
      const model = yield* host.readSnapshot.pipe(Effect.orElseSucceed(() => null));
      if (!model) return null;
      for (const event of list) {
        if (event.aggregateKind !== "thread" || !watched.has(event.aggregateId)) continue;
        const translated = translateThreadEvent(context, event, model);
        if (!translated) continue;
        const eventId = sha256(subscription.id, "orchestration", event.sequence);
        return {
          eventId,
          name: subscription.name,
          body: envelope(
            subscription,
            eventId,
            subscription.name,
            translated.payload,
            event.occurredAt,
          ),
          eventWatermark: event.sequence,
          taskWatermark: subscription.taskWatermark,
          backlog: false,
          subject: { kind: "thread", id: translated.threadId },
        } satisfies PendingEvent;
      }
      yield* store.advance(subscription.id, {
        eventWatermark: list.at(-1)!.sequence,
        taskWatermark: subscription.taskWatermark,
      });
      return "advanced" as const;
    });

  const projectNames = host.readSnapshot.pipe(
    Effect.map(
      (model) => new Map(model.projects.map((project) => [project.id as string, project.title])),
    ),
    Effect.orElseSucceed(() => new Map<string, string>()),
  );

  const backlogEvent = (context: SubscriptionContext) =>
    Effect.gen(function* () {
      const { subscription } = context;
      const revision = yield* store.currentTaskRevision;
      const tasks = (yield* store.backlogTasks(context.client.id)).filter((task) =>
        context.visible.has(task.projectId),
      );
      const names = yield* projectNames;
      const eventId = sha256(subscription.id, "backlog", revision);
      return {
        eventId,
        name: "tasks.available",
        body: envelope(
          subscription,
          eventId,
          "tasks.available",
          {
            backlog: true,
            tasks: tasks.map((task) => ({
              taskId: task.taskId,
              title: task.title.slice(0, 200),
              status: task.status,
              project: names.get(task.projectId) ?? "Unknown project",
            })),
          },
          new Date(now()).toISOString(),
        ),
        eventWatermark: subscription.eventWatermark,
        taskWatermark: Math.max(revision, subscription.taskWatermark),
        backlog: true,
        subject: { kind: "client", id: context.client.id },
      } satisfies PendingEvent;
    });

  const TASK_UPDATE_TYPES = new Set([
    "reply",
    "paused",
    "resumed",
    "cancelled",
    "question-withdrawn",
  ]);
  const TASK_AVAILABLE_TYPES = new Set(["created", "resumed"]);

  const nextTaskEvent = (context: SubscriptionContext) =>
    Effect.gen(function* () {
      const { subscription } = context;
      const activities = yield* store.taskActivitiesAfter(
        context.client.id,
        subscription.taskWatermark,
        SCAN_PAGE,
      );
      if (activities.length === 0) return null;
      const wanted =
        subscription.name === "tasks.available" ? TASK_AVAILABLE_TYPES : TASK_UPDATE_TYPES;
      const match = activities.find(
        (activity) => wanted.has(activity.type) && context.visible.has(activity.projectId),
      );
      if (!match) {
        yield* store.advance(subscription.id, {
          eventWatermark: subscription.eventWatermark,
          taskWatermark: activities.at(-1)!.revision,
        });
        return "advanced" as const;
      }
      // Everything in the same revision is reported together (one revision = one watermark step).
      const sameRevision = activities.filter(
        (activity) =>
          activity.revision === match.revision &&
          wanted.has(activity.type) &&
          context.visible.has(activity.projectId),
      );
      const eventId = sha256(subscription.id, "task", match.revision);
      let payload: unknown;
      if (subscription.name === "tasks.available") {
        const names = yield* projectNames;
        payload = {
          tasks: sameRevision.map((activity) => ({
            taskId: activity.taskId,
            title: activity.title.slice(0, 200),
            status: activity.status,
            project: names.get(activity.projectId) ?? "Unknown project",
          })),
        };
      } else {
        const [first, ...others] = sameRevision;
        payload = {
          taskId: first!.taskId,
          status: first!.status,
          ...(first!.questionId && first!.type !== "question-withdrawn"
            ? { questionId: first!.questionId }
            : {}),
          ...(others.length > 0
            ? {
                others: others.map((activity) => ({
                  taskId: activity.taskId,
                  status: activity.status,
                })),
              }
            : {}),
        };
      }
      return {
        eventId,
        name: subscription.name,
        body: envelope(
          subscription,
          eventId,
          subscription.name,
          payload,
          new Date(now()).toISOString(),
        ),
        eventWatermark: subscription.eventWatermark,
        taskWatermark: match.revision,
        backlog: false,
        subject: { kind: "task", id: match.taskId },
      } satisfies PendingEvent;
    });

  const subjectAccessible = (context: SubscriptionContext, subject: PendingEvent["subject"]) =>
    Effect.gen(function* () {
      if (subject.kind === "client") return true;
      if (subject.kind === "thread") {
        const model = yield* host.readSnapshot.pipe(Effect.orElseSucceed(() => null));
        return model !== null && visibleThread(model, context.visible, subject.id) !== undefined;
      }
      // The task still belongs to this client, in a project it can see.
      const projectId = yield* store
        .taskProject(subject.id, context.client.id)
        .pipe(Effect.orElseSucceed(() => null));
      return projectId !== null && context.visible.has(projectId);
    });

  /** Checks the subscription can still receive anything. */
  const loadContext = (subscription: SubscriptionRecord) =>
    Effect.gen(function* () {
      const at = now();
      if (Date.parse(subscription.expiresAt) <= at) return null;
      const client = yield* deps.clients
        .getClient(subscription.clientId)
        .pipe(Effect.orElseSucceed(() => null));
      if (!client || client.revokedAt !== null || !client.scopes.includes("f5.events")) return null;
      if (client.grantGeneration !== subscription.grantGeneration) return null;
      const familyActive = yield* store
        .isFamilyActive(subscription.tokenFamilyId, at)
        .pipe(Effect.orElseSucceed(() => false));
      if (!familyActive) return null;
      return {
        subscription,
        client,
        visible: deps.visibleProjectIds(client),
      } satisfies SubscriptionContext;
    });

  /** Delivers this subscription's events until it is idle or a retry is scheduled. */
  const processSubscription = (initial: SubscriptionRecord) =>
    Effect.gen(function* () {
      const claimed = yield* store.claim(initial.id, now());
      if (!claimed) return;
      yield* Effect.gen(function* () {
        for (let index = 0; index < EVENTS_PER_RUN; index++) {
          const subscription = yield* store.get(initial.id);
          if (!subscription) return;
          const context = yield* loadContext(subscription);
          if (!context) return;
          let event = subscription.pendingEvent;
          if (!event) {
            const next = subscription.backlogPending
              ? isThreadEvent(subscription.name)
                ? null
                : yield* backlogEvent(context)
              : isThreadEvent(subscription.name)
                ? yield* nextThreadEvent(context)
                : yield* nextTaskEvent(context);
            if (next === "advanced") continue;
            if (next === null) {
              if (subscription.backlogPending && isThreadEvent(subscription.name))
                yield* store.dropPending(subscription.id, {
                  eventId: "",
                  name: subscription.name,
                  body: "",
                  eventWatermark: subscription.eventWatermark,
                  taskWatermark: subscription.taskWatermark,
                  backlog: true,
                  subject: { kind: "client", id: subscription.clientId },
                });
              return;
            }
            event = next;
            yield* store.setPendingEvent(subscription.id, event);
          }
          if (!(yield* subjectAccessible(context, event.subject))) {
            yield* store.dropPending(subscription.id, event);
            continue;
          }
          const attempt = subscription.attempt + 1;
          const at = now();
          if (Buffer.byteLength(event.body, "utf8") > MAX_EVENT_BODY_BYTES) {
            yield* store.settle(subscription.id, event, {
              delivered: false,
              at,
              lastStatus: 413,
              attempts: attempt,
            });
            continue;
          }
          const secrets = yield* loadSecrets(subscription);
          if (secrets.length === 0) return;
          const started = Date.now();
          const result = yield* Effect.promise(() =>
            postWebhook(deps.outbound, {
              url: subscription.url,
              id: event.eventId,
              subscriptionId: subscription.id,
              body: event.body,
              secrets,
              now: at,
            }),
          );
          const durationMs = Date.now() - started;
          if (result.status !== null && result.status >= 200 && result.status < 300) {
            yield* store.settle(subscription.id, event, {
              delivered: true,
              at: now(),
              lastStatus: result.status,
              attempts: attempt,
            });
            if (subscription.status === "delivery-failed") deps.onChanged([subscription.clientId]);
            continue;
          }
          if (result.status === 410) {
            yield* store.recordGone(subscription.id, event, now());
            yield* removeSecrets(yield* store.remove(subscription.id));
            yield* Effect.logInfo("agentBridge.subscription.gone", {
              clientId: subscription.clientId,
              subscriptionId: subscription.id,
            });
            deps.onChanged([subscription.clientId]);
            return;
          }
          yield* Effect.logWarning("agentBridge.notification.failed", {
            clientId: subscription.clientId,
            subscriptionId: subscription.id,
            eventId: event.eventId,
            attempt,
            status: result.status,
            reason: result.error,
            durationMs,
          });
          if (result.status === 413 || attempt >= MAX_DELIVERY_ATTEMPTS) {
            yield* store.settle(subscription.id, event, {
              delivered: false,
              at: now(),
              lastStatus: result.status,
              attempts: attempt,
            });
            deps.onChanged([subscription.clientId]);
            continue;
          }
          yield* store.scheduleRetry(subscription.id, {
            attempt,
            nextAttemptAt: now() + deliveryBackoffMs(attempt, result.retryAfterSeconds),
            error: result.status === null ? (result.error ?? "network") : `status ${result.status}`,
          });
          return;
        }
      }).pipe(Effect.ensuring(store.release(initial.id).pipe(Effect.ignore)));
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("agentBridge.notification.worker.failed", {
          subscriptionId: initial.id,
          detail: error.message,
        }),
      ),
    );

  /** One pass: due subscriptions grouped per client (1 at a time), 4 clients at once. */
  const drain = Effect.gen(function* () {
    const due = yield* store.listDue(now()).pipe(Effect.orElseSucceed(() => []));
    const byClient = new Map<string, SubscriptionRecord[]>();
    for (const subscription of due) {
      const group = byClient.get(subscription.clientId) ?? [];
      group.push(subscription);
      byClient.set(subscription.clientId, group);
    }
    yield* Effect.forEach(
      [...byClient.values()],
      (group) => Effect.forEach(group, processSubscription, { discard: true }),
      { concurrency: GLOBAL_DELIVERY_CONCURRENCY, discard: true },
    );
  });

  const run = Effect.gen(function* () {
    // The live stream only wakes the worker; storage is the source of truth.
    yield* host.domainEvents.pipe(
      Stream.runForEach(() => Effect.sync(wake)),
      Effect.forkScoped,
    );
    while (true) {
      wakeSignal = yield* Deferred.make<void>();
      yield* drain;
      const nextDue = yield* store.nextDueAt.pipe(Effect.orElseSucceed(() => null));
      const waitMs =
        nextDue === null ? IDLE_POLL_MS : Math.max(50, Math.min(IDLE_POLL_MS, nextDue - now()));
      yield* Deferred.await(wakeSignal).pipe(Effect.timeoutOption(Duration.millis(waitMs)));
    }
  }).pipe(Effect.scoped) as Effect.Effect<never>;

  return {
    capability: (caller) =>
      caller.tokenFamilyId && caller.client.scopes.includes("f5.events")
        ? { list: true, subscribe: { deliveryModes: ["webhook"] }, unsubscribe: true }
        : undefined,
    handleMethod: (method, params, caller) => {
      switch (method) {
        case "events/list":
          return Effect.succeed({
            result: {
              events: EVENT_CATALOG.map((entry) => ({
                name: entry.name,
                description: entry.description,
                argumentsSchema: entry.arguments,
              })),
              nextCursor: null,
            },
          });
        case "events/subscribe":
          return subscribe(params, caller);
        case "events/unsubscribe":
          return unsubscribe(params, caller);
        default:
          return null;
      }
    },
    run,
    drain,
    wake,
    readiness: (client) =>
      Effect.gen(function* () {
        if (client.id === AGENT_BRIDGE_LOCAL_CLIENT_ID) return null;
        if (client.revokedAt !== null) return null;
        if (!client.scopes.includes("f5.events")) return "linked" as const;
        const state = yield* store
          .readiness(client.id, now())
          .pipe(Effect.orElseSucceed(() => "none" as const));
        return state === "none" ? ("awaiting-subscription" as const) : state;
      }),
    retryNotification: (clientId) =>
      store.requestBacklog(clientId).pipe(
        Effect.tap(() => Effect.sync(wake)),
        Effect.orElseSucceed(() => 0),
      ),
    removeClient: (clientId) =>
      store.removeForClient(clientId).pipe(
        Effect.flatMap(removeSecrets),
        Effect.catch((error) =>
          Effect.logWarning("agentBridge.subscription.cleanup.failed", { detail: error.message }),
        ),
      ),
    removeAll: store.removeAll.pipe(
      Effect.flatMap(removeSecrets),
      Effect.catch((error) =>
        Effect.logWarning("agentBridge.subscription.cleanup.failed", { detail: error.message }),
      ),
    ),
    sweep: Effect.suspend(() => store.sweep(now())).pipe(
      Effect.flatMap(removeSecrets),
      Effect.catch((error) =>
        Effect.logWarning("agentBridge.subscription.sweep.failed", { detail: error.message }),
      ),
    ),
  };
}
