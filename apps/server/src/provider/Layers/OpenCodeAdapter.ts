import {
  EventId,
  type OpenCodeSettings,
  ProviderInstanceId,
  type ProviderKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ToolLifecycleItemType,
  TurnId,
  type UserInputQuestion,
  type WorkflowTurnExecutionProfile,
} from "@t3tools/contracts";
import { Cause, Effect, Exit, Queue, Random, Ref, Scope, Stream, Schedule } from "effect";
import type { OpencodeClient, Part, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  loadOpenCodeSkills,
  buildOpenCodePermissionRules,
  buildOpenCodeWorkflowPermissionRules,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  openCodeQuestionId,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  runOpenCodeSdk,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
  type OpenCodeServerConnection,
} from "../opencodeRuntime.ts";
import { normalizeSupportedSlashCommands } from "../supportedSlashCommands.ts";
import { buildProviderAttachmentRuntimeContext } from "../attachmentRuntimeContext.ts";

const PROVIDER: ProviderKind = "opencode";

interface OpenCodeTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

type OpenCodeSubscribedEvent =
  Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>> extends {
    readonly stream: AsyncIterable<infer TEvent>;
  }
    ? TEvent
    : never;

interface OpenCodeSessionContext {
  session: ProviderSession;
  readonly client: OpencodeClient;
  readonly server: OpenCodeServerConnection;
  readonly directory: string;
  readonly openCodeSessionId: string;
  readonly relatedSessionIds: Set<string>;
  readonly resolvedRequestIds: Set<string>;
  readonly autoRepliedRequestIds: Set<string>;
  workflowExecutionProfile: WorkflowTurnExecutionProfile | undefined;
  readonly pendingPermissions: Map<string, PermissionRequest>;
  readonly pendingQuestions: Map<string, QuestionRequest>;
  readonly messageRoleById: Map<string, "user" | "assistant">;
  readonly partById: Map<string, Part>;
  readonly emittedTextByPartId: Map<string, string>;
  readonly completedAssistantPartIds: Set<string>;
  readonly turns: Array<OpenCodeTurnSnapshot>;
  activeTurnId: TurnId | undefined;
  activeAgent: string | undefined;
  activeVariant: string | undefined;
  /**
   * One-shot guard flipped by `stopOpenCodeContext` / `emitUnexpectedExit`.
   * The session lifecycle is owned by `sessionScope`; this Ref exists only
   * so concurrent callers can race the transition safely via `getAndSet`.
   */
  readonly stopped: Ref.Ref<boolean>;
  /**
   * Sole lifecycle handle for the session. Closing this scope:
   *   - aborts the `AbortController` registered as a finalizer
   *     (cancels the in-flight `event.subscribe` fetch),
   *   - interrupts the event-pump and server-exit fibers forked
   *     via `Effect.forkIn(sessionScope)`,
   *   - tears down the OpenCode server process for scope-owned servers.
   */
  readonly sessionScope: Scope.Closeable;
  readonly eventsAbortController: AbortController;
}

export interface OpenCodeAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Map a tagged OpenCodeRuntimeError produced by {@link runOpenCodeSdk} into
 * the adapter-boundary `ProviderAdapterRequestError`. SDK-method-level call
 * sites pipe through this in `Effect.mapError` so they never build the error
 * shape by hand.
 */
const toRequestError = (cause: OpenCodeRuntimeError): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: cause.operation,
    detail: cause.detail,
    cause: cause.cause,
  });

/**
 * Map a `Cause.squash`-ed failure into a `ProviderAdapterProcessError`. The
 * typed cause is usually an `OpenCodeRuntimeError` (from {@link runOpenCodeSdk}),
 * in which case we preserve its `detail`; otherwise we fall back to
 * {@link openCodeRuntimeErrorDetail} for unknown causes (defects, etc.).
 */
const toProcessError = (threadId: ThreadId, cause: unknown): ProviderAdapterProcessError =>
  new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: OpenCodeRuntimeError.is(cause) ? cause.detail : openCodeRuntimeErrorDetail(cause),
    cause,
  });

const buildEventBase = (input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: unknown;
}): Effect.Effect<
  Pick<
    ProviderRuntimeEvent,
    "eventId" | "provider" | "threadId" | "createdAt" | "turnId" | "itemId" | "requestId" | "raw"
  >
> =>
  Random.nextUUIDv4.pipe(
    Effect.map((uuid) => ({
      eventId: EventId.make(uuid),
      provider: PROVIDER,
      threadId: input.threadId,
      createdAt: input.createdAt ?? nowIso(),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
      ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
      ...(input.raw !== undefined
        ? {
            raw: {
              source: "opencode.sdk.event",
              payload: input.raw,
            },
          }
        : {}),
    })),
  );

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized === "todowrite" || normalized === "todoread") return "dynamic_tool_call";
  if (normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }
  if (normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (
    normalized.includes("task") ||
    normalized.includes("agent") ||
    normalized.includes("subtask")
  ) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function mapPermissionToRequestType(
  permission: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" | "unknown" {
  switch (permission) {
    case "bash":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "edit":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function mapPermissionDecision(reply: "once" | "always" | "reject"): string {
  switch (reply) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    case "reject":
    default:
      return "decline";
  }
}

function resolveTurnSnapshot(
  context: OpenCodeSessionContext,
  turnId: TurnId,
): OpenCodeTurnSnapshot {
  const existing = context.turns.find((turn) => turn.id === turnId);
  if (existing) {
    return existing;
  }

  const created: OpenCodeTurnSnapshot = { id: turnId, items: [] };
  context.turns.push(created);
  return created;
}

function appendTurnItem(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
  item: unknown,
): void {
  if (!turnId) {
    return;
  }
  resolveTurnSnapshot(context, turnId).items.push(item);
}

function ensureSessionContext(
  sessions: ReadonlyMap<ThreadId, OpenCodeSessionContext>,
  threadId: ThreadId,
): OpenCodeSessionContext {
  const session = sessions.get(threadId);
  if (!session) {
    throw new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
    });
  }
  // `ensureSessionContext` is a sync gate used from both sync helpers and
  // Effect bodies. `Ref.getUnsafe` is an atomic read of the backing cell —
  // no fiber suspension required, which keeps this callable everywhere.
  if (Ref.getUnsafe(session.stopped)) {
    throw new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
    });
  }
  return session;
}

function normalizeQuestionRequest(request: QuestionRequest): ReadonlyArray<UserInputQuestion> {
  return request.questions.map((question, index) => ({
    id: openCodeQuestionId(index, question),
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
    ...(question.multiple ? { multiSelect: true } : {}),
  }));
}

function resolveTextStreamKind(part: Part | undefined): "assistant_text" | "reasoning_text" {
  return part?.type === "reasoning" ? "reasoning_text" : "assistant_text";
}

function textFromPart(part: Part): string | undefined {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text;
    default:
      return undefined;
  }
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function suffixPrefixOverlap(text: string, delta: string): number {
  const maxLength = Math.min(text.length, delta.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (text.endsWith(delta.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

function resolveLatestAssistantText(previousText: string | undefined, nextText: string): string {
  if (previousText && previousText.length > nextText.length && previousText.startsWith(nextText)) {
    return previousText;
  }
  return nextText;
}

export function mergeOpenCodeAssistantText(
  previousText: string | undefined,
  nextText: string,
): {
  readonly latestText: string;
  readonly deltaToEmit: string;
} {
  const latestText = resolveLatestAssistantText(previousText, nextText);
  return {
    latestText,
    deltaToEmit: latestText.slice(commonPrefixLength(previousText ?? "", latestText)),
  };
}

export function appendOpenCodeAssistantTextDelta(
  previousText: string,
  delta: string,
): {
  readonly nextText: string;
  readonly deltaToEmit: string;
} {
  const deltaToEmit = delta.slice(suffixPrefixOverlap(previousText, delta));
  return {
    nextText: previousText + deltaToEmit,
    deltaToEmit,
  };
}

function isoFromEpochMs(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(value).toISOString();
}

function messageRoleForPart(
  context: OpenCodeSessionContext,
  part: Pick<Part, "messageID" | "type">,
): "assistant" | "user" | undefined {
  const known = context.messageRoleById.get(part.messageID);
  if (known) {
    return known;
  }
  return part.type === "tool" ? "assistant" : undefined;
}

function detailFromToolPart(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "completed":
      return part.state.output;
    case "error":
      return part.state.error;
    case "running":
      return part.state.title;
    default:
      return undefined;
  }
}

function toolStateCreatedAt(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "running":
      return isoFromEpochMs(part.state.time.start);
    case "completed":
    case "error":
      return isoFromEpochMs(part.state.time.end);
    default:
      return undefined;
  }
}

function sessionErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "OpenCode session failed.";
  }
  const data = "data" in error && error.data && typeof error.data === "object" ? error.data : null;
  const message = data && "message" in data ? data.message : null;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : "OpenCode session failed.";
}

function updateProviderSession(
  context: OpenCodeSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): ProviderSession {
  const nextSession = {
    ...context.session,
    ...patch,
    updatedAt: nowIso(),
  } as ProviderSession & Record<string, unknown>;
  const mutableSession = nextSession as Record<string, unknown>;
  if (options?.clearActiveTurnId) {
    delete mutableSession.activeTurnId;
  }
  if (options?.clearLastError) {
    delete mutableSession.lastError;
  }
  context.session = nextSession;
  return nextSession;
}

const abortOpenCodeTree = Effect.fn("abortOpenCodeTree")(function* (
  context: OpenCodeSessionContext,
) {
  const ids = new Set([context.openCodeSessionId, ...context.relatedSessionIds]);
  let failure: OpenCodeRuntimeError | undefined;
  const abort = (sessionID: string) =>
    runOpenCodeSdk("session.abort", (signal) =>
      context.client.session.abort({ sessionID }, { signal }),
    ).pipe(
      Effect.timeout("5 seconds"),
      Effect.catch((cause) =>
        Effect.sync(() => {
          failure ??= new OpenCodeRuntimeError({
            operation: "session.abort",
            detail: openCodeRuntimeErrorDetail(cause),
            cause,
          });
        }),
      ),
    );
  // Stop the parent before enumerating children so it cannot keep spawning work.
  // A discovery failure must not prevent aborting sessions we already know about.
  yield* abort(context.openCodeSessionId);
  yield* Effect.gen(function* () {
    for (const sessionID of ids) {
      const children = yield* runOpenCodeSdk("session.children", (signal) =>
        context.client.session.children({ sessionID }, { signal }),
      ).pipe(
        Effect.timeout("5 seconds"),
        Effect.catch((cause) =>
          Effect.sync(() => {
            failure ??= new OpenCodeRuntimeError({
              operation: "session.children",
              detail: openCodeRuntimeErrorDetail(cause),
              cause,
            });
            return { data: [] };
          }),
        ),
      );
      for (const child of children.data ?? []) {
        if (ids.size >= 128 && !ids.has(child.id)) {
          failure ??= new OpenCodeRuntimeError({
            operation: "session.children",
            detail: "Too many OpenCode child sessions to stop safely.",
          });
          break;
        }
        ids.add(child.id);
      }
    }
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.catch((cause) =>
      Effect.sync(() => {
        failure ??= new OpenCodeRuntimeError({
          operation: "session.children",
          detail: "Timed out discovering OpenCode child sessions.",
          cause,
        });
      }),
    ),
  );
  yield* Effect.forEach(
    [...ids].filter((id) => id !== context.openCodeSessionId),
    abort,
    { concurrency: 4, discard: true },
  );
  if (failure) return yield* failure;
});

const stopOpenCodeContext = Effect.fn("stopOpenCodeContext")(function* (
  context: OpenCodeSessionContext,
) {
  // Race-safe one-shot: first caller flips the flag, everyone else no-ops.
  if (yield* Ref.getAndSet(context.stopped, true)) {
    return false;
  }

  // Best-effort remote abort. The scope close below tears down the local
  // handles (event-pump fiber, server-exit fiber, event-subscribe fetch),
  // but we still want to tell OpenCode that this session is done.
  yield* abortOpenCodeTree(context).pipe(Effect.ignore({ log: true }));

  // Closing the session scope interrupts every fiber forked into it and
  // runs each finalizer we registered — the `AbortController.abort()` call,
  // the child-process termination, etc.
  context.eventsAbortController.abort();
  yield* Scope.close(context.sessionScope, Exit.void);
  return true;
});

export function makeOpenCodeAdapter(
  openCodeSettings: OpenCodeSettings,
  options?: OpenCodeAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("opencode");
    const serverConfig = yield* ServerConfig;
    const openCodeRuntime = yield* OpenCodeRuntime;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    // Only close loggers we created. If the caller passed one in via
    // `options.nativeEventLogger`, they own its lifecycle.
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, OpenCodeSessionContext>();

    // Layer-level finalizer: when the adapter layer shuts down, stop every
    // session. Each session's `Scope.close` tears down its spawned OpenCode
    // server (via the `ChildProcessSpawner` finalizer installed in
    // `startOpenCodeServerProcess`) and interrupts the forked event/exit
    // fibers. Consumers that can't reason about Effect scopes therefore
    // cannot leak OpenCode child processes by forgetting to call `stopAll`.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        // `ignoreCause` swallows both typed failures (none here) and defects
        // from throwing scope finalizers so a sibling's death can't interrupt
        // the remaining cleanups.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
        // Close the logger AFTER session teardown so any final lifecycle
        // events emitted during shutdown still get written. `close` flushes
        // the `Logger.batched` window and closes each per-thread
        // `RotatingFileSink` handle owned by the logger's internal scope.
        if (managedNativeEventLogger !== undefined) {
          yield* managedNativeEventLogger.close();
        }
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
    const writeNativeEvent = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void);
    const writeNativeEventBestEffort = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => writeNativeEvent(threadId, event).pipe(Effect.catchCause(() => Effect.void));

    const emitUnexpectedExit = Effect.fn("emitUnexpectedExit")(function* (
      context: OpenCodeSessionContext,
      message: string,
    ) {
      // Atomic one-shot: two fibers can race here (the event-pump on stream
      // failure and the server-exit watcher). `getAndSet` flips the flag in
      // a single step so the loser observes `true` and returns; a plain
      // `Ref.get` would let both racers slip past and emit duplicates.
      if (yield* Ref.getAndSet(context.stopped, true)) {
        return;
      }
      const turnId = context.activeTurnId;
      sessions.delete(context.session.threadId);
      yield* settlePending(context);
      // Emit lifecycle events BEFORE tearing down the scope. Both call sites
      // run this inside a fiber forked via `Effect.forkIn(context.sessionScope)`;
      // closing that scope triggers the fiber-interrupt finalizer, so any
      // subsequent yield point would unwind and silently drop these emits.
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "runtime.error",
        payload: {
          message,
          class: "transport_error",
        },
      }).pipe(Effect.ignore);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "session.exited",
        payload: {
          reason: message,
          recoverable: false,
          exitKind: "error",
        },
      }).pipe(Effect.ignore);
      // Inline the teardown that `stopOpenCodeContext` would do; we can't
      // delegate to it because our `getAndSet` above already flipped the
      // one-shot guard, so the call would no-op.
      yield* abortOpenCodeTree(context).pipe(Effect.ignore({ log: true }));
      context.eventsAbortController.abort();
      yield* Scope.close(context.sessionScope, Exit.void);
    });

    /** Emit content.delta and item.completed events for an assistant text part. */
    const emitAssistantTextDelta = Effect.fn("emitAssistantTextDelta")(function* (
      context: OpenCodeSessionContext,
      part: Part,
      turnId: TurnId | undefined,
      raw: unknown,
    ) {
      const text = textFromPart(part);
      if (text === undefined) {
        return;
      }
      const previousText = context.emittedTextByPartId.get(part.id);
      const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text);
      context.emittedTextByPartId.set(part.id, latestText);
      if (latestText !== text) {
        context.partById.set(
          part.id,
          (part.type === "text" || part.type === "reasoning"
            ? { ...part, text: latestText }
            : part) satisfies Part,
        );
      }
      if (deltaToEmit.length > 0) {
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId: part.id,
            createdAt:
              part.type === "text" || part.type === "reasoning"
                ? isoFromEpochMs(part.time?.start)
                : undefined,
            raw,
          })),
          type: "content.delta",
          payload: {
            streamKind: resolveTextStreamKind(part),
            delta: deltaToEmit,
          },
        });
      }

      if (
        part.type === "text" &&
        part.time?.end !== undefined &&
        !context.completedAssistantPartIds.has(part.id)
      ) {
        context.completedAssistantPartIds.add(part.id);
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId: part.id,
            createdAt: isoFromEpochMs(part.time.end),
            raw,
          })),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            ...(latestText.length > 0 ? { detail: latestText } : {}),
          },
        });
      }
    });

    const isRelatedSession = Effect.fn("isRelatedSession")(function* (
      context: OpenCodeSessionContext,
      sessionId: string,
    ) {
      if (context.relatedSessionIds.has(sessionId)) return true;
      const path: string[] = [];
      let current: string | undefined = sessionId;
      while (current && path.length < 32 && !path.includes(current)) {
        if (context.relatedSessionIds.has(current)) {
          for (const id of path) context.relatedSessionIds.add(id);
          return true;
        }
        path.push(current);
        const session = yield* runOpenCodeSdk("session.get", (signal) =>
          context.client.session.get({ sessionID: current! }, { signal }),
        ).pipe(Effect.timeout("3 seconds"));
        current = session.data?.parentID;
      }
      return false;
    });

    const finishPermission = Effect.fn("finishPermission")(function* (
      context: OpenCodeSessionContext,
      requestID: string,
      decision: string,
    ) {
      if (context.resolvedRequestIds.has(requestID)) return;
      context.resolvedRequestIds.add(requestID);
      context.pendingPermissions.delete(requestID);
      if (context.autoRepliedRequestIds.delete(requestID)) return;
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          requestId: requestID,
        })),
        type: "request.resolved",
        payload: { requestType: "unknown", decision },
      });
    });
    const finishQuestion = Effect.fn("finishQuestion")(function* (
      context: OpenCodeSessionContext,
      requestID: string,
      answers: Record<string, string>,
    ) {
      if (context.resolvedRequestIds.has(requestID)) return;
      context.resolvedRequestIds.add(requestID);
      context.pendingQuestions.delete(requestID);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          requestId: requestID,
        })),
        type: "user-input.resolved",
        payload: { answers },
      });
    });
    const publishPermission = Effect.fn("publishPermission")(function* (
      context: OpenCodeSessionContext,
      request: PermissionRequest,
      raw: unknown,
    ) {
      const base = yield* buildEventBase({
        threadId: context.session.threadId,
        turnId: context.activeTurnId,
        requestId: request.id,
        raw,
      });
      const stopped = yield* Ref.get(context.stopped);
      if (
        stopped ||
        context.resolvedRequestIds.has(request.id) ||
        context.pendingPermissions.has(request.id)
      )
        return;
      context.pendingPermissions.set(request.id, request);
      Queue.offerUnsafe(runtimeEvents, {
        ...base,
        type: "request.opened",
        payload: {
          requestType: mapPermissionToRequestType(request.permission),
          detail: request.patterns.join("\n") || request.permission,
          args: request.metadata,
        },
      });
    });

    const settlePending = Effect.fn("settlePending")(function* (context: OpenCodeSessionContext) {
      for (const id of context.autoRepliedRequestIds) context.resolvedRequestIds.add(id);
      context.autoRepliedRequestIds.clear();
      for (const id of context.pendingPermissions.keys())
        yield* finishPermission(context, id, "cancel");
      for (const id of context.pendingQuestions.keys()) yield* finishQuestion(context, id, {});
    });

    const handleSubscribedEvent = Effect.fn("handleSubscribedEvent")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeSubscribedEvent,
    ) {
      const properties = event.properties as {
        sessionID?: unknown;
        info?: { sessionID?: string };
        part?: { sessionID?: string };
      };
      const payloadSessionId =
        properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID;
      if (typeof payloadSessionId !== "string") return;
      const requestEvent =
        event.type.startsWith("permission.") || event.type.startsWith("question.");
      if (
        payloadSessionId !== context.openCodeSessionId &&
        (!requestEvent ||
          !(yield* isRelatedSession(context, payloadSessionId).pipe(
            Effect.orElseSucceed(() => false),
          )))
      )
        return;

      const turnId = context.activeTurnId;
      yield* writeNativeEventBestEffort(context.session.threadId, {
        observedAt: nowIso(),
        event: {
          provider: PROVIDER,
          threadId: context.session.threadId,
          providerThreadId: context.openCodeSessionId,
          type: event.type,
          ...(turnId ? { turnId } : {}),
          payload: event,
        },
      });

      switch (event.type) {
        case "message.updated": {
          context.messageRoleById.set(event.properties.info.id, event.properties.info.role);
          if (event.properties.info.role === "assistant") {
            for (const part of context.partById.values()) {
              if (part.messageID !== event.properties.info.id) {
                continue;
              }
              yield* emitAssistantTextDelta(context, part, turnId, event);
            }
          }
          break;
        }

        case "message.removed": {
          context.messageRoleById.delete(event.properties.messageID);
          break;
        }

        case "message.part.delta": {
          const existingPart = context.partById.get(event.properties.partID);
          if (!existingPart) {
            break;
          }
          const role = messageRoleForPart(context, existingPart);
          if (role !== "assistant") {
            break;
          }
          const streamKind = resolveTextStreamKind(existingPart);
          const delta = event.properties.delta;
          if (delta.length === 0) {
            break;
          }
          const previousText =
            context.emittedTextByPartId.get(event.properties.partID) ??
            textFromPart(existingPart) ??
            "";
          const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(previousText, delta);
          if (deltaToEmit.length === 0) {
            break;
          }
          context.emittedTextByPartId.set(event.properties.partID, nextText);
          if (existingPart.type === "text" || existingPart.type === "reasoning") {
            context.partById.set(event.properties.partID, {
              ...existingPart,
              text: nextText,
            });
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: event.properties.partID,
              raw: event,
            })),
            type: "content.delta",
            payload: {
              streamKind,
              delta: deltaToEmit,
            },
          });
          break;
        }

        case "message.part.updated": {
          const part = event.properties.part;
          context.partById.set(part.id, part);
          const messageRole = messageRoleForPart(context, part);

          if (messageRole === "assistant") {
            yield* emitAssistantTextDelta(context, part, turnId, event);
          }

          if (part.type === "tool") {
            const itemType = toToolLifecycleItemType(part.tool);
            const title =
              part.state.status === "running" ? (part.state.title ?? part.tool) : part.tool;
            const detail = detailFromToolPart(part);
            const payload = {
              itemType,
              ...(part.state.status === "error"
                ? { status: "failed" as const }
                : part.state.status === "completed"
                  ? { status: "completed" as const }
                  : { status: "inProgress" as const }),
              ...(title ? { title } : {}),
              ...(detail ? { detail } : {}),
              data: {
                tool: part.tool,
                state: part.state,
              },
            };
            const runtimeEvent: ProviderRuntimeEvent = {
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: part.callID,
                createdAt: toolStateCreatedAt(part),
                raw: event,
              })),
              type:
                part.state.status === "pending"
                  ? "item.started"
                  : part.state.status === "completed" || part.state.status === "error"
                    ? "item.completed"
                    : "item.updated",
              payload,
            };
            appendTurnItem(context, turnId, part);
            yield* emit(runtimeEvent);
          }
          break;
        }

        case "permission.asked": {
          if (
            context.resolvedRequestIds.has(event.properties.id) ||
            context.pendingPermissions.has(event.properties.id) ||
            context.autoRepliedRequestIds.has(event.properties.id)
          )
            break;
          if (context.session.runtimeMode === "full-access" && !context.workflowExecutionProfile) {
            context.autoRepliedRequestIds.add(event.properties.id);
            // Do not block the event pump while the HTTP response waits for event consumption.
            yield* runOpenCodeSdk("permission.reply", (signal) =>
              context.client.permission.reply(
                { requestID: event.properties.id, reply: "once" },
                { signal },
              ),
            ).pipe(
              Effect.timeout("10 seconds"),
              Effect.matchEffect({
                onSuccess: () => finishPermission(context, event.properties.id, "accept"),
                onFailure: () =>
                  Effect.gen(function* () {
                    context.autoRepliedRequestIds.delete(event.properties.id);
                    yield* publishPermission(context, event.properties, event);
                  }),
              }),
              Effect.forkIn(context.sessionScope),
            );
            break;
          }
          yield* publishPermission(context, event.properties, event);
          break;
        }

        case "permission.replied": {
          yield* finishPermission(
            context,
            event.properties.requestID,
            mapPermissionDecision(event.properties.reply),
          );
          break;
        }

        case "question.asked": {
          const base = yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            requestId: event.properties.id,
            raw: event,
          });
          const stopped = yield* Ref.get(context.stopped);
          if (
            stopped ||
            context.resolvedRequestIds.has(event.properties.id) ||
            context.pendingQuestions.has(event.properties.id)
          )
            break;
          context.pendingQuestions.set(event.properties.id, event.properties);
          Queue.offerUnsafe(runtimeEvents, {
            ...base,
            type: "user-input.requested",
            payload: {
              questions: normalizeQuestionRequest(event.properties),
            },
          });
          break;
        }

        case "question.replied": {
          const request = context.pendingQuestions.get(event.properties.requestID);
          context.pendingQuestions.delete(event.properties.requestID);
          const answers = Object.fromEntries(
            (request?.questions ?? []).map((question, index) => [
              openCodeQuestionId(index, question),
              event.properties.answers[index]?.join(", ") ?? "",
            ]),
          );
          yield* finishQuestion(context, event.properties.requestID, answers);
          break;
        }
        case "question.rejected": {
          yield* finishQuestion(context, event.properties.requestID, {});
          break;
        }

        case "session.status": {
          if (event.properties.status.type === "busy" && turnId) {
            updateProviderSession(context, {
              status: "running",
              activeTurnId: turnId,
            });
          }

          if (event.properties.status.type === "retry") {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              })),
              type: "runtime.warning",
              payload: {
                message: event.properties.status.message,
                detail: event.properties.status,
              },
            });
            break;
          }

          if (event.properties.status.type === "idle" && turnId) {
            yield* settlePending(context);
            context.activeTurnId = undefined;
            updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              })),
              type: "turn.completed",
              payload: {
                state: "completed",
              },
            });
          }
          break;
        }

        case "session.error": {
          const message = sessionErrorMessage(event.properties.error);
          const activeTurnId = context.activeTurnId;
          context.activeTurnId = undefined;
          updateProviderSession(
            context,
            {
              status: "error",
              lastError: message,
            },
            { clearActiveTurnId: true },
          );
          if (activeTurnId) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId: activeTurnId,
                raw: event,
              })),
              type: "turn.completed",
              payload: {
                state: "failed",
                errorMessage: message,
              },
            });
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              raw: event,
            })),
            type: "runtime.error",
            payload: {
              message,
              class: "provider_error",
              detail: event.properties.error,
            },
          });
          break;
        }

        default:
          break;
      }
    });

    const startEventPump = Effect.fn("startEventPump")(function* (context: OpenCodeSessionContext) {
      // One AbortController per session scope. The finalizer fires when
      // the scope closes (explicit stop, unexpected exit, or layer
      // shutdown) and cancels the in-flight `event.subscribe` fetch so
      // the async iterable unwinds cleanly.
      const eventsAbortController = context.eventsAbortController;
      yield* Scope.addFinalizer(
        context.sessionScope,
        Effect.sync(() => eventsAbortController.abort()),
      );

      // Fibers forked into `context.sessionScope` are interrupted
      // automatically when the scope closes — no bookkeeping required.
      yield* Effect.flatMap(
        runOpenCodeSdk("event.subscribe", () =>
          context.client.event.subscribe(undefined, {
            signal: eventsAbortController.signal,
          }),
        ),
        (subscription) =>
          Stream.fromAsyncIterable(
            subscription.stream,
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "event.subscribe",
                detail: openCodeRuntimeErrorDetail(cause),
                cause,
              }),
          ).pipe(Stream.runForEach((event) => handleSubscribedEvent(context, event))),
      ).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            // Expected paths: caller aborted the fetch or the session
            // has already been marked stopped. Treat as a clean exit.
            if (eventsAbortController.signal.aborted || (yield* Ref.get(context.stopped))) {
              return;
            }
            yield* emitUnexpectedExit(
              context,
              Exit.isFailure(exit)
                ? openCodeRuntimeErrorDetail(Cause.squash(exit.cause))
                : "OpenCode event stream closed unexpectedly. Start a new turn to reconnect.",
            );
          }),
        ),
        Effect.forkIn(context.sessionScope),
      );

      // Recover approval/question asks lost across an SSE reconnect. Completed IDs
      // remain terminal, so polling cannot reopen an answered request.
      yield* Effect.gen(function* () {
        const permissions = yield* runOpenCodeSdk("permission.list", (signal) =>
          context.client.permission.list(undefined, { signal }),
        );
        for (const request of permissions.data ?? [])
          yield* handleSubscribedEvent(context, { type: "permission.asked", properties: request });
        const questions = yield* runOpenCodeSdk("question.list", (signal) =>
          context.client.question.list(undefined, { signal }),
        );
        for (const request of questions.data ?? [])
          yield* handleSubscribedEvent(context, { type: "question.asked", properties: request });
      }).pipe(
        Effect.timeout("4 seconds"),
        Effect.ignore({ log: true }),
        Effect.repeat(Schedule.spaced("5 seconds")),
        Effect.delay("5 seconds"),
        Effect.forkIn(context.sessionScope),
      );

      if (!context.server.external && context.server.exitCode !== null) {
        yield* context.server.exitCode.pipe(
          Effect.flatMap((code) =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return;
              }
              yield* emitUnexpectedExit(context, `OpenCode server exited unexpectedly (${code}).`);
            }),
          ),
          Effect.forkIn(context.sessionScope),
        );
      }
    });

    const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
        const binaryPath = openCodeSettings.binaryPath;
        const serverUrl = openCodeSettings.serverUrl;
        const serverPassword = openCodeSettings.serverPassword;
        const directory = input.cwd ?? serverConfig.cwd;
        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* stopOpenCodeContext(existing);
          sessions.delete(input.threadId);
        }

        const started = yield* Effect.gen(function* () {
          const sessionScope = yield* Scope.make();
          const startedExit = yield* Effect.exit(
            Effect.gen(function* () {
              // The runtime binds the server's lifetime to the Scope.Scope
              // we provide below — closing `sessionScope` kills the child
              // process automatically. No manual `server.close()` needed.
              const server = yield* openCodeRuntime.connectToOpenCodeServer({
                binaryPath,
                serverUrl,
                ...(options?.environment ? { environment: options.environment } : {}),
              });
              const client = openCodeRuntime.createOpenCodeSdkClient({
                baseUrl: server.url,
                directory,
                ...(server.external && serverPassword ? { serverPassword } : {}),
              });
              const openCodeSession = yield* runOpenCodeSdk("session.create", () =>
                client.session.create({
                  title: `T3 Code ${input.threadId}`,
                  permission: input.workflowExecutionProfile
                    ? buildOpenCodeWorkflowPermissionRules(input.workflowExecutionProfile)
                    : buildOpenCodePermissionRules(input.runtimeMode),
                }),
              );
              if (!openCodeSession.data) {
                return yield* new OpenCodeRuntimeError({
                  operation: "session.create",
                  detail: "OpenCode session.create returned no session payload.",
                });
              }
              return {
                sessionScope,
                server,
                client,
                openCodeSession: openCodeSession.data,
              };
            }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
          );
          if (Exit.isFailure(startedExit)) {
            yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
            return yield* toProcessError(input.threadId, Cause.squash(startedExit.cause));
          }
          return startedExit.value;
        });

        // Guard against a concurrent startSession call that may have raced
        // and already inserted a session while we were awaiting async work.
        const raceWinner = sessions.get(input.threadId);
        if (raceWinner) {
          // Another call won the race – clean up the session we just created
          // (including the remote SDK session) and return the existing one.
          yield* runOpenCodeSdk("session.abort", () =>
            started.client.session.abort({
              sessionID: started.openCodeSession.id,
            }),
          ).pipe(Effect.ignore);
          yield* Scope.close(started.sessionScope, Exit.void).pipe(Effect.ignore);
          return raceWinner.session;
        }

        const createdAt = nowIso();
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: directory,
          ...(input.modelSelection
            ? { model: input.modelSelection.model }
            : input.model
              ? { model: input.model }
              : {}),
          threadId: input.threadId,
          createdAt,
          updatedAt: createdAt,
        };

        const context: OpenCodeSessionContext = {
          session,
          client: started.client,
          server: started.server,
          directory,
          openCodeSessionId: started.openCodeSession.id,
          relatedSessionIds: new Set([started.openCodeSession.id]),
          resolvedRequestIds: new Set(),
          autoRepliedRequestIds: new Set(),
          workflowExecutionProfile: input.workflowExecutionProfile,
          pendingPermissions: new Map(),
          pendingQuestions: new Map(),
          partById: new Map(),
          emittedTextByPartId: new Map(),
          messageRoleById: new Map(),
          completedAssistantPartIds: new Set(),
          turns: [],
          activeTurnId: undefined,
          activeAgent: undefined,
          activeVariant: undefined,
          stopped: yield* Ref.make(false),
          sessionScope: started.sessionScope,
          eventsAbortController: new AbortController(),
        };
        sessions.set(input.threadId, context);
        yield* startEventPump(context);

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: {
            message: "OpenCode session started",
          },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: {
            providerThreadId: started.openCodeSession.id,
          },
        });

        const skills = yield* loadOpenCodeSkills(started.client).pipe(
          Effect.orElseSucceed(() => []),
        );
        if (yield* Ref.get(context.stopped)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "OpenCode exited during session startup.",
          });
        }
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.configured",
          payload: {
            config: {
              slashCommands: normalizeSupportedSlashCommands(
                skills.map((skill) => ({
                  name: skill.name,
                  description: skill.description ?? `Use ${skill.name}`,
                })),
              ),
            },
          },
        });

        return session;
      },
    );

    const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const context = ensureSessionContext(sessions, input.threadId);
      const turnId = TurnId.make(`opencode-turn-${yield* Random.nextUUIDv4}`);
      const modelSelection =
        input.modelSelection ??
        (input.model ? { instanceId: boundInstanceId, model: input.model } : undefined) ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `OpenCode model selection is bound to instance '${modelSelection?.instanceId}', expected '${boundInstanceId}'.`,
        });
      }
      const parsedModel = parseOpenCodeModelSlug(modelSelection?.model);
      if (!parsedModel) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode model selection must use the 'provider/model' format.",
        });
      }

      const text = input.input?.trim();
      const attachmentContext = buildProviderAttachmentRuntimeContext(
        input.resolvedAttachments ?? [],
      );
      const fileParts = toOpenCodeFileParts({
        attachments: input.attachments,
        resolveAttachmentPath: (attachment) =>
          resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          }),
      });
      if ((!text || text.length === 0) && fileParts.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode turns require text input or at least one attachment.",
        });
      }

      const agent = getModelSelectionStringOptionValue(modelSelection, "agent");
      const variant = getModelSelectionStringOptionValue(modelSelection, "variant");

      context.workflowExecutionProfile = input.workflowExecutionProfile;
      context.activeTurnId = turnId;
      context.activeAgent = input.workflowExecutionProfile
        ? "plan"
        : (agent ?? (input.interactionMode === "plan" ? "plan" : undefined));
      context.activeVariant = variant;
      updateProviderSession(
        context,
        {
          status: "running",
          activeTurnId: turnId,
          model: modelSelection?.model ?? context.session.model,
        },
        { clearLastError: true },
      );

      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
        type: "turn.started",
        payload: {
          model: modelSelection?.model ?? context.session.model,
          ...(variant ? { effort: variant } : {}),
        },
      });

      yield* runOpenCodeSdk("session.promptAsync", () =>
        context.client.session.promptAsync({
          sessionID: context.openCodeSessionId,
          model: parsedModel,
          ...(context.activeAgent ? { agent: context.activeAgent } : {}),
          ...(context.activeVariant ? { variant: context.activeVariant } : {}),
          parts: [
            ...(text ? [{ type: "text" as const, text }] : []),
            ...(attachmentContext ? [{ type: "text" as const, text: attachmentContext }] : []),
            ...fileParts,
          ],
        }),
      ).pipe(
        Effect.mapError(toRequestError),
        // On failure: clear active-turn state, flip the session back to ready
        // with lastError set, emit turn.aborted, then let the typed error
        // propagate. We don't need to rebuild the error here — `toRequestError`
        // already produced the right shape.
        Effect.tapError((requestError) =>
          Effect.gen(function* () {
            context.activeTurnId = undefined;
            context.activeAgent = undefined;
            context.activeVariant = undefined;
            updateProviderSession(
              context,
              {
                status: "ready",
                model: modelSelection?.model ?? context.session.model,
                lastError: requestError.detail,
              },
              { clearActiveTurnId: true },
            );
            yield* emit({
              ...(yield* buildEventBase({
                threadId: input.threadId,
                turnId,
              })),
              type: "turn.aborted",
              payload: {
                reason: requestError.detail,
              },
            });
          }),
        ),
      );

      return {
        threadId: input.threadId,
        turnId,
      };
    });

    const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId, turnId) {
        const context = ensureSessionContext(sessions, threadId);
        if (turnId && context.activeTurnId !== turnId) return;
        const interruptedTurnId = context.activeTurnId;
        yield* abortOpenCodeTree(context).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.abort",
                detail: openCodeRuntimeErrorDetail(cause),
                cause,
              }),
          ),
        );
        if (context.activeTurnId !== interruptedTurnId || (yield* Ref.get(context.stopped))) return;
        yield* settlePending(context);
        context.activeTurnId = undefined;
        updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
        if (interruptedTurnId) {
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId: interruptedTurnId,
            })),
            type: "turn.aborted",
            payload: {
              reason: "Interrupted by user.",
            },
          });
        }
      },
    );

    const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = Effect.fn(
      "respondToRequest",
    )(function* (threadId, requestId, decision) {
      const context = ensureSessionContext(sessions, threadId);
      if (!context.pendingPermissions.has(requestId)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "permission.reply",
          detail: `Unknown pending permission request: ${requestId}`,
        });
      }

      yield* runOpenCodeSdk("permission.reply", () =>
        context.client.permission.reply({
          requestID: requestId,
          reply: toOpenCodePermissionReply(decision),
        }),
      ).pipe(Effect.mapError(toRequestError));
      yield* finishPermission(context, requestId, decision);
    });

    const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = Effect.fn(
      "respondToUserInput",
    )(function* (threadId, requestId, answers) {
      const context = ensureSessionContext(sessions, threadId);
      const request = context.pendingQuestions.get(requestId);
      if (!request) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "question.reply",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }

      yield* runOpenCodeSdk("question.reply", () =>
        context.client.question.reply({
          requestID: requestId,
          answers: toOpenCodeQuestionAnswers(request, answers),
        }),
      ).pipe(Effect.mapError(toRequestError));
      yield* finishQuestion(
        context,
        requestId,
        Object.fromEntries(
          Object.entries(answers).map(([key, value]) => [
            key,
            typeof value === "string" ? value : Array.isArray(value) ? value.join(", ") : "",
          ]),
        ),
      );
    });

    const stopSession: OpenCodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        yield* settlePending(context);
        const stopped = yield* stopOpenCodeContext(context);
        sessions.delete(threadId);
        if (!stopped) {
          return;
        }
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited",
          payload: {
            reason: "Session stopped.",
            recoverable: false,
            exitKind: "graceful",
          },
        });
      },
    );

    const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((context) => context.session));

    const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: OpenCodeAdapterShape["readThread"] = Effect.fn("readThread")(
      function* (threadId) {
        const context = ensureSessionContext(sessions, threadId);
        const session = yield* runOpenCodeSdk("session.get", () =>
          context.client.session.get({ sessionID: context.openCodeSessionId }),
        ).pipe(Effect.mapError(toRequestError));
        const messages = yield* runOpenCodeSdk("session.messages", () =>
          context.client.session.messages({ sessionID: context.openCodeSessionId }),
        ).pipe(Effect.mapError(toRequestError));
        const turns: Array<OpenCodeTurnSnapshot> = [];
        for (const entry of messages.data ?? []) {
          if (entry.info.id === session.data?.revert?.messageID) break;
          if (entry.info.role === "assistant")
            turns.push({ id: TurnId.make(entry.info.id), items: [entry.info, ...entry.parts] });
        }
        return { threadId, turns };
      },
    );

    const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
      function* (threadId, numTurns) {
        const context = ensureSessionContext(sessions, threadId);
        const snapshot = yield* readThread(threadId);
        const target = snapshot.turns[Math.max(0, snapshot.turns.length - numTurns)];
        if (!target) return snapshot;
        yield* runOpenCodeSdk("session.revert", () =>
          context.client.session.revert({
            sessionID: context.openCodeSessionId,
            messageID: target.id,
          }),
        ).pipe(Effect.mapError(toRequestError));
        return yield* readThread(threadId);
      },
    );

    const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        // `stopOpenCodeContext` is typed as never-failing — SDK aborts are
        // already `Effect.ignore`'d inside it. `ignoreCause` here also
        // swallows defects from throwing finalizers so one bad close can't
        // interrupt the sibling fibers. Same pattern as the layer finalizer.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies OpenCodeAdapterShape;
  });
}
