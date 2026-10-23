import { threadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";
import { captureRestartTurnMarkers } from "../../nextTurnQueue/restartMarkerCapture.ts";
import { resolveProjectProviderInstanceEnabled } from "@t3tools/shared/serverSettings";
import { registerProviderRuntimeFanout } from "../../observability/Metrics.ts";
import { readIncompleteHistory } from "../runtimePayload.ts";
import { ProviderControlTarget } from "../controlTarget.ts";
import { registerShutdown, ServerShutdown } from "../../shutdown.ts";
import { resolveOwnedMcpServerName } from "../mcpObservation.ts";
import { carryPreparedComputerEvidence } from "../prepareAutomationRuntimeEvent";
import { resolveBindingInstanceId } from "../bindingIdentity.ts";
import { makeOperationGate } from "../operationGate.ts";
import { withWorktreeLifecycleLock } from "../../project/Layers/WorktreeLifecycleCoordinator.ts";
import { canonicalWorktreePath } from "../../git/worktreePaths.ts";
import { assertWorktreeReady } from "../../project/worktreeReadiness.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { assertMcpRuntimeConfig, mcpConfigErrorMessage } from "@t3tools/shared/mcpValidation";
import { readCodexMcpOAuthCallbackConfig } from "@t3tools/shared/mcpTranslation";
import { DeliveryAttemptContext } from "../deliveryAttemptContext";
import { automationEventSanitizer } from "@t3tools/shared/automationActivitySanitizer";
import { ComputerAutomationBroker } from "../../computer/ComputerAutomationBroker";
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
import { hasProviderUpdate, withAccountAdmission } from "../../profiles/ProviderAccountGuard.ts";
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
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type McpReloadResult,
  type McpSessionReloadOutcome,
  type McpSessionSummary,
  PROVIDER_DISPLAY_NAMES,
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
  Fiber,
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
  type ProviderServiceError,
  ProviderSessionActionUnavailableError,
  ProviderUnsupportedError,
  ProviderValidationError,
  ProviderTurnDeliveryError,
  ProviderAdapterRequestError,
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
import {
  writeProviderEventLog,
  type EventNdjsonLogger,
  makeEventNdjsonLogger,
} from "./EventNdjsonLogger.ts";
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
  readPersistedUnconvergedMcpConfigVersion,
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

/** Stopped rows with no active turn are settled; shutdown leaves them untouched. */
function isSettledBinding(binding: {
  readonly status?: string | undefined;
  readonly runtimePayload?: unknown;
}): boolean {
  return (
    binding.status === "stopped" && readPersistedActiveTurnId(binding.runtimePayload) === undefined
  );
}

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
    ...(session.computerConfigurationFingerprint !== undefined
      ? {
          computerConfigurationFingerprint: session.computerConfigurationFingerprint,
          computerBackendSelection: session.computerBackendSelection ?? null,
          computerToolsInstalled: session.computerToolsInstalled ?? false,
        }
      : {}),
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
    const settingsOption = yield* Effect.serviceOption(ServerSettingsService);
    const requireProjectProvider = (binding: ProviderRuntimeBinding) =>
      Effect.gen(function* () {
        if (Option.isNone(settingsOption)) return;
        const settings = yield* settingsOption.value.getSettings.pipe(
          Effect.mapError(
            () =>
              new ProviderTurnDeliveryError({
                certainty: "not_sent",
                retryable: false,
                detail: "Provider settings could not be read.",
              }),
          ),
        );
        if (
          !resolveProjectProviderInstanceEnabled(
            settings,
            binding.projectId,
            resolveBindingInstanceId(binding),
          )
        )
          return yield* new ProviderTurnDeliveryError({
            certainty: "not_sent",
            retryable: false,
            detail:
              "This provider is disabled for the project. Enable it or select another provider before sending.",
          });
      });

    let accepting = true;
    let nativePolling: Fiber.Fiber<unknown, never> | undefined;
    const ensureAccepting = Effect.suspend(() =>
      accepting
        ? Effect.void
        : Effect.fail(
            new ProviderTurnDeliveryError({
              certainty: "not_sent",
              retryable: true,
              detail: "The server is shutting down before provider work was sent.",
            }),
          ),
    );
    yield* registerShutdown("provider-admission", "admission", () =>
      Effect.gen(function* () {
        accepting = false;
        if (nativePolling) yield* Fiber.interrupt(nativePolling);
      }),
    );
    const workspaceGit = yield* Effect.serviceOption(GitCore);
    const workspaceSql = yield* Effect.serviceOption(SqlClient.SqlClient);
    const checkWorkspace = (
      threadId: ThreadId,
      sessionCwd?: string,
      options: { readonly allowBranchDrift?: boolean } = {},
    ) =>
      Effect.gen(function* () {
        if (Option.isNone(workspaceSql)) return;
        const switching =
          yield* workspaceSql.value`SELECT 1 FROM workspace_transitions WHERE thread_id = ${threadId}
          AND phase IN ('reserved','stopping','applying','applied','needs_recovery') LIMIT 1`;
        if (switching.length)
          return yield* Effect.fail(
            new Error("A workspace transition must be resolved before provider delivery."),
          );
        const rows = yield* workspaceSql.value<{
          worktreePath: string | null;
          scratchPath: string | null;
          branch: string | null;
          projectCwd: string | null;
          projectKind: string | null;
        }>`SELECT t.worktree_path AS "worktreePath", t.scratch_path AS "scratchPath", t.branch AS "branch", p.workspace_root AS "projectCwd", p.kind AS "projectKind" FROM projection_threads t LEFT JOIN projection_projects p ON p.project_id = t.project_id WHERE t.thread_id = ${threadId}`;
        const blocks = yield* workspaceSql.value<{
          token: string | null;
        }>`SELECT worktree_block_token AS token FROM next_turn_queue_state WHERE thread_id = ${threadId}`;
        if (blocks[0]?.token)
          return yield* Effect.fail(
            new Error("Workspace preparation must finish before provider delivery."),
          );
        const row = rows[0];
        // A thread without a project works only in its own folder, never the shared root.
        if (row?.projectKind === "scratch") {
          const scratchCwd = threadWorkspaceCwd(row, {
            kind: "scratch",
            cwd: row.projectCwd ?? "",
          });
          if (!scratchCwd)
            return yield* Effect.fail(new Error("This thread's folder is not ready yet."));
          if (
            sessionCwd !== undefined &&
            (yield* Effect.tryPromise(() => canonicalWorktreePath(sessionCwd))) !==
              (yield* Effect.tryPromise(() => canonicalWorktreePath(scratchCwd)))
          )
            return yield* Effect.fail(
              new Error(
                "The provider session is attached to a different folder. Restart the session before sending.",
              ),
            );
          return;
        }
        if (!row?.worktreePath) return;
        if (!row.projectCwd || Option.isNone(workspaceGit))
          return yield* Effect.fail(new Error("Workspace identity cannot be verified."));
        if (sessionCwd === undefined)
          return yield* Effect.fail(
            new Error("The provider session workspace cannot be verified."),
          );
        if (
          (yield* Effect.tryPromise(() => canonicalWorktreePath(sessionCwd))) !==
          (yield* Effect.tryPromise(() => canonicalWorktreePath(row.worktreePath!)))
        )
          return yield* Effect.fail(
            new Error(
              "The provider session is attached to a different workspace. Restart the session before sending.",
            ),
          );
        yield* assertWorktreeReady(
          workspaceGit.value,
          {
            projectCwd: row.projectCwd,
            worktreePath: row.worktreePath,
            branch: row.branch,
          },
          false,
          options,
        );
      }).pipe(
        Effect.mapError(
          (error) => new ProviderValidationError({ operation: "workspace", issue: error.message }),
        ),
      );

    const historyRuntimeId = randomUUID();
    const submissionTokens = new Map<ThreadId, symbol>();
    interface SubmissionCompletion {
      threadId: ThreadId;
      turnId: TurnId | undefined;
      terminalIds: Set<TurnId>;
      instanceId?: ProviderInstanceId;
      generation?: number;
      done: Deferred.Deferred<void, import("../Errors").ProviderServiceError>;
    }
    const submissionCompletions = new Map<symbol, SubmissionCompletion>();
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
    const computerAutomationBroker = yield* Effect.serviceOption(ComputerAutomationBroker);
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
    const unregisterFanout = registerProviderRuntimeFanout(() => PubSub.size(runtimeEventPubSub));
    yield* Effect.addFinalizer(() => Effect.sync(unregisterFanout));
    // The generation a session is being started as, published before the
    // adapter starts so requests it opens during startup carry the generation
    // that will own them, and can be answered without the start lock.
    const nativeSql = yield* Effect.serviceOption(SqlClient.SqlClient);
    const nativeCoordinator = Option.isSome(nativeSql)
      ? makeNativeOperationCoordinator(nativeOperationSqlRepository(nativeSql.value))
      : undefined;
    const startingSessions = new Map<
      ThreadId,
      {
        readonly generation: number;
        readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
        readonly session: ProviderSession;
      }
    >();
    const whileStarting = <A, E, R>(
      threadId: ThreadId,
      generation: number,
      adapter: ProviderAdapterShape<ProviderAdapterError>,
      workspace: Pick<ProviderSession, "cwd" | "runtimeMode" | "providerInstanceId">,
      effect: Effect.Effect<A, E, R>,
    ) => {
      const reserve = checkWorkspace(threadId, workspace.cwd).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const at = new Date().toISOString();
            startingSessions.set(threadId, {
              generation,
              adapter,
              session: {
                threadId,
                provider: adapter.provider,
                ...workspace,
                status: "connecting",
                createdAt: at,
                updatedAt: at,
              },
            });
          }),
        ),
      );
      return Effect.acquireUseRelease(
        workspace.cwd
          ? withWorktreeLifecycleLock(workspace.cwd, reserve).pipe(
              Effect.mapError(
                (error) =>
                  new ProviderValidationError({ operation: "workspace", issue: error.message }),
              ),
            )
          : reserve,
        () => effect,
        () => Effect.sync(() => startingSessions.delete(threadId)),
      );
    };

    const sessionEventIdentities = new Map<
      ThreadId,
      { instanceId: ProviderInstanceId; generation: number }
    >();
    const currentMcpIdentity = (threadId: ThreadId) => {
      const starting = startingSessions.get(threadId);
      return starting?.session.providerInstanceId
        ? { instanceId: starting.session.providerInstanceId, generation: starting.generation }
        : sessionEventIdentities.get(threadId);
    };
    // Legacy adapters are stamped at admission, never after waiting in the service queue.
    const stampRuntimeEventAtAdmission = (
      event: ProviderRuntimeEvent,
      source: ProviderInstanceId,
    ): ProviderRuntimeEvent => {
      const identity = currentMcpIdentity(event.threadId);
      if (!identity || identity.instanceId !== source) return event;
      if (event.type !== "mcp.status.updated")
        return event.sessionGeneration === undefined
          ? { ...event, sessionGeneration: identity.generation }
          : event;
      return {
        ...event,
        payload: {
          status: {
            ...event.payload.status,
            providerInstanceId: event.payload.status.providerInstanceId ?? source,
            sessionGeneration: event.payload.status.sessionGeneration ?? identity.generation,
          },
        },
      };
    };
    const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (event.type === "mcp.status.updated") {
          const identity = currentMcpIdentity(event.threadId);
          const stamp = event.payload.status;
          if (
            stamp.sessionGeneration !== undefined &&
            (!identity ||
              stamp.sessionGeneration !== identity.generation ||
              stamp.providerInstanceId !== identity.instanceId)
          )
            return;
        }
        if (canonicalEventLogger)
          yield* writeProviderEventLog(
            canonicalEventLogger,
            automationEventSanitizer.sanitize(event.threadId, event),
            null,
          );
        yield* PubSub.publish(runtimeEventPubSub, event);
      });

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
      directory
        .upsert({
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
        })
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (extra?.sessionGeneration !== undefined)
                sessionEventIdentities.set(threadId, {
                  instanceId:
                    session.providerInstanceId ??
                    defaultInstanceIdForDriver(ProviderDriverKind.make(session.provider)),
                  generation: extra.sessionGeneration,
                });
              if (session.status === "closed") sessionEventIdentities.delete(threadId);
            }),
          ),
        );

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
            if (
              event.sessionGeneration !== undefined &&
              event.sessionGeneration !== readPersistedSessionGeneration(binding.runtimePayload)
            )
              return;
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

    // Persistence outages must not remove the send fence. Only the matching
    // generation may inspect/acknowledge a marker held here until storage recovers.
    const incompleteHistoryFallbacks = new Map<
      ThreadId,
      {
        instanceId: ProviderInstanceId;
        generation: number;
        eventId: string;
      }
    >();
    const rememberIncompleteHistory = (
      threadId: ThreadId,
      marker: { instanceId: ProviderInstanceId; generation: number; eventId: string },
    ) => {
      const current = currentMcpIdentity(threadId);
      if (
        current &&
        (current.instanceId !== marker.instanceId ||
          (marker.generation >= 0 && current.generation !== marker.generation))
      )
        return;
      const previous = incompleteHistoryFallbacks.get(threadId);
      if (
        previous &&
        previous.instanceId === marker.instanceId &&
        previous.generation > marker.generation
      )
        return;
      incompleteHistoryFallbacks.set(threadId, marker);
    };
    const eventPersistenceRetry = { times: 2, schedule: Schedule.spaced("100 millis") };
    const requireHistoryReconciliation: NonNullable<
      ProviderServiceShape["requireHistoryReconciliation"]
    > = (event) =>
      Effect.gen(function* () {
        const instanceId =
          event.providerInstanceId ??
          currentMcpIdentity(event.threadId)?.instanceId ??
          ProviderInstanceId.make(event.provider);
        const generation =
          event.sessionGeneration ??
          currentMcpIdentity(event.threadId)?.generation ??
          (yield* nativeGeneration(event.threadId).pipe(Effect.orElseSucceed(() => -1)));
        rememberIncompleteHistory(event.threadId, {
          instanceId,
          generation,
          eventId: event.eventId,
        });
        const binding = Option.getOrUndefined(
          yield* directory.getBinding(event.threadId).pipe(Effect.retry(eventPersistenceRetry)),
        );
        const cursor = binding?.resumeCursor;
        const historyIdentity =
          isRecord(cursor) && typeof cursor.threadId === "string" ? cursor.threadId : null;
        const persisted = yield* directory
          .updateHistoryReconciliationIfCurrent({
            threadId: event.threadId,
            instanceId,
            generation,
            marker: { eventId: event.eventId, turnId: event.turnId ?? null, historyIdentity },
          })
          .pipe(Effect.retry(eventPersistenceRetry));
        if (persisted && incompleteHistoryFallbacks.get(event.threadId)?.eventId === event.eventId)
          incompleteHistoryFallbacks.delete(event.threadId);
      });
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
        carryPreparedComputerEvidence(item.event, event);
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
        const terminalGeneration =
          event.type === "turn.completed" ||
          event.type === "turn.aborted" ||
          event.type === "session.exited"
            ? (event.sessionGeneration ??
              currentMcpIdentity(event.threadId)?.generation ??
              (yield* nativeGeneration(event.threadId).pipe(Effect.orElseSucceed(() => -1))))
            : undefined;
        if ((event.type === "turn.completed" || event.type === "turn.aborted") && event.turnId) {
          for (const [id, completion] of submissionCompletions) {
            if (
              completion.threadId !== event.threadId ||
              completion.instanceId !== item.source.instanceId ||
              completion.instanceId !== event.providerInstanceId ||
              completion.generation !== terminalGeneration
            )
              continue;
            if (completion.turnId === event.turnId) {
              yield* Deferred.succeed(completion.done, undefined);
              submissionCompletions.delete(id);
            } else if (completion.turnId === undefined) {
              if (completion.terminalIds.size < 16) completion.terminalIds.add(event.turnId);
              else {
                yield* Deferred.fail(
                  completion.done,
                  toValidationError(
                    "ProviderService.submitTurn",
                    "Completion correlation buffer overflow; inspect provider history.",
                  ),
                );
                submissionCompletions.delete(id);
              }
            }
          }
        }
        if (event.type === "session.exited") {
          for (const [id, completion] of submissionCompletions) {
            if (
              completion.threadId !== event.threadId ||
              completion.instanceId !== item.source.instanceId ||
              completion.instanceId !== event.providerInstanceId ||
              completion.generation !== terminalGeneration
            )
              continue;
            yield* Deferred.succeed(completion.done, undefined);
            submissionCompletions.delete(id);
          }
        }
        if (event.type === "runtime.error" && event.payload.historyReconciliationRequired)
          yield* requireHistoryReconciliation(event).pipe(Effect.orDie);
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
          // Bounded retries preserve order during a brief outage. Persistent failure
          // becomes a visible, fenced recovery state and releases this lane.
          yield* options
            .recordTerminalEvent(event)
            .pipe(Effect.retry(eventPersistenceRetry), Effect.orDie);
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
            yield* processRuntimeEvent(next).pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
                return Effect.gen(function* () {
                  const generation =
                    next.event.sessionGeneration ??
                    currentMcpIdentity(threadId)?.generation ??
                    (yield* nativeGeneration(threadId).pipe(Effect.orElseSucceed(() => -1)));
                  const eventId = EventId.makeUnsafe(`${next.event.eventId}:persistence-failed`);
                  yield* Effect.logError(
                    "provider event persistence failed; history recovery required",
                    {
                      threadId,
                      eventId: next.event.eventId,
                      cause: Cause.pretty(cause),
                    },
                  );
                  const failure: ProviderRuntimeEvent = {
                    type: "runtime.error",
                    eventId,
                    threadId,
                    provider: next.source.provider,
                    providerInstanceId: next.source.instanceId,
                    ...(generation >= 0 ? { sessionGeneration: generation } : {}),
                    createdAt: new Date().toISOString(),
                    payload: {
                      message:
                        "Provider output could not be persisted. Review incomplete history before continuing.",
                      class: "transport_error",
                      historyReconciliationRequired: true,
                    },
                  };
                  yield* requireHistoryReconciliation(failure).pipe(
                    Effect.catchCause((persistCause) =>
                      Effect.logError(
                        "history recovery marker remains in memory until storage recovers",
                        { threadId, cause: Cause.pretty(persistCause) },
                      ),
                    ),
                  );
                  yield* publishRuntimeEvent(failure);
                });
              }),
              Effect.ensuring(laneBudget.release(1)),
            );
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
    let pendingRuntimeAdmissions = 0;
    const worker = Effect.forever(
      Queue.take(runtimeEventQueue).pipe(
        Effect.flatMap((item) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              pendingRuntimeAdmissions++;
            }),
            () => dispatchRuntimeEvent(item),
            () =>
              Effect.sync(() => {
                pendingRuntimeAdmissions--;
              }),
          ),
        ),
      ),
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
              event: stampRuntimeEventAtAdmission(event, instanceId),
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

    // Lock order: reactor turn gate, then this service gate. Never enter the reactor here.
    const withSessionOperation = makeOperationGate<ThreadId>();

    const assertControlTarget = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const expected = yield* ProviderControlTarget;
        if (!expected) return;
        const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        let matches =
          expected.threadId === threadId &&
          (binding?.provider ?? null) === expected.provider &&
          (binding ? resolveBindingInstanceId(binding) : null) === expected.instanceId &&
          (binding ? readPersistedSessionGeneration(binding.runtimePayload) : null) ===
            expected.generation;
        if (matches && binding && expected.activeTurnId !== null) {
          const adapter = yield* registry.getByInstance(resolveBindingInstanceId(binding));
          const sessions = yield* adapter.listSessions();
          matches = sessions.some(
            (session) =>
              session.threadId === threadId && session.activeTurnId === expected.activeTurnId,
          );
        }
        if (!matches)
          return yield* toValidationError(
            "ProviderService.control",
            "The provider session or turn changed before this action ran. The action was not sent.",
          );
      });
    const withControlTarget = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
      withProviderThreadAccess(
        threadId,
        assertControlTarget(threadId).pipe(Effect.andThen(effect)),
      );

    const recoverSessionForThread = (input: {
      readonly binding: ProviderRuntimeBinding;
      readonly operation: string;
      readonly fallbackActiveTurnId?: TurnId;
    }) =>
      Effect.gen(function* () {
        yield* requireProjectProvider(input.binding);
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
                .readEffectiveRuntimeConfig(input.binding.projectId)
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

        yield* Effect.try({
          try: () => {
            assertMcpRuntimeConfig(resumedProviderOptions?.mcpServers, input.binding.provider);
            if (input.binding.provider === "codex")
              readCodexMcpOAuthCallbackConfig(resumedProviderOptions?.mcpServers);
          },
          catch: (cause) => toValidationError(input.operation, mcpConfigErrorMessage(cause)),
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
        yield* checkWorkspace(input.binding.threadId, persistedCwd);
        if (persistedCwd) yield* ensureWorkspaceDirectory(persistedCwd);
        const resumedGeneration = readPersistedSessionGeneration(input.binding.runtimePayload) + 1;
        // Covers the binding write, as in startSession.
        const resumed = yield* whileStarting(
          input.binding.threadId,
          resumedGeneration,
          adapter,
          {
            cwd: persistedCwd,
            runtimeMode: recoveredRuntimeMode,
            providerInstanceId: bindingInstanceId,
          },
          Effect.gen(function* () {
            if (hasNativeOperationReservation(input.binding.threadId))
              return yield* toValidationError(
                input.operation,
                "A native operation is pending; session recovery is unavailable.",
              );
            yield* ensureAccepting;
            const resumed = yield* adapter.startSession({
              mcpEventIdentity: {
                providerInstanceId: bindingInstanceId,
                sessionGeneration: resumedGeneration,
              },
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
        withProviderAdmission(
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

    const resolveRoutableSessionUnlocked = (input: {
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

    const resolveRoutableSession = (input: Parameters<typeof resolveRoutableSessionUnlocked>[0]) =>
      resolveRoutableSessionUnlocked({ ...input, allowRecovery: false }).pipe(
        Effect.flatMap((routed) => {
          if (routed.isActive || !input.allowRecovery) return Effect.succeed(routed);
          // Only recovery mutates lifecycle state. Live controls remain usable during reconciliation.
          const { binding: _binding, ...request } = input;
          return withSessionOperation(input.threadId, resolveRoutableSessionUnlocked(request));
        }),
      );

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

    // Resolve physical identity only while updating, including aliases added during the update.
    const withProviderAdmission =
      (stateDir: string, instanceId: string, operation: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          let installKey: string | undefined;
          if (hasProviderUpdate(stateDir) && instanceId) {
            const info = yield* registry.getInstanceInfo(ProviderInstanceId.make(instanceId));
            const target = yield* Effect.try({
              try: () => info.resolveInstallTarget?.(),
              catch: () =>
                toValidationError(
                  operation,
                  "Could not identify this installation while a provider update is running. Try again after it finishes.",
                ),
            });
            if (info.resolveInstallTarget && !target)
              return yield* toValidationError(
                operation,
                "Could not identify this installation while a provider update is running. Try again after it finishes.",
              );
            installKey = target?.installKey;
          }
          return yield* effect.pipe(
            withAccountAdmission(stateDir, instanceId, operation, installKey),
          );
        });

    const startSession: ProviderServiceShape["startSession"] = (threadId, rawInput) =>
      Effect.gen(function* () {
        yield* ensureAccepting;
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

        yield* Effect.try({
          try: () => assertMcpRuntimeConfig(parsed.providerOptions?.mcpServers),
          catch: (cause) =>
            toValidationError("ProviderService.startSession", mcpConfigErrorMessage(cause)),
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
            (resolvedProvider === "grok" ||
              resolvedProvider === "antigravity" ||
              resolvedProvider === "muse") &&
            parsed.workflowExecutionProfile?.endsWith("readonly")
          ) {
            return yield* toValidationError(
              "ProviderService.startSession",
              `${PROVIDER_DISPLAY_NAMES[resolvedProvider]} cannot enforce read-only workflow turns.`,
            );
          }
          if (parsed.provider !== undefined && parsed.provider !== resolvedProvider) {
            return yield* toValidationError(
              "ProviderService.startSession",
              `Provider instance '${requestedInstanceId}' belongs to driver '${resolvedProvider}', not '${parsed.provider}'.`,
            );
          }
          const enabledForProject = Option.isSome(settingsOption)
            ? resolveProjectProviderInstanceEnabled(
                yield* settingsOption.value.getSettings.pipe(
                  Effect.mapError(() =>
                    toValidationError(
                      "ProviderService.startSession",
                      "Provider settings could not be read.",
                    ),
                  ),
                ),
                parsed.projectId,
                requestedInstanceId,
              )
            : instanceInfo.enabled;
          if (!enabledForProject) {
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
                  .readEffectiveRuntimeConfig(input.projectId)
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
          yield* Effect.try({
            try: () => {
              assertMcpRuntimeConfig(adapterInput.providerOptions?.mcpServers, resolvedProvider);
              if (resolvedProvider === "codex")
                readCodexMcpOAuthCallbackConfig(adapterInput.providerOptions?.mcpServers);
            },
            catch: (cause) =>
              toValidationError("ProviderService.startSession", mcpConfigErrorMessage(cause)),
          });
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
          yield* checkWorkspace(threadId, adapterInput.cwd);
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
            {
              cwd: adapterInput.cwd,
              runtimeMode: adapterInput.runtimeMode,
              providerInstanceId: requestedInstanceId,
            },
            Effect.gen(function* () {
              yield* ensureAccepting;
              const session = yield* adapter.startSession({
                ...adapterInput,
                mcpEventIdentity: { providerInstanceId: requestedInstanceId, sessionGeneration },
              });
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
          withProviderAdmission(
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
                    withProviderAdmission(
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
              withProviderAdmission(
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
          .pipe(
            withProviderAdmission(
              serverConfig.stateDir,
              routed.instanceId,
              "ProviderService.nativeOperation",
            ),
            Effect.mapError(nativeError),
          );
        if (!background) return yield* execution;
        yield* execution.pipe(
          Effect.tap((record) => Deferred.succeed(admitted, record)),
          Effect.catch((error) => Deferred.fail(admitted, error)),
          Effect.forkIn(nativeScope),
        );
        return yield* Deferred.await(admitted);
      });
    const nativeOperations: NonNullable<ProviderServiceShape["nativeOperations"]> = {
      historyRecovery: (input) =>
        withProviderThreadAccess(
          input.threadId,
          withSessionOperation(
            input.threadId,
            Effect.gen(function* () {
              const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
              if (!binding) return null;
              const instanceId = resolveBindingInstanceId(binding);
              const generation = readPersistedSessionGeneration(binding.runtimePayload);
              const durable = readIncompleteHistory(binding.runtimePayload);
              const fallback = incompleteHistoryFallbacks.get(input.threadId);
              const marker =
                fallback?.instanceId === instanceId &&
                (fallback.generation === generation || fallback.generation < 0)
                  ? fallback
                  : durable;
              if (!marker) return null;
              const current = { instanceId, generation, eventId: marker.eventId };
              if (input.action === "inspect") return current;
              if (
                input.expected?.instanceId !== instanceId ||
                input.expected.generation !== generation ||
                input.expected.eventId !== marker.eventId
              )
                return yield* nativeError(
                  "The provider history changed. Review the current recovery warning before continuing.",
                );
              // Explicit acceptance never resumes/resends the interrupted turn. Stop
              // its source before releasing the matching incomplete-history fence.
              yield* stopSessionUnlocked({ threadId: input.threadId });
              // Source draining can admit another failure while stop is awaited.
              // Accept only the history the user inspected, retaining newer fences.
              const stopped = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
              const stoppedDurable = readIncompleteHistory(stopped?.runtimePayload);
              const stoppedFallback = incompleteHistoryFallbacks.get(input.threadId);
              if (
                !stopped ||
                resolveBindingInstanceId(stopped) !== instanceId ||
                readPersistedSessionGeneration(stopped.runtimePayload) !== generation ||
                (stoppedDurable &&
                  stoppedDurable.eventId !== marker.eventId &&
                  stoppedDurable.eventId !== durable?.eventId) ||
                (stoppedFallback?.instanceId === instanceId &&
                  stoppedFallback.generation === generation &&
                  stoppedFallback.eventId !== marker.eventId)
              )
                return yield* nativeError(
                  "Provider history changed while stopping. Review recovery again.",
                );
              if (stoppedDurable) {
                const cleared = yield* directory.updateHistoryReconciliationIfCurrent({
                  threadId: input.threadId,
                  instanceId,
                  generation,
                  marker: null,
                  expectedMarkerId: stoppedDurable.eventId,
                });
                if (!cleared)
                  return yield* nativeError("The provider session changed during recovery.");
              }
              const adapter = yield* registry.getByInstance(instanceId);
              yield* (
                adapter.acknowledgeHistoryReconciliation?.(input.threadId, marker.eventId) ??
                  Effect.void
              );
              if (incompleteHistoryFallbacks.get(input.threadId)?.eventId === marker.eventId)
                incompleteHistoryFallbacks.delete(input.threadId);
              return null;
            }),
          ),
        ).pipe(Effect.mapError(nativeError)),
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

    const sendTurn = (
      rawInput: Parameters<ProviderServiceShape["sendTurn"]>[0],
      onPrepared: (instanceId: ProviderInstanceId, generation: number) => void = () => {},
    ) =>
      Effect.gen(function* () {
        yield* ensureAccepting;
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
        const submissionToken = Symbol("provider-submission");
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
        if (Option.isSome(binding)) yield* requireProjectProvider(binding.value);
        const instanceId = Option.isSome(binding) ? resolveBindingInstanceId(binding.value) : "";
        let metricProvider = "unknown";
        let metricModel = input.model;
        return yield* Effect.gen(function* () {
          const { routed, nativeAttachments, resolvedAttachments, generation, token } =
            yield* withProviderThreadAccess(
              input.threadId,
              Effect.gen(function* () {
                const routed = yield* resolveRoutableSession({
                  threadId: input.threadId,
                  operation: "ProviderService.sendTurn",
                  allowRecovery:
                    input.expectedTurnId === undefined && input.continuationRequestId === undefined,
                  binding,
                });
                metricProvider = routed.adapter.provider;
                if (
                  (routed.adapter.provider === "grok" ||
                    routed.adapter.provider === "antigravity" ||
                    routed.adapter.provider === "muse") &&
                  input.workflowExecutionProfile?.endsWith("readonly")
                ) {
                  return yield* toValidationError(
                    "ProviderService.sendTurn",
                    `${PROVIDER_DISPLAY_NAMES[routed.adapter.provider]} cannot enforce read-only workflow turns.`,
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
                if (limitError)
                  return yield* toValidationError("ProviderService.sendTurn", limitError);
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
                const generation = yield* nativeGeneration(input.threadId);
                onPrepared(routed.instanceId, generation);
                if (input.expectedTurnId === undefined) {
                  if (submissionTokens.has(input.threadId))
                    return yield* new ProviderTurnDeliveryError({
                      certainty: "not_sent",
                      retryable: true,
                      detail: "An earlier submission still owns this thread.",
                    });
                  submissionTokens.set(input.threadId, submissionToken);
                }
                return {
                  routed,
                  nativeAttachments,
                  resolvedAttachments,
                  generation,
                  token: submissionToken,
                };
              }),
            );
          const deliveryAttempt = yield* DeliveryAttemptContext;
          let nativeHistoryIdentity: string | null = null;
          if (deliveryAttempt) {
            const baseline = yield* routed.adapter
              .readThread(input.threadId)
              .pipe(Effect.catchCause(() => Effect.succeed(null)));
            nativeHistoryIdentity = baseline?.history?.identity ?? null;
            yield* deliveryAttempt.prepared(
              baseline
                ? {
                    ...baseline,
                    history: baseline.history
                      ? {
                          ...baseline.history,
                          runtimeId:
                            baseline.history.provenance === "runtime-local"
                              ? `${historyRuntimeId}:${generation}`
                              : null,
                        }
                      : {
                          identity: null,
                          provenance: "unavailable",
                          coverage: "unavailable",
                          boundary: null,
                          runtimeId: null,
                        },
                  }
                : null,
            );
            const stillCurrent = yield* withProviderThreadAccess(
              input.threadId,
              nativeGeneration(input.threadId),
            );
            if (
              stillCurrent !== generation ||
              (input.expectedTurnId === undefined && submissionTokens.get(input.threadId) !== token)
            )
              return yield* new ProviderTurnDeliveryError({
                certainty: "not_sent",
                retryable: false,
                detail: "The provider session changed before dispatch.",
              });
          }
          const deliveryBinding = yield* directory.getBinding(input.threadId);
          if (
            Option.isNone(deliveryBinding) ||
            readPersistedSessionGeneration(deliveryBinding.value.runtimePayload) !== generation
          )
            return yield* new ProviderTurnDeliveryError({
              certainty: "not_sent",
              retryable: false,
              detail: "The provider session changed before dispatch.",
            });
          const fallback = incompleteHistoryFallbacks.get(input.threadId);
          if (
            readIncompleteHistory(deliveryBinding.value.runtimePayload) ||
            (fallback?.instanceId === resolveBindingInstanceId(deliveryBinding.value) &&
              (fallback.generation === generation || fallback.generation < 0))
          )
            return yield* new ProviderTurnDeliveryError({
              certainty: "not_sent",
              retryable: false,
              detail:
                "Provider output is incomplete. Review history recovery before starting another turn.",
            });
          yield* checkWorkspace(
            input.threadId,
            Option.isSome(deliveryBinding)
              ? readPersistedCwd(deliveryBinding.value.runtimePayload)
              : undefined,
            { allowBranchDrift: input.expectedTurnId !== undefined },
          ).pipe(
            Effect.mapError(
              (error) =>
                new ProviderTurnDeliveryError({
                  certainty: "not_sent",
                  retryable: false,
                  detail: error.message,
                }),
            ),
          );
          yield* requireProjectProvider(deliveryBinding.value);
          yield* ensureAccepting;
          const turn = yield* (
            input.expectedTurnId !== undefined
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
                })
          ).pipe(
            Effect.mapError((error) =>
              Schema.is(ProviderAdapterRequestError)(error) && error.deliveryCertainty
                ? new ProviderTurnDeliveryError({
                    certainty: error.deliveryCertainty,
                    retryable:
                      error.deliveryCertainty === "not_sent" && error.deliveryRetryable === true,
                    detail: error.detail,
                    ...(error.usageLimit ? { usageLimit: error.usageLimit } : {}),
                  })
                : error,
            ),
          );
          if (deliveryAttempt)
            yield* deliveryAttempt.accepted(turn, {
              runtimeGeneration: generation,
              nativeHistoryIdentity,
            });
          return yield* withProviderThreadAccess(
            input.threadId,
            Effect.gen(function* () {
              const persistedBinding = yield* directory.getBinding(input.threadId);
              if (
                Option.isNone(persistedBinding) ||
                readPersistedSessionGeneration(persistedBinding.value.runtimePayload) !==
                  generation ||
                (input.expectedTurnId === undefined &&
                  submissionTokens.get(input.threadId) !== token)
              ) {
                return yield* new ProviderTurnDeliveryError({
                  certainty: "unknown",
                  retryable: false,
                  detail: "The provider session changed while dispatching this turn.",
                });
              }
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
                  activeTurnId: routed.adapter.capabilities.turnCompletionOnReturn
                    ? null
                    : turn.turnId,
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
            }),
          );
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (submissionTokens.get(input.threadId) === submissionToken)
                submissionTokens.delete(input.threadId);
            }),
          ),
          withProviderAdmission(serverConfig.stateDir, instanceId, "ProviderService.sendTurn"),
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

    const stopSessionUnlocked: ProviderServiceShape["stopSession"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.stopSession",
          schema: ProviderStopSessionInput,
          payload: rawInput,
        });
        let metricProvider = "unknown";
        return yield* Effect.gen(function* () {
          const computerGeneration = Option.isSome(computerAutomationBroker)
            ? computerAutomationBroker.value.generation(input.threadId)
            : undefined;
          const releaseControls = Effect.gen(function* () {
            if (Option.isSome(previewAutomationBroker))
              yield* previewAutomationBroker.value.releaseThread(input.threadId);
            if (Option.isSome(computerAutomationBroker) && computerGeneration)
              computerAutomationBroker.value.releaseSession(input.threadId, computerGeneration);
          });
          const binding = yield* directory.getBinding(input.threadId);
          if (Option.isNone(binding) && !startingSessions.has(input.threadId)) {
            yield* releaseControls;
            submissionTokens.delete(input.threadId);
            for (const [id, completion] of submissionCompletions)
              if (completion.threadId === input.threadId) {
                yield* Deferred.succeed(completion.done, undefined);
                submissionCompletions.delete(id);
              }
            return;
          }
          const routed = yield* resolveRoutableSessionUnlocked({
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
          if (routed.isActive)
            yield* routed.adapter
              .stopSession(routed.threadId)
              .pipe(Effect.ensuring(releaseControls));
          else yield* releaseControls;
          submissionTokens.delete(input.threadId);
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
          for (const [id, completion] of submissionCompletions)
            if (completion.threadId === input.threadId) {
              yield* Deferred.succeed(completion.done, undefined);
              submissionCompletions.delete(id);
            }
          sessionEventIdentities.delete(input.threadId);
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

    const stopSession: ProviderServiceShape["stopSession"] = (input) =>
      withSessionOperation(input.threadId, stopSessionUnlocked(input));

    const replaceSession: ProviderServiceShape["replaceSession"] = (threadId, input, expected) =>
      withProviderThreadAccess(
        threadId,
        withSessionOperation(
          threadId,
          Effect.gen(function* () {
            const current = Option.getOrUndefined(yield* directory.getBinding(threadId));
            if (
              !current ||
              resolveBindingInstanceId(current) !== expected.instanceId ||
              readPersistedSessionGeneration(current.runtimePayload) !== expected.generation
            )
              return null;
            yield* stopSessionUnlocked({ threadId });
            return yield* startSession(threadId, input);
          }),
        ),
      );

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
        const activeSessions: ProviderSession[] = sessionsByProvider.flatMap(
          (sessions) => sessions,
        );
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

    const getCapabilities: ProviderServiceShape["getCapabilities"] = (provider, instanceId) =>
      (instanceId ? registry.getByInstance(instanceId) : registry.getByProvider(provider)).pipe(
        Effect.flatMap((adapter) =>
          adapter.provider === provider
            ? Effect.succeed(adapter.capabilities)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        ),
      );

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

    const withLiveMcpApps = <A, E>(
      threadId: ThreadId,
      run: (
        apps: NonNullable<
          import("../Services/ProviderAdapter.ts").ProviderAdapterShape<
            import("../Errors.ts").ProviderAdapterError
          >["mcpApps"]
        >,
      ) => Effect.Effect<A, E>,
    ) =>
      withProviderThreadAccess(
        threadId,
        Effect.gen(function* () {
          const routed = yield* resolveRoutableSession({
            threadId,
            operation: "ProviderService.mcpApps",
            allowRecovery: false,
          });
          if (!routed.isActive || routed.adapter.provider !== "codex" || !routed.adapter.mcpApps)
            return yield* toValidationError("McpApps", "Send a message to reconnect.");
          return yield* run(routed.adapter.mcpApps);
        }),
      );
    const mcpApps: NonNullable<ProviderServiceShape["mcpApps"]> = {
      identity: (threadId) => withLiveMcpApps(threadId, (apps) => apps.identity(threadId)),
      listTools: (input) => withLiveMcpApps(input.threadId, (apps) => apps.listTools(input)),
      callTool: (input) => withLiveMcpApps(input.threadId, (apps) => apps.callTool(input)),
      readResource: (input) => withLiveMcpApps(input.threadId, (apps) => apps.readResource(input)),
    };

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
        const originBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        const origin = {
          instanceId: originBinding
            ? resolveBindingInstanceId(originBinding)
            : defaultInstanceIdForDriver(ProviderDriverKind.make(routed.adapter.provider)),
          generation: readPersistedSessionGeneration(originBinding?.runtimePayload),
        };
        const snapshot = yield* routed.adapter.readThread(routed.threadId);
        return {
          ...snapshot,
          history: snapshot.history
            ? {
                ...snapshot.history,
                origin,
                runtimeId:
                  snapshot.history.provenance === "runtime-local"
                    ? `${historyRuntimeId}:${yield* nativeGeneration(threadId)}`
                    : null,
              }
            : {
                identity: null,
                origin,
                provenance: "unavailable" as const,
                coverage: "unavailable" as const,
                boundary: null,
                runtimeId: null,
              },
        };
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
        yield* ensureAccepting;
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
          withProviderAdmission(
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

    const hasLiveMcpSession = (binding: ProviderRuntimeBinding) =>
      registry.getByInstance(resolveBindingInstanceId(binding)).pipe(
        Effect.flatMap((adapter) => adapter.hasSession(binding.threadId)),
        Effect.orElseSucceed(() => false),
      );
    const readMcpScopeBindings = (input: {
      projectId: ProjectId;
      provider: ProviderKind;
      instanceId?: ProviderInstanceId | undefined;
    }) =>
      directory
        .listBindingsByProject(input.projectId)
        .pipe(
          Effect.map((bindings) =>
            bindings.filter(
              (binding) =>
                binding.provider === input.provider &&
                binding.status === "running" &&
                (!input.instanceId || resolveBindingInstanceId(binding) === input.instanceId),
            ),
          ),
        );

    /** Live sessions, preferring the desired config version, then the most recently seen. */
    const listLiveMcpSessions = (input: {
      projectId: ProjectId;
      provider: ProviderKind;
      instanceId?: ProviderInstanceId | undefined;
      desiredVersion?: string | undefined;
    }) =>
      Effect.gen(function* () {
        const bindings = yield* readMcpScopeBindings(input).pipe(
          Effect.flatMap((bindings) => Effect.filter(bindings, hasLiveMcpSession)),
        );
        const sessions: McpSessionSummary[] = bindings
          .map((binding) => ({
            threadId: binding.threadId,
            instanceId: resolveBindingInstanceId(binding),
            generation: readPersistedSessionGeneration(binding.runtimePayload),
            lastSeenAt: binding.lastSeenAt,
            busy: Boolean(
              binding.runtimePayload &&
              typeof binding.runtimePayload === "object" &&
              "activeTurnId" in binding.runtimePayload &&
              binding.runtimePayload.activeTurnId,
            ),
            ...(binding.mcpEffectiveConfigVersion
              ? { appliedVersion: binding.mcpEffectiveConfigVersion }
              : {}),
            ...(readPersistedUnconvergedMcpConfigVersion(binding.runtimePayload)
              ? {
                  unconvergedVersion: readPersistedUnconvergedMcpConfigVersion(
                    binding.runtimePayload,
                  )!,
                }
              : {}),
          }))
          .toSorted(
            (a, b) =>
              Number(b.appliedVersion === input.desiredVersion) -
                Number(a.appliedVersion === input.desiredVersion) ||
              b.lastSeenAt.localeCompare(a.lastSeenAt),
          );
        return sessions;
      });

    const readMcpSessionStatuses: NonNullable<ProviderServiceShape["readMcpSessionStatuses"]> = (
      input,
    ) =>
      Effect.gen(function* () {
        const sessions = yield* listLiveMcpSessions(input);
        const selected = input.threadId
          ? sessions.find((session) => session.threadId === input.threadId)
          : sessions[0];
        if (input.threadId && !selected)
          return yield* toValidationError(
            "mcp.status",
            "The conversation is not running in this project and account.",
          );
        if (!selected) return { sessions };
        const matches = (binding: ProviderRuntimeBinding | undefined) =>
          binding?.projectId === input.projectId &&
          binding.provider === input.provider &&
          binding.status === "running" &&
          resolveBindingInstanceId(binding) === selected.instanceId &&
          readPersistedSessionGeneration(binding.runtimePayload) === selected.generation;
        const adapter = yield* withSessionOperation(
          selected.threadId,
          Effect.gen(function* () {
            const binding = Option.getOrUndefined(yield* directory.getBinding(selected.threadId));
            if (!matches(binding))
              return yield* toValidationError(
                "mcp.status",
                "The MCP observation was superseded. Refresh to observe the current session.",
              );
            return yield* registry.getByInstance(selected.instanceId);
          }),
        );
        if (!adapter.getMcpServerStatuses)
          return {
            sessions,
            selected,
            observation: {
              servers: [],
              complete: false,
              omissions: ["This provider runtime cannot report MCP status."],
              capabilities: { tools: false, inputSchemas: false, resources: false },
            },
          };
        // Never hold the lifecycle gate across read I/O; replacement must remain possible.
        const observation = yield* adapter.getMcpServerStatuses(selected.threadId);
        yield* withSessionOperation(
          selected.threadId,
          Effect.gen(function* () {
            const binding = Option.getOrUndefined(yield* directory.getBinding(selected.threadId));
            if (
              !matches(binding) ||
              (binding?.mcpEffectiveConfigVersion ?? undefined) !== selected.appliedVersion
            )
              return yield* toValidationError(
                "mcp.status",
                "The MCP observation was superseded. Refresh to observe the current session.",
              );
          }),
        );
        return { sessions, selected, observation };
      });

    const getMcpReconnectTargets: NonNullable<ProviderServiceShape["getMcpReconnectTargets"]> = (
      input,
    ) =>
      Effect.gen(function* () {
        const bindings = yield* readMcpScopeBindings(input);
        if (
          input.threadIds?.some(
            (threadId) => !bindings.some((binding) => binding.threadId === threadId),
          )
        )
          return yield* toValidationError(
            "mcp.reconnect",
            "Every conversation must be running in the selected project and account.",
          );
        const targets: ThreadId[] = [];
        const failures: Array<{ threadId: ThreadId; message: string }> = [];
        for (const binding of bindings) {
          if (input.threadIds && !input.threadIds.includes(binding.threadId)) continue;
          const result = yield* Effect.gen(function* () {
            const adapter = yield* registry.getByInstance(resolveBindingInstanceId(binding));
            if (!(yield* adapter.hasSession(binding.threadId)))
              return yield* toValidationError(
                "mcp.reconnect",
                "This conversation no longer has a running provider session; it will connect when a session starts.",
              );
            const owned = adapter.getOwnedMcpServerNames
              ? yield* adapter.getOwnedMcpServerNames(binding.threadId)
              : [];
            return resolveOwnedMcpServerName(owned, input.serverName, input.provider);
          }).pipe(Effect.result);
          if (result._tag === "Failure")
            failures.push({ threadId: binding.threadId, message: result.failure.message });
          else if (result.success) targets.push(binding.threadId);
        }
        return { threadIds: targets, failures };
      });

    const reconnectMcpServerForProject: NonNullable<
      ProviderServiceShape["reconnectMcpServerForProject"]
    > = (input) =>
      Effect.gen(function* () {
        const bindings = yield* readMcpScopeBindings(input);
        if (
          input.threadIds?.some(
            (threadId) => !bindings.some((binding) => binding.threadId === threadId),
          )
        )
          return yield* toValidationError(
            "mcp.reconnect",
            "Every conversation must be running in the selected project and account.",
          );
        const targets = bindings.filter(
          (binding) =>
            (!input.threadIds || input.threadIds.includes(binding.threadId)) &&
            !input.excludeThreadIds?.includes(binding.threadId),
        );
        const failures: Array<{ threadId: ThreadId; message: string }> = [];
        let matched = 0;
        let reconnected = 0;
        const sessions: McpSessionReloadOutcome[] = [];
        yield* Effect.forEach(
          targets,
          (target) =>
            Effect.gen(function* () {
              const result = yield* withSessionOperation(
                target.threadId,
                Effect.gen(function* () {
                  const current = Option.getOrUndefined(
                    yield* directory.getBinding(target.threadId),
                  );
                  if (
                    !current ||
                    current.status !== "running" ||
                    current.projectId !== input.projectId ||
                    current.provider !== input.provider ||
                    resolveBindingInstanceId(current) !== resolveBindingInstanceId(target) ||
                    readPersistedSessionGeneration(current.runtimePayload) !==
                      readPersistedSessionGeneration(target.runtimePayload)
                  )
                    return yield* toValidationError(
                      "mcp.reconnect",
                      "The session was replaced before reconnect.",
                    );
                  const adapter = yield* registry.getByInstance(resolveBindingInstanceId(target));
                  if (!(yield* adapter.hasSession(target.threadId)))
                    return yield* toValidationError(
                      "mcp.reconnect",
                      "This conversation no longer has a running provider session; it will connect when a session starts.",
                    );
                  const owned = adapter.getOwnedMcpServerNames
                    ? yield* adapter.getOwnedMcpServerNames(target.threadId)
                    : [];
                  // External names are passed exactly; the adapter verifies ownership itself.
                  const serverName =
                    resolveOwnedMcpServerName(owned, input.serverName, input.provider) ??
                    (input.allowExternal ? input.serverName : undefined);
                  if (!adapter.reconnectMcpServer || !serverName) return false;
                  const result = yield* adapter
                    .reconnectMcpServer({
                      threadId: target.threadId,
                      serverName,
                      ...(input.allowExternal ? { allowExternal: true } : {}),
                    })
                    .pipe(Effect.timeoutOption("10 seconds"));
                  if (Option.isNone(result))
                    return yield* toValidationError(
                      "mcp.reconnect",
                      "MCP reconnect timed out. Try Reconnect again or stop the conversation.",
                    );
                  return result.value;
                }),
              ).pipe(Effect.result);
              if (result._tag === "Failure" || result.success)
                sessions.push({
                  threadId: target.threadId,
                  instanceId: resolveBindingInstanceId(target),
                  generation: readPersistedSessionGeneration(target.runtimePayload),
                  requestedVersion: target.mcpEffectiveConfigVersion ?? "",
                  attemptedVersion: target.mcpEffectiveConfigVersion ?? "",
                  disposition: result._tag === "Failure" ? "failed" : "applied",
                  result: {
                    converged: result._tag === "Success",
                    restartRequired: false,
                    servers: [],
                    errors:
                      result._tag === "Failure"
                        ? [{ server: input.serverName, message: result.failure.message }]
                        : [],
                  },
                });
              if (result._tag === "Failure") {
                matched++;
                failures.push({ threadId: target.threadId, message: result.failure.message });
              } else if (result.success) {
                matched++;
                reconnected++;
              }
            }),
          { concurrency: 4 },
        );
        return {
          settingsConnectionReloaded: false,
          sessionsMatched: matched,
          sessionsReconnected: reconnected,
          failures,
          sessions,
        };
      });

    const getLiveMcpSession: NonNullable<ProviderServiceShape["getLiveMcpSession"]> = (input) =>
      listLiveMcpSessions(input).pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );

    const authenticateMcpServerForProject: NonNullable<
      ProviderServiceShape["authenticateMcpServerForProject"]
    > = (input) =>
      Effect.gen(function* () {
        const sessions = yield* listLiveMcpSessions(input);
        const selected = input.threadId
          ? sessions.find((session) => session.threadId === input.threadId)
          : sessions[0];
        if (!selected)
          return yield* toValidationError(
            "mcp.authenticate",
            input.threadId
              ? "The conversation is not running in this project and account."
              : "Start a conversation in this project to sign in to MCP servers.",
          );
        return yield* withSessionOperation(
          selected.threadId,
          Effect.gen(function* () {
            const binding = Option.getOrUndefined(yield* directory.getBinding(selected.threadId));
            if (
              !binding ||
              binding.status !== "running" ||
              binding.projectId !== input.projectId ||
              binding.provider !== input.provider ||
              resolveBindingInstanceId(binding) !== selected.instanceId ||
              readPersistedSessionGeneration(binding.runtimePayload) !== selected.generation
            )
              return yield* toValidationError(
                "mcp.authenticate",
                "The session was replaced before sign-in. Try again.",
              );
            const adapter = yield* registry.getByInstance(selected.instanceId);
            if (!adapter.authenticateMcpServer)
              return yield* toValidationError(
                "mcp.authenticate",
                "This provider does not support MCP sign-in from a conversation.",
              );
            const result = yield* adapter
              .authenticateMcpServer({
                threadId: selected.threadId,
                serverName: input.serverName,
              })
              .pipe(Effect.timeoutOption("30 seconds"));
            if (Option.isNone(result))
              return yield* toValidationError(
                "mcp.authenticate",
                "MCP sign-in did not start in time. Try again.",
              );
            return {
              ...result.value,
              threadId: selected.threadId,
              instanceId: selected.instanceId,
              generation: selected.generation,
            };
          }),
        );
      });

    // A newer reconciliation supersedes sleeping retries even within the same generation.
    const mcpReloadAttempts = new Map<ThreadId, symbol>();
    const reloadMcpConfigForProject: ProviderServiceShape["reloadMcpConfigForProject"] = (input) =>
      Effect.gen(function* () {
        const bindings = yield* directory.listBindingsByProject(input.projectId);
        const matchingBindings = bindings.filter(
          (binding) =>
            binding.provider === input.provider &&
            binding.status !== "stopped" &&
            (!input.instanceId || resolveBindingInstanceId(binding) === input.instanceId) &&
            (!input.threadIds || input.threadIds.includes(binding.threadId)) &&
            (input.instanceId !== undefined ||
              !input.providerOptions ||
              getProviderEnvironmentKey(
                binding.provider,
                readPersistedProviderOptions(binding.runtimePayload),
              ) === getProviderEnvironmentKey(binding.provider, input.providerOptions)),
        );
        const reloadSession = (
          selected: ProviderRuntimeBinding,
        ): Effect.Effect<ReadonlyArray<McpSessionReloadOutcome>, ProviderServiceError> => {
          const token = Symbol("mcp-reload");
          const instanceId = resolveBindingInstanceId(selected);
          const generation = readPersistedSessionGeneration(selected.runtimePayload);
          const emptyResult: McpReloadResult = {
            converged: false,
            restartRequired: false,
            servers: [],
            errors: [],
          };
          const base = {
            threadId: selected.threadId,
            instanceId,
            generation,
            requestedVersion: input.requestedVersion ?? "",
            attemptedVersion: "",
          };
          const isCurrent = (binding: ProviderRuntimeBinding | undefined) =>
            binding !== undefined &&
            binding.status !== "stopped" &&
            binding.projectId === input.projectId &&
            binding.provider === input.provider &&
            resolveBindingInstanceId(binding) === instanceId &&
            readPersistedSessionGeneration(binding.runtimePayload) === generation;
          return Effect.gen(function* () {
            const prepared = yield* withSessionOperation(
              selected.threadId,
              Effect.gen(function* () {
                const current = Option.getOrUndefined(
                  yield* directory.getBinding(selected.threadId),
                );
                if (!isCurrent(current))
                  return {
                    sessions: [
                      { ...base, disposition: "superseded" as const, result: emptyResult },
                    ],
                  };
                const adapter = Option.getOrUndefined(
                  yield* registry.getByInstance(instanceId).pipe(Effect.option),
                );
                if (!adapter?.reloadMcpConfig) return { sessions: [] };
                const config = yield* projectMcpConfigService
                  .readEffectiveRuntimeConfig(input.projectId)
                  .pipe(Effect.result);
                if (config._tag === "Failure")
                  return {
                    sessions: [
                      {
                        ...base,
                        disposition: "failed" as const,
                        result: {
                          ...emptyResult,
                          errors: [{ message: mcpConfigErrorMessage(config.failure) }],
                        },
                      },
                    ],
                  };
                // Capture once; never replace this snapshot during a backoff window.
                const snapshot = {
                  ...config.success,
                  servers: structuredClone(config.success.servers),
                };
                const metadata = {
                  ...base,
                  requestedVersion: input.requestedVersion ?? snapshot.effectiveVersion,
                  attemptedVersion: snapshot.effectiveVersion,
                };
                const valid = yield* Effect.try({
                  try: () => {
                    assertMcpRuntimeConfig(snapshot.servers, input.provider);
                    if (input.provider === "codex")
                      readCodexMcpOAuthCallbackConfig(snapshot.servers);
                  },
                  catch: mcpConfigErrorMessage,
                }).pipe(Effect.result);
                if (valid._tag === "Failure")
                  return {
                    sessions: [
                      {
                        ...metadata,
                        disposition: "failed" as const,
                        result: { ...emptyResult, errors: [{ message: valid.failure }] },
                      },
                    ],
                  };
                if (!(yield* adapter.hasSession(selected.threadId))) return { sessions: [] };
                mcpReloadAttempts.set(selected.threadId, token);
                return { metadata, snapshot, reload: adapter.reloadMcpConfig };
              }),
            );
            if ("sessions" in prepared) return prepared.sessions;
            const { metadata, snapshot, reload } = prepared;
            const stillCurrent = Effect.gen(function* () {
              const binding = Option.getOrUndefined(yield* directory.getBinding(selected.threadId));
              return mcpReloadAttempts.get(selected.threadId) === token && isCurrent(binding);
            });
            const reloadOnce = () =>
              withSessionOperation(
                selected.threadId,
                Effect.gen(function* () {
                  if (!(yield* stillCurrent)) return null;
                  return yield* reload({
                    threadId: selected.threadId,
                    mcpServers: snapshot.servers,
                  }).pipe(
                    Effect.map((result) => ({ result, reached: true })),
                    Effect.catch((error) =>
                      Effect.succeed({
                        reached: false,
                        result: {
                          ...emptyResult,
                          errors: [
                            { message: error.message.trim() || "The MCP reload request failed." },
                          ],
                        },
                      }),
                    ),
                  );
                }),
              );
            let outcome = yield* reloadOnce();
            if (!outcome)
              return [{ ...metadata, disposition: "superseded" as const, result: emptyResult }];
            const delays =
              input.retry === false ? [] : (input.retryDelaysMs ?? MCP_RELOAD_RETRY_DELAYS_MS);
            for (const delay of delays) {
              if (outcome.result.converged || outcome.result.restartRequired) break;
              // Stop, replacement, recovery, and turn delivery can proceed while we wait.
              yield* Effect.sleep(Duration.millis(delay));
              const retried = yield* reloadOnce();
              if (!retried)
                return [
                  { ...metadata, disposition: "superseded" as const, result: outcome.result },
                ];
              outcome = retried;
            }
            const { result, reached } = outcome;
            return yield* withSessionOperation(
              selected.threadId,
              Effect.gen(function* () {
                if (!(yield* stillCurrent))
                  return [{ ...metadata, disposition: "superseded" as const, result }];
                const committed = yield* directory.updateMcpStateIfCurrent({
                  threadId: selected.threadId,
                  instanceId,
                  generation,
                  ...(reached && !result.restartRequired
                    ? { effectiveVersion: snapshot.effectiveVersion }
                    : {}),
                  unconvergedVersion: result.converged ? null : snapshot.effectiveVersion,
                });
                if (!committed)
                  return [{ ...metadata, disposition: "superseded" as const, result }];
                if (result.errors.length > 0 && (input.warn !== false || result.restartRequired)) {
                  yield* publishRuntimeEvent({
                    type: "runtime.warning",
                    eventId: EventId.makeUnsafe(randomUUID()),
                    provider: selected.provider,
                    threadId: selected.threadId,
                    createdAt: new Date().toISOString(),
                    payload: {
                      category: "provider",
                      message: describeMcpReloadFailure(result),
                      actionable: !result.restartRequired,
                    },
                  });
                }
                return [
                  {
                    ...metadata,
                    result,
                    disposition: result.restartRequired
                      ? ("restart-required" as const)
                      : result.converged
                        ? ("applied" as const)
                        : ("failed" as const),
                  },
                ];
              }),
            );
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (mcpReloadAttempts.get(selected.threadId) === token)
                  mcpReloadAttempts.delete(selected.threadId);
              }),
            ),
          );
        };
        const sessions = yield* Effect.forEach(matchingBindings, reloadSession, { concurrency: 4 });
        return { sessions: sessions.flat() };
      });

    const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
    const markRestartTurns = Effect.gen(function* () {
      if (Option.isNone(settingsOption) || Option.isNone(sqlOption)) return;
      const settings = yield* settingsOption.value.getSettings;
      const sql = sqlOption.value;
      yield* captureRestartTurnMarkers({
        sessions: yield* listSessions(),
        bindings: yield* directory.listBindings(),
        settings,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    });

    const runStopAll = () =>
      Effect.gen(function* () {
        const bindings = yield* directory.listBindings();
        const currentAdapters = yield* getAdapterEntries;
        const stopFailures: unknown[] = [];
        yield* markRestartTurns.pipe(
          Effect.catchCause((cause) =>
            Effect.logError("failed to mark active turns for restart", {
              cause: Cause.pretty(cause),
            }),
          ),
          Effect.ensuring(
            Effect.forEach(
              currentAdapters,
              ([instanceId, adapter]) =>
                adapter.stopAll().pipe(
                  Effect.catchCause((cause) => {
                    if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
                    stopFailures.push(cause);
                    return Effect.logWarning("provider stop incomplete", { instanceId, cause });
                  }),
                ),
              { concurrency: "unbounded", discard: true },
            ),
          ),
        );
        // Stopped rows stay for their resume cursors, so long-lived installs hold
        // thousands. Only rewrite the ones this shutdown actually stops.
        yield* Effect.forEach(
          bindings.filter((binding) => !isSettledBinding(binding)),
          (binding) =>
            directory.upsert({
              threadId: binding.threadId,
              provider: binding.provider,
              providerInstanceId: resolveBindingInstanceId(binding),
              status: "stopped",
              runtimePayload: {
                lastRuntimeEvent: "provider.stopAll",
                lastRuntimeEventAt: new Date().toISOString(),
              },
            }),
        ).pipe(Effect.asVoid);
        submissionTokens.clear();
        sessionEventIdentities.clear();
        for (const completion of submissionCompletions.values())
          yield* Deferred.succeed(completion.done, undefined);
        submissionCompletions.clear();
        yield* analytics.record("provider.sessions.stopped_all", {
          sessionCount: bindings.length,
        });
        yield* analytics.flush;
        if (stopFailures.length > 0)
          return yield* new ProviderValidationError({
            operation: "ProviderService.stopAll",
            issue: `${stopFailures.length} provider shutdown operation(s) did not finish.`,
            cause: new AggregateError(stopFailures, "Provider shutdown incomplete"),
          });
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
      nativePolling = yield* nativeCoordinator.reconcile(checkNativeOperation).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Native operation reconciliation failed", { cause }),
        ),
        Effect.repeat(Schedule.spaced("30 seconds")),
        Effect.forkIn(nativeScope),
      );
    }
    const shutdown = yield* Effect.serviceOption(ServerShutdown);
    yield* registerShutdown("providers", "producers", () => runStopAll());
    yield* registerShutdown("provider-event-delivery", "drain", () =>
      Effect.gen(function* () {
        // Producers have closed and finished preparation. Let adapter subscriptions
        // hand off their final queued events, then wait for both admission and lanes.
        let idlePasses = 0;
        while (idlePasses < 2) {
          yield* Effect.sleep("1 millis");
          const pending = yield* Queue.size(runtimeEventQueue);
          const fanout = yield* PubSub.size(runtimeEventPubSub);
          idlePasses =
            pending <= 0 && pendingRuntimeAdmissions === 0 && lanes.size === 0 && fanout === 0
              ? idlePasses + 1
              : 0;
        }
      }),
    );
    yield* Effect.addFinalizer(() =>
      Effect.catch(
        Option.isSome(shutdown) && shutdown.value.started ? Effect.void : runStopAll(),
        (cause) => Effect.logWarning("failed to stop provider service", { cause }),
      ).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            submissionTokens.clear();
            sessionEventIdentities.clear();
            for (const completion of submissionCompletions.values())
              yield* Deferred.fail(
                completion.done,
                toValidationError(
                  "ProviderService.submitTurn",
                  "Provider service shut down before completion.",
                ),
              );
            submissionCompletions.clear();
          }),
        ),
      ),
    );

    const submitTurn: NonNullable<ProviderServiceShape["submitTurn"]> = (input) =>
      Effect.gen(function* () {
        if (!accepting) {
          const rejected = Effect.fail(
            new ProviderTurnDeliveryError({
              certainty: "not_sent",
              retryable: true,
              detail: "The server is shutting down before provider work was sent.",
            }),
          );
          return { acceptance: rejected, completion: rejected };
        }
        const acceptance = yield* Deferred.make<
          import("@t3tools/contracts").ProviderTurnStartResult,
          import("../Errors").ProviderServiceError
        >();
        const completion = yield* Deferred.make<void, import("../Errors").ProviderServiceError>();
        const id = Symbol("owned-submission");
        const state: SubmissionCompletion = {
          threadId: input.threadId,
          turnId: undefined,
          terminalIds: new Set<TurnId>(),
          done: completion,
        };
        submissionCompletions.set(id, state);
        yield* Effect.forkIn(
          Effect.gen(function* () {
            const result = yield* Effect.exit(
              sendTurn(input, (instanceId, generation) => {
                state.instanceId = instanceId;
                state.generation = generation;
              }),
            );
            yield* Deferred.done(acceptance, result);
            if (result._tag === "Failure") {
              yield* Deferred.failCause(completion, result.cause);
              submissionCompletions.delete(id);
              return;
            }
            state.turnId = result.value.turnId;
            if (state.terminalIds.has(result.value.turnId)) {
              yield* Deferred.succeed(completion, undefined);
              submissionCompletions.delete(id);
            }
          }),
          nativeScope,
        );
        return { acceptance: Deferred.await(acceptance), completion: Deferred.await(completion) };
      });

    const acknowledgeHistoryReconciliation: NonNullable<
      ProviderServiceShape["acknowledgeHistoryReconciliation"]
    > = (input) =>
      withProviderThreadAccess(
        input.threadId,
        Effect.gen(function* () {
          const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
          const marker = readIncompleteHistory(binding?.runtimePayload);
          if (
            !binding ||
            !marker ||
            marker.eventId !== input.markerId ||
            marker.historyIdentity !== input.historyIdentity
          )
            return false;
          const cleared = yield* directory.updateHistoryReconciliationIfCurrent({
            threadId: input.threadId,
            instanceId: input.instanceId,
            generation: input.generation,
            marker: null,
            expectedMarkerId: input.markerId,
          });
          if (cleared) {
            const adapter = yield* registry.getByInstance(input.instanceId);
            yield* (
              adapter.acknowledgeHistoryReconciliation?.(input.threadId, input.markerId) ??
                Effect.void
            );
          }
          return cleared;
        }),
      );

    return {
      requireHistoryReconciliation,
      acknowledgeHistoryReconciliation,
      getStartingSessionIdentity: (threadId) => {
        const starting = startingSessions.get(threadId);
        return starting?.session.providerInstanceId
          ? { instanceId: starting.session.providerInstanceId, generation: starting.generation }
          : undefined;
      },
      nativeOperations,
      renameThread,
      replaceSession,
      startSession: (threadId, input) =>
        withProviderThreadAccess(
          threadId,
          withSessionOperation(threadId, startSession(threadId, input)),
        ),
      submitTurn,
      sendTurn: (input) => submitTurn(input).pipe(Effect.flatMap((handle) => handle.acceptance)),
      interruptTurn: (input) => withControlTarget(input.threadId, interruptTurn(input)),
      respondToRequest: (input) => withControlTarget(input.threadId, respondToRequest(input)),
      respondToUserInput: (input) => withControlTarget(input.threadId, respondToUserInput(input)),
      respondToElicitation: (input) =>
        Effect.suspend(() => {
          // The start holds the thread lock until the adapter returns, so a
          // request opened during startup is answered without it.
          const starting = startingSessions.get(input.threadId);
          return starting && starting.generation === input.generation
            ? respondToStartingElicitation(input, starting.adapter)
            : withProviderThreadAccess(input.threadId, respondToElicitation(input));
        }),
      stopSession: (input) => withControlTarget(input.threadId, stopSession(input)),
      listStartingWorkspaces: () =>
        Effect.sync(() =>
          Array.from(startingSessions, ([threadId, { session }]) => ({
            threadId,
            ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
          })),
        ),
      listSessions,
      getCapabilities,
      getSessionCapabilities,
      assertSessionAction,
      mcpApps,
      readThread: (threadId) => withProviderThreadAccess(threadId, readThread(threadId)),
      rollbackConversation: (input) =>
        withProviderThreadAccess(input.threadId, rollbackConversation(input)),
      runOneOffPrompt,
      compactConversation,
      reloadMcpConfigForProject,
      readMcpSessionStatuses,
      getMcpReconnectTargets,
      reconnectMcpServerForProject,
      authenticateMcpServerForProject,
      getLiveMcpSession,
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
