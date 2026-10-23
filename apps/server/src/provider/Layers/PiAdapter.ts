import type { NativeHistoryReconciliation } from "../ProviderNativeHistory.ts";
import { randomUUID } from "node:crypto";
import {
  ApprovalRequestId,
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
  type PiSettings,
  type CommandId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import { stringifyWithinBytes } from "@t3tools/shared/boundedJson";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { runtimeModeUnsupportedReason } from "@t3tools/shared/runtimeMode";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Option,
  PubSub,
  Scope,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { buildProviderAttachmentRuntimeContext } from "../attachmentRuntimeContext.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { extractToolResultImages } from "../../orchestration/toolResultImages.ts";
import { makeToolResultImageStore } from "../prepareAutomationRuntimeEvent.ts";
import { piToolPayload } from "../pi/PiToolOutput.ts";
import { makeOperationGate } from "../operationGate.ts";
import { makeOwnedOperation } from "../ownedOperation.ts";
import type {
  ProviderAdapterShape,
  ProviderAdapterSendTurnInput,
} from "../Services/ProviderAdapter.ts";
import { parsePiCompactCommand } from "../pi/commands.ts";
import { readPiCatalog, type PiCatalog } from "../pi/PiMetadata.ts";
import { buildPiRpcLaunch, resolvePiLaunchArgs } from "../pi/launch.ts";
import { materializePiMcpExtension } from "../pi/materializeExtension.ts";
import { makePiRpcConnection, PiRpcError, type PiRpcConnection } from "../pi/PiRpc.ts";
import {
  parsePiModelSlug,
  piRecordField,
  piRecordString,
  type PiRpcRecord,
} from "../pi/PiProtocol.ts";
import { piContextUsage, PiTurnUsage } from "../pi/PiUsage.ts";
import { PiAssistantOutput } from "../pi/PiAssistantOutput.ts";
import { PiNativeWake, PI_NATIVE_WAKE_ADMISSION_MS } from "../pi/PiNativeWake.ts";
import type { ProviderContinuationRequest } from "../ProviderContinuationRequests.ts";
import { PiTurnState, type PiTurnAction } from "../pi/PiTurnState.ts";
import { PiUiRequests, type PendingPiUiRequest } from "../pi/PiUiRequests.ts";
import {
  capturePiTurnTreeBoundary,
  parsePiSessionTree,
  piActiveBranch,
  piRollbackEntry,
} from "../pi/PiSessionTree.ts";
import { readPiVersion, piVersionSupportsF5 } from "./PiProvider.ts";
import { runPiMetadataPrompt } from "../../git/Layers/PiTextGeneration.ts";

export { parsePiResumeCursor } from "../pi/PiHistory.ts";
import {
  parsePiResumeCursor,
  readPiHistory,
  piHistoryBoundaryHash,
  type PiResumeCursor,
} from "../pi/PiHistory.ts";

interface PiContext {
  readonly threadId: ThreadId;
  readonly generation: string;
  readonly scope: Scope.Closeable;
  readonly rpc: PiRpcConnection;
  readonly turns: PiTurnState;
  readonly dialogs: PiUiRequests;
  readonly eventGate: Semaphore.Semaphore;
  baselineModel: { provider: string; modelId: string } | null;
  baselineThinking: string | undefined;
  appliedThinking: string | undefined;
  readonly output: PiAssistantOutput;
  readonly usage: PiTurnUsage;
  readonly tools: Map<string, { name: string; args: unknown; done: boolean }>;
  readonly barriers: Map<string, Deferred.Deferred<unknown, PiRpcError>>;
  readonly readOnly: boolean;
  wake: PiNativeWake | null;
  wakeTimer: Fiber.Fiber<void> | undefined;
  lastTurnId: TurnId | undefined;
  activeCommandId: CommandId | undefined;
  lastCommandId: CommandId | undefined;
  continuationEligible: boolean;
  lifecycle: boolean;
  session: ProviderSession;
  cursor: PiResumeCursor;
  ready: boolean;
  closed: boolean;
}
export interface PiAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly environment: NodeJS.ProcessEnv;
  readonly cacheDir: string;
  readonly offerContinuation?: (request: ProviderContinuationRequest) => Effect.Effect<boolean>;
  readonly reconcileNativeHistory?: (
    request: NativeHistoryReconciliation,
  ) => Effect.Effect<boolean>;
  readonly onCatalog?: (catalog: PiCatalog) => Effect.Effect<void>;
  readonly beforeLaunch?: Effect.Effect<void, PiRpcError, Scope.Scope>;
  readonly createMcpSession?: (
    threadId: ThreadId,
  ) => Effect.Effect<{ endpoint: string; authorizationHeader: string }, PiRpcError, Scope.Scope>;
}
type EventBody<E = ProviderRuntimeEvent> = E extends ProviderRuntimeEvent
  ? Omit<E, "provider" | "providerInstanceId" | "threadId" | "eventId" | "createdAt">
  : never;

/** One owned RPC process per session, including native continuation admission. */
export const makePiAdapter = (settings: PiSettings, options: PiAdapterOptions) =>
  Effect.gen(function* () {
    const rootScope = yield* Effect.scope;
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const storeImage = yield* makeToolResultImageStore;
    const extensionPath = yield* materializePiMcpExtension(options.cacheDir);
    const events = yield* PubSub.bounded<ProviderRuntimeEvent>(512);
    yield* Effect.addFinalizer(() => PubSub.shutdown(events));
    let closing = false;
    const sessions = new Map<ThreadId, PiContext>();
    const gate = makeOperationGate<ThreadId>();
    const requestError = (method: string, detail: string) =>
      new ProviderAdapterRequestError({ provider: "pi", method, detail });
    const owned = yield* makeOwnedOperation(rootScope, () =>
      requestError("startSession", "This Pi instance is closed."),
    );
    const wrap = <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((cause) =>
          Schema.is(ProviderAdapterRequestError)(cause) ||
          Schema.is(ProviderAdapterSessionNotFoundError)(cause)
            ? cause
            : requestError(method, `Pi ${method} failed. Refresh the session before retrying.`),
        ),
      );
    const stamp = (ctx: PiContext, body: EventBody): ProviderRuntimeEvent =>
      ({
        eventId: EventId.make(randomUUID()),
        provider: "pi",
        providerInstanceId: options.instanceId,
        threadId: ctx.threadId,
        createdAt: new Date().toISOString(),
        ...(ctx.turns.activeTurnId ? { turnId: TurnId.make(ctx.turns.activeTurnId) } : {}),
        ...body,
      }) as ProviderRuntimeEvent;
    const emit = (ctx: PiContext, body: EventBody) =>
      closing ? Effect.void : PubSub.publish(events, stamp(ctx, body)).pipe(Effect.asVoid);
    const requireSession = (threadId: ThreadId) =>
      Effect.suspend(() => {
        const ctx = sessions.get(threadId);
        return ctx && !ctx.closed
          ? Effect.succeed(ctx)
          : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: "pi", threadId }));
      });
    const orderedRequest = (ctx: PiContext, record: PiRpcRecord) =>
      Effect.gen(function* () {
        if (ctx.closed || ctx.barriers.size >= 8)
          return yield* new PiRpcError({
            operation: "history",
            detail: "Pi history admission is unavailable.",
          });
        const id = `f5-history:${randomUUID()}`;
        const reply = yield* Deferred.make<unknown, PiRpcError>();
        ctx.barriers.set(id, reply);
        return yield* ctx.rpc.send({ ...record, id }).pipe(
          Effect.andThen(Deferred.await(reply)),
          Effect.timeoutOrElse({
            duration: "5 seconds",
            onTimeout: () =>
              Effect.fail(
                new PiRpcError({
                  operation: "history",
                  detail: "Pi history did not respond before its deadline.",
                }),
              ),
          }),
          Effect.ensuring(
            Effect.sync(() => {
              ctx.barriers.delete(id);
            }),
          ),
        );
      });
    const history = (ctx: PiContext) =>
      readPiHistory({
        threadId: ctx.threadId,
        cursor: ctx.cursor,
        request: (record) => orderedRequest(ctx, record),
      });
    const resolvedDialog = (ctx: PiContext, request: PendingPiUiRequest, decision: string) =>
      emit(
        ctx,
        request.method === "confirm"
          ? {
              type: "request.resolved",
              ...(request.turnId ? { turnId: TurnId.make(request.turnId) } : {}),
              requestId: RuntimeRequestId.make(request.requestId),
              payload: {
                requestType:
                  request.title === "Allow edit?" || request.title === "Allow write?"
                    ? "file_change_approval"
                    : "command_execution_approval",
                decision,
              },
            }
          : {
              type: "user-input.resolved",
              ...(request.turnId ? { turnId: TurnId.make(request.turnId) } : {}),
              requestId: RuntimeRequestId.make(request.requestId),
              payload: { answers: {}, receipt: decision === "cancel" ? "cancelled" : "resolved" },
            },
      );
    const completeOpenItems = (ctx: PiContext, turnId: string, failed: boolean) =>
      Effect.gen(function* () {
        for (const item of ctx.output.completeOpen())
          yield* emit(ctx, {
            type: "item.completed",
            turnId: TurnId.make(turnId),
            itemId: RuntimeItemId.make(`${turnId}:${item.itemId}`),
            payload: {
              itemType: item.reasoning ? "reasoning" : "assistant_message",
              status: failed ? "failed" : "completed",
            },
          });
        for (const [callId, tool] of ctx.tools) {
          if (tool.done) continue;
          yield* emit(ctx, {
            type: "item.completed",
            turnId: TurnId.make(turnId),
            itemId: RuntimeItemId.make(`${turnId}:tool:${callId}`),
            payload: {
              ...piToolPayload({
                callId,
                name: tool.name,
                args: tool.args,
                completed: true,
                isError: true,
              }),
              status: failed ? "failed" : "declined",
            },
          });
          tool.done = true;
        }
      });
    const stop = (ctx: PiContext, reason: string, failed = false) =>
      Effect.gen(function* () {
        if (ctx.closed) return;
        ctx.closed = true;
        ctx.wake?.cancel();
        ctx.wake = null;
        for (const reply of ctx.barriers.values())
          yield* Deferred.fail(
            reply,
            new PiRpcError({ operation: "history", detail: "The Pi session closed." }),
          );
        ctx.barriers.clear();
        const turnId = ctx.turns.activeTurnId;
        const pending = ctx.dialogs.list();
        for (const record of ctx.dialogs.cancelAll())
          yield* ctx.rpc.send(record).pipe(Effect.ignore);
        for (const request of pending) yield* resolvedDialog(ctx, request, "cancel");
        yield* ctx.rpc.terminate;
        if (turnId) yield* completeOpenItems(ctx, turnId, failed);
        if (turnId)
          yield* emit(ctx, {
            type: "turn.completed",
            turnId: TurnId.make(turnId),
            payload: { state: failed ? "failed" : "cancelled", errorMessage: reason },
          });
        ctx.turns.close();
        ctx.output.clear();
        ctx.usage.clear();
        ctx.tools.clear();
        if (sessions.get(ctx.threadId) === ctx) sessions.delete(ctx.threadId);
        ctx.session = { ...ctx.session, status: "closed", updatedAt: new Date().toISOString() };
        yield* emit(ctx, { type: "session.exited", payload: { reason, recoverable: true } });
        // A pump cannot wait for its own scope to close.
        yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.forkDetach);
      });
    const finish = (ctx: PiContext, action: Extract<PiTurnAction, { type: "terminal" }>) =>
      Effect.gen(function* () {
        const tree = parsePiSessionTree(
          yield* ctx.rpc
            .request({ type: "get_entries" })
            .pipe(Effect.orElseSucceed(() => undefined)),
        );
        const boundary = tree ? capturePiTurnTreeBoundary(tree, ctx.cursor.leafId) : null;
        const state = yield* ctx.rpc
          .request({ type: "get_state" }, 2000)
          .pipe(Effect.orElseSucceed(() => undefined));
        const previousCursor = ctx.cursor;
        const sameSession = piRecordString(state, "sessionFile") === previousCursor.sessionFile;
        let nativeHistoryChanged =
          !boundary || boundary.retainedUserEntryIds !== undefined || !sameSession;
        if (nativeHistoryChanged) ctx.ready = false;
        const activeEntries = new Set(tree ? piActiveBranch(tree)?.map((entry) => entry.id) : []);
        if (boundary)
          ctx.cursor = {
            ...ctx.cursor,
            leafId: boundary.leafId,
            boundaries: [
              ...ctx.cursor.boundaries.filter(
                (known) =>
                  boundary.retainedUserEntryIds === undefined || activeEntries.has(known.entryId),
              ),
              ...(boundary.turnStartEntryId
                ? [{ turnId: action.turnId, entryId: boundary.turnStartEntryId }]
                : boundary.continuationStartEntryId
                  ? [
                      {
                        turnId: action.turnId,
                        entryId: boundary.continuationStartEntryId,
                        kind: "continuation" as const,
                      },
                    ]
                  : []),
            ].slice(-500),
          };
        if (
          boundary?.retainedUserEntryIds &&
          sameSession &&
          options.reconcileNativeHistory &&
          piRecordField(state, "isStreaming") === false
        ) {
          const cursor = ctx.cursor;
          const branchHash = piHistoryBoundaryHash([...activeEntries]);
          const verify = () =>
            readPiHistory({
              threadId: ctx.threadId,
              cursor,
              request: (record) =>
                ctx.rpc.request(record).pipe(
                  Effect.mapError(
                    () =>
                      new PiRpcError({
                        operation: "history",
                        detail: "Pi native history verification failed.",
                      }),
                  ),
                ),
            }).pipe(
              Effect.map(
                (snapshot) => piHistoryBoundaryHash(snapshot.activeEntryIds) === branchHash,
              ),
            );
          const reconciled = yield* Effect.gen(function* () {
            if (!(yield* verify())) return false;
            const accepted = yield* options.reconcileNativeHistory!({
              requestId: `pi-native-rewind:${ctx.generation}:${action.turnId}`,
              threadId: ctx.threadId,
              providerInstanceId: options.instanceId,
              turnId: TurnId.make(action.turnId),
              removedTurnIds: previousCursor.boundaries
                .filter((known) => !activeEntries.has(known.entryId))
                .map((known) => TurnId.make(known.turnId)),
              isCurrent: Effect.sync(
                () =>
                  !closing &&
                  !ctx.closed &&
                  sessions.get(ctx.threadId) === ctx &&
                  ctx.cursor === cursor,
              ),
            });
            return accepted && (yield* verify());
          }).pipe(Effect.orElseSucceed(() => false));
          if (reconciled) {
            nativeHistoryChanged = false;
            ctx.ready = true;
          }
        }
        yield* completeOpenItems(
          ctx,
          action.turnId,
          nativeHistoryChanged || action.state === "failed",
        );
        const pending = ctx.dialogs.list().filter((request) => request.turnId === action.turnId);
        for (const record of ctx.dialogs.cancelTurn(action.turnId))
          yield* ctx.rpc.send(record).pipe(Effect.ignore);
        for (const request of pending) yield* resolvedDialog(ctx, request, "cancel");
        const reportedUsage = ctx.usage.snapshot();
        const context = piContextUsage(
          yield* ctx.rpc
            .request({ type: "get_session_stats" }, 2000)
            .pipe(Effect.orElseSucceed(() => undefined)),
        );
        if (context)
          yield* emit(ctx, {
            type: "thread.token-usage.updated",
            turnId: TurnId.make(action.turnId),
            payload: { usage: {}, ...context },
          });
        ctx.output.clear();
        ctx.usage.clear();
        ctx.tools.clear();
        ctx.session = {
          ...ctx.session,
          status: nativeHistoryChanged ? "error" : "ready",
          activeTurnId: undefined,
          resumeCursor: ctx.cursor,
          updatedAt: new Date().toISOString(),
        };
        ctx.lastTurnId = TurnId.make(action.turnId);
        ctx.lastCommandId = ctx.activeCommandId;
        ctx.activeCommandId = undefined;
        ctx.continuationEligible = action.state === "completed" && !nativeHistoryChanged;
        yield* emit(ctx, {
          type: "turn.completed",
          turnId: TurnId.make(action.turnId),
          resumeCursor: ctx.cursor,
          payload: {
            state: nativeHistoryChanged
              ? "failed"
              : action.state === "interrupted"
                ? "cancelled"
                : action.state,
            ...(nativeHistoryChanged
              ? {
                  errorMessage:
                    "Pi changed native conversation history. Reconcile it before sending another prompt.",
                }
              : {}),
            ...reportedUsage,
          },
        });
      });
    const actions = (ctx: PiContext, list: readonly PiTurnAction[]): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const action of list)
          switch (action.type) {
            case "terminal":
              yield* finish(ctx, action);
              break;
            case "stop-session":
              yield* stop(ctx, "Pi could not verify native turn ownership or completion.", true);
              break;
            case "send":
              yield* ctx.rpc
                .send(action.record)
                .pipe(
                  Effect.catch(() => stop(ctx, "Pi idle verification could not be sent.", true)),
                );
              yield* Effect.sleep(action.timeoutMs).pipe(
                Effect.andThen(
                  Effect.suspend(() =>
                    ctx.eventGate.withPermit(
                      actions(ctx, ctx.turns.expireProbe(String(action.record.id))),
                    ),
                  ),
                ),
                Effect.forkIn(ctx.scope),
              );
              break;
            case "retry-probe":
              yield* Effect.sleep(action.delayMs).pipe(
                Effect.andThen(
                  Effect.suspend(() =>
                    ctx.eventGate.withPermit(
                      actions(ctx, ctx.turns.retryProbe(action.turnId, action.revision)),
                    ),
                  ),
                ),
                Effect.forkIn(ctx.scope),
              );
              break;
          }
      });
    const handleDialog = (ctx: PiContext, event: PiRpcRecord) =>
      Effect.gen(function* () {
        if (event.method === "notify") {
          const message = piRecordString(event, "message")?.trim();
          if (message)
            yield* emit(ctx, {
              type: "runtime.warning",
              payload: { message: message.slice(0, 4096), category: "provider" },
            });
          return;
        }
        const admitted = ctx.dialogs.open(
          event,
          ApprovalRequestId.make(randomUUID()),
          Date.now(),
          ctx.turns.activeTurnId,
        );
        if (admitted.type === "protocol-error")
          return yield* stop(ctx, "Pi reused an active dialog identity.", true);
        if (admitted.type === "cancelled")
          return yield* ctx.rpc.send(admitted.record).pipe(Effect.ignore);
        if (admitted.type !== "opened") return;
        const request = admitted.request;
        yield* emit(
          ctx,
          request.method === "confirm"
            ? {
                type: "request.opened",
                requestId: RuntimeRequestId.make(request.requestId),
                payload: {
                  requestType:
                    request.title === "Allow edit?" || request.title === "Allow write?"
                      ? "file_change_approval"
                      : "command_execution_approval",
                  detail: request.message.trim() || request.title,
                  approvalOptions: [
                    { decision: "accept", label: "Allow once" },
                    { decision: "decline", label: "Decline" },
                  ],
                },
              }
            : {
                type: "user-input.requested",
                requestId: RuntimeRequestId.make(request.requestId),
                payload: { questions: request.question ? [request.question] : [] },
              },
        );
        if (request.expiresAt !== null)
          yield* Effect.sleep(Math.max(0, request.expiresAt - Date.now())).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const record = ctx.dialogs.expire(request, Date.now());
                if (record) {
                  yield* ctx.rpc.send(record).pipe(Effect.ignore);
                  yield* resolvedDialog(ctx, request, "cancel");
                }
              }),
            ),
            Effect.forkIn(ctx.scope),
          );
      });
    const handleTool = (ctx: PiContext, event: PiRpcRecord) =>
      Effect.gen(function* () {
        const callId = piRecordString(event, "toolCallId");
        const nativeName = piRecordString(event, "toolName");
        if (!callId || callId.trim() !== callId || callId.includes("\0") || callId.length > 1024)
          return yield* stop(ctx, "Pi returned an invalid tool call identity.", true);
        let tool = ctx.tools.get(callId);
        if (tool?.done) return;
        if (event.type === "tool_execution_start") {
          if (
            tool ||
            ctx.tools.size >= 4096 ||
            !nativeName ||
            !nativeName.trim() ||
            nativeName.length > 512
          )
            return yield* stop(ctx, "Pi tool call ownership could not be verified.", true);
          const args = stringifyWithinBytes(event.args, 16 * 1024);
          tool = {
            name: nativeName,
            args: args === undefined ? undefined : (JSON.parse(args) as unknown),
            done: false,
          };
          ctx.tools.set(callId, tool);
        }
        if (!tool || (nativeName !== undefined && tool.name !== nativeName))
          return yield* stop(ctx, "Pi returned an unowned tool result.", true);
        const completed = event.type === "tool_execution_end";
        const result = completed ? event.result : event.partialResult;
        const extraction = extractToolResultImages(result);
        const projected = stamp(ctx, {
          type: completed
            ? "item.completed"
            : event.type === "tool_execution_start"
              ? "item.started"
              : "item.updated",
          itemId: RuntimeItemId.make(`${ctx.turns.activeTurnId}:tool:${callId}`),
          payload: piToolPayload({
            callId,
            name: tool.name,
            args: tool.args,
            result: extraction.scrubbed,
            completed,
            isError: event.isError === true,
          }),
        });
        if (
          projected.type !== "item.started" &&
          projected.type !== "item.updated" &&
          projected.type !== "item.completed"
        )
          return;
        const refs = [];
        let omitted = extraction.omitted;
        // Intermediate images are transient; only the final native result owns attachments.
        if (completed) {
          for (const image of extraction.images) {
            const ref = yield* storeImage(projected, image).pipe(
              Effect.catch(() => Effect.succeed(null)),
            );
            if (ref) refs.push(ref);
            else omitted++;
          }
        } else omitted += extraction.images.length;
        tool.done = completed;
        if (completed) tool.args = undefined;
        yield* PubSub.publish(events, {
          ...projected,
          payload: {
            ...projected.payload,
            ...(refs.length ? { mcpImages: refs } : {}),
            ...(omitted ? { mcpImagesOmitted: omitted } : {}),
          },
        });
      });
    const beginWake = (ctx: PiContext, event: PiRpcRecord) =>
      Effect.gen(function* () {
        if (
          !options.offerContinuation ||
          !ctx.ready ||
          ctx.lifecycle ||
          !ctx.lastTurnId ||
          !ctx.continuationEligible
        )
          return yield* stop(
            ctx,
            "Pi started native work without an available F5 continuation owner.",
            true,
          );
        const wake = new PiNativeWake(randomUUID(), ctx.generation, Date.now());
        if (!wake.push(event, Date.now()))
          return yield* stop(ctx, "Pi native wake could not be buffered.", true);
        ctx.wake = wake;
        const request: ProviderContinuationRequest = {
          requestId: wake.requestId,
          threadId: ctx.threadId,
          providerInstanceId: options.instanceId,
          generation: ctx.generation,
          createdAt: wake.createdAt,
          previousTurnId: ctx.lastTurnId,
          ...(ctx.lastCommandId ? { previousCommandId: ctx.lastCommandId } : {}),
          runtimeMode: ctx.session.runtimeMode,
          model: ctx.session.model,
          status: Effect.sync(() =>
            wake.adopted
              ? "adopted"
              : ctx.closed ||
                  ctx.wake !== wake ||
                  !wake.isCurrent(wake.requestId, ctx.generation, Date.now())
                ? "closed"
                : "pending",
          ),
          dispatchIfCurrent: (effect) =>
            ctx.eventGate.withPermit(
              Effect.suspend(() =>
                !ctx.closed &&
                ctx.wake === wake &&
                wake.isCurrent(wake.requestId, ctx.generation, Date.now())
                  ? effect.pipe(Effect.map(Option.some))
                  : Effect.succeed(Option.none()),
              ),
            ),
          clearIfCurrent: ctx.eventGate.withPermit(
            Effect.suspend(() => {
              if (ctx.wake !== wake || ctx.closed) return Effect.void;
              wake.cancel();
              ctx.wake = null;
              return stop(
                ctx,
                "Pi native continuation was declined, expired or superseded by F5.",
                true,
              );
            }),
          ),
        };
        if (!(yield* options.offerContinuation(request)))
          return yield* stop(ctx, "F5 continuation admission is full or already owned.", true);
        ctx.wakeTimer = yield* Effect.sleep(PI_NATIVE_WAKE_ADMISSION_MS).pipe(
          Effect.andThen(request.clearIfCurrent),
          Effect.forkIn(ctx.scope),
        );
      });
    const nativeEvent = (ctx: PiContext, event: PiRpcRecord) =>
      Effect.gen(function* () {
        if (ctx.closed) return;
        const barrier =
          event.type === "response" && typeof event.id === "string"
            ? ctx.barriers.get(event.id)
            : undefined;
        if (barrier) {
          ctx.barriers.delete(String(event.id));
          if (event.success === true) yield* Deferred.succeed(barrier, event.data);
          else
            yield* Deferred.fail(
              barrier,
              new PiRpcError({
                operation: "history",
                detail: "Pi rejected the history operation.",
              }),
            );
          return;
        }
        if (ctx.wake) {
          if (!ctx.wake.push(event, Date.now()))
            yield* stop(ctx, "Pi native continuation exceeded its bounded admission window.", true);
          return;
        }
        if (!ctx.turns.activeTurnId && event.type === "agent_start")
          return yield* beginWake(ctx, event);
        if (event.type === "extension_ui_request") return yield* handleDialog(ctx, event);
        if (
          ctx.turns.activeTurnId &&
          (event.type === "tool_execution_start" ||
            event.type === "tool_execution_update" ||
            event.type === "tool_execution_end")
        ) {
          yield* handleTool(ctx, event);
          if (ctx.closed) return;
        }
        if (ctx.turns.activeTurnId) {
          if (!ctx.usage.observe(event))
            return yield* stop(ctx, "Pi usage output exceeded its message limit.", true);
          const projected = ctx.output.observe(event);
          if (!projected)
            return yield* stop(
              ctx,
              "Pi assistant output was inconsistent or exceeded its limit.",
              true,
            );
          for (const item of projected) {
            const itemId = RuntimeItemId.make(`${ctx.turns.activeTurnId}:${item.itemId}`);
            if (item.type === "delta") {
              yield* emit(ctx, {
                type: "content.delta",
                itemId,
                payload: {
                  streamKind: item.reasoning ? "reasoning_text" : "assistant_text",
                  delta: item.text,
                },
              });
            } else {
              yield* emit(ctx, {
                type: item.type === "start" ? "item.started" : "item.completed",
                itemId,
                payload: {
                  itemType: item.reasoning ? "reasoning" : "assistant_message",
                  status: item.type === "start" ? "inProgress" : "completed",
                },
              });
            }
          }
        }
        yield* actions(ctx, ctx.turns.observe(event));
      });
    const adoptWake = (ctx: PiContext, input: ProviderAdapterSendTurnInput, claimed: () => void) =>
      ctx.eventGate.withPermit(
        Effect.gen(function* () {
          if (
            ctx.closed ||
            ctx.lifecycle ||
            ctx.turns.activeTurnId ||
            !ctx.ready ||
            !ctx.wake ||
            !input.continuationRequestId ||
            ((input.interactionMode !== undefined ||
              input.workflowExecutionProfile !== undefined) &&
              (input.interactionMode === "plan" || input.workflowExecutionProfile !== undefined) !==
                ctx.readOnly) ||
            (input.modelSelection && input.modelSelection.instanceId !== options.instanceId) ||
            ((input.modelSelection?.model ?? input.model) !== undefined &&
              (input.modelSelection?.model ?? input.model) !== ctx.session.model)
          )
            return yield* requestError(
              "sendTurn",
              "This Pi continuation is no longer current; no prompt was sent.",
            );
          const records = ctx.wake.take(input.continuationRequestId, ctx.generation, Date.now());
          if (!records)
            return yield* requestError(
              "sendTurn",
              "This Pi continuation expired; no prompt was sent.",
            );
          claimed();
          ctx.wake = null;
          if (ctx.wakeTimer) yield* Fiber.interrupt(ctx.wakeTimer);
          ctx.wakeTimer = undefined;
          const turnId = TurnId.make(randomUUID());
          ctx.turns.admitContinuation(turnId);
          ctx.activeCommandId = input.deliveryId;
          ctx.session = {
            ...ctx.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: new Date().toISOString(),
          };
          yield* emit(ctx, { type: "turn.started", turnId, payload: { model: ctx.session.model } });
          for (const event of records) yield* nativeEvent(ctx, event);
          return { threadId: input.threadId, turnId, resumeCursor: ctx.cursor };
        }),
      );
    const applySelection = (
      ctx: PiContext,
      input: Pick<ProviderAdapterSendTurnInput, "model" | "modelSelection" | "modelOptions">,
    ) =>
      Effect.gen(function* () {
        const wasReady = ctx.ready;
        if (input.modelSelection && input.modelSelection.instanceId !== options.instanceId)
          return yield* requestError(
            "model",
            "The selected model belongs to a different Pi instance.",
          );
        const selected = input.modelSelection?.model ?? input.model;
        const model =
          selected && selected !== "default"
            ? parsePiModelSlug(selected)
            : selected === "default"
              ? ctx.baselineModel
              : undefined;
        if (selected && !model)
          return yield* requestError(
            "model",
            "Pi requires a qualified provider/model identifier or a reported default.",
          );
        const modelChanged =
          model !== undefined && model !== null && selected !== ctx.session.model;
        if (modelChanged) ctx.ready = false;
        if (modelChanged)
          yield* ctx.rpc.request({
            type: "set_model",
            provider: model.provider,
            modelId: model.modelId,
          });
        const thinking =
          getModelSelectionStringOptionValue(input.modelSelection, "thinking") ??
          input.modelOptions?.pi?.thinking ??
          (selected === "default" ? ctx.baselineThinking : undefined);
        const thinkingChanged =
          thinking !== undefined && (modelChanged || thinking !== ctx.appliedThinking);
        if (thinkingChanged) ctx.ready = false;
        if (thinkingChanged)
          yield* ctx.rpc.request({ type: "set_thinking_level", level: thinking });
        if (modelChanged || thinkingChanged) {
          const state = yield* ctx.rpc.request({ type: "get_state" });
          const actual = piRecordField(state, "model");
          if (
            (modelChanged &&
              (piRecordString(actual, "provider") !== model?.provider ||
                piRecordString(actual, "id") !== model?.modelId)) ||
            (thinkingChanged && piRecordString(state, "thinkingLevel") !== thinking)
          )
            return yield* requestError(
              "model",
              "Pi did not confirm the requested model and thinking settings.",
            );
          ctx.appliedThinking = piRecordString(state, "thinkingLevel");
          ctx.ready = wasReady;
        }
        if (selected) ctx.session = { ...ctx.session, model: selected };
      });
    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      owned(
        gate(
          input.threadId,
          wrap(
            "startSession",
            Effect.gen(function* () {
              const old = sessions.get(input.threadId);
              if (old && !old.closed) {
                if (!old.ready)
                  return yield* requestError(
                    "startSession",
                    "Pi requires session reconciliation before it can be resumed.",
                  );
                return old.session;
              }
              if (!settings.enabled) return yield* requestError("startSession", "Pi is disabled.");
              const unsupported = runtimeModeUnsupportedReason("pi", input.runtimeMode);
              if (unsupported) return yield* requestError("startSession", unsupported);
              const parsed = resolvePiLaunchArgs(settings.launchArgs);
              const cwd = input.cwd;
              if (!parsed.ok || !cwd)
                return yield* requestError(
                  "startSession",
                  parsed.ok ? "A Pi workspace is required." : parsed.message,
                );
              const resume =
                input.resumeCursor === undefined
                  ? undefined
                  : parsePiResumeCursor(input.resumeCursor);
              if (input.resumeCursor !== undefined && !resume)
                return yield* requestError(
                  "resume",
                  "Pi resume metadata is invalid; a fresh session was not created.",
                );
              const scope = yield* Scope.make("sequential");
              let opening: PiContext | undefined;
              return yield* Scope.provide(
                Effect.gen(function* () {
                  if (options.beforeLaunch) yield* options.beforeLaunch;
                  const version = yield* readPiVersion(settings.binaryPath, options.environment);
                  if (!piVersionSupportsF5(version))
                    return yield* requestError("startSession", "Pi 0.80.5 or newer is required.");
                  const mcpSession = options.createMcpSession
                    ? yield* options.createMcpSession(input.threadId)
                    : undefined;
                  const launch = buildPiRpcLaunch({
                    launchArgs: parsed.args,
                    environment: options.environment,
                    extensionPath,
                    mcpSession,
                    runtimeMode: input.runtimeMode,
                    readOnly:
                      input.interactionMode === "plan" ||
                      input.workflowExecutionProfile !== undefined,
                  });
                  const rpc = yield* makePiRpcConnection({
                    command: settings.binaryPath || "pi",
                    args: launch.args,
                    cwd,
                    env: launch.env,
                  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
                  const now = new Date().toISOString();
                  const generation = randomUUID();
                  const ctx: PiContext = {
                    threadId: input.threadId,
                    generation,
                    scope,
                    rpc,
                    turns: new PiTurnState(),
                    dialogs: new PiUiRequests(generation),
                    eventGate: Semaphore.makeUnsafe(1),
                    baselineModel: null,
                    baselineThinking: undefined,
                    appliedThinking: undefined,
                    output: new PiAssistantOutput(),
                    usage: new PiTurnUsage(),
                    tools: new Map(),
                    barriers: new Map(),
                    readOnly:
                      input.interactionMode === "plan" ||
                      input.workflowExecutionProfile !== undefined,
                    activeCommandId: undefined,
                    lastCommandId: undefined,
                    continuationEligible: false,
                    wake: null,
                    wakeTimer: undefined,
                    lastTurnId: resume?.boundaries.at(-1)?.turnId
                      ? TurnId.make(resume.boundaries.at(-1)!.turnId)
                      : undefined,
                    lifecycle: false,
                    ready: false,
                    closed: false,
                    cursor: resume ?? {
                      schemaVersion: 1,
                      sessionFile: "",
                      leafId: null,
                      boundaries: [],
                    },
                    session: {
                      provider: "pi",
                      providerInstanceId: options.instanceId,
                      threadId: input.threadId,
                      status: "connecting",
                      runtimeMode: input.runtimeMode,
                      cwd,
                      createdAt: now,
                      updatedAt: now,
                    },
                  };
                  opening = ctx;
                  sessions.set(input.threadId, ctx);
                  yield* rpc.events.pipe(
                    Stream.runForEach((event) => ctx.eventGate.withPermit(nativeEvent(ctx, event))),
                    Effect.catchCause((cause) =>
                      Cause.hasInterruptsOnly(cause)
                        ? Effect.interrupt
                        : stop(ctx, "Pi transport stopped unexpectedly.", true),
                    ),
                    Effect.forkIn(scope),
                  );
                  if (resume) {
                    const result = yield* rpc.request({
                      type: "switch_session",
                      sessionPath: resume.sessionFile,
                    });
                    if (piRecordField(result, "cancelled") === true)
                      return yield* requestError(
                        "resume",
                        "A Pi extension cancelled the native session switch.",
                      );
                  }
                  const catalog = yield* readPiCatalog(rpc);
                  const sessionFile = piRecordString(catalog.state, "sessionFile");
                  if (!sessionFile || (resume && sessionFile !== resume.sessionFile))
                    return yield* requestError(
                      "startSession",
                      "Pi did not confirm the expected persisted session file.",
                    );
                  const nativeModel = piRecordField(catalog.state, "model");
                  const provider = piRecordString(nativeModel, "provider"),
                    modelId = piRecordString(nativeModel, "id");
                  ctx.baselineModel = provider && modelId ? { provider, modelId } : null;
                  ctx.baselineThinking = piRecordString(catalog.state, "thinkingLevel");
                  ctx.appliedThinking = ctx.baselineThinking;
                  const tree = parsePiSessionTree(yield* rpc.request({ type: "get_entries" }));
                  if (!tree)
                    return yield* requestError(
                      "startSession",
                      "Pi did not provide a valid persisted conversation tree.",
                    );
                  ctx.cursor = { ...ctx.cursor, sessionFile, leafId: tree.leafId };
                  yield* applySelection(ctx, input);
                  ctx.ready = true;
                  ctx.session = {
                    ...ctx.session,
                    status: "ready",
                    resumeCursor: ctx.cursor,
                    model: input.modelSelection?.model ?? input.model ?? "default",
                  };
                  yield* emit(ctx, {
                    type: "session.started",
                    resumeCursor: ctx.cursor,
                    payload: { resume: ctx.cursor },
                  });
                  yield* emit(ctx, {
                    type: "session.configured",
                    payload: {
                      config: {
                        models: catalog.models,
                        slashCommands: catalog.slashCommands,
                        skills: catalog.skills,
                      },
                    },
                  });
                  if (options.onCatalog) yield* options.onCatalog(catalog);
                  return ctx.session;
                }),
                scope,
              ).pipe(
                Effect.onExit((exit) =>
                  exit._tag === "Failure"
                    ? Effect.gen(function* () {
                        if (opening) opening.closed = true;
                        if (sessions.get(input.threadId) === opening)
                          sessions.delete(input.threadId);
                        yield* Scope.close(scope, Exit.void);
                      })
                    : Effect.void,
                ),
              );
            }),
          ),
        ),
      );
    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      gate(
        input.threadId,
        wrap(
          "sendTurn",
          Effect.suspend(() => {
            let deliveryStarted = false;
            return Effect.gen(function* () {
              const ctx = yield* requireSession(input.threadId);
              if (input.continuationRequestId)
                return yield* adoptWake(ctx, input, () => {
                  deliveryStarted = true;
                });
              if (ctx.wake)
                return yield* new ProviderAdapterRequestError({
                  provider: "pi",
                  method: "sendTurn",
                  deliveryCertainty: "not_sent",
                  deliveryRetryable: true,
                  detail: "Pi native work is waiting for F5 continuation admission.",
                });
              if (!ctx.ready || ctx.lifecycle || ctx.turns.activeTurnId)
                return yield* requestError("sendTurn", "Pi is not ready for another turn.");
              if (
                (input.interactionMode !== undefined ||
                  input.workflowExecutionProfile !== undefined) &&
                (input.interactionMode === "plan" ||
                  input.workflowExecutionProfile !== undefined) !== ctx.readOnly
              )
                return yield* requestError(
                  "sendTurn",
                  "Restart the Pi session before changing its read-only policy.",
                );
              yield* applySelection(ctx, input);
              const attachments = input.resolvedAttachments ?? [];
              const images: { type: "image"; data: string; mimeType: string }[] = [];
              let imageBytes = 0;
              for (const attachment of attachments)
                if (attachment.type === "image" && images.length < 10) {
                  if (
                    attachment.sizeBytes > 8 * 1024 * 1024 ||
                    imageBytes + attachment.sizeBytes > 8 * 1024 * 1024
                  )
                    break;
                  const bytes = Buffer.concat(
                    yield* fs
                      .stream(attachment.localPath, { bytesToRead: 8 * 1024 * 1024 + 1 })
                      .pipe(Stream.runCollect),
                  );
                  if (
                    bytes.byteLength > 8 * 1024 * 1024 ||
                    imageBytes + bytes.byteLength > 8 * 1024 * 1024
                  )
                    return yield* requestError(
                      "attachments",
                      "Pi images exceed the inline request limit.",
                    );
                  imageBytes += bytes.byteLength;
                  images.push({
                    type: "image",
                    data: Buffer.from(bytes).toString("base64"),
                    mimeType: attachment.mimeType,
                  });
                }
              const context = buildProviderAttachmentRuntimeContext(attachments);
              const message = [input.input ?? "", context, input.mcpAppContext]
                .filter(Boolean)
                .join("\n\n");
              const compact = parsePiCompactCommand(message);
              const turnId = TurnId.make(randomUUID());
              yield* ctx.eventGate.withPermit(
                Effect.gen(function* () {
                  if (ctx.closed || ctx.turns.activeTurnId)
                    return yield* requestError("sendTurn", "Pi turn ownership changed.");
                  ctx.activeCommandId = input.deliveryId;
                  const id = ctx.turns.admit({
                    turnId,
                    command: compact ? "compact" : "prompt",
                    commandOnly: compact !== null || message.trimStart().startsWith("/"),
                  });
                  ctx.session = {
                    ...ctx.session,
                    status: "running",
                    activeTurnId: turnId,
                    updatedAt: new Date().toISOString(),
                  };
                  deliveryStarted = true;
                  // Native work can start before its wake reaches F5. Steering lets Pi
                  // queue the prompt into that run, or start an idle run as usual.
                  yield* ctx.rpc
                    .send(
                      compact
                        ? { type: "compact", id, ...compact }
                        : {
                            type: "prompt",
                            id,
                            message,
                            streamingBehavior: "steer",
                            ...(images.length ? { images } : {}),
                          },
                    )
                    .pipe(
                      Effect.tapError(() =>
                        stop(ctx, "Pi turn delivery could not be verified.", true),
                      ),
                    );
                  yield* emit(ctx, {
                    type: "turn.started",
                    turnId,
                    payload: { model: ctx.session.model },
                  });
                }),
              );
              return { threadId: input.threadId, turnId, resumeCursor: ctx.cursor };
            }).pipe(
              Effect.mapError((cause) =>
                deliveryStarted
                  ? cause
                  : new ProviderAdapterRequestError({
                      provider: "pi",
                      method: "sendTurn",
                      deliveryCertainty: "not_sent",
                      deliveryRetryable: Schema.is(ProviderAdapterRequestError)(cause)
                        ? (cause.deliveryRetryable ?? false)
                        : false,
                      detail: Schema.is(ProviderAdapterRequestError)(cause)
                        ? cause.detail
                        : "Pi rejected this turn before sending its prompt.",
                    }),
              ),
            );
          }),
        ),
      );
    const respond = (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      decision?: import("@t3tools/contracts").ProviderApprovalDecision,
      answers?: Record<string, unknown>,
    ) =>
      wrap(
        "respond",
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const pending = ctx.dialogs.get(requestId);
          if (!pending)
            return yield* requestError("respond", "This Pi dialog is no longer pending.");
          const response = ctx.dialogs.answer({
            requestId,
            generation: ctx.dialogs.generation,
            now: Date.now(),
            ...(decision ? { decision } : {}),
            ...(answers ? { answer: answers[requestId] } : {}),
          });
          if (!response)
            return yield* requestError("respond", "This Pi dialog belongs to an old session.");
          yield* ctx.rpc.send(response.record);
          yield* resolvedDialog(
            ctx,
            pending,
            response.expired || response.record.cancelled === true
              ? "cancel"
              : (decision ?? "accept"),
          );
          if (response.expired)
            return yield* requestError(
              "respond",
              "This Pi dialog expired before the answer arrived.",
            );
        }),
      );
    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider: "pi",
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn: (threadId) =>
        wrap(
          "interruptTurn",
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            if (ctx.wake)
              return yield* stop(ctx, "Pi native continuation interrupted by the user.");
            const abort = ctx.turns.interrupt();
            if (abort) yield* ctx.rpc.send(abort);
          }),
        ),
      respondToRequest: (threadId, requestId, decision) => respond(threadId, requestId, decision),
      respondToUserInput: (threadId, requestId, answers) =>
        respond(threadId, requestId, undefined, answers),
      stopSession: (threadId) =>
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (ctx) {
            yield* stop(ctx, "Pi session stopped.");
            yield* Scope.close(ctx.scope, Exit.void);
            if (sessions.get(threadId) === ctx) sessions.delete(threadId);
          }
        }),
      stopAll: () =>
        Effect.forEach([...sessions.keys()], (threadId) => adapter.stopSession(threadId)).pipe(
          Effect.asVoid,
        ),
      listSessions: () =>
        Effect.sync(() =>
          [...sessions.values()].filter((ctx) => !ctx.closed).map((ctx) => ctx.session),
        ),
      hasSession: (threadId) =>
        Effect.sync(() => {
          const ctx = sessions.get(threadId);
          return !!ctx && ctx.ready && !ctx.closed;
        }),
      readThread: (threadId) =>
        gate(
          threadId,
          wrap(
            "readThread",
            Effect.gen(function* () {
              const ctx = yield* requireSession(threadId);
              if (ctx.wake)
                return yield* requestError(
                  "readThread",
                  "Pi native output is waiting for F5 continuation admission.",
                );
              return (yield* history(ctx)).snapshot;
            }),
          ),
        ),
      rollbackThread: (threadId, numTurns, rollbackOptions) =>
        gate(
          threadId,
          wrap(
            "rollbackThread",
            Effect.gen(function* () {
              const ctx = yield* requireSession(threadId);
              if (
                ctx.turns.activeTurnId ||
                ctx.wake !== null ||
                ctx.lifecycle ||
                !Number.isSafeInteger(numTurns) ||
                numTurns < 1
              )
                return yield* requestError(
                  "rollbackThread",
                  "Pi rewind requires an idle session and a positive turn count.",
                );
              const before = yield* history(ctx);
              if (
                rollbackOptions?.beforeTurnId &&
                rollbackOptions.beforeTurnId === ctx.cursor.rewindBeforeTurnId
              ) {
                if (
                  ctx.cursor.rewindRetainedHash ===
                  piHistoryBoundaryHash(
                    ctx.cursor.rewindBoundaryKind === "entries"
                      ? before.activeEntryIds
                      : before.userEntryIds,
                  )
                )
                  return before.snapshot;
                return yield* requestError(
                  "rollbackThread",
                  "The prior Pi rewind still requires reconciliation; it was not replayed.",
                );
              }
              const index = rollbackOptions?.beforeTurnId
                ? before.snapshot.turns.findIndex(
                    (turn) => turn.id === rollbackOptions.beforeTurnId,
                  )
                : before.snapshot.turns.length - numTurns;
              if (index < 0 || before.snapshot.turns.length - index !== numTurns)
                return yield* requestError(
                  "rollbackThread",
                  "The Pi rewind boundary no longer matches the selected turns.",
                );
              const activeBranch = piActiveBranch(before.tree)!;
              const selectedEntryId = before.turnEntryIds[index];
              const branchIndex = activeBranch.findIndex((entry) => entry.id === selectedEntryId);
              if (branchIndex < 0 || !activeBranch[branchIndex]?.user)
                return yield* requestError(
                  "rollbackThread",
                  "Select a native user turn to rewind; an assistant-only continuation has no Pi fork boundary.",
                );
              const discarded = activeBranch
                .slice(branchIndex)
                .filter((entry) => entry.user)
                .map((entry) => entry.id);
              const entryId = piRollbackEntry(before.tree, discarded);
              const firstTurn = before.snapshot.turns[index];
              if (
                !entryId ||
                !firstTurn ||
                !ctx.cursor.boundaries.some(
                  (boundary) => boundary.entryId === entryId && boundary.turnId === firstTurn.id,
                )
              )
                return yield* requestError(
                  "rollbackThread",
                  "This Pi turn has no captured native rewind boundary.",
                );
              const retained = activeBranch.slice(0, branchIndex).map((entry) => entry.id);
              const previousFile = ctx.cursor.sessionFile;
              ctx.lifecycle = true;
              return yield* Effect.gen(function* () {
                // Delivery may succeed even when its acknowledgement is lost. Block prompts
                // before mutating native history and reopen only after verified read-back.
                ctx.ready = false;
                const fork = yield* orderedRequest(ctx, { type: "fork", entryId });
                if (piRecordField(fork, "cancelled") === true) {
                  ctx.ready = true;
                  return yield* requestError(
                    "rollbackThread",
                    "A Pi extension cancelled the native rewind.",
                  );
                }
                const state = yield* orderedRequest(ctx, { type: "get_state" });
                const sessionFile = piRecordString(state, "sessionFile");
                if (
                  !sessionFile ||
                  sessionFile === previousFile ||
                  !parsePiResumeCursor({
                    schemaVersion: 1,
                    sessionFile,
                    leafId: null,
                    boundaries: [],
                  })
                ) {
                  ctx.ready = false;
                  return yield* requestError(
                    "rollbackThread",
                    "Pi changed its native cursor without confirming a new persisted session file.",
                  );
                }
                const tree = parsePiSessionTree(
                  yield* orderedRequest(ctx, { type: "get_entries" }).pipe(
                    Effect.orElseSucceed(() => undefined),
                  ),
                );
                ctx.cursor = {
                  ...ctx.cursor,
                  sessionFile,
                  leafId: tree?.leafId ?? null,
                  boundaries: ctx.cursor.boundaries.filter((boundary) =>
                    retained.includes(boundary.entryId),
                  ),
                  rewindSourceThreadId: previousFile,
                  rewindBeforeTurnId: firstTurn.id,
                  rewindRetainedHash: piHistoryBoundaryHash(retained),
                  rewindBoundaryKind: "entries",
                };
                ctx.ready = false;
                ctx.session = {
                  ...ctx.session,
                  resumeCursor: ctx.cursor,
                  updatedAt: new Date().toISOString(),
                };
                yield* emit(ctx, {
                  type: "session.configured",
                  resumeCursor: ctx.cursor,
                  payload: { config: { nativeSessionFile: sessionFile } },
                });
                if (rollbackOptions?.onAdoptSession)
                  yield* Effect.tryPromise({
                    try: () => rollbackOptions.onAdoptSession!(ctx.session),
                    catch: () =>
                      new PiRpcError({
                        operation: "history",
                        detail: "The new Pi cursor could not be persisted.",
                      }),
                  });
                const branch = tree ? piActiveBranch(tree) : null;
                const actual = branch?.map((entry) => entry.id);
                if (
                  ctx.closed ||
                  ctx.turns.activeTurnId ||
                  !actual ||
                  actual.length !== retained.length ||
                  actual.some((id, position) => id !== retained[position])
                )
                  return yield* requestError(
                    "rollbackThread",
                    "Pi rewind read-back did not prove the retained conversation boundary.",
                  );
                const verified = yield* history(ctx);
                const expected = before.snapshot.turns.slice(0, index).map((turn) => turn.id);
                if (
                  verified.snapshot.turns.length !== expected.length ||
                  verified.snapshot.turns.some((turn, position) => turn.id !== expected[position])
                )
                  return yield* requestError(
                    "rollbackThread",
                    "Pi rewind history changed before verification finished.",
                  );
                ctx.ready = true;
                return verified.snapshot;
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    ctx.lifecycle = false;
                  }),
                ),
              );
            }),
          ),
        ),
      streamEvents: Stream.fromPubSub(events),
      runOneOffPrompt: (input) =>
        wrap(
          "runOneOffPrompt",
          owned(
            Effect.gen(function* () {
              if (input.modelSelection && input.modelSelection.instanceId !== options.instanceId)
                return yield* requestError(
                  "runOneOffPrompt",
                  "The model belongs to a different Pi instance.",
                );
              const text = yield* runPiMetadataPrompt({
                settings,
                environment: options.environment,
                prompt: input.prompt,
                model: input.modelSelection?.model ?? input.model,
                thinking: getModelSelectionStringOptionValue(input.modelSelection, "thinking"),
                ...(options.beforeLaunch ? { beforeLaunch: options.beforeLaunch } : {}),
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              );
              return { text };
            }),
          ),
        ),
      getSessionDiscovery: (threadId) =>
        Effect.sync(() => ({
          outcome: sessions.get(threadId)?.ready ? ("discovered" as const) : ("pending" as const),
          nativeCommands: sessions.get(threadId)?.ready === true,
          nativeCompaction: sessions.get(threadId)?.ready === true,
        })),
    };
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        closing = true;
        yield* PubSub.shutdown(events);
        yield* adapter.stopAll().pipe(Effect.ignore);
      }),
    );
    return adapter;
  });
