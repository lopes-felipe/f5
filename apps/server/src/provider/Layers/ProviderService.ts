import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import {
  makeNativeOperationCoordinator,
  nativeOperationSqlRepository,
  hasNativeOperationReservation,
} from "../nativeOperations.ts";
import { withProviderThreadAccess } from "../providerThreadAccess.ts";
import { readClaudeRecoveryMetadata } from "../claudeResumeState.ts";
import { Cause } from "effect";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  getProviderAttachmentLimitError,
  nativeProviderAttachments,
} from "@t3tools/shared/attachmentLimits";
import { withAccountAdmission } from "../../profiles/ProviderAccountGuard.ts";
import { ensureWorkspaceDirectory } from "../workspaceDirectory.ts";
/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import { lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import {
  DEFAULT_RUNTIME_MODE,
  EventId,
  ModelSelection,
  isKnownProviderKind,
  type TurnId,
  NonNegativeInt,
  ProjectId,
  ProviderKind,
  type ProviderModelOptions,
  ProviderStartOptions,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  RuntimeMode,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderDriverKind,
  defaultInstanceIdForDriver,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type McpReloadResult,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { describeMcpReloadFailure, MCP_RELOAD_RETRY_DELAYS_MS } from "../mcpReconcile.ts";
import { getProviderEnvironmentKey } from "@t3tools/shared/providerOptions";
import { getProviderTurnInputLengthIssue } from "@t3tools/shared/providerInput";
import { runtimeModeUnsupportedReason } from "@t3tools/shared/runtimeMode";
import {
  Duration,
  Deferred,
  Effect,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  Schedule,
  Semaphore,
  Schema,
  SchemaIssue,
  Stream,
} from "effect";

import {
  increment,
  providerMetricAttributes,
  providerRuntimeEventsDroppedTotal,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import {
  type ProviderAdapterError,
  ProviderSessionActionUnavailableError,
  ProviderValidationError,
  ProviderTurnDeliveryError,
} from "../Errors.ts";
import {
  buildProviderSessionCapabilities,
  checkSessionAction,
  readPersistedSessionGeneration,
  sessionGenerationPayload,
} from "../sessionCapabilities.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import type { SharedInstructionInput } from "../sharedAssistantContract.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import {
  ProjectMcpConfigService,
  ProjectMcpConfigServiceError,
} from "../../mcp/ProjectMcpConfigService.ts";
import {
  isRecord,
  persistedStartConfigToRecord,
  readPersistedCwd,
  readPersistedInstructionContext,
  readPersistedProviderOptions,
  readPersistedRuntimePayloadRecord,
  readPersistedStartConfig,
  sanitizeProviderOptionsForPersistence,
  startConfigValueOrUndefined,
  type PersistedStartConfig,
  type PersistedStartConfigValue,
} from "../runtimePayload.ts";
import { computeProviderLaunchFingerprint } from "../providerLaunchFingerprint.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import {
  isProviderTerminalRuntimeEvent,
  type ProviderTerminalEventRepositoryError,
  type ProviderTerminalRuntimeEvent,
} from "../../persistence/Services/ProviderTerminalEvents.ts";
import {
  makeOrphanedSessionExitedEvent,
  readPersistedActiveTurnId,
} from "../orphanedTurnRecovery.ts";

export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogPath?: string;
  readonly canonicalEventLogger?: EventNdjsonLogger;
  readonly recordTerminalEvent?: (
    event: ProviderTerminalRuntimeEvent,
  ) => Effect.Effect<void, ProviderTerminalEventRepositoryError>;
}

const PROVIDER_RUNTIME_EVENT_QUEUE_CAPACITY = 2_048;

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
  beforeTurnId: Schema.optional(TrimmedNonEmptyString),
});

const ProviderConversationCompactionInputSchema = Schema.Struct({
  threadId: ThreadId,
  provider: Schema.optional(ProviderKind),
  prompt: TrimmedNonEmptyString,
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  providerOptions: Schema.optional(ProviderStartOptions),
  timeoutMs: Schema.optional(NonNegativeInt),
});

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function toProjectMcpProviderError(
  operation: string,
  projectId: ProjectId,
): (cause: ProjectMcpConfigServiceError) => ProviderValidationError {
  return (cause) =>
    new ProviderValidationError({
      operation,
      issue: `Failed to resolve MCP configuration for project '${projectId}': ${cause.message}`,
      cause,
    });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) =>
  Schema.decodeUnknownEffect(input.schema)(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly startConfig?: Record<string, unknown>;
    readonly instructionContext?: Partial<SharedInstructionInput> | null;
    readonly sessionGeneration?: number;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.sessionGeneration !== undefined
      ? {
          ...sessionGenerationPayload(extra.sessionGeneration),
          // A new session launches its MCP servers afresh.
          mcpUnconvergedConfigVersion: null,
        }
      : {}),
    ...(extra?.startConfig !== undefined ? { startConfig: extra.startConfig } : {}),
    ...(extra?.instructionContext !== undefined
      ? { instructionContext: extra.instructionContext }
      : {}),
  };
}

function mergeResolvedMcpProviderOptions(input: {
  readonly providerOptions: ProviderStartOptions | undefined;
  readonly projectMcpServers: ProviderStartOptions["mcpServers"] | undefined;
}): ProviderStartOptions | undefined {
  if (input.projectMcpServers === undefined) {
    return input.providerOptions;
  }

  return {
    ...input.providerOptions,
    mcpServers: input.projectMcpServers,
  };
}

function resolveBindingInstanceId(binding: {
  readonly provider: ProviderKind;
  readonly providerInstanceId?: ProviderInstanceId | null;
}): ProviderInstanceId {
  return (
    binding.providerInstanceId ??
    defaultInstanceIdForDriver(ProviderDriverKind.make(binding.provider))
  );
}

function resolveStartInstanceId(input: {
  readonly provider?: ProviderKind | undefined;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly modelSelection?: { readonly instanceId: ProviderInstanceId } | undefined;
}): ProviderInstanceId {
  if (input.providerInstanceId !== undefined) {
    return input.providerInstanceId;
  }
  if (input.modelSelection?.instanceId !== undefined) {
    return input.modelSelection.instanceId;
  }
  return defaultInstanceIdForDriver(ProviderDriverKind.make(input.provider ?? "codex"));
}

function toInstructionContextFromSessionStartInput(
  input: ProviderSessionStartInput,
): Partial<SharedInstructionInput> {
  return {
    ...(input.projectTitle !== undefined ? { projectTitle: input.projectTitle } : {}),
    ...(input.threadTitle !== undefined ? { threadTitle: input.threadTitle } : {}),
    ...(input.turnCount !== undefined ? { turnCount: input.turnCount } : {}),
    ...(input.priorWorkSummary !== undefined ? { priorWorkSummary: input.priorWorkSummary } : {}),
    ...(input.preservedTranscriptBefore !== undefined
      ? { preservedTranscriptBefore: input.preservedTranscriptBefore }
      : {}),
    ...(input.preservedTranscriptAfter !== undefined
      ? { preservedTranscriptAfter: input.preservedTranscriptAfter }
      : {}),
    ...(input.restoredRecentFileRefs !== undefined
      ? { restoredRecentFileRefs: input.restoredRecentFileRefs }
      : {}),
    ...(input.restoredActivePlan !== undefined
      ? { restoredActivePlan: input.restoredActivePlan }
      : {}),
    ...(input.restoredTasks !== undefined ? { restoredTasks: input.restoredTasks } : {}),
    ...(input.sessionNotes !== undefined ? { sessionNotes: input.sessionNotes } : {}),
    ...(input.projectMemories !== undefined ? { projectMemories: input.projectMemories } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    ...(input.workflowExecutionProfile !== undefined
      ? { workflowExecutionProfile: input.workflowExecutionProfile }
      : {}),
    runtimeMode: input.runtimeMode,
  };
}

const makeProviderService = (options?: ProviderServiceLiveOptions) =>
  Effect.gen(function* () {
    const nativeScope = yield* Effect.scope;
    const analytics = yield* Effect.service(AnalyticsService);
    const canonicalEventLogger =
      options?.canonicalEventLogger ??
      (options?.canonicalEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.canonicalEventLogPath, {
            stream: "canonical",
          })
        : undefined);

    const registry = yield* ProviderAdapterRegistry;
    const directory = yield* ProviderSessionDirectory;
    // Optional so narrow test layers need not build provider snapshots; without
    // it, session snapshots omit the executable version.
    const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);
    const projectMcpConfigService = yield* ProjectMcpConfigService;
    const serverConfig = yield* ServerConfig;
    const previewAutomationBroker = yield* Effect.serviceOption(PreviewAutomationBroker);
    // Terminal receipts are persisted in order within each thread. Bound the
    // queue so a prolonged SQLite outage applies backpressure to provider
    // streams instead of allowing process memory to grow without limit.
    const runtimeEventQueue = yield* Queue.bounded<{
      readonly source: {
        readonly instanceId: ProviderInstanceId;
        readonly provider: ProviderKind;
      };
      readonly event: ProviderRuntimeEvent;
    }>(PROVIDER_RUNTIME_EVENT_QUEUE_CAPACITY);
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    // The generation a session is being started as, published before the
    // adapter starts so requests it opens during startup carry the generation
    // that will own them, and can be answered without the start lock.
    const nativeSql = yield* Effect.serviceOption(SqlClient.SqlClient);
    const nativeCoordinator = Option.isSome(nativeSql)
      ? makeNativeOperationCoordinator(nativeOperationSqlRepository(nativeSql.value))
      : undefined;
    const startingSessions = new Map<
      ThreadId,
      { readonly generation: number; readonly adapter: ProviderAdapterShape<ProviderAdapterError> }
    >();
    const whileStarting = <A, E, R>(
      threadId: ThreadId,
      generation: number,
      adapter: ProviderAdapterShape<ProviderAdapterError>,
      effect: Effect.Effect<A, E, R>,
    ) =>
      Effect.acquireUseRelease(
        Effect.sync(() => startingSessions.set(threadId, { generation, adapter })),
        () => effect,
        () => Effect.sync(() => startingSessions.delete(threadId)),
      );

    const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Effect.succeed(event).pipe(
        Effect.tap((canonicalEvent) =>
          canonicalEventLogger ? canonicalEventLogger.write(canonicalEvent, null) : Effect.void,
        ),
        Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
        Effect.asVoid,
      );

    const upsertSessionBinding = (
      session: ProviderSession,
      threadId: ThreadId,
      extra?: {
        readonly projectId?: ProjectId | null;
        readonly mcpEffectiveConfigVersion?: string | null;
        readonly launchFingerprint?: string | null;
        readonly startConfig?: Record<string, unknown>;
        readonly instructionContext?: Partial<SharedInstructionInput> | null;
        readonly clearMissingResumeCursor?: boolean;
        readonly sessionGeneration?: number;
      },
    ) =>
      directory.upsert({
        threadId,
        ...(extra?.projectId !== undefined ? { projectId: extra.projectId } : {}),
        provider: session.provider,
        providerInstanceId:
          session.providerInstanceId ??
          defaultInstanceIdForDriver(ProviderDriverKind.make(session.provider)),
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(extra?.mcpEffectiveConfigVersion !== undefined
          ? { mcpEffectiveConfigVersion: extra.mcpEffectiveConfigVersion }
          : {}),
        ...(extra?.launchFingerprint !== undefined
          ? { launchFingerprint: extra.launchFingerprint }
          : {}),
        ...(session.resumeCursor !== undefined
          ? { resumeCursor: session.resumeCursor }
          : extra?.clearMissingResumeCursor
            ? { resumeCursor: null }
            : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      });

    const readExecutableVersion = (instanceId: ProviderInstanceId) =>
      Option.match(providerRegistry, {
        onNone: () => Effect.succeed<string | undefined>(undefined),
        onSome: (service) =>
          service.getProviders.pipe(
            Effect.map(
              (providers) =>
                providers.find((provider) => provider.instanceId === instanceId)?.version ??
                undefined,
            ),
          ),
      });

    const snapshotSessionCapabilities = (input: {
      readonly threadId: ThreadId;
      readonly instanceId: ProviderInstanceId;
      readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
      readonly generation: number;
    }) =>
      Effect.gen(function* () {
        const active = yield* input.adapter.hasSession(input.threadId);
        const discovery =
          active && input.adapter.getSessionDiscovery
            ? yield* input.adapter.getSessionDiscovery(input.threadId)
            : undefined;
        const instanceInfo = yield* registry
          .getInstanceInfo(input.instanceId)
          .pipe(Effect.option, Effect.map(Option.getOrUndefined));
        return buildProviderSessionCapabilities({
          generation: input.generation,
          driver: instanceInfo?.driverKind ?? input.adapter.provider,
          providerInstanceId: input.instanceId,
          executableVersion: yield* readExecutableVersion(input.instanceId),
          adapterCapabilities: input.adapter.capabilities,
          hasSteer: input.adapter.steerTurn !== undefined,
          hasMcpReload: input.adapter.reloadMcpConfig !== undefined,
          active,
          discovery,
          checkedAt: new Date().toISOString(),
        });
      });

    const persistResumeCursorFromRuntimeEvent = (
      event: ProviderRuntimeEvent,
    ): Effect.Effect<void> =>
      event.resumeCursor === undefined
        ? Effect.void
        : Effect.gen(function* () {
            const bindingOption = yield* directory.getBinding(event.threadId);
            if (Option.isNone(bindingOption)) {
              return;
            }

            const binding = bindingOption.value;
            if (binding.provider !== event.provider) {
              yield* Effect.logWarning("provider runtime resume cursor provider mismatch", {
                expectedProvider: binding.provider,
                eventProvider: event.provider,
                threadId: event.threadId,
                eventType: event.type,
              });
              return;
            }
            if (
              event.providerInstanceId !== undefined &&
              binding.providerInstanceId !== undefined &&
              binding.providerInstanceId !== null &&
              binding.providerInstanceId !== event.providerInstanceId
            ) {
              yield* Effect.logWarning("provider runtime resume cursor instance mismatch", {
                expectedInstanceId: binding.providerInstanceId,
                eventInstanceId: event.providerInstanceId,
                threadId: event.threadId,
                eventType: event.type,
              });
              return;
            }

            if (
              binding.provider === "claudeAgent" &&
              readClaudeRecoveryMetadata(binding.resumeCursor).resumeRecoveryGeneration !==
                readClaudeRecoveryMetadata(event.resumeCursor).resumeRecoveryGeneration
            ) {
              yield* Effect.logInfo("ignored Claude cursor from an earlier recovery generation", {
                threadId: event.threadId,
                eventType: event.type,
              });
              return;
            }
            yield* directory.upsert({
              threadId: event.threadId,
              provider: binding.provider,
              providerInstanceId: binding.providerInstanceId ?? event.providerInstanceId ?? null,
              resumeCursor: event.resumeCursor,
            });
          }).pipe(
            (effect) => withProviderThreadAccess(event.threadId, effect),
            Effect.catch((cause) =>
              Effect.logWarning("failed to persist provider runtime resume cursor", {
                provider: event.provider,
                threadId: event.threadId,
                eventType: event.type,
                cause,
              }),
            ),
          );

    const processRuntimeEvent = (item: {
      readonly source: {
        readonly instanceId: ProviderInstanceId;
        readonly provider: ProviderKind;
      };
      readonly event: ProviderRuntimeEvent;
    }): Effect.Effect<void> =>
      Effect.gen(function* () {
        let event: ProviderRuntimeEvent = {
          ...item.event,
          providerInstanceId: item.event.providerInstanceId ?? item.source.instanceId,
        };
        if (event.provider !== item.source.provider) {
          yield* Effect.logWarning("provider runtime event provider mismatch", {
            sourceProvider: item.source.provider,
            eventProvider: event.provider,
            instanceId: item.source.instanceId,
            threadId: event.threadId,
            eventType: event.type,
          });
          yield* increment(providerRuntimeEventsDroppedTotal, {
            reason: "provider_mismatch",
            sourceProvider: item.source.provider,
            eventProvider: event.provider,
            eventType: event.type,
          });
          if (
            process.env.NODE_ENV === "test" ||
            process.env.T3CODE_FATAL_PROVIDER_RUNTIME_MISMATCH === "1"
          ) {
            return yield* Effect.die(
              new Error(
                `Provider runtime event provider mismatch: source '${item.source.provider}' emitted '${event.provider}' for ${event.type}.`,
              ),
            );
          }
          return;
        }
        yield* persistResumeCursorFromRuntimeEvent(event);
        if (event.type === "user-input.requested" && event.payload.elicitation) {
          // The owning generation is what a later private answer must match.
          const starting = startingSessions.get(event.threadId);
          const binding = starting
            ? undefined
            : Option.getOrUndefined(
                yield* directory
                  .getBinding(event.threadId)
                  .pipe(Effect.orElseSucceed(() => Option.none<ProviderRuntimeBinding>())),
              );
          event = {
            ...event,
            payload: {
              ...event.payload,
              elicitation: {
                ...event.payload.elicitation,
                generation:
                  starting?.generation ?? readPersistedSessionGeneration(binding?.runtimePayload),
              },
            },
          };
        }
        if (isProviderTerminalRuntimeEvent(event) && options?.recordTerminalEvent !== undefined) {
          // Do not fan out a terminal event until its recovery receipt is durable.
          // Retrying in place preserves provider event order while SQLite is unavailable.
          yield* options
            .recordTerminalEvent(event)
            .pipe(Effect.retry({ schedule: Schedule.spaced("1 second") }), Effect.orDie);
        }
        yield* publishRuntimeEvent(event);
        yield* increment(providerRuntimeEventsTotal, {
          provider: event.provider,
          eventType: event.type,
        });
      });

    // One maintenance lock must not stall every provider stream. Admission and
    // lane buffering share a fixed global budget; each thread retains cursor,
    // terminal-receipt and publication order, and idle lanes are discarded.
    const laneBudget = yield* Semaphore.make(PROVIDER_RUNTIME_EVENT_QUEUE_CAPACITY);
    type RuntimeEventItem = Parameters<typeof processRuntimeEvent>[0];
    const lanes = new Map<ThreadId, RuntimeEventItem[]>();
    const dispatchRuntimeEvent = (item: RuntimeEventItem) =>
      Effect.gen(function* () {
        yield* laneBudget.take(1);
        const threadId = item.event.threadId;
        const existing = lanes.get(threadId);
        if (existing) {
          existing.push(item);
          return;
        }
        const lane = [item];
        lanes.set(threadId, lane);
        const drain = Effect.gen(function* () {
          while (true) {
            const next = yield* Effect.sync(() => {
              const next = lane.shift();
              // Retire atomically with the empty check so a new event cannot
              // append to an idle lane just before its finalizer removes it.
              if (!next) lanes.delete(threadId);
              return next;
            });
            if (!next) return;
            yield* processRuntimeEvent(next).pipe(Effect.ensuring(laneBudget.release(1)));
          }
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (lanes.get(threadId) === lane) lanes.delete(threadId);
              yield* laneBudget.release(lane.length);
            }),
          ),
        );
        yield* Effect.forkScoped(drain);
      });
    const worker = Effect.forever(
      Queue.take(runtimeEventQueue).pipe(Effect.flatMap(dispatchRuntimeEvent)),
    );
    yield* Effect.forkScoped(worker);

    const subscribedAdapters = yield* Ref.make(
      new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>(),
    );
    const getAdapterEntries = Ref.get(subscribedAdapters).pipe(
      Effect.map((map) => Array.from(map.entries())),
    );
    const reconcileInstanceSubscriptions = Effect.gen(function* () {
      const previous = yield* Ref.get(subscribedAdapters);
      const instanceIds = yield* registry.listInstances();
      const next = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>();
      for (const instanceId of instanceIds) {
        const adapterOption = yield* registry
          .getByInstance(instanceId)
          .pipe(Effect.tapError(Effect.logWarning), Effect.option);
        if (Option.isNone(adapterOption)) {
          continue;
        }
        const adapter = adapterOption.value;
        next.set(instanceId, adapter);
        if (previous.get(instanceId) !== adapter) {
          yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Queue.offer(runtimeEventQueue, {
              source: { instanceId, provider: adapter.provider },
              event,
            }).pipe(Effect.asVoid),
          ).pipe(Effect.forkScoped);
        }
      }
      yield* Ref.set(subscribedAdapters, next);
    });
    const instanceChanges = yield* registry.subscribeChanges;
    yield* reconcileInstanceSubscriptions;
    yield* Stream.runForEach(
      Stream.fromSubscription(instanceChanges),
      () => reconcileInstanceSubscriptions,
    ).pipe(Effect.forkScoped);

    const recoverSessionForThread = (input: {
      readonly binding: ProviderRuntimeBinding;
      readonly operation: string;
      readonly fallbackActiveTurnId?: TurnId;
    }) =>
      Effect.gen(function* () {
        const bindingInstanceId = resolveBindingInstanceId(input.binding);
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "recover-session",
          "provider.kind": input.binding.provider,
          "provider.instance_id": bindingInstanceId,
          "provider.thread_id": input.binding.threadId,
        });
        const adapter = yield* registry.getByInstance(bindingInstanceId);
        const instanceInfo = yield* registry.getInstanceInfo(bindingInstanceId);
        const hasResumeCursor =
          input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
        const persistedActiveTurnId = readPersistedActiveTurnId(input.binding.runtimePayload);
        const orphanedTurnId =
          persistedActiveTurnId !== undefined &&
          input.fallbackActiveTurnId !== undefined &&
          persistedActiveTurnId !== input.fallbackActiveTurnId
            ? undefined
            : (persistedActiveTurnId ?? input.fallbackActiveTurnId);
        if (
          persistedActiveTurnId !== undefined &&
          input.fallbackActiveTurnId !== undefined &&
          orphanedTurnId === undefined
        ) {
          yield* Effect.logWarning("provider recovery active turn evidence mismatch", {
            operation: input.operation,
            threadId: input.binding.threadId,
            persistedActiveTurnId,
            fallbackActiveTurnId: input.fallbackActiveTurnId,
          });
        }
        const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
        const persistedStartConfig = readPersistedStartConfig(input.binding.runtimePayload);
        const persistedProviderOptions = startConfigValueOrUndefined(
          persistedStartConfig.providerOptions,
        );
        const persistedModelOptions = startConfigValueOrUndefined(
          persistedStartConfig.modelOptions,
        );
        const persistedModel = startConfigValueOrUndefined(persistedStartConfig.model);
        const persistedInstructionContext = readPersistedInstructionContext(
          input.binding.runtimePayload,
        );
        const recoveredInstructionContext = persistedInstructionContext;
        const resolvedProjectMcp =
          input.binding.projectId !== undefined && input.binding.projectId !== null
            ? yield* projectMcpConfigService
                .readEffectiveStoredConfig(input.binding.projectId)
                .pipe(
                  Effect.mapError(
                    toProjectMcpProviderError(
                      "ProviderService.recoverSession",
                      input.binding.projectId,
                    ),
                  ),
                )
            : undefined;
        const resumedProviderOptions = mergeResolvedMcpProviderOptions({
          providerOptions: persistedProviderOptions as ProviderStartOptions | undefined,
          projectMcpServers: resolvedProjectMcp?.servers,
        });

        const recoveredRuntimeMode = input.binding.runtimeMode ?? DEFAULT_RUNTIME_MODE;
        const unsupportedRuntimeMode = runtimeModeUnsupportedReason(
          input.binding.provider,
          recoveredRuntimeMode,
        );
        if (unsupportedRuntimeMode) {
          return yield* toValidationError(input.operation, unsupportedRuntimeMode);
        }
        const launchFingerprint = computeProviderLaunchFingerprint({
          provider: input.binding.provider,
          providerInstanceId: bindingInstanceId,
          runtimeMode: recoveredRuntimeMode,
          ...(persistedCwd ? { cwd: persistedCwd } : {}),
          ...(resumedProviderOptions ? { providerOptions: resumedProviderOptions } : {}),
          ...(instanceInfo.launchIdentity
            ? { instanceLaunchIdentity: instanceInfo.launchIdentity }
            : {}),
          mcpEffectiveConfigVersion: resolvedProjectMcp?.effectiveVersion ?? null,
          ...(recoveredInstructionContext?.workflowExecutionProfile
            ? {
                workflowExecutionProfile: recoveredInstructionContext.workflowExecutionProfile,
              }
            : {}),
        });
        const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
        if (hasActiveSession && input.binding.launchFingerprint === launchFingerprint) {
          const activeSessions = yield* adapter.listSessions();
          const existing = activeSessions.find(
            (session) => session.threadId === input.binding.threadId,
          );
          if (existing) {
            yield* upsertSessionBinding(
              { ...existing, providerInstanceId: bindingInstanceId },
              input.binding.threadId,
              { launchFingerprint },
            );
            const adopted = {
              ...existing,
              capabilities: yield* snapshotSessionCapabilities({
                threadId: input.binding.threadId,
                instanceId: bindingInstanceId,
                adapter,
                generation: readPersistedSessionGeneration(input.binding.runtimePayload),
              }),
            };
            yield* Effect.logInfo("provider service adopted existing provider session", {
              operation: input.operation,
              threadId: input.binding.threadId,
              provider: existing.provider,
              bindingStatus: input.binding.status ?? null,
              hasResumeCursor: existing.resumeCursor !== undefined,
            });
            yield* analytics.record("provider.session.recovered", {
              provider: existing.provider,
              strategy: "adopt-existing",
              hasResumeCursor: existing.resumeCursor !== undefined,
            });
            return { adapter, session: adopted, orphanedTurnId: undefined } as const;
          }
        } else if (hasActiveSession) {
          if (hasNativeOperationReservation(input.binding.threadId))
            return yield* toValidationError(
              input.operation,
              "A native operation is pending; session replacement is unavailable.",
            );
          yield* Effect.logWarning("provider launch identity changed; replacing active session", {
            operation: input.operation,
            threadId: input.binding.threadId,
            provider: input.binding.provider,
          });
          yield* adapter.stopSession(input.binding.threadId);
        }

        if (!hasActiveSession && orphanedTurnId !== undefined) {
          const event = makeOrphanedSessionExitedEvent({
            threadId: input.binding.threadId,
            turnId: orphanedTurnId,
            provider: input.binding.provider,
            providerInstanceId: bindingInstanceId,
            createdAt: new Date().toISOString(),
          });
          // This terminal event enters the same ordered, durable path as native
          // provider events. Enqueue it before starting the replacement session
          // so consumers observe the old generation exit before the new session
          // start notifications.
          yield* Queue.offer(runtimeEventQueue, {
            source: {
              instanceId: bindingInstanceId,
              provider: input.binding.provider,
            },
            event,
          });
          yield* Effect.logInfo("provider service queued orphaned turn settlement", {
            operation: input.operation,
            threadId: input.binding.threadId,
            turnId: orphanedTurnId,
            provider: input.binding.provider,
          });
        }

        if (!hasResumeCursor) {
          return yield* toValidationError(
            input.operation,
            `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
          );
        }
        if (persistedCwd) yield* ensureWorkspaceDirectory(persistedCwd);
        const resumedGeneration = readPersistedSessionGeneration(input.binding.runtimePayload) + 1;
        // Covers the binding write, as in startSession.
        const resumed = yield* whileStarting(
          input.binding.threadId,
          resumedGeneration,
          adapter,
          Effect.gen(function* () {
            if (hasNativeOperationReservation(input.binding.threadId))
              return yield* toValidationError(
                input.operation,
                "A native operation is pending; session recovery is unavailable.",
              );
            const resumed = yield* adapter.startSession({
              threadId: input.binding.threadId,
              ...(input.binding.projectId ? { projectId: input.binding.projectId } : {}),
              provider: input.binding.provider,
              providerInstanceId: bindingInstanceId,
              ...(persistedCwd ? { cwd: persistedCwd } : {}),
              ...recoveredInstructionContext,
              ...(persistedModel ? { model: persistedModel } : {}),
              ...(persistedModelOptions ? { modelOptions: persistedModelOptions } : {}),
              ...(resumedProviderOptions ? { providerOptions: resumedProviderOptions } : {}),
              ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
              runtimeMode: recoveredRuntimeMode,
            });
            if (resumed.provider !== adapter.provider) {
              return yield* toValidationError(
                input.operation,
                `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
              );
            }
            yield* upsertSessionBinding(
              { ...resumed, providerInstanceId: bindingInstanceId },
              input.binding.threadId,
              {
                ...(input.binding.projectId !== undefined
                  ? { projectId: input.binding.projectId }
                  : {}),
                mcpEffectiveConfigVersion: resolvedProjectMcp?.effectiveVersion ?? null,
                launchFingerprint,
                startConfig: persistedStartConfigToRecord(persistedStartConfig),
                ...(recoveredInstructionContext
                  ? { instructionContext: recoveredInstructionContext }
                  : {}),
                sessionGeneration: resumedGeneration,
              },
            );
            return resumed;
          }),
        );
        const resumedWithCapabilities = {
          ...resumed,
          capabilities: yield* snapshotSessionCapabilities({
            threadId: input.binding.threadId,
            instanceId: bindingInstanceId,
            adapter,
            generation: resumedGeneration,
          }),
        };
        yield* Effect.logInfo("provider service resumed provider session from persisted binding", {
          operation: input.operation,
          threadId: input.binding.threadId,
          provider: resumed.provider,
          bindingStatus: input.binding.status ?? null,
          hasResumeCursor: resumed.resumeCursor !== undefined,
        });
        yield* analytics.record("provider.session.recovered", {
          provider: resumed.provider,
          strategy: "resume-thread",
          hasResumeCursor: resumed.resumeCursor !== undefined,
        });
        return { adapter, session: resumedWithCapabilities, orphanedTurnId } as const;
      }).pipe(
        withAccountAdmission(
          serverConfig.stateDir,
          resolveBindingInstanceId(input.binding),
          input.operation,
        ),
        withMetrics({
          counter: providerSessionsTotal,
          attributes: providerMetricAttributes(input.binding.provider, {
            operation: "recover",
          }),
        }),
      );

    const resolveRoutableSession = (input: {
      readonly threadId: ThreadId;
      readonly operation: string;
      readonly allowRecovery: boolean;
      readonly fallbackActiveTurnId?: TurnId;
      readonly binding?: Option.Option<ProviderRuntimeBinding>;
    }) =>
      Effect.gen(function* () {
        const bindingOption = input.binding ?? (yield* directory.getBinding(input.threadId));
        const binding = Option.getOrUndefined(bindingOption);
        if (!binding) {
          return yield* toValidationError(
            input.operation,
            `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
          );
        }
        const instanceId = resolveBindingInstanceId(binding);
        const adapter = yield* registry.getByInstance(instanceId);

        const hasRequestedSession = yield* adapter.hasSession(input.threadId);
        if (hasRequestedSession) {
          yield* Effect.logDebug("provider service resolved active provider session", {
            operation: input.operation,
            threadId: input.threadId,
            provider: binding.provider,
            bindingStatus: binding.status ?? null,
          });
          return {
            adapter,
            instanceId,
            threadId: input.threadId,
            isActive: true,
            orphanedTurnId: undefined,
          } as const;
        }

        if (!input.allowRecovery) {
          yield* Effect.logInfo(
            "provider service resolved stopped provider binding without recovery",
            {
              operation: input.operation,
              threadId: input.threadId,
              provider: binding.provider,
              bindingStatus: binding.status ?? null,
            },
          );
          return {
            adapter,
            instanceId,
            threadId: input.threadId,
            isActive: false,
            orphanedTurnId: undefined,
          } as const;
        }

        yield* Effect.logInfo(
          "provider service recovering provider session from persisted binding",
          {
            operation: input.operation,
            threadId: input.threadId,
            provider: binding.provider,
            bindingStatus: binding.status ?? null,
          },
        );
        const recovered = yield* recoverSessionForThread({
          binding,
          operation: input.operation,
          ...(input.fallbackActiveTurnId !== undefined
            ? { fallbackActiveTurnId: input.fallbackActiveTurnId }
            : {}),
        });
        return {
          adapter: recovered.adapter,
          instanceId,
          threadId: input.threadId,
          isActive: true,
          ...(recovered.orphanedTurnId !== undefined
            ? { orphanedTurnId: recovered.orphanedTurnId }
            : {}),
        } as const;
      });

    const stopStaleSessionsForThread = Effect.fnUntraced(function* (input: {
      readonly threadId: ThreadId;
      readonly currentInstanceId: ProviderInstanceId;
    }) {
      const currentAdapters = yield* getAdapterEntries;
      yield* Effect.forEach(
        currentAdapters,
        ([instanceId, adapter]) =>
          instanceId === input.currentInstanceId
            ? Effect.void
            : Effect.gen(function* () {
                const hasSession = yield* adapter.hasSession(input.threadId);
                if (!hasSession) {
                  return;
                }

                yield* adapter.stopSession(input.threadId).pipe(
                  Effect.tap(() =>
                    analytics.record("provider.session.stopped", {
                      provider: adapter.provider,
                    }),
                  ),
                  Effect.tapError((cause) =>
                    Effect.logWarning("provider.session.stop-stale-failed", {
                      threadId: input.threadId,
                      provider: adapter.provider,
                      cause,
                    }),
                  ),
                );
              }),
        { discard: true },
      );
    });

    const startSession: ProviderServiceShape["startSession"] = (threadId, rawInput) =>
      Effect.gen(function* () {
        if (hasNativeOperationReservation(threadId))
          return yield* toValidationError(
            "ProviderService.startSession",
            "A native operation is pending. Settle or acknowledge it before restarting the session.",
          );
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderService.startSession",
          schema: ProviderSessionStartInput,
          payload: rawInput,
        });

        const requestedInstanceId = resolveStartInstanceId(parsed);
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "start-session",
          "provider.instance_id": requestedInstanceId,
          "provider.thread_id": threadId,
          "provider.runtime_mode": parsed.runtimeMode,
        });
        let metricProvider: ProviderKind = parsed.provider ?? "codex";
        return yield* Effect.gen(function* () {
          const instanceInfo = yield* registry.getInstanceInfo(requestedInstanceId);
          const resolvedProvider = instanceInfo.driverKind as ProviderKind;
          metricProvider = resolvedProvider;
          if (
            (resolvedProvider === "grok" || resolvedProvider === "antigravity") &&
            parsed.workflowExecutionProfile?.endsWith("readonly")
          ) {
            return yield* toValidationError(
              "ProviderService.startSession",
              `${resolvedProvider === "grok" ? "Grok" : "Antigravity"} cannot enforce read-only workflow turns.`,
            );
          }
          if (parsed.provider !== undefined && parsed.provider !== resolvedProvider) {
            return yield* toValidationError(
              "ProviderService.startSession",
              `Provider instance '${requestedInstanceId}' belongs to driver '${resolvedProvider}', not '${parsed.provider}'.`,
            );
          }
          if (!instanceInfo.enabled) {
            return yield* toValidationError(
              "ProviderService.startSession",
              `Provider instance '${requestedInstanceId}' is disabled in settings.`,
            );
          }
          const unsupportedRuntimeMode = runtimeModeUnsupportedReason(
            resolvedProvider,
            parsed.runtimeMode,
          );
          if (unsupportedRuntimeMode) {
            return yield* toValidationError("ProviderService.startSession", unsupportedRuntimeMode);
          }
          const input = {
            ...parsed,
            threadId,
            provider: resolvedProvider,
            providerInstanceId: requestedInstanceId,
          };
          const adapter = yield* registry.getByInstance(requestedInstanceId);
          const previousBinding = yield* directory
            .getBinding(threadId)
            .pipe(Effect.map(Option.getOrUndefined));
          const sameProvenance =
            previousBinding?.provider === resolvedProvider &&
            resolveBindingInstanceId(previousBinding) === requestedInstanceId;
          const previousStartConfig: PersistedStartConfig = sameProvenance
            ? readPersistedStartConfig(previousBinding.runtimePayload)
            : {
                providerOptions: { state: "absent" },
                modelOptions: { state: "absent" },
                model: { state: "absent" },
              };
          // Presence is inspected on the caller input because schema decoding cannot
          // distinguish an omitted optional field from a deliberate empty object.
          // Explicit `undefined` remains omission; callers use `{}` to clear an
          // object-valued start-config dimension.
          const suppliedProviderOptions =
            Object.hasOwn(rawInput, "providerOptions") && rawInput.providerOptions !== undefined;
          const suppliedModelOptions =
            Object.hasOwn(rawInput, "modelOptions") && rawInput.modelOptions !== undefined;
          const suppliedModel = Object.hasOwn(rawInput, "model") && rawInput.model !== undefined;
          const sanitizedProviderOptions = sanitizeProviderOptionsForPersistence(
            input.providerOptions,
          );
          const providerOptionsDimension: PersistedStartConfigValue<ProviderStartOptions> =
            suppliedProviderOptions
              ? sanitizedProviderOptions !== undefined
                ? {
                    state: "value",
                    value: sanitizedProviderOptions as ProviderStartOptions,
                  }
                : { state: "cleared" }
              : previousStartConfig.providerOptions;
          const modelOptionsDimension: PersistedStartConfigValue<ProviderModelOptions> =
            suppliedModelOptions
              ? input.modelOptions !== undefined
                ? { state: "value", value: input.modelOptions }
                : { state: "cleared" }
              : previousStartConfig.modelOptions;
          const modelDimension: PersistedStartConfigValue<string> = suppliedModel
            ? input.model !== undefined
              ? { state: "value", value: input.model }
              : { state: "cleared" }
            : previousStartConfig.model;
          const persistedStartConfig = persistedStartConfigToRecord({
            providerOptions: providerOptionsDimension,
            modelOptions: modelOptionsDimension,
            model: modelDimension,
          });
          const resolvedProjectMcp =
            input.projectId !== undefined
              ? yield* projectMcpConfigService
                  .readEffectiveStoredConfig(input.projectId)
                  .pipe(
                    Effect.mapError(
                      toProjectMcpProviderError("ProviderService.startSession", input.projectId),
                    ),
                  )
              : undefined;
          const adapterInput = {
            ...input,
            providerOptions: mergeResolvedMcpProviderOptions({
              providerOptions: input.providerOptions,
              projectMcpServers: resolvedProjectMcp?.servers,
            }),
          };
          const launchFingerprint = computeProviderLaunchFingerprint({
            provider: resolvedProvider,
            providerInstanceId: requestedInstanceId,
            runtimeMode: input.runtimeMode,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(adapterInput.providerOptions
              ? { providerOptions: adapterInput.providerOptions }
              : {}),
            ...(instanceInfo.launchIdentity
              ? { instanceLaunchIdentity: instanceInfo.launchIdentity }
              : {}),
            mcpEffectiveConfigVersion: resolvedProjectMcp?.effectiveVersion ?? null,
            ...(input.workflowExecutionProfile
              ? { workflowExecutionProfile: input.workflowExecutionProfile }
              : {}),
          });
          yield* stopStaleSessionsForThread({
            threadId,
            currentInstanceId: requestedInstanceId,
          });
          if (adapterInput.cwd) yield* ensureWorkspaceDirectory(adapterInput.cwd);
          // Generations only grow per thread, across instance switches too, so a
          // browser can never mistake a new session for the one it looked at.
          const sessionGeneration =
            readPersistedSessionGeneration(previousBinding?.runtimePayload) + 1;
          // Covers the binding write: until then, events from this start
          // still find the old generation in the directory.
          const session = yield* whileStarting(
            threadId,
            sessionGeneration,
            adapter,
            Effect.gen(function* () {
              const session = yield* adapter.startSession(adapterInput);
              if (session.provider !== adapter.provider) {
                return yield* toValidationError(
                  "ProviderService.startSession",
                  `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
                );
              }
              yield* upsertSessionBinding(
                { ...session, providerInstanceId: requestedInstanceId },
                threadId,
                {
                  ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
                  mcpEffectiveConfigVersion: resolvedProjectMcp?.effectiveVersion ?? null,
                  launchFingerprint,
                  startConfig: persistedStartConfig,
                  instructionContext: toInstructionContextFromSessionStartInput(input),
                  clearMissingResumeCursor: !sameProvenance,
                  sessionGeneration,
                },
              );
              return session;
            }),
          );
          const sessionWithInstance = {
            ...session,
            providerInstanceId: requestedInstanceId,
            capabilities: yield* snapshotSessionCapabilities({
              threadId,
              instanceId: requestedInstanceId,
              adapter,
              generation: sessionGeneration,
            }),
          };
          yield* Effect.logInfo("provider service started provider session", {
            threadId,
            provider: sessionWithInstance.provider,
            providerInstanceId: requestedInstanceId,
            runtimeMode: input.runtimeMode,
            hasResumeCursor: sessionWithInstance.resumeCursor !== undefined,
            inputCwd: input.cwd ?? null,
            sessionCwd: sessionWithInstance.cwd ?? null,
          });
          yield* analytics.record("provider.session.started", {
            provider: sessionWithInstance.provider,
            runtimeMode: input.runtimeMode,
            hasResumeCursor: sessionWithInstance.resumeCursor !== undefined,
            hasCwd: typeof input.cwd === "string" && input.cwd.trim().length > 0,
            hasModel: typeof input.model === "string" && input.model.trim().length > 0,
          });

          return sessionWithInstance;
        }).pipe(
          withAccountAdmission(
            serverConfig.stateDir,
            requestedInstanceId,
            "ProviderService.startSession",
          ),
          withMetrics({
            counter: providerSessionsTotal,
            attributes: () =>
              providerMetricAttributes(metricProvider, {
                operation: "start",
              }),
          }),
        );
      });

    const nativeError = (cause: unknown) =>
      toValidationError(
        "ProviderService.nativeOperation",
        cause instanceof Error ? cause.message : String(cause),
      );
    const nativeGeneration = (threadId: ThreadId) =>
      directory
        .getBinding(threadId)
        .pipe(
          Effect.map((binding) =>
            Option.isSome(binding)
              ? readPersistedSessionGeneration(binding.value.runtimePayload)
              : -1,
          ),
        );
    const executeNativeOperation = (
      input: import("@t3tools/contracts").NativeOperationInput,
      apply?: (result: unknown) => Effect.Effect<void, import("../Errors.ts").ProviderServiceError>,
      prepare?: Effect.Effect<void, import("../Errors.ts").ProviderServiceError>,
      background = false,
    ) =>
      Effect.gen(function* () {
        if (!nativeCoordinator)
          return yield* nativeError("Native operation persistence is unavailable.");
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "nativeOperation.execute",
          allowRecovery: false,
        });
        const action =
          input.command.kind === "compact"
            ? "nativeCompaction"
            : input.command.kind === "review"
              ? "nativeReview"
              : input.command.kind === "fork"
                ? "nativeFork"
                : input.command.kind === "stopTask"
                  ? "childTaskStop"
                  : input.command.kind === "revertFiles"
                    ? "fileCheckpointing"
                    : "nativeGoals";
        const admitted = yield* Deferred.make<
          import("@t3tools/contracts").NativeOperationRecord,
          import("../Errors.ts").ProviderServiceError
        >();
        const execution = nativeCoordinator
          .execute(input, {
            ...(background
              ? { onAdmitted: (record) => Deferred.succeed(admitted, record).pipe(Effect.asVoid) }
              : {}),
            generation: nativeGeneration(input.threadId),
            ...(apply ? { apply } : {}),
            ...(prepare
              ? {
                  prepare: prepare.pipe(
                    withAccountAdmission(
                      serverConfig.stateDir,
                      routed.instanceId,
                      "ProviderService.nativeOperation.prepare",
                    ),
                  ),
                }
              : {}),
            validate: Effect.gen(function* () {
              yield* assertSessionAction({
                threadId: input.threadId,
                action,
                expectedGeneration: input.generation,
              });
              const current = (yield* routed.adapter.listSessions()).find(
                (session) => session.threadId === input.threadId,
              );
              if (current?.activeTurnId && input.command.kind !== "stopTask")
                return yield* nativeError(
                  "Wait for the current turn to finish before starting this operation.",
                );
              if (!routed.adapter.executeNativeOperation)
                return yield* nativeError("The provider does not implement this operation.");
              const binding = yield* directory.getBinding(input.threadId);
              if (
                Option.isSome(binding) &&
                readPersistedInstructionContext(binding.value.runtimePayload)
                  ?.workflowExecutionProfile
              )
                return yield* nativeError(
                  "Native operations are unavailable during a workflow stage.",
                );
              if (input.command.kind === "revertFiles") {
                const checkpoints = yield* Effect.serviceOption(CheckpointStore);
                if (
                  Option.isNone(checkpoints) ||
                  !current?.cwd ||
                  (yield* checkpoints.value.isGitRepository(current.cwd))
                )
                  return yield* nativeError(
                    "Native file rewind is only available in non-git projects. Git projects use F5 checkpoints.",
                  );
              }
            }).pipe(
              withAccountAdmission(
                serverConfig.stateDir,
                routed.instanceId,
                "ProviderService.nativeOperation.validate",
              ),
            ),
            dispatch: Effect.suspend(() => routed.adapter.executeNativeOperation!(input)),
            dispatchWithReceipt: (receipt) =>
              Effect.suspend(() =>
                routed.adapter.executeNativeOperation!(input, (value) =>
                  Effect.runPromise(receipt(value)),
                ),
              ),
          })
          .pipe(Effect.mapError(nativeError));
        if (!background) return yield* execution;
        yield* execution.pipe(
          Effect.tap((record) => Deferred.succeed(admitted, record)),
          Effect.catch((error) => Deferred.fail(admitted, error)),
          Effect.forkIn(nativeScope),
        );
        return yield* Deferred.await(admitted);
      });
    const nativeOperations: NonNullable<ProviderServiceShape["nativeOperations"]> = {
      list: (threadId) =>
        nativeCoordinator
          ? nativeCoordinator.list(threadId).pipe(Effect.mapError(nativeError))
          : Effect.fail(nativeError("Native operation persistence is unavailable.")),
      resolve: (input) =>
        withProviderThreadAccess(
          input.threadId,
          Effect.gen(function* () {
            if (!nativeCoordinator)
              return yield* nativeError("Native operation persistence is unavailable.");
            const record = (yield* nativeCoordinator.list(input.threadId)).find(
              (entry) => entry.operationId === input.operationId,
            );
            if (!record || (yield* nativeGeneration(input.threadId)) !== input.generation)
              return yield* nativeError(
                "The provider session changed. Reload before resolving this outcome.",
              );
            if (input.action === "reconcile") {
              yield* nativeCoordinator
                .reconcileThread(input.threadId, checkNativeOperation)
                .pipe(Effect.mapError(nativeError));
              return (yield* nativeCoordinator.list(input.threadId)).find(
                (entry) => entry.operationId === input.operationId,
              )!;
            }
            if (record.state === "cancelled") return record;
            if (record.state !== "indeterminate")
              return yield* nativeError("Only an indeterminate operation can be acknowledged.");
            // Explicit acknowledgement stops the provider before releasing admission. Never replay a mutation.
            yield* stopSession({ threadId: input.threadId });
            return yield* nativeCoordinator
              .abandon(input.threadId, input.operationId)
              .pipe(Effect.mapError(nativeError));
          }),
        ).pipe(Effect.mapError(nativeError)),
      inspect: (input) =>
        withProviderThreadAccess(
          input.threadId,
          Effect.gen(function* () {
            const action =
              input.kind === "task"
                ? "childTaskInspection"
                : input.kind === "filePreview"
                  ? "fileCheckpointing"
                  : input.kind === "goal"
                    ? "nativeGoals"
                    : "nativeAttachments";
            yield* assertSessionAction({
              threadId: input.threadId,
              action,
              expectedGeneration: input.generation,
            });
            const routed = yield* resolveRoutableSession({
              threadId: input.threadId,
              operation: "nativeOperation.inspect",
              allowRecovery: false,
            });
            if (!routed.adapter.inspectNativeOperation)
              return yield* nativeError("This provider cannot inspect native operations.");
            return yield* routed.adapter.inspectNativeOperation(input);
          }),
        ),
      execute: (input) => executeNativeOperation(input, undefined, undefined, true),
      executeWithApply: (input, apply, prepare, options) =>
        executeNativeOperation(input, apply, prepare, options?.background),
    };
    const renameThread: NonNullable<ProviderServiceShape["renameThread"]> = (threadId, title) =>
      withProviderThreadAccess(
        threadId,
        Effect.gen(function* () {
          const binding = yield* directory.getBinding(threadId);
          if (Option.isNone(binding)) return;
          const routed = yield* resolveRoutableSession({
            threadId,
            operation: "renameThread",
            allowRecovery: false,
          });
          if (routed.adapter.renameThread) yield* routed.adapter.renameThread(threadId, title);
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("Provider title synchronization failed", { threadId, cause }),
        ),
      );

    const sendTurn: ProviderServiceShape["sendTurn"] = (rawInput) =>
      Effect.gen(function* () {
        if (isRecord(rawInput) && typeof rawInput.input === "string") {
          const inputLengthIssue = getProviderTurnInputLengthIssue(rawInput.input);
          if (inputLengthIssue) {
            return yield* toValidationError("ProviderService.sendTurn", inputLengthIssue.message);
          }
        }

        if (hasNativeOperationReservation(rawInput.threadId))
          return yield* new ProviderTurnDeliveryError({
            certainty: "not_sent",
            retryable: true,
            detail: "A native operation holds this conversation.",
          });
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderService.sendTurn",
          schema: ProviderSendTurnInput,
          payload: rawInput,
        });

        const input = {
          ...parsed,
          attachments: parsed.attachments ?? [],
        };
        if (!input.input && input.attachments.length === 0) {
          return yield* toValidationError(
            "ProviderService.sendTurn",
            "Either input text or at least one attachment is required",
          );
        }
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "send-turn",
          "provider.thread_id": input.threadId,
          "provider.interaction_mode": input.interactionMode,
          "provider.attachment_count": input.attachments.length,
        });
        const binding = yield* directory.getBinding(input.threadId);
        const instanceId = Option.isSome(binding) ? resolveBindingInstanceId(binding.value) : "";
        let metricProvider = "unknown";
        let metricModel = input.model;
        return yield* Effect.gen(function* () {
          const routed = yield* resolveRoutableSession({
            threadId: input.threadId,
            operation: "ProviderService.sendTurn",
            allowRecovery: input.expectedTurnId === undefined,
            binding,
          });
          metricProvider = routed.adapter.provider;
          if (
            (routed.adapter.provider === "grok" || routed.adapter.provider === "antigravity") &&
            input.workflowExecutionProfile?.endsWith("readonly")
          ) {
            return yield* toValidationError(
              "ProviderService.sendTurn",
              `${routed.adapter.provider === "grok" ? "Grok" : "Antigravity"} cannot enforce read-only workflow turns.`,
            );
          }
          metricModel = input.model;
          yield* Effect.annotateCurrentSpan({
            "provider.kind": routed.adapter.provider,
            ...(input.model ? { "provider.model": input.model } : {}),
          });
          const limitError = getProviderAttachmentLimitError(
            input.attachments,
            routed.adapter.provider,
          );
          if (limitError) return yield* toValidationError("ProviderService.sendTurn", limitError);
          const attachmentPaths = input.attachments.map((attachment) => {
            switch (attachment.type) {
              case "file":
              case "image": {
                const localPath = resolveAttachmentPath({
                  attachmentsDir: serverConfig.attachmentsDir,
                  attachment,
                });
                return { attachment, localPath };
              }
              default:
                throw new Error(
                  `Unsupported provider attachment type '${String((attachment as { type?: unknown }).type)}'.`,
                );
            }
          });
          const missingAttachmentIds = (yield* Effect.promise(() =>
            Promise.all(
              attachmentPaths.map(async ({ attachment, localPath }) => {
                if (localPath === null) return attachment.id;
                try {
                  const current = await lstat(localPath);
                  return current.isFile() && current.size === attachment.sizeBytes
                    ? null
                    : attachment.id;
                } catch {
                  return attachment.id;
                }
              }),
            ),
          )).filter((id): id is string => id !== null);
          if (missingAttachmentIds.length > 0) {
            return yield* toValidationError(
              "ProviderService.sendTurn",
              `The following attachments changed or are no longer available: ${missingAttachmentIds.join(", ")}`,
            );
          }
          const resolvedAttachments = attachmentPaths.map(({ attachment, localPath }) => ({
            ...attachment,
            localPath: localPath!,
          }));
          const nativeAttachments = nativeProviderAttachments(
            input.attachments,
            routed.adapter.provider,
          );
          if (input.expectedTurnId !== undefined && !routed.adapter.steerTurn) {
            return yield* new ProviderTurnDeliveryError({
              certainty: "not_sent",
              retryable: false,
              detail: "This provider does not support steering.",
            });
          }
          // Steering re-checks the routed generation and executable support, so
          // a stale browser cannot steer a session restarted since it looked.
          if (input.expectedTurnId !== undefined) {
            yield* assertSessionAction({
              threadId: input.threadId,
              action: "steer",
              ...(input.expectedSessionGeneration !== undefined
                ? { expectedGeneration: input.expectedSessionGeneration }
                : {}),
            });
          }
          const turn = yield* input.expectedTurnId !== undefined
            ? routed.adapter.steerTurn!({
                ...input,
                expectedTurnId: input.expectedTurnId,
                attachments: nativeAttachments,
                resolvedAttachments,
              })
            : routed.adapter.sendTurn({
                ...input,
                attachments: nativeAttachments,
                resolvedAttachments,
              });
          const inlineIds = new Set(nativeAttachments.map((attachment) => attachment.id));
          const overflowImages = input.attachments.filter(
            (attachment) => attachment.type === "image" && !inlineIds.has(attachment.id),
          );
          if (overflowImages.length)
            yield* publishRuntimeEvent({
              type: "runtime.warning",
              eventId: EventId.makeUnsafe(randomUUID()),
              provider: routed.adapter.provider,
              threadId: input.threadId,
              turnId: turn.turnId,
              createdAt: new Date().toISOString(),
              payload: {
                category: "provider",
                message: `${overflowImages.length} image(s) delivered as files because this provider's inline image limit was reached. Saved paths remain available to the agent.`,
                actionable: false,
              },
            });
          const persistedBinding = yield* directory.getBinding(input.threadId);
          const persistedRuntimePayload = Option.match(persistedBinding, {
            onNone: () => undefined,
            onSome: (binding) => readPersistedRuntimePayloadRecord(binding.runtimePayload),
          });
          const persistedInstructionContext = Option.match(persistedBinding, {
            onNone: () => undefined,
            onSome: (binding) => readPersistedInstructionContext(binding.runtimePayload),
          });
          yield* directory.upsert({
            threadId: input.threadId,
            provider: routed.adapter.provider,
            providerInstanceId: routed.instanceId,
            status: "running",
            ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
            runtimePayload: {
              ...persistedRuntimePayload,
              activeTurnId: turn.turnId,
              lastRuntimeEvent: "provider.sendTurn",
              lastRuntimeEventAt: new Date().toISOString(),
              instructionContext: persistedInstructionContext ?? null,
              firstTurnSent: true,
            },
          });
          yield* analytics.record("provider.turn.sent", {
            provider: routed.adapter.provider,
            model: input.model,
            interactionMode: input.interactionMode,
            attachmentCount: input.attachments.length,
            hasInput: typeof input.input === "string" && input.input.trim().length > 0,
          });
          return turn;
        }).pipe(
          withAccountAdmission(serverConfig.stateDir, instanceId, "ProviderService.sendTurn"),
          withMetrics({
            counter: providerTurnsTotal,
            timer: providerTurnDuration,
            attributes: () =>
              providerTurnMetricAttributes({
                provider: metricProvider,
                model: metricModel,
                extra: {
                  operation: "send",
                },
              }),
          }),
        );
      });

    const interruptTurn: ProviderServiceShape["interruptTurn"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.interruptTurn",
          schema: ProviderInterruptTurnInput,
          payload: rawInput,
        });
        let metricProvider = "unknown";
        return yield* Effect.gen(function* () {
          const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
          const routed = yield* resolveRoutableSession({
            threadId: input.threadId,
            operation: "ProviderService.interruptTurn",
            allowRecovery:
              binding?.status === "running" &&
              (readPersistedActiveTurnId(binding.runtimePayload) !== undefined ||
                input.turnId !== undefined),
            ...(input.turnId !== undefined ? { fallbackActiveTurnId: input.turnId } : {}),
          });
          metricProvider = routed.adapter.provider;
          yield* Effect.annotateCurrentSpan({
            "provider.operation": "interrupt-turn",
            "provider.kind": routed.adapter.provider,
            "provider.thread_id": input.threadId,
            "provider.turn_id": input.turnId,
          });
          if (routed.isActive && routed.orphanedTurnId === undefined) {
            yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
          }
          yield* analytics.record("provider.turn.interrupted", {
            provider: routed.adapter.provider,
          });
        }).pipe(
          withMetrics({
            counter: providerTurnsTotal,
            outcomeAttributes: () =>
              providerMetricAttributes(metricProvider, {
                operation: "interrupt",
              }),
          }),
        );
      });

    const respondToRequest: ProviderServiceShape["respondToRequest"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.respondToRequest",
          schema: ProviderRespondToRequestInput,
          payload: rawInput,
        });
        if (input.decision === "acceptAlways") {
          const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
          if (binding?.provider !== "codex")
            return yield* toValidationError(
              "ProviderService.respondToRequest",
              "This provider does not support persistent app approvals.",
            );
        }
        let metricProvider = "unknown";
        return yield* Effect.gen(function* () {
          const routed = yield* resolveRoutableSession({
            threadId: input.threadId,
            operation: "ProviderService.respondToRequest",
            allowRecovery: true,
          });
          metricProvider = routed.adapter.provider;
          if (input.decision === "acceptAlways" && routed.adapter.provider !== "codex")
            return yield* toValidationError(
              "ProviderService.respondToRequest",
              "This provider does not support persistent app approvals.",
            );
          yield* Effect.annotateCurrentSpan({
            "provider.operation": "respond-to-request",
            "provider.kind": routed.adapter.provider,
            "provider.thread_id": input.threadId,
            "provider.request_id": input.requestId,
          });
          yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
          yield* analytics.record("provider.request.responded", {
            provider: routed.adapter.provider,
            decision: input.decision,
          });
        }).pipe(
          withMetrics({
            counter: providerTurnsTotal,
            outcomeAttributes: () =>
              providerMetricAttributes(metricProvider, {
                operation: "respond-to-request",
              }),
          }),
        );
      });

    const respondToUserInput: ProviderServiceShape["respondToUserInput"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.respondToUserInput",
          schema: ProviderRespondToUserInputInput,
          payload: rawInput,
        });
        let metricProvider = "unknown";
        return yield* Effect.gen(function* () {
          const routed = yield* resolveRoutableSession({
            threadId: input.threadId,
            operation: "ProviderService.respondToUserInput",
            allowRecovery: true,
          });
          metricProvider = routed.adapter.provider;
          yield* Effect.annotateCurrentSpan({
            "provider.operation": "respond-to-user-input",
            "provider.kind": routed.adapter.provider,
            "provider.thread_id": input.threadId,
            "provider.request_id": input.requestId,
          });
          const paths: string[] = [];
          const attachmentIssue = getProviderAttachmentLimitError(
            input.attachments ?? [],
            routed.adapter.provider,
          );
          if (attachmentIssue)
            return yield* toValidationError("ProviderService.respondToUserInput", attachmentIssue);
          for (const attachment of input.attachments ?? []) {
            const localPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!localPath)
              return yield* toValidationError(
                "ProviderService.respondToUserInput",
                "The answer attachment path is invalid.",
              );
            const valid = yield* Effect.tryPromise(() => lstat(localPath)).pipe(
              Effect.map((file) => file.isFile() && file.size === attachment.sizeBytes),
              Effect.catch(() => Effect.succeed(false)),
            );
            if (!valid)
              return yield* toValidationError(
                "ProviderService.respondToUserInput",
                "The answer attachment changed or is unavailable.",
              );
            paths.push(`saved at ${localPath}`);
          }
          const note = paths.join("\n");
          const answers = paths.length
            ? Object.fromEntries(
                Object.entries(input.answers).map(([key, value]) => [
                  key,
                  isRecord(value) && Array.isArray(value.answers)
                    ? { ...value, answers: [...value.answers, note] }
                    : { answers: [...(Array.isArray(value) ? value : [String(value)]), note] },
                ]),
              )
            : input.answers;
          yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, answers);
        }).pipe(
          withMetrics({
            counter: providerTurnsTotal,
            outcomeAttributes: () =>
              providerMetricAttributes(metricProvider, {
                operation: "respond-to-user-input",
              }),
          }),
        );
      });

    const respondToElicitation: ProviderServiceShape["respondToElicitation"] = (input) =>
      Effect.gen(function* () {
        const operation = "ProviderService.respondToElicitation";
        const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
        if (!binding)
          return yield* toValidationError(operation, "This conversation has no provider session.");
        if (readPersistedSessionGeneration(binding.runtimePayload) !== input.generation)
          return yield* toValidationError(
            operation,
            "This request belongs to an earlier provider session and can no longer be answered.",
          );
        // Never recover: a recovered session is a new generation that does not
        // own this request.
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation,
          allowRecovery: false,
          binding: Option.some(binding),
        });
        if (!routed.isActive || !routed.adapter.respondToElicitation)
          return yield* toValidationError(
            operation,
            "The provider session that asked for this input is no longer running.",
          );
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-elicitation",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        return yield* routed.adapter.respondToElicitation(routed.threadId, input.requestId, {
          action: input.action,
          ...(input.content !== undefined ? { content: input.content } : {}),
        });
      });

    const respondToStartingElicitation = (
      input: Parameters<ProviderServiceShape["respondToElicitation"]>[0],
      adapter: ProviderAdapterShape<ProviderAdapterError>,
    ) =>
      adapter.respondToElicitation
        ? adapter.respondToElicitation(input.threadId, input.requestId, {
            action: input.action,
            ...(input.content !== undefined ? { content: input.content } : {}),
          })
        : Effect.gen(function* () {
            return yield* toValidationError(
              "ProviderService.respondToElicitation",
              "The provider session that asked for this input is no longer running.",
            );
          });

    const stopSession: ProviderServiceShape["stopSession"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.stopSession",
          schema: ProviderStopSessionInput,
          payload: rawInput,
        });
        let metricProvider = "unknown";
        return yield* Effect.gen(function* () {
          const routed = yield* resolveRoutableSession({
            threadId: input.threadId,
            operation: "ProviderService.stopSession",
            allowRecovery: false,
          });
          metricProvider = routed.adapter.provider;
          yield* Effect.annotateCurrentSpan({
            "provider.operation": "stop-session",
            "provider.kind": routed.adapter.provider,
            "provider.thread_id": input.threadId,
          });
          if (routed.isActive) {
            yield* routed.adapter.stopSession(routed.threadId);
          }
          // Unpin any hidden agent-controlled preview this session was using.
          if (Option.isSome(previewAutomationBroker)) {
            yield* previewAutomationBroker.value.releaseThread(input.threadId);
          }
          yield* directory.upsert({
            threadId: input.threadId,
            provider: routed.adapter.provider,
            providerInstanceId: routed.instanceId,
            status: "stopped",
            runtimePayload: {
              lastError: null,
              lastRuntimeEvent: "provider.stopSession",
              lastRuntimeEventAt: new Date().toISOString(),
            },
          });
          yield* Effect.logInfo(
            "provider service preserved provider binding while stopping session",
            {
              threadId: input.threadId,
              provider: routed.adapter.provider,
              wasActive: routed.isActive,
            },
          );
          yield* analytics.record("provider.session.stopped", {
            provider: routed.adapter.provider,
          });
        }).pipe(
          withMetrics({
            counter: providerSessionsTotal,
            outcomeAttributes: () =>
              providerMetricAttributes(metricProvider, {
                operation: "stop",
              }),
          }),
        );
      });

    const listSessions: ProviderServiceShape["listSessions"] = () =>
      Effect.gen(function* () {
        const currentAdapters = yield* getAdapterEntries;
        const sessionsByProvider = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
          adapter.listSessions().pipe(
            Effect.map((sessions) =>
              sessions.map((session) => ({
                ...session,
                providerInstanceId: session.providerInstanceId ?? instanceId,
              })),
            ),
          ),
        );
        const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
        const persistedBindings = yield* directory.listThreadIds().pipe(
          Effect.flatMap((threadIds) =>
            Effect.forEach(
              threadIds,
              (threadId) =>
                directory
                  .getBinding(threadId)
                  .pipe(Effect.orElseSucceed(() => Option.none<ProviderRuntimeBinding>())),
              { concurrency: "unbounded" },
            ),
          ),
          Effect.orElseSucceed(() => [] as Array<Option.Option<ProviderRuntimeBinding>>),
        );
        const bindingsByThreadId = new Map<ThreadId, ProviderRuntimeBinding>();
        for (const bindingOption of persistedBindings) {
          const binding = Option.getOrUndefined(bindingOption);
          if (binding) {
            bindingsByThreadId.set(binding.threadId, binding);
          }
        }

        return activeSessions.map((session) => {
          const binding = bindingsByThreadId.get(session.threadId);
          if (!binding) {
            return session;
          }

          const overrides: {
            resumeCursor?: ProviderSession["resumeCursor"];
            runtimeMode?: ProviderSession["runtimeMode"];
            providerInstanceId?: ProviderSession["providerInstanceId"];
          } = {};
          if (binding.providerInstanceId !== undefined && binding.providerInstanceId !== null) {
            overrides.providerInstanceId = binding.providerInstanceId;
          }
          if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
            overrides.resumeCursor = binding.resumeCursor;
          }
          if (binding.runtimeMode !== undefined) {
            overrides.runtimeMode = binding.runtimeMode;
          }
          return Object.assign({}, session, overrides);
        });
      });

    const getCapabilities: ProviderServiceShape["getCapabilities"] = (provider) =>
      registry.getByProvider(provider).pipe(Effect.map((adapter) => adapter.capabilities));

    const getSessionCapabilities: ProviderServiceShape["getSessionCapabilities"] = (threadId) =>
      Effect.gen(function* () {
        const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        if (!binding) return null;
        const instanceId = resolveBindingInstanceId(binding);
        const adapter = yield* registry.getByInstance(instanceId);
        return yield* snapshotSessionCapabilities({
          threadId,
          instanceId,
          adapter,
          generation: readPersistedSessionGeneration(binding.runtimePayload),
        });
      });

    const assertSessionAction: ProviderServiceShape["assertSessionAction"] = (input) =>
      Effect.gen(function* () {
        const capabilities = yield* getSessionCapabilities(input.threadId);
        if (!capabilities) {
          return yield* new ProviderSessionActionUnavailableError({
            threadId: input.threadId,
            action: input.action,
            reason: {
              code: "no-session",
              message: "This conversation has no provider session yet.",
            },
          });
        }
        const reason = checkSessionAction({
          capabilities,
          action: input.action,
          expectedGeneration: input.expectedGeneration,
        });
        if (reason) {
          return yield* new ProviderSessionActionUnavailableError({
            threadId: input.threadId,
            action: input.action,
            reason,
          });
        }
        return capabilities;
      });

    const readThread: ProviderServiceShape["readThread"] = (rawThreadId) =>
      Effect.gen(function* () {
        const threadId = yield* decodeInputOrValidationError({
          operation: "ProviderService.readThread",
          schema: ThreadId,
          payload: rawThreadId,
        });
        const routed = yield* resolveRoutableSession({
          threadId,
          operation: "ProviderService.readThread",
          allowRecovery: true,
        });
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "read-thread",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": threadId,
        });
        return yield* routed.adapter.readThread(routed.threadId);
      });

    const rollbackConversation: ProviderServiceShape["rollbackConversation"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.rollbackConversation",
          schema: ProviderRollbackConversationInput,
          payload: rawInput,
        });
        if (input.numTurns === 0) {
          return;
        }
        let metricProvider = "unknown";
        return yield* Effect.gen(function* () {
          const routed = yield* resolveRoutableSession({
            threadId: input.threadId,
            operation: "ProviderService.rollbackConversation",
            allowRecovery: true,
          });
          metricProvider = routed.adapter.provider;
          yield* Effect.annotateCurrentSpan({
            "provider.operation": "rollback-conversation",
            "provider.kind": routed.adapter.provider,
            "provider.thread_id": input.threadId,
            "provider.num_turns": input.numTurns,
          });
          yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns, {
            ...(input.beforeTurnId !== undefined ? { beforeTurnId: input.beforeTurnId } : {}),
            onAdoptSession: (session) =>
              Effect.runPromise(
                directory.upsert({
                  threadId: input.threadId,
                  provider: routed.adapter.provider,
                  providerInstanceId: routed.instanceId,
                  status: "running",
                  resumeCursor: session.resumeCursor,
                  runtimePayload: toRuntimePayloadFromSession(session),
                }),
              ),
          });
          const session = (yield* routed.adapter.listSessions()).find(
            (session) => session.threadId === input.threadId,
          );
          if (session)
            yield* directory.upsert({
              threadId: input.threadId,
              provider: routed.adapter.provider,
              providerInstanceId: routed.instanceId,
              status: "running",
              resumeCursor: session.resumeCursor,
              runtimePayload: toRuntimePayloadFromSession(session),
            });
          yield* analytics.record("provider.conversation.rolled_back", {
            provider: routed.adapter.provider,
            turns: input.numTurns,
          });
        }).pipe(
          withMetrics({
            counter: providerTurnsTotal,
            outcomeAttributes: () =>
              providerMetricAttributes(metricProvider, {
                operation: "rollback",
              }),
          }),
        );
      });

    const runOneOffPrompt: ProviderServiceShape["runOneOffPrompt"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.runOneOffPrompt",
          schema: ProviderConversationCompactionInputSchema,
          payload: rawInput,
        });
        const selectedInstance = input.modelSelection
          ? yield* registry.getInstanceInfo(input.modelSelection.instanceId)
          : undefined;
        if (
          selectedInstance &&
          (!selectedInstance.enabled || !isKnownProviderKind(selectedInstance.driverKind))
        ) {
          return yield* toValidationError(
            "ProviderService.runOneOffPrompt",
            `Summary provider instance '${selectedInstance.instanceId}' is disabled or unsupported.`,
          );
        }
        const provider =
          (selectedInstance?.driverKind as ProviderKind | undefined) ?? input.provider;
        if (!provider) {
          return yield* toValidationError(
            "ProviderService.runOneOffPrompt",
            "A provider or modelSelection is required.",
          );
        }
        const adapter = input.modelSelection
          ? yield* registry.getByInstance(input.modelSelection.instanceId)
          : yield* registry.getByProvider(provider);
        if (!adapter.runOneOffPrompt && (input.modelSelection || !adapter.compactConversation)) {
          return yield* toValidationError(
            "ProviderService.runOneOffPrompt",
            `Provider '${provider}' does not support one-off prompts.`,
          );
        }
        const persistedBinding = input.modelSelection
          ? Option.none<ProviderRuntimeBinding>()
          : yield* directory.getBinding(input.threadId);
        const persistedProviderOptions = Option.match(persistedBinding, {
          onNone: () => undefined,
          onSome: (binding) => readPersistedProviderOptions(binding.runtimePayload),
        });
        const persistedRuntimeMode = Option.match(persistedBinding, {
          onNone: () => undefined,
          onSome: (binding) => binding.runtimeMode,
        });
        const providerInput = {
          threadId: input.threadId,
          provider,
          prompt: input.prompt,
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.modelSelection
            ? { model: input.modelSelection.model, modelSelection: input.modelSelection }
            : input.model !== undefined
              ? { model: input.model }
              : {}),
          ...(input.runtimeMode !== undefined
            ? { runtimeMode: input.runtimeMode }
            : persistedRuntimeMode !== undefined
              ? { runtimeMode: persistedRuntimeMode }
              : {}),
          ...(input.providerOptions !== undefined
            ? { providerOptions: input.providerOptions }
            : persistedProviderOptions !== undefined
              ? { providerOptions: persistedProviderOptions }
              : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        };
        const result = yield* (
          adapter.runOneOffPrompt
            ? adapter.runOneOffPrompt(providerInput)
            : adapter.compactConversation!(providerInput).pipe(
                Effect.map((response) => ({ text: response.summary })),
              )
        ).pipe(
          withAccountAdmission(
            serverConfig.stateDir,
            input.modelSelection?.instanceId ??
              defaultInstanceIdForDriver(ProviderDriverKind.make(provider)),
            "ProviderService.runOneOffPrompt",
          ),
        );
        yield* analytics.record("provider.one_off_prompt.ran", {
          provider,
          model: input.modelSelection?.model ?? input.model,
          hasCwd: input.cwd !== undefined,
          hasProviderOptions:
            input.providerOptions !== undefined || persistedProviderOptions !== undefined,
        });
        return result;
      });

    const compactConversation: ProviderServiceShape["compactConversation"] = (rawInput) =>
      runOneOffPrompt(rawInput).pipe(
        Effect.map((result) => ({
          summary: result.text,
        })),
      );

    const reloadMcpConfigForProject: ProviderServiceShape["reloadMcpConfigForProject"] = (input) =>
      Effect.gen(function* () {
        const bindings = yield* directory.listBindingsByProject(input.projectId);
        const matchingBindings = bindings.filter((binding) => {
          if (binding.provider !== input.provider) {
            return false;
          }
          if (input.threadIds && !input.threadIds.includes(binding.threadId)) {
            return false;
          }
          if (binding.status === "stopped") {
            return false;
          }
          if (binding.projectId !== input.projectId) {
            return false;
          }
          if (!input.providerOptions) {
            return true;
          }
          const persistedProviderOptions = readPersistedProviderOptions(binding.runtimePayload);
          return (
            getProviderEnvironmentKey(
              binding.provider,
              persistedProviderOptions as ProviderStartOptions | undefined,
            ) === getProviderEnvironmentKey(binding.provider, input.providerOptions)
          );
        });

        if (matchingBindings.length === 0) {
          return { sessions: [] };
        }

        const currentProjectMcp = yield* projectMcpConfigService
          .readEffectiveStoredConfig(input.projectId)
          .pipe(
            Effect.mapError(
              toProjectMcpProviderError(
                "ProviderService.reloadMcpConfigForProject",
                input.projectId,
              ),
            ),
          );

        // `reached` is false when the reload request itself failed, so the
        // session may not hold the new config at all.
        const reloadOnce = (
          reloadMcpConfig: NonNullable<
            ProviderAdapterShape<ProviderAdapterError>["reloadMcpConfig"]
          >,
          threadId: ThreadId,
        ) =>
          reloadMcpConfig({ threadId, mcpServers: currentProjectMcp.servers }).pipe(
            Effect.map((result) => ({ result, reached: true })),
            Effect.catch((error) =>
              Effect.succeed({
                result: {
                  converged: false,
                  restartRequired: false,
                  servers: [],
                  errors: [{ message: error.message.trim() || "The MCP reload request failed." }],
                } satisfies McpReloadResult,
                reached: false,
              }),
            ),
          );
        // Bounded backoff: a restart-required result is final, as is convergence.
        const retryDelays = input.retry === false ? [] : MCP_RELOAD_RETRY_DELAYS_MS;
        const reloadWithRetry = (
          reloadMcpConfig: NonNullable<
            ProviderAdapterShape<ProviderAdapterError>["reloadMcpConfig"]
          >,
          threadId: ThreadId,
          attempt: number,
        ): Effect.Effect<{ readonly result: McpReloadResult; readonly reached: boolean }> =>
          reloadOnce(reloadMcpConfig, threadId).pipe(
            Effect.flatMap((outcome) => {
              const delayMs = retryDelays[attempt];
              if (
                outcome.result.converged ||
                outcome.result.restartRequired ||
                delayMs === undefined
              ) {
                return Effect.succeed(outcome);
              }
              return Effect.sleep(Duration.millis(delayMs)).pipe(
                Effect.andThen(reloadWithRetry(reloadMcpConfig, threadId, attempt + 1)),
              );
            }),
          );

        const sessions = yield* Effect.forEach(
          matchingBindings,
          (binding) =>
            Effect.gen(function* () {
              // Custom instances have their own adapter; resolve it per binding.
              const adapter = yield* registry
                .getByInstance(resolveBindingInstanceId(binding))
                .pipe(Effect.option);
              const reloadMcpConfig = Option.getOrUndefined(adapter)?.reloadMcpConfig;
              if (
                Option.isNone(adapter) ||
                !reloadMcpConfig ||
                !(yield* adapter.value.hasSession(binding.threadId))
              ) {
                return [];
              }
              const { result, reached } = yield* reloadWithRetry(
                reloadMcpConfig,
                binding.threadId,
                0,
              );
              // A broken server stays broken after a restart, so only a
              // restart-required (or undelivered) reload keeps the version
              // stale; the next turn start restarts that session. A reload
              // that did not converge is marked so Apply still retries it.
              if (reached && !result.restartRequired) {
                yield* directory.upsert({
                  threadId: binding.threadId,
                  projectId: input.projectId,
                  provider: binding.provider,
                  // The directory resets an omitted instance to the default one.
                  providerInstanceId: resolveBindingInstanceId(binding),
                  mcpEffectiveConfigVersion: currentProjectMcp.effectiveVersion,
                  runtimePayload: {
                    mcpUnconvergedConfigVersion: result.converged
                      ? null
                      : currentProjectMcp.effectiveVersion,
                  },
                });
              }
              // A restart-required result is final, so a caller's own retries
              // cannot change it: always say so.
              if (result.errors.length > 0 && (input.warn !== false || result.restartRequired)) {
                yield* publishRuntimeEvent({
                  type: "runtime.warning",
                  eventId: EventId.makeUnsafe(randomUUID()),
                  provider: binding.provider,
                  threadId: binding.threadId,
                  createdAt: new Date().toISOString(),
                  payload: {
                    category: "provider",
                    message: describeMcpReloadFailure(result),
                    actionable: !result.restartRequired,
                  },
                });
              }
              return [{ threadId: binding.threadId, result }];
            }),
          // Bound the wall time of Apply when several sessions retry.
          { concurrency: 4 },
        );
        return { sessions: sessions.flat() };
      });

    const settingsOption = yield* Effect.serviceOption(ServerSettingsService);
    const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
    const markRestartTurns = Effect.gen(function* () {
      if (Option.isNone(settingsOption) || Option.isNone(sqlOption)) return;
      const settings = yield* settingsOption.value.getSettings;
      const sql = sqlOption.value;
      const sessions = yield* listSessions();
      for (const session of sessions) {
        if (!session.activeTurnId) continue;
        const thread = (yield* sql<{
          readonly projectId: string;
        }>`SELECT project_id AS "projectId" FROM projection_threads WHERE thread_id = ${session.threadId}`)[0];
        const enabled = thread
          ? (settings.projectSettingsOverrides[
              thread.projectId as import("@t3tools/contracts").ProjectId
            ]?.resumeActiveTurnsAfterRestart ?? settings.resumeActiveTurnsAfterRestart)
          : false;
        if (!enabled) continue;
        const continuation =
          yield* sql`SELECT c.continuation_id FROM restart_continuations c LEFT JOIN provider_turn_deliveries d ON d.delivery_id = c.continuation_id WHERE c.thread_id = ${session.threadId} AND (c.provider_turn_id = ${session.activeTurnId} OR d.provider_turn_id = ${session.activeTurnId} OR d.state = 'sending' OR EXISTS (SELECT 1 FROM projection_turns t WHERE t.thread_id = c.thread_id AND t.turn_id = ${session.activeTurnId} AND t.pending_message_id = c.continuation_id))`;
        const recovery =
          yield* sql`SELECT pending_message_id FROM projection_turns WHERE thread_id = ${session.threadId} AND turn_id = ${session.activeTurnId} AND pending_message_id LIKE 'usage-resume:%'`;
        if (continuation.length || recovery.length) continue;
        const continuationId = `resume:${session.threadId}:${session.activeTurnId}`;
        yield* sql`INSERT INTO restart_turn_markers VALUES (${session.threadId}, ${session.activeTurnId}, ${new Date().toISOString()}, ${continuationId}) ON CONFLICT(thread_id) DO UPDATE SET turn_id = excluded.turn_id, marked_at = excluded.marked_at, continuation_id = excluded.continuation_id`;
      }
    });

    const runStopAll = () =>
      Effect.gen(function* () {
        const threadIds = yield* directory.listThreadIds();
        const currentAdapters = yield* getAdapterEntries;
        yield* markRestartTurns.pipe(
          Effect.catchCause((cause) =>
            Effect.logError("failed to mark active turns for restart", {
              cause: Cause.pretty(cause),
            }),
          ),
        );
        yield* Effect.forEach(currentAdapters, ([, adapter]) => adapter.stopAll()).pipe(
          Effect.asVoid,
        );
        yield* Effect.forEach(threadIds, (threadId) =>
          directory.getBinding(threadId).pipe(
            Effect.flatMap((bindingOption) => {
              const binding = Option.getOrUndefined(bindingOption);
              if (!binding) return Effect.void;
              return directory.upsert({
                threadId,
                provider: binding.provider,
                providerInstanceId: resolveBindingInstanceId(binding),
                status: "stopped",
                runtimePayload: {
                  lastRuntimeEvent: "provider.stopAll",
                  lastRuntimeEventAt: new Date().toISOString(),
                },
              });
            }),
          ),
        ).pipe(Effect.asVoid);
        yield* analytics.record("provider.sessions.stopped_all", {
          sessionCount: threadIds.length,
        });
        yield* analytics.flush;
      });

    const checkNativeOperation = (record: import("@t3tools/contracts").NativeOperationRecord) =>
      Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: record.threadId,
          operation: "nativeOperation.reconcile",
          allowRecovery: false,
        });
        if (!routed.adapter.reconcileNativeOperation) return { state: "indeterminate" as const };
        const outcome = yield* routed.adapter.reconcileNativeOperation(record);
        return {
          ...outcome,
          ...((yield* nativeGeneration(record.threadId)) !== record.generation
            ? { staleGeneration: true }
            : {}),
        };
      }).pipe(Effect.timeout("10 seconds"));
    if (nativeCoordinator) {
      // Restore every durable reservation before exposing the layer; provider reads happen later.
      yield* nativeCoordinator.restoreReservations.pipe(Effect.orDie);
      yield* nativeCoordinator.reconcile(checkNativeOperation).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Native operation reconciliation failed", { cause }),
        ),
        Effect.repeat(Schedule.spaced("30 seconds")),
        Effect.forkIn(nativeScope),
      );
    }
    yield* Effect.addFinalizer(() =>
      Effect.catch(runStopAll(), (cause) =>
        Effect.logWarning("failed to stop provider service", { cause }),
      ),
    );

    return {
      nativeOperations,
      renameThread,
      startSession: (threadId, input) =>
        withProviderThreadAccess(threadId, startSession(threadId, input)),
      sendTurn: (input) => withProviderThreadAccess(input.threadId, sendTurn(input)),
      interruptTurn: (input) => withProviderThreadAccess(input.threadId, interruptTurn(input)),
      respondToRequest: (input) =>
        withProviderThreadAccess(input.threadId, respondToRequest(input)),
      respondToUserInput: (input) =>
        withProviderThreadAccess(input.threadId, respondToUserInput(input)),
      respondToElicitation: (input) =>
        Effect.suspend(() => {
          // The start holds the thread lock until the adapter returns, so a
          // request opened during startup is answered without it.
          const starting = startingSessions.get(input.threadId);
          return starting && starting.generation === input.generation
            ? respondToStartingElicitation(input, starting.adapter)
            : withProviderThreadAccess(input.threadId, respondToElicitation(input));
        }),
      stopSession,
      listSessions,
      getCapabilities,
      getSessionCapabilities,
      assertSessionAction,
      readThread: (threadId) => withProviderThreadAccess(threadId, readThread(threadId)),
      rollbackConversation: (input) =>
        withProviderThreadAccess(input.threadId, rollbackConversation(input)),
      runOneOffPrompt,
      compactConversation,
      reloadMcpConfigForProject,
      // Each access creates a fresh PubSub subscription so that multiple
      // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
      // independently receive all runtime events.
      get streamEvents(): ProviderServiceShape["streamEvents"] {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    } satisfies ProviderServiceShape;
  });

export const ProviderServiceLive = Layer.effect(ProviderService, makeProviderService());

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService, makeProviderService(options));
}
