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
import {
  NonNegativeInt,
  ProjectId,
  ProviderKind,
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
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { getProviderEnvironmentKey } from "@t3tools/shared/providerOptions";
import { Effect, Layer, Option, PubSub, Queue, Ref, Schema, SchemaIssue, Stream } from "effect";

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
import { type ProviderAdapterError, ProviderValidationError } from "../Errors.ts";
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

export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogPath?: string;
  readonly canonicalEventLogger?: EventNdjsonLogger;
}

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

const ProviderConversationCompactionInputSchema = Schema.Struct({
  threadId: ThreadId,
  provider: ProviderKind,
  prompt: TrimmedNonEmptyString,
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
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
    readonly providerOptions?: unknown;
    readonly instructionContext?: Partial<SharedInstructionInput> | null;
  },
): Record<string, unknown> {
  const persistedProviderOptions = sanitizeProviderOptionsForPersistence(extra?.providerOptions);
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(persistedProviderOptions !== undefined
      ? { providerOptions: persistedProviderOptions }
      : {}),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeProviderOptionsForPersistence(
  providerOptions: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(providerOptions)) {
    return undefined;
  }

  const { mcpServers: _discardedMcpServers, ...rest } = providerOptions;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function readPersistedProviderOptions(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): Record<string, unknown> | undefined {
  if (!isRecord(runtimePayload)) {
    return undefined;
  }
  const raw = "providerOptions" in runtimePayload ? runtimePayload.providerOptions : undefined;
  if (!isRecord(raw)) return undefined;
  return raw as Record<string, unknown>;
}

function readPersistedCwd(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!isRecord(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPersistedInstructionContext(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): Partial<SharedInstructionInput> | undefined {
  if (!isRecord(runtimePayload)) {
    return undefined;
  }
  const raw =
    "instructionContext" in runtimePayload ? runtimePayload.instructionContext : undefined;
  return isRecord(raw) ? (raw as Partial<SharedInstructionInput>) : undefined;
}

function readPersistedRuntimePayloadRecord(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): Record<string, unknown> | undefined {
  return isRecord(runtimePayload) ? runtimePayload : undefined;
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
    runtimeMode: input.runtimeMode,
  };
}

const makeProviderService = (options?: ProviderServiceLiveOptions) =>
  Effect.gen(function* () {
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
    const projectMcpConfigService = yield* ProjectMcpConfigService;
    const runtimeEventQueue = yield* Queue.unbounded<{
      readonly source: {
        readonly instanceId: ProviderInstanceId;
        readonly provider: ProviderKind;
      };
      readonly event: ProviderRuntimeEvent;
    }>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

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
        readonly providerOptions?: unknown;
        readonly instructionContext?: Partial<SharedInstructionInput> | null;
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
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      });

    const persistResumeCursorFromRuntimeEvent = (
      event: ProviderRuntimeEvent,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (event.resumeCursor === undefined) {
          return;
        }

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

        yield* directory.upsert({
          threadId: event.threadId,
          provider: binding.provider,
          providerInstanceId: binding.providerInstanceId ?? event.providerInstanceId ?? null,
          resumeCursor: event.resumeCursor,
        });
      }).pipe(
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
        const event = {
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
        yield* publishRuntimeEvent(event);
        yield* increment(providerRuntimeEventsTotal, {
          provider: event.provider,
          eventType: event.type,
        });
      });

    const worker = Effect.forever(
      Queue.take(runtimeEventQueue).pipe(Effect.flatMap(processRuntimeEvent)),
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
        const hasResumeCursor =
          input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
        const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
        if (hasActiveSession) {
          const activeSessions = yield* adapter.listSessions();
          const existing = activeSessions.find(
            (session) => session.threadId === input.binding.threadId,
          );
          if (existing) {
            yield* upsertSessionBinding(
              { ...existing, providerInstanceId: bindingInstanceId },
              input.binding.threadId,
            );
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
            return { adapter, session: existing } as const;
          }
        }

        if (!hasResumeCursor) {
          return yield* toValidationError(
            input.operation,
            `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
          );
        }

        const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
        const persistedProviderOptions = readPersistedProviderOptions(input.binding.runtimePayload);
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

        const resumed = yield* adapter.startSession({
          threadId: input.binding.threadId,
          ...(input.binding.projectId ? { projectId: input.binding.projectId } : {}),
          provider: input.binding.provider,
          providerInstanceId: bindingInstanceId,
          ...(persistedCwd ? { cwd: persistedCwd } : {}),
          ...recoveredInstructionContext,
          ...(resumedProviderOptions ? { providerOptions: resumedProviderOptions } : {}),
          ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
          runtimeMode: input.binding.runtimeMode ?? "full-access",
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
            ...(persistedProviderOptions ? { providerOptions: persistedProviderOptions } : {}),
            ...(recoveredInstructionContext
              ? { instructionContext: recoveredInstructionContext }
              : {}),
          },
        );
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
        return { adapter, session: resumed } as const;
      }).pipe(
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
    }) =>
      Effect.gen(function* () {
        const bindingOption = yield* directory.getBinding(input.threadId);
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
          return { adapter, instanceId, threadId: input.threadId, isActive: true } as const;
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
          return { adapter, instanceId, threadId: input.threadId, isActive: false } as const;
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
        const recovered = yield* recoverSessionForThread({ binding, operation: input.operation });
        return {
          adapter: recovered.adapter,
          instanceId,
          threadId: input.threadId,
          isActive: true,
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
          const input = {
            ...parsed,
            threadId,
            provider: resolvedProvider,
            providerInstanceId: requestedInstanceId,
          };
          const adapter = yield* registry.getByInstance(requestedInstanceId);
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
          yield* stopStaleSessionsForThread({
            threadId,
            currentInstanceId: requestedInstanceId,
          });
          const session = yield* adapter.startSession(adapterInput);

          if (session.provider !== adapter.provider) {
            return yield* toValidationError(
              "ProviderService.startSession",
              `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
            );
          }
          const sessionWithInstance = {
            ...session,
            providerInstanceId: requestedInstanceId,
          };

          yield* upsertSessionBinding(sessionWithInstance, threadId, {
            ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
            mcpEffectiveConfigVersion: resolvedProjectMcp?.effectiveVersion ?? null,
            providerOptions: input.providerOptions,
            instructionContext: toInstructionContextFromSessionStartInput(input),
          });
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
          withMetrics({
            counter: providerSessionsTotal,
            attributes: () =>
              providerMetricAttributes(metricProvider, {
                operation: "start",
              }),
          }),
        );
      });

    const sendTurn: ProviderServiceShape["sendTurn"] = (rawInput) =>
      Effect.gen(function* () {
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
        let metricProvider = "unknown";
        let metricModel = input.model;
        return yield* Effect.gen(function* () {
          const routed = yield* resolveRoutableSession({
            threadId: input.threadId,
            operation: "ProviderService.sendTurn",
            allowRecovery: true,
          });
          metricProvider = routed.adapter.provider;
          metricModel = input.model;
          yield* Effect.annotateCurrentSpan({
            "provider.kind": routed.adapter.provider,
            ...(input.model ? { "provider.model": input.model } : {}),
          });
          const turn = yield* routed.adapter.sendTurn(input);
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
          const routed = yield* resolveRoutableSession({
            threadId: input.threadId,
            operation: "ProviderService.interruptTurn",
            allowRecovery: true,
          });
          metricProvider = routed.adapter.provider;
          yield* Effect.annotateCurrentSpan({
            "provider.operation": "interrupt-turn",
            "provider.kind": routed.adapter.provider,
            "provider.thread_id": input.threadId,
            "provider.turn_id": input.turnId,
          });
          yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
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
        let metricProvider = "unknown";
        return yield* Effect.gen(function* () {
          const routed = yield* resolveRoutableSession({
            threadId: input.threadId,
            operation: "ProviderService.respondToRequest",
            allowRecovery: true,
          });
          metricProvider = routed.adapter.provider;
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
          yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
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
          yield* directory.upsert({
            threadId: input.threadId,
            provider: routed.adapter.provider,
            providerInstanceId: routed.instanceId,
            status: "stopped",
            runtimePayload: {
              activeTurnId: null,
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
          yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
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
        const adapter = yield* registry.getByProvider(input.provider);
        if (!adapter.runOneOffPrompt && !adapter.compactConversation) {
          return yield* toValidationError(
            "ProviderService.runOneOffPrompt",
            `Provider '${input.provider}' does not support one-off prompts.`,
          );
        }
        const persistedBinding = yield* directory.getBinding(input.threadId);
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
          provider: input.provider,
          prompt: input.prompt,
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
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
        const result = yield* adapter.runOneOffPrompt
          ? adapter.runOneOffPrompt(providerInput)
          : adapter.compactConversation!(providerInput).pipe(
              Effect.map((response) => ({ text: response.summary })),
            );
        yield* analytics.record("provider.one_off_prompt.ran", {
          provider: input.provider,
          model: input.model,
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
        const adapter = yield* registry.getByProvider(input.provider);
        const reloadMcpConfig = adapter.reloadMcpConfig;
        if (!reloadMcpConfig) {
          return;
        }

        const bindings = yield* directory.listBindingsByProject(input.projectId);
        const matchingBindings = bindings.filter((binding) => {
          if (binding.provider !== input.provider) {
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
          return;
        }

        const currentProjectMcpVersion = yield* projectMcpConfigService
          .readEffectiveStoredConfig(input.projectId)
          .pipe(
            Effect.map((config) => config.effectiveVersion),
            Effect.mapError(
              toProjectMcpProviderError(
                "ProviderService.reloadMcpConfigForProject",
                input.projectId,
              ),
            ),
          );

        yield* Effect.forEach(matchingBindings, (binding) =>
          reloadMcpConfig(binding.threadId).pipe(
            Effect.andThen(
              directory.upsert({
                threadId: binding.threadId,
                projectId: input.projectId,
                provider: binding.provider,
                mcpEffectiveConfigVersion: currentProjectMcpVersion,
              }),
            ),
          ),
        ).pipe(Effect.asVoid);
      });

    const runStopAll = () =>
      Effect.gen(function* () {
        const threadIds = yield* directory.listThreadIds();
        const currentAdapters = yield* getAdapterEntries;
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
                  activeTurnId: null,
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

    yield* Effect.addFinalizer(() =>
      Effect.catch(runStopAll(), (cause) =>
        Effect.logWarning("failed to stop provider service", { cause }),
      ),
    );

    return {
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      getCapabilities,
      readThread,
      rollbackConversation,
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
