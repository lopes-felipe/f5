/**
 * MuseAdapter — F5 provider adapter for Muse Code over the Muse Session
 * Protocol (MSP), through Meta's `@muse-code/sdk`.
 *
 * One `muse serve` host per thread session. The SDK's `MuseClient` opens and
 * resumes sessions and folds the event stream (revisions, deltas, gap
 * splice-fill); this adapter projects folded state onto F5 runtime events,
 * enforces the permission read-back, and owns approvals and user input.
 *
 * This is Muse Code, Meta's coding CLI — not the Muse personal agent.
 *
 * @module provider/Layers/MuseAdapter
 */
import { randomUUID } from "node:crypto";
import * as nodePath from "node:path";

import {
  MuseGapFillError,
  MuseSessionDiscardedError,
  type Session as MspSession,
  type SessionDurabilityProfile,
} from "@muse-code/sdk";
import type {
  ApprovalRequestParams,
  ApprovalResolvedParams,
  ApprovalUpdatedParams,
  Item,
  Notification,
  SessionReadResult,
  TurnInputPart,
  UserInputRequestParams,
  UserInputSettledParams,
} from "@muse-code/sdk/dist/src/msp.js";
import {
  ApprovalRequestId,
  EventId,
  type MuseSettings,
  type ProviderApprovalDecision,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { MUSE_SERVE_ARGS } from "@t3tools/shared/museProtocolManifest";
import { providerRuntimeCapabilities } from "@t3tools/shared/providerRuntimeCapabilities";
import { runtimeModeUnsupportedReason } from "@t3tools/shared/runtimeMode";
import {
  Data,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  PubSub,
  Queue,
  Random,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { buildProviderAttachmentRuntimeContext } from "../attachmentRuntimeContext.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  classifyMspDelivery,
  describeMspError,
  isMuseRuntimeMode,
  MSP_REQUEST_TIMEOUT_MS,
  MSP_TURN_START_TIMEOUT_MS,
  type MspHost,
  mspErrorKind,
  type MuseRuntimeMode,
  openMspHost,
  verifyMusePermissionState,
} from "../msp/MspSessionRuntime.ts";
import { makeMspTransport } from "../msp/MspTransport.ts";
import {
  decodeMuseApproval,
  mapMuseApprovalChoices,
  museAnswers,
  museApprovalDetail,
  museApprovalOptions,
  museApprovalRequestId,
  museDeltaStreamKind,
  type MuseMappedChoice,
  museQuestions,
  museRequestType,
  museTodoPlan,
  museTurnState,
  projectMuseItem,
  salvageMuseDeny,
} from "../msp/MuseEventMapping.ts";
import { memoryNativeCommandIdStore, type NativeCommandIdStore } from "../msp/nativeCommandIds.ts";
import { type MuseAdapterShape } from "../Services/MuseAdapter.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "muse" as const;
const MUSE_RESUME_VERSION = 1 as const;
const CURSOR_PERSIST_INTERVAL_MS = 5_000;
const CANCEL_SETTLE_TIMEOUT_MS = 10_000;
const DEFAULT_REASONING_EFFORT = "high";
/** How long a splice-fill may run before F5 stops waiting to reconcile it. */
const GAP_FILL_WAIT_MS = 60_000;
const GAP_FILL_POLL_MS = 25;
/** Settled ids kept for duplicate suppression; older ones are dropped first. */
const MAX_REMEMBERED_IDS = 5_000;
const RESUME_HYDRATION_KINDS = new Set([
  "boundaryPruned",
  "boundaryUnusable",
  "noBoundary",
  "viewTruncated",
]);

/** A rejected SDK promise, kept whole so callers can classify it. */
class MuseCallFailure extends Data.TaggedError("MuseCallFailure")<{ readonly cause: unknown }> {}

export interface MuseResumeCursor {
  readonly schemaVersion: typeof MUSE_RESUME_VERSION;
  readonly mspSessionId: string;
  readonly viewCursor: string | null;
  readonly durability: SessionDurabilityProfile["kind"];
}

export function parseMuseResumeCursor(raw: unknown): MuseResumeCursor | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== MUSE_RESUME_VERSION) return undefined;
  if (typeof record.mspSessionId !== "string" || !record.mspSessionId) return undefined;
  const durability =
    record.durability === "ephemeral" || record.durability === "unrecognized"
      ? record.durability
      : "durable";
  return {
    schemaVersion: MUSE_RESUME_VERSION,
    mspSessionId: record.mspSessionId,
    viewCursor: typeof record.viewCursor === "string" ? record.viewCursor : null,
    durability,
  };
}

/** The opened host plus what the adapter needs from its process. */
export interface MuseHostHandle {
  readonly host: MspHost;
  readonly stderrTail: () => string;
}

export interface MuseAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly nativeCommandIds?: NativeCommandIdStore;
  readonly clientVersion?: string;
  /** Deadline for `session/start` and `session/resume`; defaults to the MSP request timeout. */
  readonly sessionOpenTimeoutMs?: number;
  /** Test seam: open a host in the given scope instead of spawning `muse serve`. */
  readonly openHost?: (input: {
    readonly cwd: string;
  }) => Effect.Effect<MuseHostHandle, ProviderAdapterProcessError, Scope.Scope>;
}

interface PendingMuseApproval {
  readonly requestId: ApprovalRequestId;
  readonly approvalId: string;
  readonly params: ApprovalRequestParams;
  readonly choices: ReadonlyArray<MuseMappedChoice>;
}

interface MuseSessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly handle: MuseHostHandle;
  readonly mspSessionId: string;
  readonly runtimeMode: MuseRuntimeMode;
  readonly notifications: Queue.Queue<Notification | AdapterSignal>;
  mspSession: MspSession;
  session: ProviderSession;
  viewCursor: string | null;
  lastCursorPersistAt: number;
  activeTurnId: string | undefined;
  currentModelId: string | undefined;
  currentEffort: string | undefined;
  stopped: boolean;
  diverged: boolean;
  readonly turnSettleWaiters: Map<string, Set<() => void>>;
  readonly projectedRevisions: Map<string, number>;
  readonly completedItems: Set<string>;
  readonly streamedText: Map<string, string>;
  readonly approvals: Map<ApprovalRequestId, PendingMuseApproval>;
  readonly approvalRequestByApprovalId: Map<string, ApprovalRequestId>;
  readonly settledApprovalRequests: Set<ApprovalRequestId>;
  readonly userInputs: Map<ApprovalRequestId, UserInputRequestParams>;
  readonly settledUserInputs: Set<string>;
  gapReconcilePending: boolean;
  readonly declinedRetracts: Set<string>;
}

/** Adapter-internal entries on the notification queue, processed in order with host frames. */
type AdapterSignal = { readonly method: "$gapError" } | { readonly method: "$gapFilled" };

/** Records an id, dropping the oldest once the set is full. */
function remember<A>(set: Set<A>, value: A): void {
  set.delete(value);
  set.add(value);
  while (set.size > MAX_REMEMBERED_IDS) {
    const oldest = set.values().next();
    if (oldest.done) return;
    set.delete(oldest.value);
  }
}

function selectionValue(
  options: ReadonlyArray<{ readonly id: string; readonly value: unknown }> | undefined,
  id: string,
): string | undefined {
  const value = options?.find((option) => option.id === id)?.value;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function makeMuseAdapter(museSettings: MuseSettings, options?: MuseAdapterOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make(PROVIDER);
    const fileSystem = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const environment = options?.environment ?? process.env;
    const nativeCommandIds = options?.nativeCommandIds ?? memoryNativeCommandIdStore();
    const nativeEventLogger = options?.nativeEventLogger;
    const sessions = new Map<ThreadId, MuseSessionContext>();
    const threadLocks = new Map<string, Semaphore.Semaphore>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const offer = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const stamp = (threadId: ThreadId, turnId?: string) =>
      Effect.gen(function* () {
        return {
          eventId: EventId.make(yield* Random.nextUUIDv4),
          createdAt: yield* nowIso,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId,
          ...(turnId ? { turnId: TurnId.make(turnId) } : {}),
        };
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        let semaphore = threadLocks.get(threadId);
        if (!semaphore) {
          semaphore = Semaphore.makeUnsafe(1);
          threadLocks.set(threadId, semaphore);
        }
        return semaphore.withPermit(effect);
      });

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      nativeEventLogger
        ? Effect.suspend(() => {
            const observedAt = new Date().toISOString();
            return nativeEventLogger.write(
              {
                observedAt,
                event: {
                  id: randomUUID(),
                  kind: "notification",
                  provider: PROVIDER,
                  createdAt: observedAt,
                  method,
                  threadId,
                  payload,
                },
              },
              threadId,
            );
          })
        : Effect.void;

    const requestError = (method: string, error: unknown, prefix?: string) => {
      const classification = classifyMspDelivery(error);
      return new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: `${prefix ? `${prefix} ` : ""}${describeMspError(error)}`,
        ...(classification.certainty === "not_sent"
          ? {
              deliveryCertainty: "not_sent" as const,
              deliveryRetryable: classification.retryable,
            }
          : {}),
        cause: error,
      });
    };

    const call = <A>(method: string, run: () => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: (error) => requestError(method, error) });

    const resumeCursorOf = (ctx: MuseSessionContext): MuseResumeCursor => ({
      schemaVersion: MUSE_RESUME_VERSION,
      mspSessionId: ctx.mspSessionId,
      viewCursor: ctx.viewCursor,
      durability: ctx.handle.host.durability.kind,
    });

    /** Attach the cursor at turn ends and at most every 5 s while streaming. */
    const cursorField = (ctx: MuseSessionContext, force: boolean) => {
      const now = Date.now();
      if (!force && now - ctx.lastCursorPersistAt < CURSOR_PERSIST_INTERVAL_MS) return {};
      ctx.lastCursorPersistAt = now;
      const resumeCursor = resumeCursorOf(ctx);
      ctx.session = { ...ctx.session, resumeCursor };
      return { resumeCursor };
    };

    const requireSession = (threadId: ThreadId) => {
      const ctx = sessions.get(threadId);
      return !ctx || ctx.stopped
        ? Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }))
        : Effect.succeed(ctx);
    };

    /** A session whose permissions diverged is stopping and takes no new work or decisions. */
    const requireUsableSession = (threadId: ThreadId, method: string) =>
      Effect.flatMap(requireSession(threadId), (ctx) =>
        ctx.diverged
          ? Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method,
                detail: "Muse Code permissions changed; the session is stopping.",
                deliveryCertainty: "not_sent",
                deliveryRetryable: false,
              }),
            )
          : Effect.succeed(ctx),
      );

    /**
     * A failure before `turn/start` was written: the turn provably never
     * reached the host. Timeouts and transport losses may be retried; an
     * answer the host gave (an unknown model, say) may not.
     */
    const beforeTurnStart = (error: ProviderAdapterRequestError): ProviderAdapterRequestError => {
      if (error.deliveryCertainty) return error;
      const classification = classifyMspDelivery(error.cause);
      return new ProviderAdapterRequestError({
        provider: error.provider,
        method: error.method,
        detail: error.detail,
        deliveryCertainty: "not_sent",
        deliveryRetryable:
          classification.certainty === "not_sent"
            ? classification.retryable
            : classification.certainty === "ambiguous",
        ...(error.cause !== undefined ? { cause: error.cause } : {}),
      });
    };

    const settleTurnWaiters = (ctx: MuseSessionContext, turnId: string) => {
      const waiters = ctx.turnSettleWaiters.get(turnId);
      ctx.turnSettleWaiters.delete(turnId);
      for (const resolve of waiters ?? []) resolve();
    };

    /** Resolves when the turn completes or is retracted, or after the timeout. */
    const awaitTurnSettled = (ctx: MuseSessionContext, turnId: string, timeoutMs: number) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            if (ctx.activeTurnId !== turnId) return resolve();
            const timer = setTimeout(resolve, timeoutMs);
            timer.unref?.();
            const waiters = ctx.turnSettleWaiters.get(turnId) ?? new Set<() => void>();
            waiters.add(() => {
              clearTimeout(timer);
              resolve();
            });
            ctx.turnSettleWaiters.set(turnId, waiters);
          }),
      );

    const stopSessionInternal = (
      ctx: MuseSessionContext,
      exit: { readonly exitKind: "graceful" | "error"; readonly reason?: string },
    ) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        if (sessions.get(ctx.threadId) === ctx) sessions.delete(ctx.threadId);
        for (const pending of ctx.approvals.values()) {
          yield* offer({
            type: "request.resolved",
            ...(yield* stamp(ctx.threadId, pending.params.turnId)),
            requestId: RuntimeRequestId.make(pending.requestId),
            payload: { requestType: museRequestType(pending.params), decision: "cancel" },
          });
        }
        ctx.approvals.clear();
        for (const requestId of ctx.userInputs.keys()) {
          yield* offer({
            type: "user-input.resolved",
            ...(yield* stamp(ctx.threadId, ctx.activeTurnId)),
            requestId: RuntimeRequestId.make(requestId),
            payload: { answers: {}, receipt: "cancelled" },
          });
        }
        ctx.userInputs.clear();
        if (ctx.activeTurnId) {
          const turnId = ctx.activeTurnId;
          ctx.activeTurnId = undefined;
          settleTurnWaiters(ctx, turnId);
          yield* offer({
            type: "turn.completed",
            ...(yield* stamp(ctx.threadId, turnId)),
            payload: {
              state: exit.exitKind === "error" ? "failed" : "cancelled",
              stopReason: exit.exitKind === "error" ? "error" : "cancelled",
              ...(exit.reason ? { errorMessage: exit.reason } : {}),
            },
          });
        }
        yield* offer({
          type: "session.exited",
          ...(yield* stamp(ctx.threadId)),
          resumeCursor: resumeCursorOf(ctx),
          payload: {
            exitKind: exit.exitKind,
            ...(exit.reason ? { reason: exit.reason } : {}),
            recoverable: ctx.handle.host.durability.kind === "durable",
          },
        });
        yield* Queue.shutdown(ctx.notifications);
        yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore, Effect.forkDetach);
      });

    /**
     * Mark the session diverged (no new turns or decisions), then interrupt,
     * wait for the turn to settle, and stop with `runtime.error`. The wait runs
     * off the notification fiber, which is the one that delivers the turn's
     * terminal event.
     */
    const failClosed = (ctx: MuseSessionContext, message: string) =>
      Effect.gen(function* () {
        if (ctx.stopped || ctx.diverged) return;
        ctx.diverged = true;
        yield* offer({
          type: "runtime.error",
          ...(yield* stamp(ctx.threadId, ctx.activeTurnId)),
          payload: { message, class: "permission_error" },
        });
        const turnId = ctx.activeTurnId;
        yield* Effect.gen(function* () {
          if (turnId) {
            yield* call("turn/interrupt", () =>
              ctx.handle.host.command("turn/interrupt", { sessionId: ctx.mspSessionId, turnId }),
            ).pipe(Effect.ignore);
            yield* awaitTurnSettled(ctx, turnId, CANCEL_SETTLE_TIMEOUT_MS);
          }
          yield* stopSessionInternal(ctx, { exitKind: "error", reason: message });
        }).pipe(Effect.forkDetach);
      });

    const emitItem = (ctx: MuseSessionContext, item: Item, force = false) =>
      Effect.gen(function* () {
        const projected = projectMuseItem(item);
        const previous = ctx.projectedRevisions.get(item.itemId);
        if (!force && previous !== undefined && previous >= item.revision) return;
        if (ctx.completedItems.has(item.itemId)) return;
        ctx.projectedRevisions.set(item.itemId, item.revision);
        if (!projected) {
          if (item.status !== "inProgress") ctx.projectedRevisions.delete(item.itemId);
          return;
        }
        const turnId = item.turnId ?? ctx.activeTurnId;
        const completed = projected.status !== "inProgress";
        if (completed) {
          // From here `completedItems` alone suppresses re-projection.
          ctx.projectedRevisions.delete(item.itemId);
          remember(ctx.completedItems, item.itemId);
          // Completed text is authoritative: stream whatever the deltas missed.
          if (projected.itemType === "assistant_message" && typeof item.text === "string") {
            const streamed = ctx.streamedText.get(item.itemId) ?? "";
            if (streamed && item.text.startsWith(streamed) && item.text.length > streamed.length) {
              yield* offer({
                type: "content.delta",
                ...(yield* stamp(ctx.threadId, turnId ?? undefined)),
                itemId: RuntimeItemId.make(item.itemId),
                payload: { streamKind: "assistant_text", delta: item.text.slice(streamed.length) },
              });
            }
          }
          ctx.streamedText.delete(item.itemId);
        }
        const type = completed
          ? "item.completed"
          : previous === undefined
            ? "item.started"
            : "item.updated";
        yield* offer({
          type,
          ...(yield* stamp(ctx.threadId, turnId ?? undefined)),
          itemId: RuntimeItemId.make(item.itemId),
          ...(completed ? cursorField(ctx, false) : {}),
          payload: {
            itemType: projected.itemType,
            status: projected.status,
            ...(projected.title ? { title: projected.title } : {}),
            ...(projected.detail ? { detail: projected.detail } : {}),
            data: { kind: item.kind, ...(item.tool ? { tool: item.tool } : {}) },
          },
          raw: { source: "msp.jsonrpc", method: `item/${type.slice(5)}`, payload: item },
        });
      });

    /** Emit `item.completed` for finished items the adapter has not projected. */
    const hydrate = (ctx: MuseSessionContext, read: SessionReadResult) =>
      Effect.gen(function* () {
        const items = read.history.items ?? read.history.snapshot?.state.items ?? [];
        for (const item of items) {
          if (item.status === "inProgress" || ctx.completedItems.has(item.itemId)) continue;
          yield* emitItem(ctx, item, true);
        }
      });

    const openApproval = (ctx: MuseSessionContext, params: ApprovalRequestParams) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(
          museApprovalRequestId(params.approvalId, params.currentRequirementId),
        );
        if (ctx.approvals.has(requestId) || ctx.settledApprovalRequests.has(requestId)) return;
        const choices = mapMuseApprovalChoices(params.availableChoices);
        ctx.approvals.set(requestId, {
          requestId,
          approvalId: params.approvalId,
          params,
          choices,
        });
        ctx.approvalRequestByApprovalId.set(params.approvalId, requestId);
        yield* offer({
          type: "request.opened",
          ...(yield* stamp(ctx.threadId, params.turnId)),
          requestId: RuntimeRequestId.make(requestId),
          payload: {
            requestType: museRequestType(params),
            detail: museApprovalDetail(params),
            approvalOptions: museApprovalOptions(choices),
            args: { toolName: params.toolName, subject: params.subject },
          },
          raw: { source: "msp.jsonrpc", method: "approval/requested", payload: params },
        });
      });

    const closeApproval = (
      ctx: MuseSessionContext,
      requestId: ApprovalRequestId,
      decision: string,
      resolution?: unknown,
    ) =>
      Effect.gen(function* () {
        const pending = ctx.approvals.get(requestId);
        if (!pending) return;
        ctx.approvals.delete(requestId);
        remember(ctx.settledApprovalRequests, requestId);
        if (ctx.approvalRequestByApprovalId.get(pending.approvalId) === requestId) {
          ctx.approvalRequestByApprovalId.delete(pending.approvalId);
        }
        yield* offer({
          type: "request.resolved",
          ...(yield* stamp(ctx.threadId, pending.params.turnId)),
          requestId: RuntimeRequestId.make(requestId),
          payload: {
            requestType: museRequestType(pending.params),
            decision,
            ...(resolution !== undefined ? { resolution } : {}),
          },
        });
      });

    const handleApprovalRequested = (ctx: MuseSessionContext, raw: unknown) =>
      Effect.gen(function* () {
        const params = decodeMuseApproval(raw);
        if (params) return yield* openApproval(ctx, params);
        const deny = salvageMuseDeny(raw);
        if (deny) {
          yield* call("approval/decide", () =>
            ctx.handle.host.command("approval/decide", {
              sessionId: ctx.mspSessionId,
              approvalId: deny.approvalId,
              choiceId: deny.choiceId,
              requirementId: deny.requirementId,
            }),
          ).pipe(Effect.ignore);
          yield* offer({
            type: "runtime.warning",
            ...(yield* stamp(ctx.threadId, ctx.activeTurnId)),
            payload: {
              message: "Muse Code sent an approval F5 could not read; F5 denied it.",
              category: "protocol",
              protocolMethod: "approval/requested",
            },
          });
          return;
        }
        yield* failClosed(
          ctx,
          "Muse Code sent an approval F5 could not read or deny; the session was stopped.",
        );
      });

    const handleApprovalUpdated = (ctx: MuseSessionContext, params: ApprovalUpdatedParams) =>
      Effect.gen(function* () {
        const previousId = ctx.approvalRequestByApprovalId.get(params.approvalId);
        const previous = previousId ? ctx.approvals.get(previousId) : undefined;
        if (!previous || !previousId) return;
        if (params.change.kind === "alreadyTerminal") {
          return yield* closeApproval(ctx, previousId, "resolved");
        }
        yield* closeApproval(ctx, previousId, "superseded", { superseded: true });
        yield* openApproval(ctx, {
          ...previous.params,
          availableChoices: params.availableChoices,
          currentRequirementId: params.currentRequirementId,
          subject: params.subject,
          viewCursor: params.viewCursor,
        });
      });

    const reopenPending = (ctx: MuseSessionContext) =>
      Effect.gen(function* () {
        const pending = yield* call("approval/listPending", () =>
          ctx.handle.host.request("approval/listPending", { sessionId: ctx.mspSessionId }),
        );
        const approvals = Array.isArray(pending.approvals) ? pending.approvals : [];
        const live = new Set<string>();
        for (const raw of approvals) {
          const params = decodeMuseApproval(raw);
          if (!params) {
            yield* handleApprovalRequested(ctx, raw);
            continue;
          }
          live.add(params.approvalId);
          const currentId = ctx.approvalRequestByApprovalId.get(params.approvalId);
          const nextId = museApprovalRequestId(params.approvalId, params.currentRequirementId);
          if (currentId && currentId !== nextId) {
            yield* closeApproval(ctx, currentId, "superseded", { superseded: true });
          }
          yield* openApproval(ctx, params);
        }
        for (const [approvalId, requestId] of ctx.approvalRequestByApprovalId) {
          if (!live.has(approvalId)) yield* closeApproval(ctx, requestId, "resolved");
        }
        const userInputs = Array.isArray(pending.userInputs) ? pending.userInputs : [];
        for (const params of userInputs as UserInputRequestParams[]) {
          yield* openUserInput(ctx, params);
        }
      });

    const openUserInput = (ctx: MuseSessionContext, params: UserInputRequestParams) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(params.userInputId);
        if (ctx.userInputs.has(requestId) || ctx.settledUserInputs.has(params.userInputId)) return;
        ctx.userInputs.set(requestId, params);
        yield* offer({
          type: "user-input.requested",
          ...(yield* stamp(ctx.threadId, params.turnId)),
          requestId: RuntimeRequestId.make(requestId),
          payload: { questions: museQuestions(params.questions) },
          raw: { source: "msp.jsonrpc", method: "userInput/requested", payload: params },
        });
      });

    const settleUserInput = (ctx: MuseSessionContext, settled: UserInputSettledParams) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(settled.userInputId);
        const pending = ctx.userInputs.get(requestId);
        remember(ctx.settledUserInputs, settled.userInputId);
        if (!pending) return;
        ctx.userInputs.delete(requestId);
        const answers = Object.fromEntries(
          settled.answers.map((answer) => [
            answer.questionId,
            answer.selectedLabels ?? answer.selectedLabel ?? answer.freeText ?? "",
          ]),
        );
        yield* offer({
          type: "user-input.resolved",
          ...(yield* stamp(ctx.threadId, pending.turnId)),
          requestId: RuntimeRequestId.make(requestId),
          payload: {
            answers,
            receipt: settled.outcome === "answered" ? "resolved" : "cancelled",
          },
        });
      });

    /** The turn ended: project its remaining items, then `turn.completed`. */
    const completeTurn = (
      ctx: MuseSessionContext,
      turnId: string,
      outcome: {
        readonly terminal: string;
        readonly reason?: string;
        readonly usage?: unknown;
        readonly errorMessage?: string;
      },
    ) =>
      Effect.gen(function* () {
        for (const item of ctx.mspSession.fold.items.list()) {
          if (item.turnId === turnId) yield* emitItem(ctx, item as Item);
        }
        endTurn(ctx, turnId);
        yield* offer({
          type: "turn.completed",
          ...(yield* stamp(ctx.threadId, turnId)),
          ...cursorField(ctx, true),
          payload: {
            state: museTurnState(outcome.terminal),
            stopReason: outcome.reason ?? outcome.terminal,
            ...(outcome.usage ? { usage: outcome.usage } : {}),
            ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
          },
        });
        settleTurnWaiters(ctx, turnId);
      });

    const abortTurn = (ctx: MuseSessionContext, turnId: string, reason: string) =>
      Effect.gen(function* () {
        endTurn(ctx, turnId);
        yield* offer({
          type: "turn.aborted",
          ...(yield* stamp(ctx.threadId, turnId)),
          ...cursorField(ctx, true),
          payload: { reason },
        });
        settleTurnWaiters(ctx, turnId);
      });

    const endTurn = (ctx: MuseSessionContext, turnId: string) => {
      if (ctx.activeTurnId !== turnId) return;
      ctx.activeTurnId = undefined;
      const { activeTurnId: _ended, ...rest } = ctx.session;
      ctx.session = { ...rest, status: "ready" };
    };

    /**
     * The SDK fills a delivery gap from `view/page` straight into its fold;
     * the recovered events never reach connection listeners. Once the fill
     * lands, project what the fold now knows. A failed fill goes through
     * `recoverFromGap` instead.
     */
    const scheduleGapReconcile = (ctx: MuseSessionContext) =>
      Effect.gen(function* () {
        if (ctx.gapReconcilePending) return;
        ctx.gapReconcilePending = true;
        const deadline = Date.now() + GAP_FILL_WAIT_MS;
        yield* Effect.gen(function* () {
          while (
            ctx.mspSession.fold.pendingGap !== undefined &&
            !ctx.stopped &&
            Date.now() < deadline
          ) {
            yield* Effect.sleep(GAP_FILL_POLL_MS);
          }
          ctx.gapReconcilePending = false;
          if (!ctx.stopped && ctx.mspSession.fold.pendingGap === undefined) {
            Queue.offerUnsafe(ctx.notifications, { method: "$gapFilled" });
          }
        }).pipe(Effect.forkIn(ctx.scope));
      });

    const reconcileFold = (ctx: MuseSessionContext) =>
      Effect.gen(function* () {
        const fold = ctx.mspSession.fold;
        if (!ctx.activeTurnId && fold.activeTurnId) {
          yield* handleNotification(ctx, {
            method: "turn/started",
            params: { sessionId: ctx.mspSessionId, turnId: fold.activeTurnId },
          } as unknown as Notification);
        }
        for (const item of fold.items.list()) yield* emitItem(ctx, item as Item);
        const turnId = ctx.activeTurnId;
        const turn = turnId ? fold.turn(turnId) : undefined;
        if (turnId && turn?.state === "settled") {
          yield* completeTurn(ctx, turnId, {
            terminal: String(turn.terminal ?? "completed"),
            ...(turn.error?.message?.trim() ? { errorMessage: turn.error.message.trim() } : {}),
          });
        } else if (
          turnId &&
          (turn?.state === "retracted" || turn?.state === "unqueued") &&
          // The fold also marks a declined retract retracted; that turn still runs.
          !ctx.declinedRetracts.has(turnId)
        ) {
          yield* abortTurn(ctx, turnId, "Muse Code retracted the turn before it ran.");
        }
        for (const settled of fold.settledUserInputs()) {
          yield* settleUserInput(ctx, settled as UserInputSettledParams);
        }
        // The host's pending list is authoritative for approvals and questions.
        yield* reopenPending(ctx);
        const approvalMode = fold.sessionState.get("session/approvalModeChanged");
        if (approvalMode && typeof approvalMode.mode === "string") {
          const check = verifyMusePermissionState({
            runtimeMode: ctx.runtimeMode,
            initializeResult: ctx.handle.host.initializeResult,
            effectiveApprovalMode: approvalMode.mode,
          });
          if (!check.ok) {
            yield* failClosed(ctx, `Muse Code permissions changed mid-session: ${check.reason}`);
          }
        }
      }).pipe(
        Effect.catch((cause) =>
          stamp(ctx.threadId, ctx.activeTurnId).pipe(
            Effect.flatMap((stamped) =>
              offer({
                type: "runtime.warning",
                ...stamped,
                payload: {
                  message: `F5 could not reconcile recovered Muse Code history: ${cause.message}`,
                  category: "protocol",
                },
              }),
            ),
          ),
        ),
      );

    const handleNotification = (ctx: MuseSessionContext, notification: Notification) =>
      Effect.gen(function* () {
        const params = (notification.params ?? {}) as Record<string, unknown>;
        if (params.sessionId !== ctx.mspSessionId || ctx.stopped) return;
        if (typeof params.viewCursor === "string") ctx.viewCursor = params.viewCursor;
        yield* logNative(ctx.threadId, notification.method, params);
        const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
        switch (notification.method) {
          case "turn/started": {
            ctx.activeTurnId = turnId;
            ctx.session = {
              ...ctx.session,
              status: "running",
              ...(turnId ? { activeTurnId: TurnId.make(turnId) } : {}),
            };
            yield* offer({
              type: "turn.started",
              ...(yield* stamp(ctx.threadId, turnId)),
              payload: {
                ...(ctx.currentModelId ? { model: ctx.currentModelId } : {}),
                ...(ctx.currentEffort ? { effort: ctx.currentEffort } : {}),
              },
            });
            return;
          }
          case "turn/completed": {
            if (!turnId) return;
            const error = params.error as { message?: string } | undefined;
            return yield* completeTurn(ctx, turnId, {
              terminal: typeof params.terminal === "string" ? params.terminal : "completed",
              ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
              ...(params.usage ? { usage: params.usage } : {}),
              ...(error?.message?.trim() ? { errorMessage: error.message.trim() } : {}),
            });
          }
          case "turn/retracted": {
            if (!turnId) return;
            // A declined retract leaves the turn running to its own terminal
            // event. An absent or unrecognized outcome reads as accepted.
            if (params.outcome === "declined") {
              remember(ctx.declinedRetracts, turnId);
              return;
            }
            return yield* abortTurn(ctx, turnId, "Muse Code retracted the turn before it ran.");
          }
          case "view/gap":
            return yield* scheduleGapReconcile(ctx);
          case "item/started":
          case "item/updated":
          case "item/completed": {
            const raw = params.item as Item | undefined;
            if (!raw?.itemId) return;
            // This queue runs behind the SDK fold, so the fold may already hold
            // a later revision; project frames in order and let the revision
            // check in `emitItem` drop stale ones.
            return yield* emitItem(ctx, raw);
          }
          case "item/delta": {
            const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
            const delta = typeof params.delta === "string" ? params.delta : "";
            if (!itemId || !delta || ctx.completedItems.has(itemId)) return;
            const folded = ctx.mspSession.fold.items.get(itemId) as Item | undefined;
            const field = typeof params.field === "string" ? params.field : undefined;
            if (folded?.kind === "userMessage") return;
            ctx.streamedText.set(itemId, (ctx.streamedText.get(itemId) ?? "") + delta);
            yield* offer({
              type: "content.delta",
              ...(yield* stamp(ctx.threadId, (folded?.turnId ?? ctx.activeTurnId) || undefined)),
              itemId: RuntimeItemId.make(itemId),
              ...cursorField(ctx, false),
              payload: { streamKind: museDeltaStreamKind(folded, field), delta },
            });
            return;
          }
          case "approval/requested":
            return yield* handleApprovalRequested(ctx, params);
          case "approval/updated":
            return yield* handleApprovalUpdated(ctx, params as unknown as ApprovalUpdatedParams);
          case "approval/resolved": {
            const resolved = params as unknown as ApprovalResolvedParams;
            const requestId = ctx.approvalRequestByApprovalId.get(resolved.approvalId);
            if (requestId) {
              yield* closeApproval(ctx, requestId, resolved.decision, {
                resolvedBy: resolved.resolvedBy,
              });
            }
            return;
          }
          case "userInput/requested":
            return yield* openUserInput(ctx, params as unknown as UserInputRequestParams);
          case "userInput/settled":
            return yield* settleUserInput(ctx, params as unknown as UserInputSettledParams);
          case "session/todoListChanged": {
            const items = Array.isArray(params.items) ? params.items : [];
            yield* offer({
              type: "turn.plan.updated",
              ...(yield* stamp(ctx.threadId, ctx.activeTurnId)),
              payload: { plan: museTodoPlan(items) },
            });
            return;
          }
          case "session/tokenUsage": {
            const cumulative = params.cumulative as Record<string, unknown> | undefined;
            yield* offer({
              type: "thread.token-usage.updated",
              ...(yield* stamp(ctx.threadId, turnId)),
              payload: {
                usage: {
                  prompt_tokens: params.promptTokens,
                  total_tokens: params.totalTokens,
                  ...(cumulative ? { cumulative } : {}),
                },
              },
            });
            return;
          }
          case "session/contextUsage": {
            const used = typeof params.usedTokens === "number" ? params.usedTokens : undefined;
            const window =
              typeof params.windowTokens === "number" ? params.windowTokens : undefined;
            yield* offer({
              type: "thread.token-usage.updated",
              ...(yield* stamp(ctx.threadId, ctx.activeTurnId)),
              payload: {
                usage: { total_tokens: used, pressure: params.pressure },
                ...(used !== undefined ? { contextTokens: Math.max(0, Math.floor(used)) } : {}),
                ...(window !== undefined
                  ? { modelContextWindowTokens: Math.max(0, Math.floor(window)) }
                  : {}),
              },
            });
            return;
          }
          case "usage/changed":
            yield* offer({
              type: "account.rate-limits.updated",
              ...(yield* stamp(ctx.threadId)),
              payload: { rateLimits: params },
            });
            return;
          case "turn/retryScheduled":
          case "turn/modelRetryScheduled":
            yield* offer({
              type: "runtime.warning",
              ...(yield* stamp(ctx.threadId, turnId)),
              payload: {
                message: `Muse Code is retrying (attempt ${String(params.nextAttempt ?? "?")} of ${String(params.maxAttempts ?? "?")}).`,
                category: "provider",
                detail: params,
              },
            });
            return;
          case "session/modelRouteUnserved":
            yield* offer({
              type: "runtime.warning",
              ...(yield* stamp(ctx.threadId, ctx.activeTurnId)),
              payload: {
                message: `Muse Code cannot route model '${String(params.modelId)}' through its installed provider.`,
                category: "provider",
                detail: params,
              },
            });
            return;
          case "session/modelChanged":
            if (typeof params.modelId === "string") ctx.currentModelId = params.modelId;
            return;
          case "session/reasoningEffortChanged":
            if (typeof params.reasoningEffort === "string") {
              ctx.currentEffort = params.reasoningEffort;
            }
            return;
          case "session/approvalModeChanged": {
            const check = verifyMusePermissionState({
              runtimeMode: ctx.runtimeMode,
              initializeResult: ctx.handle.host.initializeResult,
              effectiveApprovalMode: typeof params.mode === "string" ? params.mode : undefined,
            });
            if (!check.ok) {
              yield* failClosed(ctx, `Muse Code permissions changed mid-session: ${check.reason}`);
            }
            return;
          }
          case "session/closed":
            yield* stopSessionInternal(ctx, {
              exitKind: "graceful",
              reason: `Muse Code closed the session (${String(params.reason ?? "unknown")}).`,
            });
            return;
          default:
            return;
        }
      });

    /** Splice-fill failed: warn, hydrate from `session/read`, resume at the server cursor. */
    const recoverFromGap = (ctx: MuseSessionContext, error: unknown) =>
      Effect.gen(function* () {
        const bounds =
          error instanceof MuseGapFillError ? ` between ${error.after} and ${error.next}` : "";
        yield* offer({
          type: "runtime.warning",
          ...(yield* stamp(ctx.threadId, ctx.activeTurnId)),
          payload: {
            message: `Muse Code history${bounds} could not be recovered; F5 reloaded the session's current state.`,
            category: "protocol",
          },
        });
        const read = yield* call("session/read", () =>
          ctx.handle.host.request("session/read", { sessionId: ctx.mspSessionId }),
        ).pipe(Effect.map((result) => result as unknown as SessionReadResult));
        yield* hydrate(ctx, read);
        ctx.viewCursor = read.viewCursor;
        const resumed = yield* call("session/resume", () =>
          ctx.handle.host.gate.run(
            "session/resume",
            options?.sessionOpenTimeoutMs ?? MSP_REQUEST_TIMEOUT_MS,
            () =>
              ctx.handle.host.client.resumeSession({
                sessionId: ctx.mspSessionId,
                cursor: read.viewCursor,
                excludeItems: true,
              }),
          ),
        );
        ctx.mspSession = resumed;
        attachGapHandler(ctx, resumed);
      }).pipe(
        Effect.catch((cause) =>
          stopSessionInternal(ctx, {
            exitKind: "error",
            reason: `Muse Code session view could not be recovered: ${cause.message}`,
          }),
        ),
      );

    const attachGapHandler = (ctx: MuseSessionContext, session: MspSession) => {
      session.onGapError(() => {
        if (ctx.mspSession === session) {
          Queue.offerUnsafe(ctx.notifications, { method: "$gapError" });
        }
      });
    };

    const defaultOpenHost = (input: { readonly cwd: string }) =>
      Effect.gen(function* () {
        const transport = yield* makeMspTransport({
          binaryPath: museSettings.binaryPath || "muse",
          args: MUSE_SERVE_ARGS,
          cwd: input.cwd,
          environment,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        const host = yield* Effect.tryPromise({
          try: () =>
            openMspHost({
              transport: transport.transport,
              clientVersion: options?.clientVersion ?? "0.0.0",
            }),
          catch: (cause) => new MuseCallFailure({ cause }),
        });
        yield* Effect.addFinalizer(() => Effect.promise(() => host.close().catch(() => undefined)));
        return { host, stderrTail: transport.stderrTail } satisfies MuseHostHandle;
      }).pipe(
        Effect.mapError((failure) => {
          const cause = failure instanceof MuseCallFailure ? failure.cause : failure;
          return new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: "",
            detail: `Failed to start Muse Code (\`muse serve\`): ${describeMspError(cause)}`,
            cause,
          });
        }),
      );

    /** Open (or resume) the MSP session; `fresh` reports why a resume was abandoned. */
    const openSession = (input: {
      readonly handle: MuseHostHandle;
      readonly cwd: string;
      readonly runtimeMode: MuseRuntimeMode;
      readonly modelId: string | undefined;
      readonly resume: MuseResumeCursor | undefined;
    }) =>
      Effect.gen(function* () {
        const { host } = input.handle;
        // The SDK has no response deadline of its own; a host that stops
        // answering must not hold the thread lock forever.
        const openTimeoutMs = options?.sessionOpenTimeoutMs ?? MSP_REQUEST_TIMEOUT_MS;
        const startFresh = call("session/start", () =>
          host.gate.run("session/start", openTimeoutMs, () =>
            host.client.startSession({
              workspaceRoot: input.cwd,
              approvalMode: verifyExpectedMode(input.runtimeMode),
              ...(input.modelId ? { modelId: input.modelId } : {}),
            }),
          ),
        );
        if (!input.resume) {
          return { session: yield* startFresh, freshReason: undefined, hydrate: undefined };
        }
        if (input.resume.durability !== "durable") {
          return {
            session: yield* startFresh,
            freshReason:
              "The previous Muse Code host kept sessions only in memory, so the conversation was lost when it exited.",
            hydrate: undefined,
          };
        }
        const attempt = (cursor: string | null) =>
          Effect.tryPromise({
            try: () =>
              host.gate.run("session/resume", openTimeoutMs, () =>
                host.client.resumeSession({
                  sessionId: input.resume!.mspSessionId,
                  ...(cursor ? { cursor } : { excludeItems: true }),
                }),
              ),
            catch: (cause) => new MuseCallFailure({ cause }),
          });
        const resumed = yield* attempt(input.resume.viewCursor).pipe(Effect.result);
        if (resumed._tag === "Success") {
          return { session: resumed.success, freshReason: undefined, hydrate: undefined };
        }
        const error = resumed.failure.cause;
        const kind = mspErrorKind(error);
        if (kind === "sessionNotFound" || error instanceof MuseSessionDiscardedError) {
          return {
            session: yield* startFresh,
            freshReason: "Muse Code could not resume the requested conversation (sessionNotFound).",
            hydrate: undefined,
          };
        }
        if (kind && RESUME_HYDRATION_KINDS.has(kind)) {
          const session = yield* attempt(null).pipe(
            Effect.mapError((failure) => requestError("session/resume", failure.cause)),
          );
          const read = yield* call("session/read", () =>
            host.request("session/read", { sessionId: session.sessionId }),
          );
          return {
            session,
            freshReason: undefined,
            hydrate: read as unknown as SessionReadResult,
          };
        }
        return yield* requestError("session/resume", error, "Muse Code could not resume:");
      });

    const verifyExpectedMode = (runtimeMode: MuseRuntimeMode) =>
      runtimeMode === "full-access" ? ("allowAll" as const) : ("promptUnmatched" as const);

    /** Apply the approval mode and require the read-back to match. */
    const enforcePermissions = (host: MspHost, session: MspSession, runtimeMode: MuseRuntimeMode) =>
      Effect.gen(function* () {
        const opening = session.opening;
        let effective =
          opening?.verb === "session/start" ? opening.result.session.approvalMode?.mode : undefined;
        if (effective === undefined) {
          const applied = yield* call("session/setApprovalMode", () =>
            host.command("session/setApprovalMode", {
              sessionId: session.sessionId,
              mode: verifyExpectedMode(runtimeMode),
            }),
          );
          const effectiveMode = applied.effectiveMode as { mode?: string } | undefined;
          effective = effectiveMode?.mode as typeof effective;
        }
        return verifyMusePermissionState({
          runtimeMode,
          initializeResult: host.initializeResult,
          effectiveApprovalMode: effective,
        });
      });

    const startSession: MuseAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!isMuseRuntimeMode(input.runtimeMode)) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue:
                runtimeModeUnsupportedReason(PROVIDER, input.runtimeMode) ??
                `${input.runtimeMode} is not available for Muse Code.`,
            });
          }
          if (!input.cwd) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }
          const runtimeMode = input.runtimeMode;
          const cwd = nodePath.resolve(input.cwd);
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing, { exitKind: "graceful" });
          }
          const selection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const requestedEffort =
            selectionValue(selection?.options, "reasoningEffort") ?? DEFAULT_REASONING_EFFORT;

          const sessionScope = yield* Scope.make("sequential");
          return yield* Effect.gen(function* () {
            const handle = yield* (options?.openHost ?? defaultOpenHost)({ cwd }).pipe(
              Effect.provideService(Scope.Scope, sessionScope),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: cause.detail,
                    cause,
                  }),
              ),
            );
            const notifications = yield* Queue.unbounded<Notification | AdapterSignal>();
            const unsubscribe = handle.host.connection.addListener((notification) => {
              Queue.offerUnsafe(notifications, notification);
            });
            yield* Scope.addFinalizer(sessionScope, Effect.sync(unsubscribe));

            const opened = yield* openSession({
              handle,
              cwd,
              runtimeMode,
              modelId: selection?.model,
              resume: parseMuseResumeCursor(input.resumeCursor),
            });
            const permissions = yield* enforcePermissions(handle.host, opened.session, runtimeMode);
            if (!permissions.ok) {
              const stamped = yield* stamp(input.threadId);
              yield* offer({
                type: "runtime.error",
                ...stamped,
                payload: { message: permissions.reason, class: "permission_error" },
              });
              return yield* new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: permissions.reason,
              });
            }
            yield* call("session/setReasoningEffort", () =>
              handle.host.command("session/setReasoningEffort", {
                sessionId: opened.session.sessionId,
                reasoningEffort: requestedEffort,
              }),
            );
            const opening = opened.session.opening;
            // `session/resume` takes no model: the host keeps the stored one
            // until F5 switches it explicitly.
            let currentModelId = opening?.result.session.modelId ?? undefined;
            if (selection?.model && selection.model !== currentModelId) {
              yield* call("session/setModel", () =>
                handle.host.command("session/setModel", {
                  sessionId: opened.session.sessionId,
                  model: { modelId: selection.model },
                }),
              );
              currentModelId = selection.model;
            }

            const now = yield* nowIso;
            const viewCursor = opening?.result.viewCursor ?? null;
            const ctx: MuseSessionContext = {
              threadId: input.threadId,
              scope: sessionScope,
              handle,
              mspSessionId: opened.session.sessionId,
              runtimeMode,
              notifications,
              mspSession: opened.session,
              session: {
                provider: PROVIDER,
                providerInstanceId: boundInstanceId,
                status: "ready",
                runtimeMode,
                cwd,
                ...(currentModelId ? { model: currentModelId } : {}),
                threadId: input.threadId,
                createdAt: now,
                updatedAt: now,
              },
              viewCursor,
              lastCursorPersistAt: 0,
              activeTurnId: undefined,
              currentModelId,
              currentEffort: requestedEffort,
              stopped: false,
              diverged: false,
              turnSettleWaiters: new Map(),
              projectedRevisions: new Map(),
              completedItems: new Set(),
              streamedText: new Map(),
              approvals: new Map(),
              approvalRequestByApprovalId: new Map(),
              settledApprovalRequests: new Set(),
              userInputs: new Map(),
              settledUserInputs: new Set(),
              gapReconcilePending: false,
              declinedRetracts: new Set(),
            };
            ctx.session = { ...ctx.session, resumeCursor: resumeCursorOf(ctx) };
            attachGapHandler(ctx, opened.session);
            sessions.set(input.threadId, ctx);

            yield* Stream.fromQueue(notifications).pipe(
              Stream.runForEach((entry) =>
                entry.method === "$gapError"
                  ? recoverFromGap(ctx, undefined)
                  : entry.method === "$gapFilled"
                    ? reconcileFold(ctx)
                    : handleNotification(ctx, entry as Notification),
              ),
              Effect.forkIn(sessionScope),
            );
            yield* Effect.promise(() => handle.host.connection.closed).pipe(
              Effect.flatMap(() =>
                ctx.stopped
                  ? Effect.void
                  : stopSessionInternal(ctx, {
                      exitKind: "error",
                      reason: `Muse Code host exited unexpectedly.${
                        handle.stderrTail().trim()
                          ? ` ${handle.stderrTail().trim().slice(-500)}`
                          : ""
                      }`,
                    }),
              ),
              Effect.forkIn(sessionScope),
            );

            if (handle.host.fingerprintWarning) {
              yield* offer({
                type: "runtime.warning",
                ...(yield* stamp(input.threadId)),
                payload: {
                  message:
                    "Untested Muse Code protocol: this CLI's schema differs from the one F5 was built against.",
                  category: "protocol",
                  detail: handle.host.fingerprintWarning,
                },
              });
            }
            if (opened.freshReason) {
              yield* offer({
                type: "runtime.warning",
                ...(yield* stamp(input.threadId)),
                payload: {
                  message: `${opened.freshReason} F5 started a new Muse Code session.`,
                  category: "provider",
                },
              });
            }
            if (opened.hydrate) {
              yield* offer({
                type: "runtime.warning",
                ...(yield* stamp(input.threadId)),
                payload: {
                  message:
                    "Muse Code pruned history after F5's last checkpoint; F5 reloaded the session's current state.",
                  category: "protocol",
                },
              });
              yield* hydrate(ctx, opened.hydrate);
              ctx.viewCursor = opened.hydrate.viewCursor;
            }
            yield* reopenPending(ctx);

            yield* offer({
              type: "session.started",
              ...(yield* stamp(input.threadId)),
              payload: { resume: { mspSessionId: ctx.mspSessionId } },
            });
            yield* offer({
              type: "session.state.changed",
              ...(yield* stamp(input.threadId)),
              payload: { state: "ready", reason: "Muse Code session ready" },
            });
            yield* offer({
              type: "thread.started",
              ...(yield* stamp(input.threadId)),
              resumeCursor: resumeCursorOf(ctx),
              payload: { providerThreadId: ctx.mspSessionId },
            });
            return ctx.session;
          }).pipe(
            Effect.onError(() =>
              Effect.gen(function* () {
                const ctx = sessions.get(input.threadId);
                if (ctx?.scope === sessionScope) sessions.delete(input.threadId);
                yield* Scope.close(sessionScope, Exit.void);
              }),
            ),
          );
        }),
      );

    const buildInput = (
      ctx: MuseSessionContext,
      input: Parameters<MuseAdapterShape["sendTurn"]>[0],
    ) =>
      Effect.gen(function* () {
        const parts: TurnInputPart[] = [];
        const text = input.input?.trim();
        if (text) parts.push({ type: "text", text });
        const attachmentContext = buildProviderAttachmentRuntimeContext(
          input.resolvedAttachments ?? [],
        );
        if (attachmentContext) parts.push({ type: "text", text: attachmentContext });
        for (const attachment of input.attachments ?? []) {
          if (attachment.type !== "image") continue;
          const path = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!path) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/start",
              detail: `Invalid attachment id '${attachment.id}'.`,
              deliveryCertainty: "not_sent",
              deliveryRetryable: false,
            });
          }
          const bytes = yield* fileSystem.readFile(path).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "turn/start",
                  detail: cause.message,
                  deliveryCertainty: "not_sent",
                  deliveryRetryable: false,
                  cause,
                }),
            ),
          );
          // MSP carries images inline; `media/upload` is for video only. Inline
          // bytes also keep a retried turn's payload identical under its pinned id.
          parts.push({
            type: "image",
            mediaType: attachment.mimeType,
            base64Data: Buffer.from(bytes).toString("base64"),
          });
        }
        if (parts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }
        return parts;
      });

    /** Model and effort changes apply to the session before the turn. */
    const applySelection = (
      ctx: MuseSessionContext,
      input: Parameters<MuseAdapterShape["sendTurn"]>[0],
    ) =>
      Effect.gen(function* () {
        const selection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        if (selection?.model && selection.model !== ctx.currentModelId) {
          yield* call("session/setModel", () =>
            ctx.handle.host.command("session/setModel", {
              sessionId: ctx.mspSessionId,
              model: { modelId: selection.model },
            }),
          );
          ctx.currentModelId = selection.model;
          ctx.session = { ...ctx.session, model: selection.model };
        }
        const effort =
          selectionValue(selection?.options, "reasoningEffort") ??
          (selection ? DEFAULT_REASONING_EFFORT : undefined);
        if (effort && effort !== ctx.currentEffort) {
          yield* call("session/setReasoningEffort", () =>
            ctx.handle.host.command("session/setReasoningEffort", {
              sessionId: ctx.mspSessionId,
              reasoningEffort: effort,
            }),
          );
          ctx.currentEffort = effort;
        }
      });

    const sendTurn: MuseAdapterShape["sendTurn"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireUsableSession(input.threadId, "turn/start");
          if (input.interactionMode === "plan") {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue:
                "Muse Code cannot enforce plan mode: MSP 1.4 cannot switch a running session to a read-only profile.",
            });
          }
          yield* applySelection(ctx, input).pipe(Effect.mapError(beforeTurnStart));
          const parts = yield* buildInput(ctx, input);
          const nativeCommandId = input.deliveryId
            ? yield* nativeCommandIds.resolve({
                providerInstanceId: boundInstanceId,
                f5CommandId: input.deliveryId,
                mint: ctx.handle.host.commandIds.fresh,
              })
            : ctx.handle.host.commandIds.fresh();
          const turn = yield* Effect.tryPromise({
            try: () =>
              ctx.handle.host.gate.run("turn/start", MSP_TURN_START_TIMEOUT_MS, () => {
                ctx.handle.host.commandIds.pin(nativeCommandId);
                return ctx.mspSession.sendUserTurn({ input: parts });
              }),
            catch: (error) => requestError("turn/start", error),
          }).pipe(
            // Keep the native id only while the outcome is unknown. Once the host
            // has answered, its dedupe would replay that answer, so a later retry
            // of this delivery is a new attempt under a fresh id.
            Effect.tapError((error) =>
              input.deliveryId && classifyMspDelivery(error.cause).certainty !== "ambiguous"
                ? nativeCommandIds.forget(input.deliveryId)
                : Effect.void,
            ),
          );
          ctx.activeTurnId = turn.turnId;
          ctx.session = {
            ...ctx.session,
            status: "running",
            activeTurnId: TurnId.make(turn.turnId),
            updatedAt: yield* nowIso,
          };
          return {
            threadId: input.threadId,
            turnId: TurnId.make(turn.turnId),
            resumeCursor: resumeCursorOf(ctx),
          };
        }),
      );

    const steerTurn: NonNullable<MuseAdapterShape["steerTurn"]> = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireUsableSession(input.threadId, "turn/steer");
          if (!ctx.activeTurnId || ctx.activeTurnId !== input.expectedTurnId) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/steer",
              detail: "The active turn ended or changed before steering.",
              deliveryCertainty: "not_sent",
              deliveryRetryable: false,
            });
          }
          const parts = yield* buildInput(ctx, input);
          yield* call("turn/steer", () =>
            ctx.handle.host.command("turn/steer", {
              sessionId: ctx.mspSessionId,
              expectedTurnId: input.expectedTurnId,
              input: parts,
            }),
          );
          return { threadId: input.threadId, turnId: input.expectedTurnId };
        }),
      );

    const interruptTurn: MuseAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped || !ctx.activeTurnId) return;
        if (turnId && turnId !== ctx.activeTurnId) return;
        yield* call("turn/interrupt", () =>
          ctx.handle.host.command("turn/interrupt", {
            sessionId: ctx.mspSessionId,
            turnId: ctx.activeTurnId,
          }),
        );
      });

    const respondToRequest: MuseAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision: ProviderApprovalDecision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireUsableSession(threadId, "approval/decide");
        const pending = ctx.approvals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "approval/decide",
            detail: ctx.settledApprovalRequests.has(requestId)
              ? "This approval was already resolved."
              : `Unknown pending approval request: ${requestId}`,
          });
        }
        const choice = pending.choices.find((entry) => entry.decision === decision);
        if (!choice) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToRequest",
            issue: `Muse Code did not offer '${decision}' for this approval.`,
          });
        }
        const decided = yield* Effect.tryPromise({
          try: () =>
            ctx.handle.host.command("approval/decide", {
              sessionId: ctx.mspSessionId,
              approvalId: pending.approvalId,
              choiceId: choice.choiceId,
              requirementId: pending.params.currentRequirementId,
            }),
          catch: (cause) => new MuseCallFailure({ cause }),
        }).pipe(Effect.result);
        if (decided._tag === "Success") {
          return yield* closeApproval(ctx, requestId, decision);
        }
        const kind = mspErrorKind(decided.failure.cause);
        if (kind === "approvalRequirementStale") {
          yield* reopenPending(ctx).pipe(Effect.ignore);
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "approval/decide",
            detail: "This approval changed; review the updated request.",
          });
        }
        if (kind === "approvalAlreadyResolved" || kind === "approvalNotFound") {
          yield* closeApproval(ctx, requestId, "resolved");
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "approval/decide",
            detail: "This approval was already resolved.",
          });
        }
        return yield* requestError("approval/decide", decided.failure.cause);
      });

    const respondToUserInput: MuseAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireUsableSession(threadId, "userInput/answer");
        const pending = ctx.userInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "userInput/answer",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        const mapped = museAnswers(pending.questions, answers);
        if (mapped.length === 0) {
          yield* call("userInput/cancel", () =>
            ctx.handle.host.command("userInput/cancel", {
              sessionId: ctx.mspSessionId,
              userInputId: pending.userInputId,
            }),
          );
          return;
        }
        yield* call("userInput/answer", () =>
          ctx.handle.host.command("userInput/answer", {
            sessionId: ctx.mspSessionId,
            userInputId: pending.userInputId,
            answers: mapped,
          }),
        );
      });

    const readThread: MuseAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const read = (yield* call("session/read", () =>
          ctx.handle.host.request("session/read", { sessionId: ctx.mspSessionId }),
        )) as unknown as SessionReadResult;
        const items = read.history.items ?? read.history.snapshot?.state.items ?? [];
        const turns = new Map<string, Array<unknown>>();
        for (const item of items) {
          if (!item.turnId) continue;
          const list = turns.get(item.turnId) ?? [];
          list.push(item);
          turns.set(item.turnId, list);
        }
        return {
          threadId,
          turns: [...turns].map(([id, turnItems]) => ({ id: TurnId.make(id), items: turnItems })),
        };
      });

    const rollbackThread: MuseAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Muse Code sessions do not support provider-side rollback yet.",
        });
      });

    /** Cancel, wait up to 10 s for the turn to settle, then close the host. */
    const stopSession: MuseAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const turnId = ctx.activeTurnId;
          if (turnId) {
            yield* call("turn/cancel", () =>
              ctx.handle.host.command("turn/cancel", { sessionId: ctx.mspSessionId, turnId }),
            ).pipe(Effect.ignore);
            // A cancel ack only means the request was admitted.
            yield* awaitTurnSettled(ctx, turnId, CANCEL_SETTLE_TIMEOUT_MS);
          }
          yield* stopSessionInternal(ctx, { exitKind: "graceful" });
        }),
      );

    const listSessions: MuseAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: MuseAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const stopAll: MuseAdapterShape["stopAll"] = () =>
      Effect.forEach(
        Array.from(sessions.values()),
        (ctx) => stopSessionInternal(ctx, { exitKind: "graceful" }),
        { discard: true },
      );

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(Effect.tap(() => PubSub.shutdown(runtimeEventPubSub))),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        nativeTurnIdempotency: true,
        runtimeCapabilities: providerRuntimeCapabilities(PROVIDER),
      },
      startSession,
      sendTurn,
      steerTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies MuseAdapterShape;
  });
}
