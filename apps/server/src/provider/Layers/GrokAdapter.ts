import { acpPdfDocuments } from "../pdfDocuments.ts";
import type { ProviderAdapterSessionStartInput } from "../Services/ProviderAdapter.ts";
import {
  applyAcpPlanMode,
  makeAcpBuildConfiguration,
  type AcpBuildConfiguration,
} from "../acp/AcpPlanMode.ts";
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
import { AntigravityTasks } from "../acp/AntigravityTasks.ts";
import { makeAntigravityToolNormalizer } from "../acp/AntigravityToolCalls.ts";
import { watchAntigravityPromptOutcome } from "../acp/AntigravityTurnOutcome.ts";
import { readAntigravityChildrenAtWork } from "../acp/AntigravityChildWork.ts";
import { PromptInactivityDeadline } from "../acp/PromptInactivityDeadline";
import {
  acpElicitationDescriptor,
  acpElicitationResponse,
  type AcpElicitationResponse,
} from "../acp/AcpElicitationForm.ts";
import { ElicitationRegistry, type ElicitationTerminalReceipt } from "../elicitationRegistry.ts";
import {
  antigravityApprovalOptions,
  antigravityQuestion,
  antigravityQuestionResponse,
} from "../acp/AntigravityQuestions.ts";
import { normalizeSupportedSlashCommands } from "../supportedSlashCommands.ts";
import { leadingSlashCommandName } from "../nativeCommandInput.ts";
import {
  discoverGrokSkills,
  leadingGrokSkillMention,
  rewriteLeadingGrokSkill,
} from "../Drivers/GrokSkills.ts";
import * as nodePath from "node:path";

import {
  ApprovalRequestId,
  type GrokSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderInstanceId,
  type RuntimeMode,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  DateTime,
  Clock,
  Duration,
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
import { assertNever } from "@t3tools/shared/exhaustive";
import { timeOrderedUuid } from "@t3tools/shared/ids";
import { customModelSlug } from "@t3tools/shared/customModels";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { acpPermissionOutcome, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  type AcpSessionRuntimeShape,
  type AcpSessionRuntimeStartResult,
} from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpNoticeEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  boundPermissionRequestPayload,
  findModelConfigOption,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import {
  AntigravityModelUnavailableError,
  AntigravityModeUnavailableError,
  antigravityAdvertisedModes,
  antigravityApprovalDecision,
  antigravityLaunchedVersion,
  antigravityTargetMode,
  antigravityThinkingLevels,
  applyAntigravityModelSelection,
  applyAntigravitySessionMode,
  makeAntigravitySelectionState,
  type AntigravitySelectionState,
  type AntigravityThinkingLevels,
} from "../acp/AntigravityAcpSupport.ts";
import { antigravityStepLayoutVerified } from "../antigravityPrivateFormats.ts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { canonicalJson } from "../../canonicalJsonHash.ts";
import { makeAcpNativeLoggers, redactAcpLogPayload } from "../acp/AcpNativeLogging.ts";
import {
  applyGrokAcpModelSelection,
  currentGrokModelIdFromSessionSetup,
  offeredAcpModelIds,
  makeGrokAcpRuntime,
  resolveGrokAcpBaseModelId,
} from "../acp/GrokAcpSupport.ts";
import {
  extractXAiAskUserQuestions,
  makeXAiAskUserQuestionCancelledResponse,
  makeXAiAskUserQuestionResponse,
  XAiAskUserQuestionRequest,
} from "../acp/XAiAcpExtension.ts";
import { type GrokAdapterShape } from "../Services/GrokAdapter.ts";
import {
  writeProviderEventLog,
  type EventNdjsonLogger,
  makeEventNdjsonLogger,
} from "./EventNdjsonLogger.ts";
import { buildProviderAttachmentRuntimeContext } from "../attachmentRuntimeContext.ts";

import {
  buildGrokBackgroundTaskEvents,
  type GrokBackgroundTaskRecord,
} from "../acp/XAiBackgroundTasks.ts";

const PROVIDER: ProviderKind = "grok";
const GROK_RESUME_VERSION = 1 as const;

export interface GrokAdapterLiveOptions {
  readonly antigravityProfileDirectory?: string;
  /** Antigravity silent-prompt deadline; configurable for deterministic tests. */
  readonly promptInactivityTimeoutMs?: number;
  /** Certification/test seam; production drivers leave this unset. */
  readonly automationCatalogVerification?: { preview?: boolean; computer?: boolean };
  readonly previewMcpHttpServer?: PreviewMcpHttpServerShape;
  readonly computerAutomationBroker?: ComputerAutomationBrokerRuntime;
  readonly provider?: ProviderKind;
  readonly nativeCompaction?: boolean;
  readonly discoverSkillCommands?: (
    cwd: string,
  ) => Effect.Effect<ReadonlyArray<{ name: string; description: string }>>;
  readonly onRuntimeReady?: (
    runtime: AcpSessionRuntimeShape,
    started: AcpSessionRuntimeStartResult,
  ) => Effect.Effect<void>;
  readonly makeRuntime?: typeof makeGrokAcpRuntime;
  readonly normalizeModel?: (model: string | null | undefined) => string;
  readonly configureRuntime?: (
    runtime: AcpSessionRuntimeShape,
    runtimeMode: ProviderSession["runtimeMode"],
  ) => Effect.Effect<void, EffectAcpErrors.AcpError>;

  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: typeof ProviderInstanceId.Type;
  /** Antigravity policy hooks, added per workstream (account, catalog, modes). */
  readonly antigravity?: AntigravityAdapterHooks;
}

export interface AntigravityCatalogObservation {
  readonly model: string | undefined;
  readonly thinking: AntigravityThinkingLevels | null;
  readonly modelChoices: ReadonlyArray<{ readonly value: string; readonly name: string }>;
  readonly advertisedModes: ReadonlyArray<string>;
  /** The account revision the observing session started under; others are discarded. */
  readonly accountRevision?: number;
}

export interface AntigravityAdapterHooks {
  /** Account revision; a resume cursor from another revision starts a fresh native session. */
  readonly accountRevision?: Effect.Effect<number>;
  /** Thread sessions report the catalog entry for the model they select. */
  readonly observeCatalog?: (observation: AntigravityCatalogObservation) => Effect.Effect<void>;
  /**
   * A reason to refuse new work, set once settings published another sign-in method or key than
   * this instance was built with; the registry replaces the instance shortly after.
   */
  readonly staleAccount?: Effect.Effect<string | undefined>;
  /** Launch credentials (the Gemini API key) registered with each session's scrubber. */
  readonly credentials?: ReadonlyArray<string>;
  /**
   * Whether the runtime version is certified for the private turn-outcome and child-work
   * formats. When false the session runs standard ACP only. Absent means certified.
   */
  readonly nativeReaders?: (runtime: object) => Effect.Effect<boolean>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

type PendingUserInputResolution =
  | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
  | { readonly _tag: "cancelled" };

interface PendingUserInput {
  readonly validate?: (answers: ProviderUserInputAnswers) => boolean;
  readonly resolution: Deferred.Deferred<PendingUserInputResolution>;
}

interface GrokSessionContext {
  readonly supportsDocuments: boolean;
  readonly eventIdentity: ProviderAdapterSessionStartInput["mcpEventIdentity"];
  readonly historySessionOrigin: "fresh" | "resumed";
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** The last turn this adapter emitted `turn.completed` for. */
  completedTurnId: TurnId | undefined;
  promptsInFlight: number;
  currentModelId: string | undefined;
  stopped: boolean;
  transportFailure?: string | undefined;
  readonly backgroundTasks: Map<string, GrokBackgroundTaskRecord>;
  readonly antigravityTasks: AntigravityTasks;
  readonly normalizeAntigravityTool: ReturnType<typeof makeAntigravityToolNormalizer>;
  nativeChildrenPolling: boolean;
  /** Antigravity: the native mode as last written or reported (`ModeChanged`). */
  antigravityMode: string | undefined;
  /**
   * Antigravity: native Auto was unavailable or rejected for this session, which then runs as
   * Supervised. Later turns do not retry it, so its one warning is not repeated.
   */
  antigravityAutoUnavailable: boolean;
  /** Antigravity: the latest turn asked for Plan; its requests keep Plan's rules. */
  antigravityPlanRequested: boolean;
  /** Antigravity: a mode warning not yet published, kept until a turn starts. */
  antigravityPendingWarning: string | undefined;
  /** Antigravity: private-format readers are certified for the runtime this session launched. */
  readonly antigravityNativeReaders: boolean;
  /** Antigravity: the launched runtime's step numbering was checked, so any error step fails. */
  readonly antigravityStepLayoutVerified: boolean;
  /** Antigravity: the account revision this session started under. */
  readonly antigravityAccountRevision: number | undefined;
  readonly antigravitySelection: AntigravitySelectionState;
  /** Antigravity: last context sample emitted, for coalescing. */
  lastContextUsage: string | undefined;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsCancelled(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.resolution, { _tag: "cancelled" }).pipe(Effect.ignore),
    { discard: true },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGrokResume(raw: unknown): { sessionId: string; accountRevision: number } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== GROK_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return {
    sessionId: raw.sessionId.trim(),
    // Cursors written before account revisions existed belong to revision zero.
    accountRevision:
      typeof raw.accountRevision === "number" && Number.isSafeInteger(raw.accountRevision)
        ? raw.accountRevision
        : 0,
  };
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  try {
    return JSON.stringify(input);
  } catch {
    return undefined;
  }
}

function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  return acpPermissionOutcome(decision, request.options);
}

/**
 * Identifies an operation for "Always allow this session": the same command, or the same tool
 * with the same input, never every future call of a tool. A generic title with no input cannot
 * identify an operation, so it is not remembered.
 */
function sessionApprovalKey(request: EffectAcpSchema.RequestPermissionRequest): string | undefined {
  const { kind, title, rawInput, locations } = request.toolCall;
  const command = parsePermissionRequest(request).toolCall?.command;
  let input = rawInput;
  if (isRecord(rawInput) && rawInput.variant === "Bash") {
    const { description: _description, ...shellInput } = rawInput;
    input = shellInput;
  }
  return command || (isRecord(rawInput) && Object.keys(rawInput).length > 0)
    ? canonicalJson({ kind, title, command, input, locations })
    : undefined;
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "acceptForSession") ??
    selectPermissionOptionId(request, "accept")
  );
}

export function makeGrokAdapter(grokSettings: GrokSettings, options?: GrokAdapterLiveOptions) {
  return Effect.gen(function* () {
    const PROVIDER = options?.provider ?? "grok";
    const providerLabel =
      PROVIDER === "acp" ? "Custom ACP agent" : PROVIDER === "antigravity" ? "Antigravity" : "Grok";
    const normalizeModel = options?.normalizeModel ?? resolveGrokAcpBaseModelId;
    /** Unavailable models and modes fail as validation errors before anything is sent. */
    const antigravityErrorMapper =
      (threadId: ThreadId, operation: "startSession" | "sendTurn") =>
      (
        cause:
          | EffectAcpErrors.AcpError
          | AntigravityModelUnavailableError
          | AntigravityModeUnavailableError,
      ) =>
        cause instanceof AntigravityModelUnavailableError ||
        cause instanceof AntigravityModeUnavailableError
          ? new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation,
              issue: cause.message,
            })
          : mapAcpToAdapterError(
              PROVIDER,
              threadId,
              operation === "startSession" ? "session/configure" : "session/set_config_option",
              cause,
              automationCatalogs.get(threadId)?.scrubDiagnostic,
              automationCatalogs.get(threadId)?.hasSensitiveConfiguration() ?? false,
            );
    const observeAntigravityCatalog = (
      acp: AcpSessionRuntimeShape,
      selection: AntigravitySelectionState,
      accountRevision: number | undefined,
    ) =>
      options?.antigravity?.observeCatalog
        ? Effect.gen(function* () {
            const configOptions = yield* acp.getConfigOptions;
            const modelOption = findModelConfigOption(configOptions);
            const model = modelOption?.currentValue || undefined;
            const levels = antigravityThinkingLevels(configOptions);
            // The current value is this thread's selection; the catalog's default is the level
            // the model reported right after `setModel`, before F5 wrote one.
            const baseline =
              selection.baseline && selection.baseline.model === model
                ? selection.baseline.level
                : undefined;
            yield* options.antigravity!.observeCatalog!({
              model,
              thinking: levels && { ...levels, defaultLevel: baseline ?? levels.defaultLevel },
              modelChoices: (modelOption?.options ?? []).flatMap((entry) =>
                "value" in entry ? [entry] : entry.options,
              ),
              advertisedModes: antigravityAdvertisedModes(yield* acp.getModeState, configOptions)
                .modes,
              ...(accountRevision !== undefined ? { accountRevision } : {}),
            });
          })
        : Effect.void;
    const adapterScope = yield* Scope.Scope;
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make(PROVIDER);
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

    const sessions = new Map<ThreadId, GrokSessionContext>();
    const skillInventory = (
      cwd: string,
    ): Effect.Effect<ReadonlyArray<{ name: string; enabled: boolean }>> =>
      options?.discoverSkillCommands
        ? options.discoverSkillCommands(cwd).pipe(
            Effect.map((commands) => commands.map((command) => ({ ...command, enabled: true }))),
            Effect.orElseSucceed(() => []),
          )
        : discoverGrokSkills(grokSettings, options?.environment ?? process.env, cwd);
    const rewriteUserText = (text: string, cwd: string | undefined) =>
      PROVIDER === "grok" && leadingGrokSkillMention(text) && cwd
        ? skillInventory(cwd).pipe(Effect.map((skills) => rewriteLeadingGrokSkill(text, skills)))
        : Effect.succeed(text);
    const startupPendingUserInputs = new Map<ThreadId, Map<ApprovalRequestId, PendingUserInput>>();
    /** Private ACP form/URL requests, keyed by thread so startup requests are covered. */
    const elicitationsByThread = new Map<ThreadId, ElicitationRegistry>();
    const elicitationsFor = (threadId: ThreadId) => {
      let registry = elicitationsByThread.get(threadId);
      if (!registry) {
        registry = new ElicitationRegistry();
        elicitationsByThread.set(threadId, registry);
      }
      return registry;
    };
    const emitElicitationReceipt = (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      receipt: ElicitationTerminalReceipt,
    ) =>
      Effect.gen(function* () {
        yield* offerRuntimeEvent({
          type: "user-input.resolved",
          ...(yield* makeEventStamp(sessions.get(threadId))),
          provider: PROVIDER,
          threadId,
          turnId: sessions.get(threadId)?.activeTurnId,
          requestId: RuntimeRequestId.make(requestId),
          payload: { answers: {}, receipt },
        });
      });
    const settleElicitationsForTurn = (threadId: ThreadId, turnId: TurnId) =>
      Effect.gen(function* () {
        const registry = elicitationsByThread.get(threadId);
        for (const requestId of registry?.forTurn(turnId) ?? []) {
          const receipt = registry?.settle(requestId, "completed");
          if (receipt) yield* emitElicitationReceipt(threadId, requestId, receipt);
        }
      });
    const abortElicitations = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const registry = elicitationsByThread.get(threadId);
        elicitationsByThread.delete(threadId);
        for (const { requestId, receipt } of registry?.abortAll() ?? [])
          yield* emitElicitationReceipt(threadId, requestId, receipt);
      });
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.make(timeOrderedUuid(id)));
    const makeEventStamp = (ctx?: GrokSessionContext) => {
      const identity = ctx?.eventIdentity;
      return Effect.all({ eventId: nextEventId, createdAt: nowIso }).pipe(
        Effect.map((stamp) => ({ ...stamp, ...identity })),
      );
    };

    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: `Failed to process ${providerLabel} ACP callback.`,
              cause,
            }),
        ),
      );

    const automationCatalogs = new Map<string, AcpAutomationCatalogs>();
    const buildConfigurations = new Map<
      string,
      { sessionId: string; configuration: AcpBuildConfiguration }
    >();
    const prepareRuntimeEvent = yield* makeAutomationRuntimeEventPreparer;
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) => {
      const release = automationEventSanitizer.retain(event.threadId);
      const catalogs = automationCatalogs.get(event.threadId);
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

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
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

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
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
      ctx: GrokSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
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
            source: "acp.jsonrpc",
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<GrokSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const getOrCreateStartupPendingUserInputs = (threadId: ThreadId) => {
      const existing = startupPendingUserInputs.get(threadId);
      if (existing) {
        return existing;
      }
      const pending = new Map<ApprovalRequestId, PendingUserInput>();
      startupPendingUserInputs.set(threadId, pending);
      return pending;
    };

    const getPendingUserInputsForRequest = (threadId: ThreadId) => {
      const ctx = sessions.get(threadId);
      if (ctx && !ctx.stopped) {
        return ctx.pendingUserInputs;
      }
      return getOrCreateStartupPendingUserInputs(threadId);
    };

    const settleAndDeleteStartupPendingUserInputs = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const pending = startupPendingUserInputs.get(threadId);
        if (!pending) {
          return;
        }
        yield* settlePendingUserInputsAsCancelled(pending);
        pending.clear();
        startupPendingUserInputs.delete(threadId);
      });

    const stopSessionInternal = (ctx: GrokSessionContext, failure?: string) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        ctx.transportFailure = failure;
        if (failure)
          yield* offerRuntimeEvent({
            type: "runtime.error",
            ...(yield* makeEventStamp(ctx)),
            provider: PROVIDER,
            threadId: ctx.threadId,
            ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
            payload: { class: "transport_error", message: failure },
          });
        sessions.delete(ctx.threadId);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
        yield* abortElicitations(ctx.threadId);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        for (const task of ctx.backgroundTasks.values()) {
          yield* offerRuntimeEvent({
            type: "task.completed",
            ...(yield* makeEventStamp(ctx)),
            provider: PROVIDER,
            threadId: ctx.threadId,
            ...(task.turnId ? { turnId: task.turnId } : {}),
            payload: {
              taskId: task.payload.taskId,
              status: "stopped",
              summary: `${providerLabel} session stopped`,
            },
          });
        }
        ctx.backgroundTasks.clear();
        for (const eventData of ctx.antigravityTasks.finish())
          yield* offerRuntimeEvent({
            ...eventData,
            ...(yield* makeEventStamp(ctx)),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
          } as ProviderRuntimeEvent);
        // After an agent exit its failed prompt may already have left the
        // in-flight count, so an uncompleted active turn is enough.
        if (
          ctx.activeTurnId &&
          (failure ? ctx.completedTurnId !== ctx.activeTurnId : ctx.promptsInFlight > 0)
        ) {
          ctx.completedTurnId = ctx.activeTurnId;
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp(ctx)),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload: failure
              ? { state: "failed", errorMessage: failure }
              : { state: "cancelled", stopReason: "cancelled" },
          });
        }
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
    const handleUnexpectedAgentExit = (ctx: GrokSessionContext, code: number | undefined) =>
      withThreadLock(
        ctx.threadId,
        Effect.gen(function* () {
          if (ctx.stopped || sessions.get(ctx.threadId) !== ctx) return;
          yield* stopSessionInternal(
            ctx,
            code === undefined
              ? `The ${providerLabel} agent exited unexpectedly.`
              : `The ${providerLabel} agent exited unexpectedly (code ${code}).`,
          );
        }),
      );

    const startSession: GrokAdapterShape["startSession"] = (input) =>
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
          if (!input.cwd) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }
          const staleStart = options?.antigravity?.staleAccount
            ? yield* options.antigravity.staleAccount
            : undefined;
          if (staleStart)
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: staleStart,
            });

          const cwd = nodePath.resolve(input.cwd);
          const grokModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const sessionApprovedOperations = new Set<string>();
          const pendingUserInputs = getOrCreateStartupPendingUserInputs(input.threadId);
          yield* settlePendingUserInputsAsCancelled(pendingUserInputs);
          pendingUserInputs.clear();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred
              ? Effect.void
              : settleAndDeleteStartupPendingUserInputs(input.threadId).pipe(
                  Effect.andThen(Scope.close(sessionScope, Exit.void)),
                ),
          );

          const discoveredSkillCommands = yield* (
            options?.discoverSkillCommands?.(cwd) ?? Effect.succeed([])
          );
          const accountRevision =
            PROVIDER === "antigravity" && options?.antigravity?.accountRevision
              ? yield* options.antigravity.accountRevision
              : 0;
          const parsedResume = parseGrokResume(input.resumeCursor);
          // A cursor from another account revision starts a fresh native session over the
          // retained F5 history; the old account's session is never resumed.
          const resumeSessionId =
            parsedResume &&
            (PROVIDER !== "antigravity" || parsedResume.accountRevision === accountRevision)
              ? parsedResume.sessionId
              : undefined;
          const catalogs = yield* prepareAcpAutomationCatalogs({
            threadId: input.threadId,
            provider: PROVIDER as "cursor" | "grok" | "antigravity" | "acp",
            scope: sessionScope,
            ...(options?.previewMcpHttpServer ? { preview: options.previewMcpHttpServer } : {}),
            ...(options?.computerAutomationBroker
              ? { computer: options.computerAutomationBroker }
              : {}),
            ...(options?.automationCatalogVerification
              ? { verification: options.automationCatalogVerification }
              : {}),
            ...(options?.antigravity?.credentials
              ? { credentials: options.antigravity.credentials }
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
              if (automationCatalogs.get(input.threadId) === catalogs)
                automationCatalogs.delete(input.threadId);
            }),
          ).pipe(Effect.provideService(Scope.Scope, sessionScope));
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
            redactForLog: catalogs.redactForLog,
          });

          const acp = yield* (options?.makeRuntime ?? makeGrokAcpRuntime)({
            grokSettings,
            runtimeMode: input.runtimeMode,
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
            yield* Effect.forEach(
              ["x.ai/ask_user_question", "_x.ai/ask_user_question"] as const,
              (method) =>
                acp.handleExtRequest(method, XAiAskUserQuestionRequest, (params) =>
                  mapAcpCallbackFailure(
                    Effect.gen(function* () {
                      yield* logNative(input.threadId, method, params);
                      const requestId = ApprovalRequestId.make(yield* Random.nextUUIDv4);
                      const runtimeRequestId = RuntimeRequestId.make(requestId);
                      const resolution = yield* Deferred.make<PendingUserInputResolution>();
                      const pendingUserInputsForRequest = getPendingUserInputsForRequest(
                        input.threadId,
                      );
                      pendingUserInputsForRequest.set(requestId, { resolution });
                      yield* offerRuntimeEvent({
                        type: "user-input.requested",
                        ...(yield* makeEventStamp(ctx)),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId: sessions.get(input.threadId)?.activeTurnId,
                        requestId: runtimeRequestId,
                        payload: { questions: extractXAiAskUserQuestions(params) },
                        raw: {
                          source: "acp.grok.extension",
                          method,
                          payload: params,
                        },
                      });
                      const resolved = yield* Deferred.await(resolution);
                      pendingUserInputsForRequest.delete(requestId);
                      const resolvedAnswers = resolved._tag === "answered" ? resolved.answers : {};
                      yield* offerRuntimeEvent({
                        type: "user-input.resolved",
                        ...(yield* makeEventStamp(ctx)),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId: sessions.get(input.threadId)?.activeTurnId,
                        requestId: runtimeRequestId,
                        payload: { answers: resolvedAnswers },
                        raw: {
                          source: "acp.grok.extension",
                          method,
                          payload: params,
                        },
                      });
                      return resolved._tag === "answered"
                        ? makeXAiAskUserQuestionResponse(params, resolved.answers)
                        : makeXAiAskUserQuestionCancelledResponse();
                    }),
                  ),
                ),
              { discard: true },
            );
            if (PROVIDER === "antigravity")
              yield* acp.handleElicitation((params) =>
                mapAcpCallbackFailure(
                  Effect.gen(function* () {
                    const live = sessions.get(input.threadId);
                    if (
                      startupPendingUserInputs.get(input.threadId) !== pendingUserInputs &&
                      (!live || live.stopped || live.pendingUserInputs !== pendingUserInputs)
                    )
                      return { action: { action: "cancel" as const } };
                    const cancelled = { action: { action: "cancel" as const } };
                    const descriptor = acpElicitationDescriptor(params);
                    if (!descriptor.ok) {
                      yield* offerRuntimeEvent({
                        type: "runtime.warning",
                        ...(yield* makeEventStamp(ctx)),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId: sessions.get(input.threadId)?.activeTurnId,
                        payload: {
                          message: `${providerLabel} asked for input F5 cannot show completely (${descriptor.reason}); it was cancelled without submitting data.`,
                        },
                      });
                      return cancelled;
                    }
                    // Answers travel only through the private elicitation path.
                    const requestId = ApprovalRequestId.make(yield* Random.nextUUIDv4);
                    const answer = yield* Deferred.make<AcpElicitationResponse>();
                    const release = (response: AcpElicitationResponse) => {
                      Effect.runSync(Deferred.succeed(answer, response));
                    };
                    const turnId = sessions.get(input.threadId)?.activeTurnId;
                    elicitationsFor(input.threadId).open({
                      requestId,
                      descriptor: descriptor.value,
                      turnId,
                      deliver: async (response) => release(acpElicitationResponse(response)),
                      abort: () => release(cancelled),
                      // Releasing the deferred is the ACP callback's response.
                      completesOnDelivery: true,
                    });
                    yield* offerRuntimeEvent({
                      type: "user-input.requested",
                      ...(yield* makeEventStamp(ctx)),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: RuntimeRequestId.make(requestId),
                      payload: { questions: [], elicitation: descriptor.value },
                    });
                    return yield* Deferred.await(answer);
                  }),
                ),
              );
            if (PROVIDER === "antigravity")
              yield* acp.handleElicitationComplete((notification) =>
                Effect.gen(function* () {
                  // Correlated native completion of a URL request.
                  const registry = elicitationsByThread.get(input.threadId);
                  const requestId = registry?.findByNativeId(notification.elicitationId);
                  const receipt = requestId ? registry?.settle(requestId, "completed") : undefined;
                  if (requestId && receipt)
                    yield* emitElicitationReceipt(input.threadId, requestId, receipt);
                }),
              );
            yield* acp.handleRequestPermission((params) =>
              mapAcpCallbackFailure(
                Effect.gen(function* () {
                  const live = sessions.get(input.threadId);
                  if (
                    startupPendingUserInputs.get(input.threadId) !== pendingUserInputs &&
                    (!live || live.stopped || live.pendingApprovals !== pendingApprovals)
                  )
                    return { outcome: { outcome: "cancelled" as const } };
                  yield* logNative(
                    input.threadId,
                    "session/request_permission",
                    boundPermissionRequestPayload(params),
                  );
                  const computerRequest = catalogs.classify(params.toolCall);
                  const approvalKey = computerRequest ? undefined : sessionApprovalKey(params);
                  if (computerRequest)
                    params = {
                      ...params,
                      toolCall: { toolCallId: params.toolCall.toolCallId, title: "Tool activity" },
                    };

                  if (
                    !computerRequest &&
                    PROVIDER === "antigravity" &&
                    params.toolCall.toolCallId.startsWith("interaction_")
                  ) {
                    const question = antigravityQuestion(params);
                    if (!question) return { outcome: { outcome: "cancelled" as const } };
                    const requestId = ApprovalRequestId.make(yield* Random.nextUUIDv4);
                    const resolution = yield* Deferred.make<PendingUserInputResolution>();
                    pendingUserInputs.set(requestId, {
                      resolution,
                      validate: (answers) =>
                        Object.keys(answers).length === 0 ||
                        antigravityQuestionResponse(params, answers) !== undefined,
                    });
                    yield* offerRuntimeEvent({
                      type: "user-input.requested",
                      ...(yield* makeEventStamp(ctx)),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: sessions.get(input.threadId)?.activeTurnId,
                      requestId: RuntimeRequestId.make(requestId),
                      payload: { questions: [question] },
                    });
                    const answer = yield* Deferred.await(resolution);
                    pendingUserInputs.delete(requestId);
                    const answers = answer._tag === "answered" ? answer.answers : {};
                    yield* offerRuntimeEvent({
                      type: "user-input.resolved",
                      ...(yield* makeEventStamp(ctx)),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: sessions.get(input.threadId)?.activeTurnId,
                      requestId: RuntimeRequestId.make(requestId),
                      payload: { answers },
                    });
                    return (
                      antigravityQuestionResponse(params, answers) ?? {
                        outcome: { outcome: "cancelled" as const },
                      }
                    );
                  }
                  // The runtime applies mode notifications and `set_mode` responses in transport
                  // order, so its state cannot be overwritten by a stale queued `ModeChanged`.
                  const nativeMode =
                    PROVIDER === "antigravity"
                      ? antigravityAdvertisedModes(
                          yield* acp.getModeState,
                          yield* acp.getConfigOptions,
                        ).current
                      : undefined;
                  const antigravityDecision =
                    PROVIDER === "antigravity"
                      ? antigravityApprovalDecision({
                          runtimeMode: input.runtimeMode,
                          sessionMode: nativeMode ?? live?.antigravityMode,
                          planRequested: live?.antigravityPlanRequested === true,
                          computerRequest: Boolean(computerRequest),
                          toolCall: params.toolCall,
                          workspaceRoot: cwd,
                        })
                      : undefined;
                  const sessionApprovedOptionId =
                    approvalKey !== undefined &&
                    antigravityDecision?.kind !== "allow" &&
                    (antigravityDecision === undefined || antigravityDecision.applyThreadGrants) &&
                    sessionApprovedOperations.has(approvalKey)
                      ? selectPermissionOptionId(params, "accept")
                      : undefined;
                  if (sessionApprovedOptionId !== undefined)
                    return {
                      outcome: { outcome: "selected" as const, optionId: sessionApprovedOptionId },
                    };
                  if (antigravityDecision?.kind === "allow") {
                    // Single-use allow; "always" options are never chosen on the user's behalf.
                    const allowOnce = selectPermissionOptionId(params, "accept");
                    if (allowOnce !== undefined)
                      return { outcome: { outcome: "selected" as const, optionId: allowOnce } };
                  }
                  const runtimeMode: RuntimeMode = input.runtimeMode;
                  if (PROVIDER !== "antigravity")
                    switch (runtimeMode) {
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
                        throw new Error(
                          `${providerLabel} does not support runtime mode '${runtimeMode}'.`,
                        );
                      default:
                        return assertNever(runtimeMode, `${providerLabel} approval mode`);
                    }
                  const permissionRequest = parsePermissionRequest(params);
                  // Persisted on the runtime event; a large `rawOutput` or `content` is bounded.
                  const publishedParams = boundPermissionRequestPayload(params);
                  const requestId = ApprovalRequestId.make(yield* Random.nextUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  pendingApprovals.set(requestId, { decision });
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(ctx),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: sessions.get(input.threadId)?.activeTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail: computerRequest
                        ? "Tool inputs hidden while computer control is enabled"
                        : (permissionRequest.detail ??
                          encodeJsonStringForDiagnostics(publishedParams)?.slice(0, 2000) ??
                          "[unserializable params]"),
                      ...(PROVIDER === "antigravity"
                        ? {
                            approvalOptions: antigravityApprovalOptions(params, {
                              allowThreadGrants:
                                antigravityDecision?.kind !== "ask" ||
                                antigravityDecision.applyThreadGrants,
                            }),
                          }
                        : {}),
                      args: publishedParams,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: publishedParams,
                    }),
                  );
                  const answered = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  // Where thread grants do not apply (Plan, computer consent), a thread-wide
                  // answer is enforced as single-use so the CLI never receives `allow_always`.
                  const resolved: ProviderApprovalDecision =
                    answered === "acceptForSession" &&
                    antigravityDecision?.kind === "ask" &&
                    !antigravityDecision.applyThreadGrants
                      ? "accept"
                      : answered;
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(ctx),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: sessions.get(input.threadId)?.activeTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  const selectedOptionId =
                    resolved === "cancel" ? undefined : selectPermissionOptionId(params, resolved);
                  if (
                    resolved === "acceptForSession" &&
                    selectedOptionId &&
                    approvalKey &&
                    (antigravityDecision === undefined ||
                      (antigravityDecision.kind === "ask" && antigravityDecision.applyThreadGrants))
                  )
                    sessionApprovedOperations.add(approvalKey);
                  return {
                    outcome: selectedOptionId
                      ? {
                          outcome: "selected" as const,
                          optionId: selectedOptionId,
                        }
                      : ({ outcome: "cancelled" } as const),
                  };
                }),
              ),
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

          if (options?.configureRuntime)
            yield* options
              .configureRuntime(acp, input.runtimeMode)
              .pipe(
                Effect.mapError((cause) =>
                  mapAcpToAdapterError(
                    PROVIDER,
                    input.threadId,
                    "session/configure",
                    cause,
                    automationCatalogs.get(input.threadId)?.scrubDiagnostic,
                    automationCatalogs.get(input.threadId)?.hasSensitiveConfiguration() ?? false,
                  ),
                ),
              );
          if (options?.onRuntimeReady) yield* options.onRuntimeReady(acp, started);
          // Session recovery passes the persisted `model` and `modelOptions` instead of a
          // selection; Antigravity restores both so a resume never keeps the account default.
          const recoveredModel =
            PROVIDER === "antigravity" && !grokModelSelection ? input.model?.trim() : undefined;
          const requestedStartModelId = grokModelSelection?.model
            ? normalizeModel(grokModelSelection.model)
            : recoveredModel
              ? normalizeModel(recoveredModel)
              : undefined;
          const requestedStartThinking = grokModelSelection
            ? getModelSelectionStringOptionValue(grokModelSelection, "thinking")
            : PROVIDER === "antigravity"
              ? input.modelOptions?.antigravity?.thinking
              : undefined;
          const antigravitySelection = makeAntigravitySelectionState();
          const antigravityStartWarnings: string[] = [];
          let antigravityStartMode: string | undefined;
          let antigravityAutoUnavailable = false;
          // Certified once, for the runtime this session just launched.
          const antigravityNativeReaders =
            PROVIDER === "antigravity" && options?.antigravity?.nativeReaders
              ? yield* options.antigravity.nativeReaders(acp)
              : true;
          if (PROVIDER === "antigravity") {
            const mapStartError = antigravityErrorMapper(input.threadId, "startSession");
            const advertised = antigravityAdvertisedModes(
              yield* acp.getModeState,
              yield* acp.getConfigOptions,
            );
            if (input.runtimeMode === "auto" && !advertised.modes.includes("auto")) {
              antigravityAutoUnavailable = true;
              antigravityStartWarnings.push(
                "This Antigravity session does not offer native Auto, so it runs as Supervised and asks before acting.",
              );
            }
            antigravityStartMode = yield* applyAntigravitySessionMode({
              runtime: acp,
              target: antigravityTargetMode({
                runtimeMode: input.runtimeMode,
                plan: false,
                advertised: advertised.modes,
              }),
              mapError: mapStartError,
              onAutoFallback: (warning) => {
                antigravityAutoUnavailable = true;
                antigravityStartWarnings.push(warning);
              },
            });
          }
          // Custom ACP and Antigravity write the model config option; Grok uses session/set_model.
          const writesConfigOption = PROVIDER !== "grok";
          const boundModelId =
            PROVIDER === "antigravity"
              ? yield* applyAntigravityModelSelection({
                  runtime: acp,
                  requestedModel: requestedStartModelId,
                  requestedThinking: requestedStartThinking,
                  customModels: grokSettings.customModels.map(customModelSlug),
                  state: antigravitySelection,
                  mapError: antigravityErrorMapper(input.threadId, "startSession"),
                }).pipe(
                  Effect.tap((selection) =>
                    Effect.sync(() => {
                      if (selection.warning) antigravityStartWarnings.push(selection.warning);
                    }),
                  ),
                  Effect.tap(() =>
                    observeAntigravityCatalog(acp, antigravitySelection, accountRevision),
                  ),
                  Effect.map((selection) => selection.model),
                )
              : yield* applyGrokAcpModelSelection({
                  runtime: acp,
                  defaultModelId: PROVIDER === "acp" ? "acp-default" : "grok-build",
                  currentModelId: currentGrokModelIdFromSessionSetup(
                    started.sessionSetupResult,
                    writesConfigOption ? "config-option" : "model-state",
                  ),
                  ...(writesConfigOption
                    ? {
                        availableModels: {
                          offered: offeredAcpModelIds(started.sessionSetupResult),
                          custom: grokSettings.customModels.map(customModelSlug),
                        },
                      }
                    : {}),
                  requestedModelId:
                    PROVIDER === "acp" && requestedStartModelId === "acp-default"
                      ? undefined
                      : requestedStartModelId,
                  mapError: (cause) =>
                    mapAcpToAdapterError(
                      PROVIDER,
                      input.threadId,
                      "session/set_model",
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
            ...(boundModelId ? { model: normalizeModel(boundModelId) } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: GROK_RESUME_VERSION,
              sessionId: started.sessionId,
              ...(catalogs.computerCapable() ? { computerCapable: true } : {}),
              ...(PROVIDER === "antigravity" ? { accountRevision } : {}),
            },
            createdAt: now,
            updatedAt: now,
          };

          const ctx: GrokSessionContext = {
            supportsDocuments:
              started.initializeResult.agentCapabilities?.promptCapabilities?.embeddedContext ===
              true,
            eventIdentity: input.mcpEventIdentity,
            threadId: input.threadId,
            historySessionOrigin: "sessionId" in started.sessionSetupResult ? "fresh" : "resumed",
            acpSessionId: started.sessionId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            completedTurnId: undefined,
            promptsInFlight: 0,
            currentModelId: boundModelId,
            stopped: false,
            backgroundTasks: new Map(),
            antigravityTasks: new AntigravityTasks(),
            normalizeAntigravityTool: makeAntigravityToolNormalizer(),
            nativeChildrenPolling: false,
            antigravityMode: antigravityStartMode,
            antigravityAutoUnavailable,
            antigravityPlanRequested: false,
            antigravityPendingWarning: undefined,
            antigravityNativeReaders,
            antigravityStepLayoutVerified:
              PROVIDER === "antigravity" &&
              antigravityStepLayoutVerified(antigravityLaunchedVersion(acp)),
            antigravityAccountRevision: PROVIDER === "antigravity" ? accountRevision : undefined,
            antigravitySelection,
            lastContextUsage: undefined,
          };

          let nativeSkillCommands: typeof discoveredSkillCommands = [];
          const offCatalogStatus = catalogs.onChanged(() => {
            void Effect.runPromise(
              Effect.gen(function* () {
                yield* offerRuntimeEvent({
                  type: "session.configured",
                  ...(yield* makeEventStamp(ctx)),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  payload: { config: {} },
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
                if (
                  event._tag === "ContentDelta" ||
                  event._tag === "PlanUpdated" ||
                  event._tag === "AssistantItemStarted"
                )
                  ctx.antigravityTasks.noteParentProgress();
                const computerCall =
                  event._tag === "ToolCallUpdated" && classifyAcpToolEvent(catalogs, event);
                switch (event._tag) {
                  case "TransportTerminated":
                    // Closing a scope from its own notification fiber deadlocks.
                    // A sibling owns teardown, fenced against session replacement.
                    yield* withThreadLock(
                      ctx.threadId,
                      Effect.suspend(() =>
                        sessions.get(ctx.threadId) === ctx && !ctx.stopped
                          ? stopSessionInternal(ctx, event.message)
                          : Effect.void,
                      ),
                    ).pipe(Effect.forkIn(adapterScope));
                    return;
                  case "ModeChanged":
                    ctx.antigravityMode = event.modeId;
                    return;
                  case "UsageUpdated": {
                    // Context samples only; prompt-response totals never overwrite the window.
                    if (PROVIDER !== "antigravity") return;
                    if (ctx.stopped || sessions.get(ctx.threadId) !== ctx) return;
                    const sample = `${event.used}/${event.size}`;
                    if (ctx.lastContextUsage === sample) return;
                    ctx.lastContextUsage = sample;
                    yield* offerRuntimeEvent({
                      type: "thread.token-usage.updated",
                      ...(yield* makeEventStamp(ctx)),
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
                      payload: {
                        usage: {},
                        contextTokens: event.used,
                        modelContextWindowTokens: event.size,
                      },
                    });
                    return;
                  }
                  case "AssistantItemStarted":
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
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* emitPlanUpdate(ctx, event.payload, event.rawPayload, "session/update");
                    return;
                  case "NoticeReceived":
                    yield* offerRuntimeEvent(
                      makeAcpNoticeEvent({
                        stamp: yield* makeEventStamp(ctx),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        notice: event,
                      }),
                    );
                    return;
                  case "ToolCallUpdated":
                    if (ctx.stopped) return;
                    if (!computerCall && PROVIDER === "antigravity" && ctx.activeTurnId) {
                      for (const eventData of ctx.antigravityTasks.update(
                        event.toolCall,
                        event.rawPayload,
                      ))
                        yield* offerRuntimeEvent({
                          ...eventData,
                          payload: {
                            ...eventData.payload,
                            ...(eventData.type === "task.started"
                              ? { nativeParentSessionId: ctx.acpSessionId }
                              : {}),
                          },
                          ...(yield* makeEventStamp(ctx)),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: ctx.activeTurnId,
                        } as ProviderRuntimeEvent);
                    }
                    for (const task of computerCall
                      ? []
                      : buildGrokBackgroundTaskEvents({
                          tasks: ctx.backgroundTasks,
                          toolCallId: event.toolCall.toolCallId,
                          rawInput: event.toolCall.data.rawInput,
                          rawOutput: event.toolCall.data.rawOutput,
                          toolCallStatus: event.toolCall.status,
                          turnId: ctx.activeTurnId,
                        })) {
                      yield* offerRuntimeEvent({
                        ...task,
                        ...(yield* makeEventStamp(ctx)),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                      });
                    }
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(ctx),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall:
                          PROVIDER === "antigravity"
                            ? ctx.normalizeAntigravityTool(event.toolCall)
                            : event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "SlashCommandsUpdated":
                    nativeSkillCommands = event.commands;
                    yield* offerRuntimeEvent({
                      ...(yield* makeEventStamp(ctx)),
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      type: "session.configured",
                      payload: {
                        config: {
                          slashCommands: normalizeSupportedSlashCommands(
                            [...event.commands, ...discoveredSkillCommands].filter(
                              (command) =>
                                PROVIDER !== "antigravity" ||
                                options?.nativeCompaction ||
                                command.name.replace(/^\//, "") !== "compact",
                            ),
                          ),
                        },
                      },
                    });
                    return;
                  case "ContentDelta":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
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
          startupPendingUserInputs.delete(input.threadId);
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
          if (discoveredSkillCommands.length)
            yield* offerRuntimeEvent({
              ...(yield* makeEventStamp(ctx)),
              provider: PROVIDER,
              threadId: input.threadId,
              type: "session.configured",
              payload: {
                config: {
                  slashCommands: normalizeSupportedSlashCommands([
                    ...nativeSkillCommands,
                    ...discoveredSkillCommands,
                  ]),
                },
              },
            });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp(ctx)),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: `${providerLabel} ACP session ready` },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp(ctx)),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });
          for (const message of antigravityStartWarnings)
            yield* offerRuntimeEvent({
              type: "runtime.warning",
              ...(yield* makeEventStamp(ctx)),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { message },
            });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: GrokAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            const staleTurn = options?.antigravity?.staleAccount
              ? yield* options.antigravity.staleAccount
              : undefined;
            if (staleTurn)
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: staleTurn,
              });
            if (
              PROVIDER === "antigravity" &&
              !options?.nativeCompaction &&
              /^\/compact(?:\s|$)/.test(input.input?.trim() ?? "")
            )
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue:
                  "Native compaction is disabled for this Antigravity instance. Use F5’s Compact action or enable native compaction in Settings.",
              });
            if (
              input.expectedTurnId &&
              (ctx.activeTurnId !== input.expectedTurnId || ctx.promptsInFlight === 0)
            )
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/steer",
                detail: "The active turn ended or changed before steering.",
              });
            const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
            const turnId = steeringTurnId ?? TurnId.make(yield* Random.nextUUIDv4);
            ctx.promptsInFlight += 1;

            return yield* Effect.gen(function* () {
              if (PROVIDER === "acp" && steeringTurnId === undefined) {
                let saved = buildConfigurations.get(input.threadId);
                if (!saved || saved.sessionId !== ctx.acpSessionId) {
                  saved = {
                    sessionId: ctx.acpSessionId,
                    configuration: makeAcpBuildConfiguration(),
                  };
                  buildConfigurations.set(input.threadId, saved);
                }
                yield* applyAcpPlanMode(
                  ctx.acp,
                  input.interactionMode === "plan",
                  saved.configuration,
                ).pipe(
                  Effect.mapError(({ method, cause }) =>
                    mapAcpToAdapterError(
                      PROVIDER,
                      input.threadId,
                      method,
                      cause,
                      automationCatalogs.get(input.threadId)?.scrubDiagnostic,
                      automationCatalogs.get(input.threadId)?.hasSensitiveConfiguration() ?? false,
                    ),
                  ),
                );
              }
              const turnModelSelection =
                input.modelSelection?.instanceId === boundInstanceId
                  ? input.modelSelection
                  : undefined;
              const requestedTurnModelId = turnModelSelection?.model
                ? normalizeModel(turnModelSelection.model)
                : undefined;
              let antigravityTurnWarning: string | undefined;
              let antigravityModeWarning: string | undefined;
              if (PROVIDER === "antigravity" && steeringTurnId === undefined) {
                // Steers stay inside the running turn: no mode, model or level writes.
                const mapTurnError = antigravityErrorMapper(input.threadId, "sendTurn");
                // Set before the mode write, so a request that arrives while the native mode
                // lags behind is still held to Plan's rules.
                ctx.antigravityPlanRequested = input.interactionMode === "plan";
                const advertised = antigravityAdvertisedModes(
                  yield* ctx.acp.getModeState,
                  yield* ctx.acp.getConfigOptions,
                );
                ctx.antigravityMode = yield* applyAntigravitySessionMode({
                  runtime: ctx.acp,
                  target: antigravityTargetMode({
                    // Once Auto fell back for this session, later turns stay Supervised.
                    runtimeMode: ctx.antigravityAutoUnavailable
                      ? "approval-required"
                      : ctx.session.runtimeMode,
                    plan: input.interactionMode === "plan",
                    advertised: advertised.modes,
                  }),
                  mapError: mapTurnError,
                  onAutoFallback: (warning) => {
                    ctx.antigravityAutoUnavailable = true;
                    // Kept on the session until a turn publishes it: a turn that fails later
                    // (an attachment, an empty prompt) must not swallow the only warning.
                    ctx.antigravityPendingWarning = warning;
                  },
                });
                antigravityModeWarning = ctx.antigravityPendingWarning;
              }
              const currentModelId =
                PROVIDER === "antigravity"
                  ? steeringTurnId !== undefined || turnModelSelection === undefined
                    ? ctx.currentModelId
                    : yield* applyAntigravityModelSelection({
                        runtime: ctx.acp,
                        requestedModel: requestedTurnModelId,
                        requestedThinking: getModelSelectionStringOptionValue(
                          turnModelSelection,
                          "thinking",
                        ),
                        customModels: grokSettings.customModels.map(customModelSlug),
                        state: ctx.antigravitySelection,
                        mapError: antigravityErrorMapper(input.threadId, "sendTurn"),
                      }).pipe(
                        Effect.tap((selection) =>
                          Effect.sync(() => {
                            antigravityTurnWarning = selection.warning;
                            // The native session has switched: keep the cache in step even if
                            // the turn fails later (an attachment, an empty prompt).
                            ctx.currentModelId = selection.model;
                          }),
                        ),
                        // A selection can switch the model and then fail on the level: read back
                        // the native model so a later turn without a selection reports the
                        // model it really runs on.
                        Effect.tapError(() =>
                          ctx.acp.getConfigOptions.pipe(
                            Effect.map((options) => {
                              const active = findModelConfigOption(options)?.currentValue;
                              if (typeof active === "string" && active) ctx.currentModelId = active;
                            }),
                          ),
                        ),
                        Effect.tap(() =>
                          observeAntigravityCatalog(
                            ctx.acp,
                            ctx.antigravitySelection,
                            ctx.antigravityAccountRevision,
                          ),
                        ),
                        Effect.map((selection) => selection.model),
                      )
                  : yield* applyGrokAcpModelSelection({
                      runtime: ctx.acp,
                      defaultModelId: PROVIDER === "acp" ? "acp-default" : "grok-build",
                      currentModelId: ctx.currentModelId,
                      requestedModelId:
                        PROVIDER === "acp" && requestedTurnModelId === "acp-default"
                          ? undefined
                          : requestedTurnModelId,
                      mapError: (cause) =>
                        mapAcpToAdapterError(
                          PROVIDER,
                          input.threadId,
                          "session/set_model",
                          cause,
                          automationCatalogs.get(input.threadId)?.scrubDiagnostic,
                          automationCatalogs.get(input.threadId)?.hasSensitiveConfiguration() ??
                            false,
                        ),
                    });

              const userText = input.input ?? "";
              const text = (yield* rewriteUserText(userText, ctx.session.cwd)).trim();
              let totalAttachmentBytes = 0;
              const imagePromptParts = yield* Effect.forEach(
                input.attachments ?? [],
                (attachment) =>
                  Effect.gen(function* () {
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
                        totalAttachmentBytes += bytes.length;
                        if (
                          PROVIDER === "antigravity" &&
                          (bytes.length > 10 * 1024 * 1024 ||
                            totalAttachmentBytes > 50 * 1024 * 1024)
                        )
                          return yield* new ProviderAdapterValidationError({
                            provider: PROVIDER,
                            operation: "sendTurn",
                            issue:
                              "Antigravity accepts images up to 10 MiB each and 50 MiB total attachments.",
                          });
                        return {
                          type: "image",
                          data: Buffer.from(bytes).toString("base64"),
                          mimeType: attachment.mimeType,
                        } satisfies EffectAcpSchema.ContentBlock;
                      }
                      default:
                        throw new Error(
                          `Unsupported Grok attachment type '${String((attachment as { type?: unknown }).type)}'.`,
                        );
                    }
                  }),
              );
              const attachmentContext = buildProviderAttachmentRuntimeContext(
                input.resolvedAttachments ?? [],
              );
              const promptParts: Array<EffectAcpSchema.ContentBlock> = [
                ...(text ? [{ type: "text" as const, text }] : []),
                ...(attachmentContext ? [{ type: "text" as const, text: attachmentContext }] : []),
                ...imagePromptParts,
              ];
              if (PROVIDER === "antigravity") {
                const documents = yield* Effect.tryPromise({
                  try: () =>
                    acpPdfDocuments(
                      {
                        stateDir: serverConfig.stateDir,
                        sessionKey: "antigravity:" + input.threadId,
                        baseBytes: Buffer.byteLength(JSON.stringify(promptParts)),
                        attachments: input.resolvedAttachments ?? [],
                      },
                      ctx.supportsDocuments,
                    ),
                  catch: (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "session/prompt",
                      detail: "Could not persist the document request budget.",
                      cause,
                    }),
                });
                promptParts.push(...documents);
              }

              if (promptParts.length === 0) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "Turn requires non-empty text or attachments.",
                });
              }

              ctx.currentModelId = currentModelId;
              const displayModel = currentModelId ? normalizeModel(currentModelId) : undefined;
              ctx.activeTurnId = turnId;
              if (steeringTurnId === undefined) {
                ctx.lastPlanFingerprint = undefined;
              }
              ctx.session = {
                ...ctx.session,
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
                ...(displayModel ? { model: displayModel } : {}),
              };

              if (steeringTurnId === undefined) {
                yield* offerRuntimeEvent({
                  type: "turn.started",
                  ...(yield* makeEventStamp(ctx)),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: displayModel ? { model: displayModel } : {},
                });
                if (antigravityModeWarning !== undefined) ctx.antigravityPendingWarning = undefined;
                for (const message of [antigravityModeWarning, antigravityTurnWarning])
                  if (message)
                    yield* offerRuntimeEvent({
                      type: "runtime.warning",
                      ...(yield* makeEventStamp(ctx)),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      payload: { message },
                    });
              }

              return {
                context: ctx,
                acp: ctx.acp,
                acpSessionId: ctx.acpSessionId,
                displayModel,
                promptParts,
                turnId,
              };
            }).pipe(
              Effect.tapCause(() =>
                Effect.sync(() => {
                  ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
                }),
              ),
            );
          }),
        );

        return yield* Effect.gen(function* () {
          // Private-format readers run only when the session's own runtime was certified.
          const nativeProfileDirectory =
            PROVIDER === "antigravity" &&
            options?.antigravityProfileDirectory &&
            prepared.context.antigravityNativeReaders
              ? options.antigravityProfileDirectory
              : undefined;
          const checkOutcome = nativeProfileDirectory
            ? yield* watchAntigravityPromptOutcome(
                nativeProfileDirectory,
                prepared.context.acpSessionId,
                { unrecognizedErrors: prepared.context.antigravityStepLayoutVerified },
              )
            : undefined;
          const deadline =
            options?.promptInactivityTimeoutMs ??
            (PROVIDER === "antigravity" ? 15 * 60_000 : undefined);
          let timedOut = false;
          const watchdog = Effect.gen(function* () {
            const timer = new PromptInactivityDeadline(deadline!, yield* Clock.currentTimeMillis);
            while (true) {
              const now = yield* Clock.currentTimeMillis;
              const activity = prepared.acp.getPromptActivity
                ? yield* prepared.acp.getPromptActivity
                : undefined;
              const paused = Boolean(
                activity?.paused ||
                prepared.context.pendingApprovals.size > 0 ||
                prepared.context.pendingUserInputs.size > 0 ||
                prepared.context.backgroundTasks.size > 0,
              );
              const remaining = timer.remaining(
                now,
                activity?.lastProgressAt ?? 0,
                paused,
                prepared.context.antigravityTasks.inactivityPauseGeneration,
              );
              if (remaining <= 0) {
                timedOut = true;
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "Antigravity sent nothing for 15 minutes. Send a message to continue.",
                });
              }
              // Sample pauses so their end grants a full inactivity interval.
              yield* Effect.sleep(Duration.millis(Math.min(remaining, 1_000)));
            }
          });
          const prompt = prepared.acp
            .prompt({
              prompt: prepared.promptParts,
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
            );
          const result = yield* (
            deadline === undefined ? prompt : Effect.raceFirst(prompt, watchdog)
          ).pipe(
            Effect.onError(() =>
              timedOut
                ? withThreadLock(
                    input.threadId,
                    Effect.suspend(() =>
                      sessions.get(input.threadId) === prepared.context && !prepared.context.stopped
                        ? stopSessionInternal(
                            prepared.context,
                            "Antigravity sent nothing for 15 minutes. F5 stopped the stalled agent. Send a message to continue.",
                          )
                        : Effect.void,
                    ),
                  ).pipe(Effect.uninterruptible)
                : Effect.void,
            ),
          );
          const nativeFailure = checkOutcome ? yield* checkOutcome(result) : undefined;
          const nativeChildren = nativeProfileDirectory
            ? yield* readAntigravityChildrenAtWork({
                profileDirectory: nativeProfileDirectory,
                rootSessionId: prepared.context.acpSessionId,
                toolCallIds: prepared.context.antigravityTasks.taskIds,
              })
            : [];

          return yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const ctx = yield* requireSession(input.threadId);
              if (ctx !== prepared.context) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: `${providerLabel} session changed before the turn completed.`,
                });
              }

              const existingTurnRecord = ctx.turns.find((turn) => turn.id === prepared.turnId);
              ctx.turns = existingTurnRecord
                ? ctx.turns.map((turn) =>
                    turn.id === prepared.turnId
                      ? {
                          ...turn,
                          items: [...turn.items, { prompt: prepared.promptParts, result }],
                        }
                      : turn,
                  )
                : [
                    ...ctx.turns,
                    { id: prepared.turnId, items: [{ prompt: prepared.promptParts, result }] },
                  ];
              ctx.session = {
                ...ctx.session,
                activeTurnId: prepared.turnId,
                updatedAt: yield* nowIso,
                ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
              };

              if (ctx.promptsInFlight === 1) {
                yield* ctx.acp.awaitEventBarrier;
                for (const eventData of nativeChildren.length
                  ? ctx.antigravityTasks.settleDetached(nativeChildren)
                  : ctx.antigravityTasks.finish())
                  yield* offerRuntimeEvent({
                    ...eventData,
                    ...(yield* makeEventStamp(ctx)),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: prepared.turnId,
                  } as ProviderRuntimeEvent);
                if (nativeChildren.length && !ctx.nativeChildrenPolling && nativeProfileDirectory) {
                  ctx.nativeChildrenPolling = true;
                  const profileDirectory = nativeProfileDirectory;
                  yield* Effect.gen(function* () {
                    while (!ctx.stopped && ctx.antigravityTasks.taskIds.length) {
                      yield* Effect.sleep(Duration.seconds(2));
                      const observed = ctx.antigravityTasks.taskIds;
                      const atWork = yield* readAntigravityChildrenAtWork({
                        profileDirectory,
                        rootSessionId: ctx.acpSessionId,
                        toolCallIds: observed,
                      });
                      for (const eventData of ctx.antigravityTasks.settleDetached(atWork, observed))
                        yield* offerRuntimeEvent({
                          ...eventData,
                          ...(yield* makeEventStamp(ctx)),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                        } as ProviderRuntimeEvent);
                    }
                  }).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        ctx.nativeChildrenPolling = false;
                      }),
                    ),
                    Effect.forkIn(ctx.scope),
                  );
                }
                yield* settleElicitationsForTurn(input.threadId, prepared.turnId);
                ctx.completedTurnId = prepared.turnId;
                if (nativeFailure)
                  yield* offerRuntimeEvent({
                    type: "runtime.error",
                    ...(yield* makeEventStamp(ctx)),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: prepared.turnId,
                    payload: {
                      class: "provider_error",
                      message: nativeFailure.message,
                      ...(nativeFailure.class === "usage_limit"
                        ? {
                            usageLimit: {
                              windows: [],
                              resetsAt: nativeFailure.resetAt ?? null,
                              resetSource: nativeFailure.resetAt ? ("provider" as const) : null,
                              evidence: "typed" as const,
                            },
                          }
                        : {}),
                    },
                  });
                yield* offerRuntimeEvent({
                  type: "turn.completed",
                  ...(yield* makeEventStamp(ctx)),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  payload: {
                    state: nativeFailure
                      ? "failed"
                      : result.stopReason === "cancelled"
                        ? "cancelled"
                        : "completed",
                    ...(nativeFailure ? { errorMessage: nativeFailure.message } : {}),
                    stopReason: result.stopReason ?? null,
                  },
                });
              }

              return {
                threadId: input.threadId,
                turnId: prepared.turnId,
                resumeCursor: ctx.session.resumeCursor,
              };
            }),
          );
        }).pipe(
          Effect.catchCause((cause) =>
            sessions.get(input.threadId) !== prepared.context && !prepared.context.transportFailure
              ? Effect.succeed({ threadId: input.threadId, turnId: prepared.turnId })
              : Effect.failCause(cause),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              const liveCtx = sessions.get(input.threadId);
              if (liveCtx === prepared.context) {
                liveCtx.promptsInFlight = Math.max(0, liveCtx.promptsInFlight - 1);
              }
            }),
          ),
        );
      });

    const interruptTurn: GrokAdapterShape["interruptTurn"] = (threadId, turnId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped || (turnId && ctx.activeTurnId && turnId !== ctx.activeTurnId))
            return;
          if (ctx.promptsInFlight === 0 && ctx.backgroundTasks.size === 0) return;
          // A notification alone cannot guarantee the CLI stopped its prompt or background tools.
          // Closing this process preserves the resume cursor and makes Stop definitive.
          yield* stopSessionInternal(ctx);
        }),
      );

    const respondToRequest: GrokAdapterShape["respondToRequest"] = (
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

    const respondToElicitation: NonNullable<GrokAdapterShape["respondToElicitation"]> = (
      threadId,
      requestId,
      response,
    ) =>
      Effect.gen(function* () {
        const registry = elicitationsByThread.get(threadId);
        if (!registry?.has(requestId))
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/elicitation",
            detail: `Unknown pending elicitation request: ${requestId}`,
          });
        const submitted = yield* Effect.tryPromise({
          try: () => registry.submit(requestId, response),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/elicitation",
              detail: cause instanceof Error ? cause.message : "The answer could not be delivered.",
            }),
        });
        // The callback's response is the completion; a startup form has no turn end.
        const receipt = registry.settleIfDelivered(requestId);
        if (receipt) yield* emitElicitationReceipt(threadId, requestId, receipt);
        return submitted;
      });

    const respondToUserInput: GrokAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const pending =
          sessions.get(threadId)?.pendingUserInputs.get(requestId) ??
          startupPendingUserInputs.get(threadId)?.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "_x.ai/ask_user_question",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        if (pending.validate && !pending.validate(answers))
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToUserInput",
            detail: "Choose one of the displayed options, or dismiss the question.",
          });
        yield* Deferred.succeed(pending.resolution, { _tag: "answered", answers });
      });

    const readThread: GrokAdapterShape["readThread"] = (threadId) =>
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

    const rollbackThread: GrokAdapterShape["rollbackThread"] = (threadId, numTurns) =>
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
          detail: `${providerLabel} ACP sessions do not support provider-side rollback yet.`,
        });
      });

    const stopSession: GrokAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
          buildConfigurations.delete(threadId);
        }),
      );

    const listSessions: GrokAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: GrokAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: GrokAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), (ctx) => stopSessionInternal(ctx), {
        discard: true,
      }).pipe(Effect.tap(() => Effect.sync(() => buildConfigurations.clear())));

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
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
        // Grok and Antigravity cannot hold a turn to read-only tools; a custom
        // ACP agent is trusted with the plan-mode request.
        enforcesReadOnlyWorkflow: PROVIDER === "acp",
      },
      // ACP agents read a slash command only as the leading prompt text, and learn
      // their commands after the session starts, so any leading `/name` may be one.
      classifyTurnInput: (threadId, text, cwd) => {
        if (leadingSlashCommandName(text) !== undefined) return "native-command";
        if (PROVIDER !== "grok" || !leadingGrokSkillMention(text)) return "prompt";
        return rewriteUserText(text, cwd ?? sessions.get(threadId)?.session.cwd).pipe(
          Effect.map((rewritten) =>
            leadingSlashCommandName(rewritten) !== undefined
              ? ("native-command" as const)
              : ("prompt" as const),
          ),
        );
      },
      startSession,
      sendTurn,
      steerTurn: sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      respondToElicitation,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies GrokAdapterShape;
  });
}
