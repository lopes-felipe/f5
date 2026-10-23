import type { ProviderAdapterSessionStartInput } from "../Services/ProviderAdapter.ts";
import { isSyntheticOneOffThreadId } from "../../codexAppServerManager";
import { automationEventSanitizer } from "@t3tools/shared/automationActivitySanitizer";
import {
  prepareAcpAutomationCatalogs,
  classifyAcpToolEvent,
  type AcpAutomationCatalogs,
} from "../acp/AcpAutomationCatalogs";
import type { PreviewMcpHttpServerShape } from "../../mcp/PreviewMcpHttpServer";
import type { ComputerAutomationBrokerRuntime } from "../../computer/ComputerAutomationBroker";
import { makeAutomationRuntimeEventPreparer } from "../prepareAutomationRuntimeEvent";
import { providerRuntimeCapabilities } from "@t3tools/shared/providerRuntimeCapabilities";
import { normalizeSupportedSlashCommands } from "../supportedSlashCommands.ts";
/**
 * CursorAdapterLive — Cursor CLI (`agent acp`) via ACP.
 *
 * @module CursorAdapterLive
 */
import * as nodePath from "node:path";

import {
  ApprovalRequestId,
  type CursorSettings,
  type ProviderOptionSelection,
  EventId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderKind,
  type ProviderModelOptions,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderInstanceId,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { cursorModelOptionsToProviderOptionSelections } from "@t3tools/shared/model";
import { assertNever } from "@t3tools/shared/exhaustive";
import {
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  PubSub,
  Random,
  Scope,
  Semaphore,
  Stream,
  SynchronizedRef,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  acpCursorSerializationWaitsTotal,
  providerMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { acpPermissionOutcome, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import { type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  type AcpSessionMode,
  type AcpSessionModeState,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggers, redactAcpLogPayload } from "../acp/AcpNativeLogging.ts";
import { applyCursorAcpModelSelection, makeCursorAcpRuntime } from "../acp/CursorAcpSupport.ts";
import {
  CursorAskQuestionRequest,
  CursorCreatePlanRequest,
  CursorUpdateTodosRequest,
  extractAskQuestions,
  extractPlanMarkdown,
  extractTodosAsPlan,
} from "../acp/CursorAcpExtension.ts";
import { discoverCursorSkills, cursorSkillCommands } from "../acp/CursorSkills.ts";
import { CursorTransportFailure } from "../acp/CursorTransportFailure.ts";
import { type CursorAdapterShape } from "../Services/CursorAdapter.ts";
import { resolveCursorAcpBaseModelId } from "./CursorProvider.ts";
import {
  writeProviderEventLog,
  type EventNdjsonLogger,
  makeEventNdjsonLogger,
} from "./EventNdjsonLogger.ts";
import { buildProviderAttachmentRuntimeContext } from "../attachmentRuntimeContext.ts";

const PROVIDER: ProviderKind = "cursor";
const CURSOR_RESUME_VERSION = 1 as const;
const ACP_PLAN_MODE_ALIASES = ["plan", "architect"];
const ACP_IMPLEMENT_MODE_ALIASES = ["code", "agent", "default", "chat", "implement"];
const ACP_APPROVAL_MODE_ALIASES = ["ask"];

export interface CursorAdapterLiveOptions {
  /** Certification/test seam; production drivers leave this unset. */
  readonly automationCatalogVerification?: { preview?: boolean; computer?: boolean };
  readonly previewMcpHttpServer?: PreviewMcpHttpServerShape;
  readonly computerAutomationBroker?: ComputerAutomationBrokerRuntime;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Selections are honored when `modelSelection.instanceId` matches this value.
   * Defaults to the legacy built-in instance id (`cursor`).
   */
  readonly instanceId?: typeof ProviderInstanceId.Type;
  /**
   * Optional per-session settings resolver. When provided the adapter yields
   * this effect at the start of every session and uses the result instead of
   * the `cursorSettings` captured at construction.
   *
   * Production instances bind settings to the instance scope (the hydration
   * layer rebuilds the adapter on config change) and leave this undefined.
   * Test suites that mutate `ServerSettingsService` mid-flight — e.g. to
   * swap `binaryPath` to a mock ACP wrapper — pass a resolver that reads
   * the latest snapshot so the closure isn't stale.
   */
  readonly resolveSettings?: Effect.Effect<CursorSettings>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface CursorSessionContext {
  readonly eventIdentity: ProviderAdapterSessionStartInput["mcpEventIdentity"];
  readonly historySessionOrigin: "fresh" | "resumed";
  promptsInFlight: number;
  readonly threadId: ThreadId;
  session: ProviderSession;
  configuredConfig: Record<string, unknown>;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  assistantReply: CursorTransportFailure;
  readonly skillCommands: ReturnType<typeof cursorSkillCommands>;
  nativeCommands: ReturnType<typeof normalizeSupportedSlashCommands>;
  stopped: boolean;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingApprovals.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingUserInputs.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCursorResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== CURSOR_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find((mode) => {
      const id = mode.id.toLowerCase();
      const name = mode.name.toLowerCase();
      return id === alias || name === alias;
    });
    if (exact) {
      return exact;
    }
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

function isPlanMode(mode: AcpSessionMode): boolean {
  return findModeByAliases([mode], ACP_PLAN_MODE_ALIASES) !== undefined;
}

function resolveRequestedModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, ACP_PLAN_MODE_ALIASES)?.id;
  }

  switch (input.runtimeMode) {
    case "approval-required":
      return (
        findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
        findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
        modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
        modeState.currentModeId
      );
    case "full-access":
      return (
        findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
        findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
        modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
        modeState.currentModeId
      );
    case "auto-accept-edits":
    case "auto":
      throw new Error(`Cursor does not support runtime mode '${input.runtimeMode}'.`);
    default:
      return assertNever(input.runtimeMode, "Cursor runtime mode");
  }
}

function applyRequestedSessionConfiguration<E>(input: {
  readonly runtime: AcpSessionRuntimeShape;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modelSelection:
    | {
        readonly model: string;
        readonly options?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
      }
    | undefined;
  readonly mapError: (context: {
    readonly cause: import("effect-acp/errors").AcpError;
    readonly method: "session/set_config_option" | "session/set_mode";
  }) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    if (input.modelSelection) {
      yield* applyCursorAcpModelSelection({
        runtime: input.runtime,
        model: input.modelSelection.model,
        selections: input.modelSelection.options,
        mapError: ({ cause }) =>
          input.mapError({
            cause,
            method: "session/set_config_option",
          }),
      });
    }

    const requestedModeId = resolveRequestedModeId({
      interactionMode: input.interactionMode,
      runtimeMode: input.runtimeMode,
      modeState: yield* input.runtime.getModeState,
    });
    if (!requestedModeId) {
      return;
    }

    yield* input.runtime.setMode(requestedModeId).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          method: "session/set_mode",
        }),
      ),
    );
  });
}

function booleanSelectionState(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): string | undefined {
  const value = selections?.find((selection) => selection.id === id)?.value;
  return typeof value === "boolean" ? (value ? "on" : "off") : undefined;
}

function stringSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): string | undefined {
  const value = selections?.find((selection) => selection.id === id)?.value;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function buildCursorConfiguredConfig(input: {
  readonly sessionId: string;
  readonly skillCommands: ReturnType<typeof cursorSkillCommands>;
  readonly model: string | null | undefined;
  readonly options: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): Record<string, unknown> {
  const model = input.model?.trim();
  const sessionId = input.sessionId.trim();
  const fastModeState = booleanSelectionState(input.options, "fastMode");
  const thinkingState = booleanSelectionState(input.options, "thinking");
  const reasoning = stringSelectionValue(input.options, "reasoning");
  const contextWindow = stringSelectionValue(input.options, "contextWindow");
  return {
    slashCommands: input.skillCommands,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(model ? { model: resolveCursorAcpBaseModelId(model) } : {}),
    ...(fastModeState ? { fast_mode_state: fastModeState } : {}),
    ...(thinkingState ? { thinking_state: thinkingState } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(contextWindow ? { context_window: contextWindow } : {}),
  };
}

function resolveCursorModelSelection(input: {
  readonly boundInstanceId: typeof ProviderInstanceId.Type;
  readonly model: string | null | undefined;
  readonly modelOptions: ProviderModelOptions | null | undefined;
  readonly modelSelection:
    | {
        readonly instanceId: typeof ProviderInstanceId.Type;
        readonly model: string;
        readonly options?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
      }
    | undefined;
}):
  | {
      readonly model: string;
      readonly options?: ReadonlyArray<ProviderOptionSelection> | undefined;
    }
  | undefined {
  const matchingSelection =
    input.modelSelection?.instanceId === input.boundInstanceId ? input.modelSelection : undefined;
  const model = matchingSelection?.model ?? input.model?.trim();
  if (!model) {
    return undefined;
  }
  const options =
    matchingSelection?.options ??
    cursorModelOptionsToProviderOptionSelections(input.modelOptions?.cursor);
  return {
    model,
    ...(options && options.length > 0 ? { options } : {}),
  };
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const allowAlwaysOption = request.options.find((option) => option.kind === "allow_always");
  if (typeof allowAlwaysOption?.optionId === "string" && allowAlwaysOption.optionId.trim()) {
    return allowAlwaysOption.optionId.trim();
  }

  const allowOnceOption = request.options.find((option) => option.kind === "allow_once");
  if (typeof allowOnceOption?.optionId === "string" && allowOnceOption.optionId.trim()) {
    return allowOnceOption.optionId.trim();
  }

  return undefined;
}

export function makeCursorAdapter(
  cursorSettings: CursorSettings,
  options?: CursorAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const adapterScope = yield* Scope.Scope;
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("cursor");
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, CursorSessionContext>();
    const sendsInFlight = new Map<ThreadId, number>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const sessionLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = (ctx?: CursorSessionContext) => {
      const identity = ctx?.eventIdentity;
      return Effect.all({ eventId: nextEventId, createdAt: nowIso }).pipe(
        Effect.map((stamp) => ({ ...stamp, ...identity })),
      );
    };

    const automationCatalogs = new Map<string, AcpAutomationCatalogs>();
    const prepareRuntimeEvent = yield* makeAutomationRuntimeEventPreparer;
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) => {
      const release = automationEventSanitizer.retain(event.threadId);
      const catalogs = automationCatalogs.get(event.threadId);
      if (event.type === "session.configured") {
        const context = sessions.get(event.threadId);
        if (context) {
          context.configuredConfig = { ...context.configuredConfig, ...event.payload.config };
          event = { ...event, payload: { ...event.payload, config: context.configuredConfig } };
        }
      }
      if (event.type === "turn.completed" && event.turnId) catalogs?.endTurn(event.turnId);
      const hiddenPermission =
        event.type === "request.opened" &&
        event.payload.detail === "Tool inputs hidden while computer control is enabled";
      return (
        event.type === "session.configured" && catalogs
          ? Effect.promise(catalogs.refresh)
          : Effect.void
      ).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (event.type === "session.configured" && catalogs)
              event = {
                ...event,
                payload: {
                  ...event.payload,
                  config: { ...event.payload.config, agentBrowser: catalogs.agentBrowser() },
                },
              };
            return prepareRuntimeEvent(event);
          }),
        ),
        Effect.map((prepared) =>
          hiddenPermission && prepared.type === "request.opened"
            ? {
                ...prepared,
                payload: {
                  ...prepared.payload,
                  detail: "Tool inputs hidden while computer control is enabled",
                },
              }
            : prepared,
        ),
        Effect.flatMap((prepared) =>
          PubSub.publish(runtimeEventPubSub, catalogs?.sanitizeEvent(prepared) ?? prepared),
        ),
        Effect.asVoid,
        Effect.ensuring(Effect.sync(release)),
      );
    };

    const getThreadSemaphore = (threadId: string, locks = threadLocksRef) =>
      SynchronizedRef.modifyEffect(locks, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const withSessionLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId, sessionLocksRef), (semaphore) =>
        semaphore.withPermit(effect),
      );

    const logNative = (
      threadId: ThreadId,
      method: string,
      payload: unknown,
      _source: "acp.jsonrpc" | "acp.cursor.extension",
    ) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = new Date().toISOString();
        yield* writeProviderEventLog(
          nativeEventLogger,
          {
            observedAt,
            event: {
              id: crypto.randomUUID(),
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload: (automationCatalogs.get(threadId)?.redactForLog ?? redactAcpLogPayload)(
                payload,
              ),
            },
          },
          threadId,
        );
      });

    const emitPlanUpdate = (
      ctx: CursorSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      source: "acp.jsonrpc" | "acp.cursor.extension",
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${JSON.stringify(payload)}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(ctx),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source,
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<CursorSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: CursorSessionContext, failure?: string) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        if (failure)
          yield* offerRuntimeEvent({
            type: "runtime.error",
            ...(yield* makeEventStamp(ctx)),
            provider: PROVIDER,
            threadId: ctx.threadId,
            ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
            payload: { class: "transport_error", message: failure },
          });
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        if (sessions.get(ctx.threadId) === ctx) sessions.delete(ctx.threadId);
        if (failure && ctx.activeTurnId)
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp(ctx)),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload: { state: "failed", errorMessage: failure },
          });
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp(ctx)),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: failure
            ? { exitKind: "error", reason: failure, recoverable: true }
            : { exitKind: "graceful" },
        });
      });

    // The ACP event stream never ends on its own, so an agent that dies
    // mid-turn would otherwise leave a live-looking session whose turn never
    // settles and whose later prompts all fail.
    const handleUnexpectedAgentExit = (ctx: CursorSessionContext, code: number | undefined) =>
      withSessionLock(
        ctx.threadId,
        Effect.gen(function* () {
          if (ctx.stopped || sessions.get(ctx.threadId) !== ctx) return;
          const reason =
            code === undefined
              ? "The Cursor agent exited unexpectedly."
              : `The Cursor agent exited unexpectedly (code ${code}).`;
          const turnId = ctx.activeTurnId;
          if (turnId) {
            ctx.activeTurnId = undefined;
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId,
              payload: { state: "failed", errorMessage: reason },
            });
          }
          yield* stopSessionInternal(ctx, reason);
        }),
      );

    const startSession: CursorAdapterShape["startSession"] = (input) =>
      withSessionLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = nodePath.resolve(input.cwd);
          const cursorModelSelection = resolveCursorModelSelection({
            boundInstanceId,
            model: input.model,
            modelOptions: input.modelOptions,
            modelSelection: input.modelSelection,
          });
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: CursorSessionContext;

          const resumeSessionId = parseCursorResume(input.resumeCursor)?.sessionId;
          const catalogs = yield* prepareAcpAutomationCatalogs({
            threadId: input.threadId,
            provider: PROVIDER as "cursor" | "grok" | "antigravity",
            scope: sessionScope,
            ...(options?.previewMcpHttpServer ? { preview: options.previewMcpHttpServer } : {}),
            ...(options?.computerAutomationBroker
              ? { computer: options.computerAutomationBroker }
              : {}),
            ...(options?.automationCatalogVerification
              ? { verification: options.automationCatalogVerification }
              : {}),
            readOnlyWorkflow: !!input.workflowExecutionProfile,
            threadSession:
              !isSyntheticOneOffThreadId(input.threadId) && !input.workflowExecutionProfile,
            ordinarySession:
              serverConfig.mode === "desktop" &&
              !isSyntheticOneOffThreadId(input.threadId) &&
              !input.workflowExecutionProfile,
            computerCapableLineage: !!(
              input.resumeCursor &&
              typeof input.resumeCursor === "object" &&
              "computerCapable" in input.resumeCursor &&
              input.resumeCursor.computerCapable === true
            ),
          });
          automationCatalogs.set(input.threadId, catalogs);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (automationCatalogs.get(input.threadId) === catalogs) {
                automationCatalogs.delete(input.threadId);
              }
            }),
          ).pipe(Effect.provideService(Scope.Scope, sessionScope));
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
            redactForLog: catalogs.redactForLog,
          });

          // Resolve the CursorSettings used to spawn the ACP child. Production
          // leaves `options.resolveSettings` undefined so we use the value
          // captured at adapter construction — per-instance isolation is
          // enforced by the hydration layer rebuilding this adapter whenever
          // its config changes. Tests set `resolveSettings` to pull the latest
          // snapshot from `ServerSettingsService` so that mid-suite
          // `updateSettings({ providers: { cursor: { binaryPath } } })` calls
          // actually take effect when the next session spawns.
          const effectiveCursorSettings = options?.resolveSettings
            ? yield* options.resolveSettings
            : cursorSettings;

          const acp = yield* makeCursorAcpRuntime({
            cursorSettings: effectiveCursorSettings,
            runtimeMode: input.workflowExecutionProfile ? "approval-required" : input.runtimeMode,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            hardening: {
              enabled: serverConfig.acpHardeningEnabled,
              provider: PROVIDER,
            },
            ...acpNativeLoggers,
            mcpServers: catalogs.mcpServers,
            sanitizeStderr: catalogs.scrubDiagnostic,
            hasSensitiveConfiguration: catalogs.hasSensitiveConfiguration,
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (error) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: catalogs.scrubDiagnostic(error.message).slice(0, 2000),
                  cause: undefined,
                }),
            ),
          );
          const started = yield* Effect.gen(function* () {
            yield* acp.handleExtRequest("cursor/ask_question", CursorAskQuestionRequest, (params) =>
              Effect.gen(function* () {
                yield* logNative(
                  input.threadId,
                  "cursor/ask_question",
                  params,
                  "acp.cursor.extension",
                );
                if (input.workflowExecutionProfile === "unattended-readonly") {
                  // No reply path exists, so the request is auto-declined rather
                  // than registered as pending. Emit the matching `resolved`
                  // event too: the timeline keeps a record of what was asked,
                  // and the UI does not leave an unanswerable question card open
                  // (pending requests are only closed by a `resolved` event).
                  const requestId = RuntimeRequestId.make(crypto.randomUUID());
                  yield* offerRuntimeEvent({
                    type: "user-input.requested",
                    ...(yield* makeEventStamp(ctx)),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId,
                    payload: { questions: extractAskQuestions(params) },
                    raw: {
                      source: "acp.cursor.extension",
                      method: "cursor/ask_question",
                      payload: params,
                    },
                  });
                  yield* offerRuntimeEvent({
                    type: "user-input.resolved",
                    ...(yield* makeEventStamp(ctx)),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId,
                    payload: { answers: {} },
                    raw: {
                      source: "acp.cursor.extension",
                      method: "cursor/ask_question/unattended-declined",
                      payload: { answers: {} },
                    },
                  });
                  return { answers: {} };
                }
                const requestId = ApprovalRequestId.make(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const answers = yield* Deferred.make<ProviderUserInputAnswers>();
                pendingUserInputs.set(requestId, { answers });
                yield* offerRuntimeEvent({
                  type: "user-input.requested",
                  ...(yield* makeEventStamp(ctx)),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  payload: { questions: extractAskQuestions(params) },
                  raw: {
                    source: "acp.cursor.extension",
                    method: "cursor/ask_question",
                    payload: params,
                  },
                });
                const resolved = yield* Deferred.await(answers);
                pendingUserInputs.delete(requestId);
                yield* offerRuntimeEvent({
                  type: "user-input.resolved",
                  ...(yield* makeEventStamp(ctx)),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  payload: { answers: resolved },
                });
                return { answers: resolved };
              }),
            );
            yield* acp.handleExtRequest("cursor/create_plan", CursorCreatePlanRequest, (params) =>
              Effect.gen(function* () {
                yield* logNative(
                  input.threadId,
                  "cursor/create_plan",
                  params,
                  "acp.cursor.extension",
                );
                yield* offerRuntimeEvent({
                  type: "turn.proposed.completed",
                  ...(yield* makeEventStamp(ctx)),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  payload: { planMarkdown: extractPlanMarkdown(params) },
                  raw: {
                    source: "acp.cursor.extension",
                    method: "cursor/create_plan",
                    payload: params,
                  },
                });
                return { accepted: true } as const;
              }),
            );
            yield* acp.handleExtNotification(
              "cursor/update_todos",
              CursorUpdateTodosRequest,
              (params) =>
                Effect.gen(function* () {
                  yield* logNative(
                    input.threadId,
                    "cursor/update_todos",
                    params,
                    "acp.cursor.extension",
                  );
                  if (ctx) {
                    yield* emitPlanUpdate(
                      ctx,
                      extractTodosAsPlan(params),
                      params,
                      "acp.cursor.extension",
                      "cursor/update_todos",
                    );
                  }
                }),
            );
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                yield* logNative(
                  input.threadId,
                  "session/request_permission",
                  params,
                  "acp.jsonrpc",
                );
                if (input.workflowExecutionProfile) {
                  const permissionRequest = parsePermissionRequest(params);
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(ctx),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
                      requestId: RuntimeRequestId.make(crypto.randomUUID()),
                      permissionRequest,
                      detail: catalogs.classify(params.toolCall)
                        ? "Tool inputs hidden while computer control is enabled"
                        : (permissionRequest.detail ?? JSON.stringify(params).slice(0, 2000)),
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  return { outcome: { outcome: "cancelled" as const } };
                }
                const computerRequest = catalogs.classify(params.toolCall);
                if (computerRequest)
                  params = {
                    ...params,
                    toolCall: { toolCallId: params.toolCall.toolCallId, title: "Tool activity" },
                  };
                switch (input.runtimeMode) {
                  case "full-access": {
                    const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                    if (!computerRequest && autoApprovedOptionId !== undefined) {
                      return {
                        outcome: {
                          outcome: "selected" as const,
                          optionId: autoApprovedOptionId,
                        },
                      };
                    }
                    break;
                  }
                  case "approval-required":
                    break;
                  case "auto-accept-edits":
                  case "auto":
                    throw new Error(`Cursor does not support runtime mode '${input.runtimeMode}'.`);
                  default:
                    return assertNever(input.runtimeMode, "Cursor approval mode");
                }
                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.make(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                pendingApprovals.set(requestId, {
                  decision,
                  kind: permissionRequest.kind,
                });
                yield* offerRuntimeEvent(
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(ctx),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    detail: catalogs.classify(params.toolCall)
                      ? "Tool inputs hidden while computer control is enabled"
                      : (permissionRequest.detail ?? JSON.stringify(params).slice(0, 2000)),
                    args: params,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: params,
                  }),
                );
                const resolved = yield* Deferred.await(decision);
                pendingApprovals.delete(requestId);
                yield* offerRuntimeEvent(
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(ctx),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: resolved,
                  }),
                );
                return {
                  outcome:
                    resolved === "cancel"
                      ? ({ outcome: "cancelled" } as const)
                      : {
                          outcome: "selected" as const,
                          optionId: acpPermissionOutcome(resolved),
                        },
                };
              }),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(
                PROVIDER,
                input.threadId,
                "session/start",
                error,
                automationCatalogs.get(input.threadId)?.scrubDiagnostic,
                automationCatalogs.get(input.threadId)?.hasSensitiveConfiguration() ?? false,
              ),
            ),
          );

          yield* applyRequestedSessionConfiguration({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            modelSelection: cursorModelSelection,
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(
                PROVIDER,
                input.threadId,
                method,
                cause,
                automationCatalogs.get(input.threadId)?.scrubDiagnostic,
                automationCatalogs.get(input.threadId)?.hasSensitiveConfiguration() ?? false,
              ),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: cursorModelSelection?.model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: CURSOR_RESUME_VERSION,
              sessionId: started.sessionId,
              ...(catalogs.computerCapable() ? { computerCapable: true } : {}),
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            eventIdentity: input.mcpEventIdentity,
            historySessionOrigin: "sessionId" in started.sessionSetupResult ? "fresh" : "resumed",
            threadId: input.threadId,
            session,
            configuredConfig: {},
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            promptsInFlight: 0,
            assistantReply: new CursorTransportFailure(),
            nativeCommands: [],
            skillCommands: cursorSkillCommands(
              yield* discoverCursorSkills(cwd, options?.environment ?? process.env).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
              ),
            ),
            stopped: false,
          };

          const offCatalogStatus = catalogs.onChanged(() => {
            void Effect.runPromise(
              Effect.gen(function* () {
                yield* offerRuntimeEvent({
                  type: "session.configured",
                  ...(yield* makeEventStamp(ctx)),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  payload: { config: ctx.configuredConfig },
                });
              }),
            );
          });
          yield* Effect.addFinalizer(() => Effect.sync(offCatalogStatus)).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
          );
          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                if (event._tag === "ToolCallUpdated") classifyAcpToolEvent(catalogs, event);
                switch (event._tag) {
                  case "TransportTerminated":
                    // Closing a scope from its own notification fiber deadlocks.
                    // A sibling owns teardown, fenced against session replacement.
                    yield* withSessionLock(
                      ctx.threadId,
                      Effect.suspend(() =>
                        sessions.get(ctx.threadId) === ctx && !ctx.stopped
                          ? stopSessionInternal(ctx, event.message)
                          : Effect.void,
                      ),
                    ).pipe(Effect.forkIn(adapterScope));
                    return;
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted":
                    ctx.assistantReply = new CursorTransportFailure();
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(ctx),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(ctx),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* emitPlanUpdate(
                      ctx,
                      event.payload,
                      event.rawPayload,
                      "acp.jsonrpc",
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(ctx),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "SlashCommandsUpdated":
                    ctx.nativeCommands = normalizeSupportedSlashCommands(event.commands);
                    yield* offerRuntimeEvent({
                      ...(yield* makeEventStamp(ctx)),
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      type: "session.configured",
                      payload: {
                        config: buildCursorConfiguredConfig({
                          sessionId: parseCursorResume(ctx.session.resumeCursor)?.sessionId ?? "",
                          skillCommands: normalizeSupportedSlashCommands([
                            ...ctx.nativeCommands,
                            ...ctx.skillCommands,
                          ]),
                          model: ctx.session.model,
                          options: undefined,
                        }),
                      },
                    });
                    return;
                  case "ContentDelta":
                    if (event.streamKind !== "reasoning_text") ctx.assistantReply.push(event.text);
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(ctx),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        ...(event.streamKind ? { streamKind: event.streamKind } : {}),
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(Effect.forkIn(sessionScope));

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;
          const watchedCtx = ctx;
          // Settle outside the session scope: stopping closes that scope.
          yield* acp.awaitExit.pipe(
            Effect.flatMap((code) =>
              Effect.forkDetach(handleUnexpectedAgentExit(watchedCtx, code)),
            ),
            Effect.forkIn(sessionScope),
          );

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp(ctx)),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.configured",
            ...(yield* makeEventStamp(ctx)),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: {
              config: buildCursorConfiguredConfig({
                sessionId: started.sessionId,
                skillCommands: normalizeSupportedSlashCommands([
                  ...ctx.nativeCommands,
                  ...ctx.skillCommands,
                ]),
                model: cursorModelSelection?.model,
                options: cursorModelSelection?.options,
              }),
            },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp(ctx)),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Cursor ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp(ctx)),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurnUnlocked: CursorAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const { ctx, turnId, promptParts, resolvedModel } = yield* withSessionLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            const steering = input.expectedTurnId !== undefined;
            if (
              steering &&
              (ctx.activeTurnId !== input.expectedTurnId || ctx.promptsInFlight === 0)
            )
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/steer",
                detail: "The active turn ended or changed before steering.",
              });
            if (!steering && ctx.promptsInFlight > 0)
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/start",
                detail: "A Cursor turn is already running.",
              });
            const turnId = input.expectedTurnId ?? TurnId.make(crypto.randomUUID());
            const turnModelSelection = resolveCursorModelSelection({
              boundInstanceId,
              model: input.model ?? ctx.session.model,
              modelOptions: input.modelOptions,
              modelSelection: input.modelSelection,
            });
            const model = turnModelSelection?.model ?? ctx.session.model;
            const resolvedModel = resolveCursorAcpBaseModelId(model);
            if (input.workflowExecutionProfile) {
              const modeState = yield* ctx.acp.getModeState;
              const planModeId = resolveRequestedModeId({
                interactionMode: "plan",
                runtimeMode: ctx.session.runtimeMode,
                modeState,
              });
              if (!planModeId) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue:
                    "Cursor did not advertise a read-only ACP plan mode for this workflow stage.",
                });
              }
            }
            if (!steering)
              yield* applyRequestedSessionConfiguration({
                runtime: ctx.acp,
                runtimeMode: ctx.session.runtimeMode,
                interactionMode: input.workflowExecutionProfile ? "plan" : input.interactionMode,
                modelSelection:
                  model === undefined
                    ? undefined
                    : {
                        model,
                        options: turnModelSelection?.options,
                      },
                mapError: ({ cause, method }) =>
                  mapAcpToAdapterError(
                    PROVIDER,
                    input.threadId,
                    method,
                    cause,
                    automationCatalogs.get(input.threadId)?.scrubDiagnostic,
                    automationCatalogs.get(input.threadId)?.hasSensitiveConfiguration() ?? false,
                  ),
              });
            ctx.activeTurnId = turnId;
            if (!steering) {
              ctx.assistantReply = new CursorTransportFailure();
              ctx.lastPlanFingerprint = undefined;
            }
            ctx.session = {
              ...ctx.session,
              activeTurnId: turnId,
              model,
              updatedAt: yield* nowIso,
            };

            yield* offerRuntimeEvent({
              type: "session.configured",
              ...(yield* makeEventStamp(ctx)),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: {
                config: buildCursorConfiguredConfig({
                  sessionId: parseCursorResume(ctx.session.resumeCursor)?.sessionId ?? "",
                  skillCommands: normalizeSupportedSlashCommands([
                    ...ctx.nativeCommands,
                    ...ctx.skillCommands,
                  ]),
                  model,
                  options: turnModelSelection?.options,
                }),
              },
            });

            if (!steering)
              yield* offerRuntimeEvent({
                type: "turn.started",
                ...(yield* makeEventStamp(ctx)),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: { model: resolvedModel },
              });

            const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
            if (input.input?.trim()) {
              promptParts.push({ type: "text", text: input.input.trim() });
            }
            const attachmentContext = buildProviderAttachmentRuntimeContext(
              input.resolvedAttachments ?? [],
            );
            if (attachmentContext) {
              promptParts.push({ type: "text", text: attachmentContext });
            }
            if (input.attachments && input.attachments.length > 0) {
              for (const attachment of input.attachments) {
                switch (attachment.type) {
                  case "image": {
                    const attachmentPath = resolveAttachmentPath({
                      attachmentsDir: serverConfig.attachmentsDir,
                      attachment,
                    });
                    if (!attachmentPath) {
                      return yield* new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "session/prompt",
                        detail: `Invalid attachment id '${attachment.id}'.`,
                      });
                    }
                    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProviderAdapterRequestError({
                            provider: PROVIDER,
                            method: "session/prompt",
                            detail: cause.message,
                            cause,
                          }),
                      ),
                    );
                    promptParts.push({
                      type: "image",
                      data: Buffer.from(bytes).toString("base64"),
                      mimeType: attachment.mimeType,
                    });
                    break;
                  }
                  default:
                    throw new Error(
                      `Unsupported Cursor attachment type '${String((attachment as { type?: unknown }).type)}'.`,
                    );
                }
              }
            }

            if (promptParts.length === 0) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: "Turn requires non-empty text or attachments.",
              });
            }

            if (steering && (ctx.activeTurnId !== turnId || ctx.promptsInFlight === 0))
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/steer",
                detail: "The active turn ended while preparing the steer.",
              });
            ctx.promptsInFlight += 1;
            return { ctx, turnId, promptParts, resolvedModel };
          }),
        );
        // Preparation shares the session lifecycle lock. The live prompt stays
        // outside it so steers can reach the active turn and replacement can cancel it.
        const result = yield* ctx.acp
          .prompt({
            prompt: promptParts,
          })
          .pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(
                PROVIDER,
                input.threadId,
                "session/prompt",
                error,
                automationCatalogs.get(input.threadId)?.scrubDiagnostic,
                automationCatalogs.get(input.threadId)?.hasSensitiveConfiguration() ?? false,
              ),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
              }),
            ),
          );

        if (sessions.get(input.threadId) !== ctx || ctx.stopped)
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/prompt",
            detail: "The Cursor session was replaced while prompting.",
          });
        yield* ctx.acp.awaitEventBarrier;
        if (ctx.promptsInFlight > 0 || ctx.activeTurnId !== turnId)
          return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
        // Claim completion synchronously: overlapping prompts can both drain their
        // event barriers after the last prompt has decremented the counter.
        ctx.activeTurnId = undefined;
        const failure = ctx.assistantReply.failure;
        if (result.stopReason !== "cancelled" && failure) {
          ctx.activeTurnId = undefined;
          ctx.session = {
            ...ctx.session,
            activeTurnId: undefined,
            status: "ready",
            lastError: failure,
          };
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp(ctx)),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: { state: "failed", errorMessage: failure },
          });
          return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
        }

        ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
        ctx.session = {
          ...ctx.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: yield* nowIso,
          model: resolvedModel,
        };

        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp(ctx)),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: {
            state: result.stopReason === "cancelled" ? "cancelled" : "completed",
            stopReason: result.stopReason ?? null,
          },
        });

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    const sendTurn: CursorAdapterShape["sendTurn"] = (input) => {
      if (!serverConfig.acpHardeningEnabled) {
        return sendTurnUnlocked(input);
      }

      return Effect.acquireUseRelease(
        Effect.sync(() => {
          const previousInFlight = sendsInFlight.get(input.threadId) ?? 0;
          sendsInFlight.set(input.threadId, previousInFlight + 1);
          return previousInFlight;
        }),
        (previousInFlight) =>
          (previousInFlight > 0
            ? Effect.void.pipe(
                withMetrics({
                  counter: acpCursorSerializationWaitsTotal,
                  attributes: providerMetricAttributes(PROVIDER),
                }),
              )
            : Effect.void
          ).pipe(Effect.andThen(withThreadLock(input.threadId, sendTurnUnlocked(input)))),
        () =>
          Effect.sync(() => {
            const next = Math.max(0, (sendsInFlight.get(input.threadId) ?? 1) - 1);
            if (next === 0) {
              sendsInFlight.delete(input.threadId);
            } else {
              sendsInFlight.set(input.threadId, next);
            }
          }),
      );
    };

    const interruptTurn: CursorAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(
                PROVIDER,
                threadId,
                "session/cancel",
                error,
                automationCatalogs.get(threadId)?.scrubDiagnostic,
                automationCatalogs.get(threadId)?.hasSensitiveConfiguration() ?? false,
              ),
            ),
          ),
        );
      });

    const respondToRequest: CursorAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: CursorAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "cursor/ask_question",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: CursorAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return {
          threadId,
          turns: ctx.turns.map((turn) => ({ ...turn, items: [...turn.items] })),
          history: {
            sessionOrigin: ctx.historySessionOrigin,
            identity: JSON.stringify(ctx.session.resumeCursor ?? null),
            provenance: "runtime-local" as const,
            coverage: "partial" as const,
            boundary: null,
            runtimeId: null,
          },
        };
      });

    const rollbackThread: CursorAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        return {
          threadId,
          turns: ctx.turns.map((turn) => ({ ...turn, items: [...turn.items] })),
          history: {
            sessionOrigin: ctx.historySessionOrigin,
            identity: JSON.stringify(ctx.session.resumeCursor ?? null),
            provenance: "runtime-local" as const,
            coverage: "partial" as const,
            boundary: null,
            runtimeId: null,
          },
        };
      });

    const stopSession: CursorAdapterShape["stopSession"] = (threadId) =>
      withSessionLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: CursorAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: CursorAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: CursorAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), (ctx) => stopSessionInternal(ctx), { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), (ctx) => stopSessionInternal(ctx), { discard: true }).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: {
        turnCompletionOnReturn: true,
        sessionModelSwitch: "in-session",
        runtimeCapabilities: providerRuntimeCapabilities(PROVIDER),
      },
      startSession,
      sendTurn,
      steerTurn: sendTurnUnlocked,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies CursorAdapterShape;
  });
}
