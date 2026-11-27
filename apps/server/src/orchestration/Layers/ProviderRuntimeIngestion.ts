import { timeOrderedUuid } from "@t3tools/shared/ids";
import { recoverRestartBackgroundWork } from "../../nextTurnQueue/restartMarkerCapture.ts";
import { commandCreatesPullRequest, detectCreatedPullRequest } from "@t3tools/shared/sourceControl";
import { LosslessCommandAdmission } from "../commandAdmission.ts";
import { startTerminalReceiptRetries } from "../terminalReceiptRecovery.ts";
import { PerformanceStageProbe } from "../../observability/Metrics.ts";
import { registerShutdown, AcceptedShutdownWork } from "../../shutdown.ts";
import { tryWithProviderThreadAccess } from "../../provider/providerThreadAccess.ts";
import { readPersistedSessionGeneration } from "../../provider/sessionCapabilities.ts";
import { redactProviderFailureText } from "../../provider/failureText.ts";
import { ACP_HIDDEN_TOOL_INPUTS_DETAIL } from "../../provider/acp/AcpReadOnlyWorkflowPolicy.ts";
import { CodexMcpEventBus } from "../../codex/CodexMcpEventBus.ts";
import { isPreparedComputerEvent } from "../../provider/prepareAutomationRuntimeEvent";
import { codexMessagePresentation } from "@t3tools/shared/codexMessagePresentation";
import {
  COALESCE_STREAMING_DELTAS_DRIVERS,
  makeStreamingAssistantDeltas,
} from "../streamingAssistantDeltas.ts";
import { automationEventSanitizer } from "@t3tools/shared/automationActivitySanitizer";
import { ComputerAutomationBroker } from "../../computer/ComputerAutomationBroker";
import { parseCodexTryAgainAt } from "../../provider/codexErrors.ts";
import { UsageService } from "../../usage/Services/UsageService.ts";
import { resolveAccountUsageLimit } from "../../provider/usageLimitMessages.ts";
import { toOrchestrationUsageLimit } from "../providerTerminalLifecycle.ts";
import { ServerSettingsService } from "../../serverSettings";
import { ForgeAccounts } from "../../sourceControl/accountRouting";
import { readProjectSettings } from "../../project/projectSettings";
import { createHash } from "node:crypto";
import * as NodeFs from "node:fs/promises";

import { ServerConfig } from "../../config.ts";
import { resolveAttachmentRelativePath } from "../../attachmentPaths.ts";
import {
  ApprovalRequestId,
  type AssistantDeliveryMode,
  CommandId,
  ProviderInstanceId,
  ProviderExtensionStatuses,
  EventId,
  MessageId,
  OrchestrationCommandExecutionId,
  type OrchestrationCommandExecutionStatus,
  type OrchestrationReadModel,
  OrchestrationFileChangeId,
  type OrchestrationFileChangeStatus,
  type OrchestrationProposedPlanId,
  ProviderItemId,
  CheckpointRef,
  isToolLifecycleItemType,
  ThreadId,
  TurnId,
  USAGE_ASIDE_TURN_ID_PREFIX,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import {
  Cache,
  Cause,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Schedule,
  ServiceMap,
  Stream,
  Schema,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { enqueueBackgroundWork, makeBackgroundWorker } from "../../backgroundWorker.ts";
import { isBlockingUserInput } from "@t3tools/shared/pendingUserInputs";
import { reconcileElicitationsOnStartup } from "../elicitationSubmission.ts";
import { REASONING_STATUS_ACTIVITY_KIND } from "@t3tools/shared/orchestrationActivityPayload";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { ThreadCommandExecutionQuery } from "../Services/ThreadCommandExecutionQuery.ts";
import {
  isOrphanedSessionExitEvent,
  makeOrphanedSessionExitedEvent,
  PROVIDER_SHUTDOWN_RUNTIME_EVENTS,
  readPersistedActiveTurnId,
  readPersistedLastRuntimeEvent,
  readPersistedLastRuntimeEventAt,
} from "../../provider/orphanedTurnRecovery.ts";
import {
  readIncompleteHistory,
  readPersistedInstructionContext,
} from "../../provider/runtimePayload.ts";
import {
  readConfiguredModelContextWindowTokens,
  resolveModelContextWindowTokens,
} from "../../provider/modelContextWindowMetadata.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProviderTerminalEventRepositoryLive } from "../../persistence/Layers/ProviderTerminalEvents.ts";
import {
  isProviderTerminalRuntimeEvent,
  ProviderTerminalEventRepository,
} from "../../persistence/Services/ProviderTerminalEvents.ts";
import { resolveThreadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";
import { isGitRepository } from "../../git/isRepo.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import { reconcileCodexThreadSnapshots } from "../codexSnapshotReconciliation.ts";
import { commandExecutionIdForRuntimeItem } from "../commandExecutionIds.ts";
import { isSupersedableToolUpdate, makeToolUpdateCoalescer } from "../toolUpdateCoalescing.ts";
import { truncateMiddleByBytes } from "../outputTruncation.ts";
import {
  extractToolResultImages,
  ingestToolResultImage,
  type ToolResultImageRef,
} from "../toolResultImages.ts";
import { validateThreadTaskTracking, validateThreadTasks } from "../threadTasks.ts";
import {
  abandonPendingTaskToolCalls,
  discardTaskToolCall,
  reduceTaskToolLifecycle,
  type TaskToolLifecycleInput,
} from "@t3tools/shared/claudeTaskToolProjection";
import { ThreadBackgroundWork } from "../Services/ThreadBackgroundWork.ts";
import { increment, providerProjectionWriteFailuresTotal } from "../../observability/Metrics.ts";
import {
  extractTurnCompletedContextTokens,
  makeCompletedTurnUsageFact,
  makeTurnCompletedSessionSetCommand,
  mergeProviderReportedContextTokens,
  providerCommandId,
  retainIncompleteHistoryError,
  runtimeTurnErrorMessage,
  runtimeTurnState,
} from "../providerTerminalLifecycle.ts";

import {
  sameSessionCapabilities,
  providerTurnKey,
  isPermanentDispatchRejection,
  isPermanentDispatchError,
  reasoningStatusActivityId,
  restoreReasoningStatusEntry,
  eventSessionSequence,
  DEFAULT_ASSISTANT_DELIVERY_MODE,
  TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
  TURN_MESSAGE_IDS_BY_TURN_TTL,
  BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
  BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
  BUFFERED_REASONING_TEXT_BY_TURN_KEY_CACHE_CAPACITY,
  BUFFERED_REASONING_TEXT_BY_TURN_KEY_TTL,
  BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
  BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
  LAST_THINKING_TOKENS_BY_THREAD_CACHE_CAPACITY,
  LAST_THINKING_TOKENS_BY_THREAD_TTL,
  REASONING_STATUS_BY_TURN_KEY_CACHE_CAPACITY,
  REASONING_STATUS_BY_TURN_KEY_TTL,
  REASONING_SECTION_BY_TURN_KEY_CACHE_CAPACITY,
  REASONING_SECTION_BY_TURN_KEY_TTL,
  REASONING_TOKENS_BY_TURN_KEY_CACHE_CAPACITY,
  REASONING_TOKENS_BY_TURN_KEY_TTL,
  REASONING_HEADING_SCAN_CHARS,
  REASONING_HEADING_REGEX,
  THINKING_TOKENS_DISPATCH_THRESHOLD,
  contextTokensDispatchThreshold,
  currentPendingContextTokens,
  PROFILED_WORKFLOW_TURN_TIMEOUT_MS,
  MAX_TRACKED_TOOL_UPDATES,
  MAX_BUFFERED_ASSISTANT_CHARS,
  MAX_BUFFERED_REASONING_CHARS,
  COMMAND_OUTPUT_FLUSH_INTERVAL_MS,
  COMMAND_OUTPUT_BUFFER_FLUSH_BYTES,
  MAX_FILE_CHANGE_OUTPUT_BYTES,
  FILE_CHANGE_OUTPUT_HEAD_BYTES,
  FILE_CHANGE_OUTPUT_TRUNCATION_MARKER,
  FILE_CHANGE_OUTPUT_TRUNCATE_THRESHOLD_BYTES,
  STRICT_PROVIDER_LIFECYCLE_GUARD,
  appendPullRequestCreateOutput,
  clearCommandExecutionFlushTimer,
  laterIsoTimestamp,
  toTurnId,
  sameId,
  normalizeProposedPlanMarkdown,
  capBufferedReasoningText,
  proposedPlanIdForTurn,
  proposedPlanIdFromEvent,
  asString,
  asRecord,
  extractThreadTokenUsageContextTokens,
  nextResumeCursorFromThreadStartedEvent,
  normalizeLifecycleCommandExecutionTitle,
  extractRawCommandExecutionCommand,
  extractCommandExecutionCommand,
  extractCommandExecutionCwd,
  extractCommandExecutionDescription,
  extractCommandExecutionExitCode,
  commandExecutionStatusFromLifecycleEvent,
  fileChangeIdForRuntimeItem,
  fileChangeStatusFromLifecycleEvent,
  extractFileChangePreview,
  extractUnknownStructuredFileChangeKinds,
  synthesizeStructuredFileChangePatch,
  resolvedFileChangePatch,
  runtimeErrorMessageFromEvent,
  orchestrationSessionStatusFromRuntimeState,
  taskToolLifecycleInput,
  MAX_TASK_TOOL_ARTIFACT_BYTES,
  attachmentIdBelongsToThread,
  isDiscardedTaskToolTurn,
  extractTodoWriteTasksFromLifecycleEvent,
  areTaskListsEqual,
  runtimeEventToActivities,
  type ReasoningStatusEntry,
  type PendingReasoningTokens,
  type ReasoningSection,
  type PendingContextTokens,
  type TurnStartRequestedDomainEvent,
  type RuntimeIngestionInput,
  type OpenCommandExecutionState,
  type PendingCommandExecutionOutputState,
  type PendingFileChangeState,
  type ToolImageRefs,
} from "../ingestion/runtimeIngestionHelpers.ts";

export { contextTokensDispatchThreshold, runtimeEventToActivities };

/**
 * How long a provider gets to settle a read-only workflow turn after F5 failed and interrupted
 * it. One that is still running afterwards (Cursor once kept working ~40s) has its session
 * stopped, so nothing else is produced for a stage that already failed. Tests shorten it.
 */
export const ProfiledFailureStopGraceMs = ServiceMap.Reference<number>(
  "f5/orchestration/ProfiledFailureStopGraceMs",
  { defaultValue: () => 10_000 },
);
/** Lifecycle error id that marks a turn F5 failed under a read-only workflow profile. */
const PROFILED_FAILURE_ERROR_ID_PREFIX = "workflow-profile-failure:";
const profiledFailureErrorId = (turnId: TurnId) => `${PROFILED_FAILURE_ERROR_ID_PREFIX}${turnId}`;
/**
 * How long recording a profile failure waits for the provider to acknowledge the interrupt.
 * Tests shorten it.
 */
export const ProfiledFailureInterruptTimeout = ServiceMap.Reference<Duration.Duration>(
  "f5/orchestration/ProfiledFailureInterruptTimeout",
  { defaultValue: () => Duration.seconds(5) },
);
/**
 * Request details quoted in profile-violation messages are redacted, then cut to this many
 * characters: redacting first keeps a credential near the start from surviving the cut.
 */
const PROFILE_VIOLATION_DETAIL_CHARS = 320;
const PROFILE_VIOLATION_DETAIL_TAIL_CHARS = 140;
const profileViolationDetail = (detail: string | undefined): string => {
  const trimmed = detail ? redactProviderFailureText(detail).trim() : "";
  if (!trimmed) return "";
  if (trimmed.length <= PROFILE_VIOLATION_DETAIL_CHARS) return trimmed;
  // A refusal reads `<command> (<reason>)`: keep the end, so a long command still says why.
  const tail = trimmed.slice(-PROFILE_VIOLATION_DETAIL_TAIL_CHARS);
  return `${trimmed.slice(0, PROFILE_VIOLATION_DETAIL_CHARS - PROFILE_VIOLATION_DETAIL_TAIL_CHARS)}…${tail}`;
};
/**
 * What makes two refused requests "the same operation": the request type and what was asked,
 * as the adapter recorded it (`<command> (<reason>)`). Undefined when the detail doesn't say
 * what was asked: refused computer-control requests all carry one fixed text, and three
 * different ones are not a model stuck on one operation.
 */
const autoDeclinedOperationKey = (
  requestType: string,
  detail: string | undefined,
): string | undefined =>
  !detail?.trim() || detail === ACP_HIDDEN_TOOL_INPUTS_DETAIL
    ? undefined
    : `${requestType}\n${detail}`;

const make = Effect.gen(function* () {
  const probe = yield* PerformanceStageProbe;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const forgeAccounts = yield* Effect.serviceOption(ForgeAccounts);
  const providerService = yield* ProviderService;
  const usageService = yield* Effect.serviceOption(UsageService);
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);
  const ingestionScope = yield* Effect.scope;
  const mcpEventBus = yield* Effect.serviceOption(CodexMcpEventBus);
  const pendingMcpPushes = new Map<
    string,
    Set<import("@t3tools/contracts").ProviderInstanceId | null>
  >();
  // Last tool.updated activity appended per open tool item. Providers such as OpenCode resend
  // the whole tool state on every part update, so a repeat that matches it is not stored again.
  const lastToolUpdates = new Map<string, string>();
  const recordToolUpdate = (trackingKey: string, signature: string) => {
    lastToolUpdates.delete(trackingKey);
    lastToolUpdates.set(trackingKey, signature);
    if (lastToolUpdates.size > MAX_TRACKED_TOOL_UPDATES)
      lastToolUpdates.delete(lastToolUpdates.keys().next().value!);
  };
  // Tool updates wait briefly so a chatty call appends only its newest state. Every other
  // event for the thread flushes them first, so the completion still follows the last update.
  const toolUpdateCoalescingEnabled = process.env.F5_COALESCE_TOOL_UPDATES !== "false";
  let enqueueToolUpdateFlush: ((threadId: ThreadId) => void) | null = null;
  const pendingToolUpdates = makeToolUpdateCoalescer<{
    readonly event: ProviderRuntimeEvent;
    readonly activity: OrchestrationThreadActivity;
    readonly trackingKey: string;
    readonly signature: string;
  }>({ onWindowClosed: (threadId) => enqueueToolUpdateFlush?.(threadId) });
  const flushToolUpdates = (threadId: ThreadId) =>
    Effect.forEach(
      pendingToolUpdates.take(threadId),
      (update) =>
        orchestrationEngine
          .dispatch({
            type: "thread.activity.append",
            commandId: providerCommandId(
              update.event,
              `thread-activity-append:${update.activity.id}`,
            ),
            threadId,
            activity: update.activity,
            createdAt: update.activity.createdAt,
          })
          .pipe(
            // Recorded only after the append succeeds, so a retried event is not skipped.
            Effect.tap(() =>
              Effect.sync(() => recordToolUpdate(update.trackingKey, update.signature)),
            ),
            // The superseded states were never stored, so a lost append needs a history repair.
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("failed to append coalesced tool update", {
                    threadId,
                    activityId: update.activity.id,
                    cause: Cause.pretty(cause),
                  }).pipe(
                    Effect.andThen(
                      providerService.requireHistoryReconciliation?.(update.event) ?? Effect.void,
                    ),
                    Effect.catchCause((markCause) =>
                      Effect.logError("could not persist incomplete provider history marker", {
                        eventId: update.event.eventId,
                        cause: Cause.pretty(markCause),
                      }),
                    ),
                  ),
            ),
          ),
      { discard: true },
    );
  const flushAllToolUpdates = Effect.suspend(() =>
    Effect.forEach(pendingToolUpdates.threadIds(), flushToolUpdates, { discard: true }),
  );
  // Runtime error and terminal reports share one refresh, without blocking the serial worker.
  const MAX_TRACKED_USAGE_FAILURE_THREADS = 1_024;
  const refreshedUsageFailures = new Map<ThreadId, string>();
  const rememberRefreshedUsageFailure = (threadId: ThreadId, key: string): void => {
    refreshedUsageFailures.delete(threadId);
    refreshedUsageFailures.set(threadId, key);
    if (refreshedUsageFailures.size > MAX_TRACKED_USAGE_FAILURE_THREADS) {
      const oldest = refreshedUsageFailures.keys().next().value;
      if (oldest !== undefined) refreshedUsageFailures.delete(oldest);
    }
  };
  let enqueueResolvedUsageLimit: (input: RuntimeIngestionInput) => Effect.Effect<void> = () =>
    Effect.void;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const threadCommandExecutionQuery = yield* ThreadCommandExecutionQuery;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const providerTerminalEventRepository = yield* ProviderTerminalEventRepository;
  const threadBackgroundWork = yield* ThreadBackgroundWork;
  const computerAutomationBroker = yield* Effect.serviceOption(ComputerAutomationBroker);
  const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
  const imageStorage = {
    config: yield* Effect.serviceOption(ServerConfig),
    sql: sqlOption,
    fileSystem: yield* Effect.serviceOption(FileSystem.FileSystem),
    path: yield* Effect.serviceOption(Path.Path),
  };

  /**
   * Tool results can carry base64 screenshots. Before the lifecycle event is compacted
   * into an activity, they are moved into the attachment registry (owned by the activity)
   * and the event keeps only a scrubbed result, so durable activities never hold image
   * bytes and compaction cannot serialize them into `mcpResult`.
   */
  const extractLifecycleImages = (
    threadId: ThreadId,
    event: ProviderRuntimeEvent,
    interactionMode?: string,
  ): Effect.Effect<{ readonly event: ProviderRuntimeEvent; readonly images?: ToolImageRefs }> => {
    if (
      (event.type !== "item.started" &&
        event.type !== "item.updated" &&
        event.type !== "item.completed") ||
      event.payload.data === undefined
    ) {
      return Effect.succeed({
        event: automationEventSanitizer.sanitize(threadId, event) as ProviderRuntimeEvent,
      });
    }
    const extraction = extractToolResultImages(event.payload.data);
    // Register provenance on the whole event before deciding whether its images persist.
    automationEventSanitizer.sanitize(threadId, event);
    const omitComputerImages =
      interactionMode === "plan" &&
      (automationEventSanitizer.isComputerItem(threadId, event.itemId ?? event.eventId) ||
        event.payload.mcpImages !== undefined ||
        event.payload.mcpImagesOmitted !== undefined);
    const preparedRefs = event.payload.mcpImages ?? [];
    const preparedOmitted =
      (event.payload.mcpImagesOmitted ?? 0) + (omitComputerImages ? preparedRefs.length : 0);
    const preparedImages: ToolImageRefs = {
      ...(!omitComputerImages && preparedRefs.length ? { mcpImages: preparedRefs } : {}),
      ...(preparedOmitted ? { mcpImagesOmitted: preparedOmitted } : {}),
    };
    if (extraction.images.length === 0 && extraction.omitted === 0) {
      return Effect.succeed({
        event: automationEventSanitizer.sanitize(threadId, event) as ProviderRuntimeEvent,
        images: preparedImages,
      });
    }
    return Effect.gen(function* () {
      const refs: ToolResultImageRef[] = [...(preparedImages.mcpImages ?? [])];
      let omitted = extraction.omitted + (preparedImages.mcpImagesOmitted ?? 0);
      const { config, sql, fileSystem, path } = imageStorage;
      for (const image of extraction.images) {
        if (
          omitComputerImages ||
          Option.isNone(config) ||
          Option.isNone(sql) ||
          Option.isNone(fileSystem) ||
          Option.isNone(path)
        ) {
          omitted += 1;
          continue;
        }
        const ref = yield* ingestToolResultImage({
          attachmentsDir: config.value.attachmentsDir,
          threadId,
          itemKey: event.itemId ?? event.eventId,
          // Lifecycle activities are keyed by their event id.
          activityId: event.eventId,
          image,
        }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql.value),
          Effect.provideService(FileSystem.FileSystem, fileSystem.value),
          Effect.provideService(Path.Path, path.value),
          Effect.catchCause(() => Effect.succeed(null)),
        );
        if (ref) refs.push(ref);
        else omitted += 1;
      }
      return {
        event: automationEventSanitizer.sanitize(threadId, {
          ...event,
          payload: {
            ...event.payload,
            data: automationEventSanitizer.sanitize(threadId, extraction.scrubbed),
          },
        }) as ProviderRuntimeEvent,
        images: {
          ...(refs.length > 0 ? { mcpImages: refs } : {}),
          ...(omitted > 0 ? { mcpImagesOmitted: omitted } : {}),
        },
      };
    });
  };
  const profiledTurnWatchdogs = new Map<
    ThreadId,
    { readonly turnId: TurnId; readonly timer: ReturnType<typeof setTimeout> }
  >();

  /**
   * Per-turn count of `user-input.requested` events auto-declined in an
   * unattended stage. A single question is a recoverable mistake, but a model
   * that keeps re-asking after each empty answer would otherwise loop until the
   * 30-minute watchdog fires, writing durable activities and burning tokens the
   * whole time (`maxCostUsd` is only checked at stage entry).
   */
  const MAX_TRACKED_UNATTENDED_DECLINE_THREADS = 1_024;
  const unattendedDeclineCounts = new Map<ThreadId, { readonly turnId: TurnId; count: number }>();
  const MAX_UNATTENDED_DECLINES_PER_TURN = 3;

  const clearProfiledTurnWatchdog = (threadId: ThreadId, turnId?: TurnId) =>
    Effect.sync(() => {
      const existing = profiledTurnWatchdogs.get(threadId);
      if (!existing || (turnId !== undefined && existing.turnId !== turnId)) return;
      clearTimeout(existing.timer);
      profiledTurnWatchdogs.delete(threadId);
    });

  /** Records an auto-declined question and returns the running count for the turn. */
  const countUnattendedDecline = (threadId: ThreadId, turnId: TurnId) =>
    Effect.sync(() => {
      const existing = unattendedDeclineCounts.get(threadId);
      const next = existing && existing.turnId === turnId ? existing.count + 1 : 1;
      unattendedDeclineCounts.delete(threadId);
      unattendedDeclineCounts.set(threadId, { turnId, count: next });
      if (unattendedDeclineCounts.size > MAX_TRACKED_UNATTENDED_DECLINE_THREADS) {
        // Never evict a counter belonging to a still-running profiled turn;
        // only evict completed/stale entries whose watchdog is no longer active.
        for (const [candidateThreadId, entry] of unattendedDeclineCounts) {
          if (candidateThreadId === threadId) continue;
          const activeWatchdog = profiledTurnWatchdogs.get(candidateThreadId);
          if (!activeWatchdog || activeWatchdog.turnId !== entry.turnId) {
            unattendedDeclineCounts.delete(candidateThreadId);
            if (unattendedDeclineCounts.size <= MAX_TRACKED_UNATTENDED_DECLINE_THREADS) break;
          }
        }
      }
      return next;
    });

  const clearUnattendedDeclines = (threadId: ThreadId, turnId?: TurnId) =>
    Effect.sync(() => {
      const existing = unattendedDeclineCounts.get(threadId);
      if (!existing || (turnId !== undefined && existing.turnId !== turnId)) return;
      unattendedDeclineCounts.delete(threadId);
    });

  /**
   * Per-turn count of operations an adapter already refused under a read-only profile
   * (`request.opened` with `autoDeclined`). Nothing ran and the model was told no, so a refusal is
   * recoverable: a model that then tries something else keeps going. The turn fails when the
   * model is stuck, asking for the same refused operation again and again, or when it has been
   * refused so often that it is plainly not doing read-only work.
   */
  const autoDeclinedRequestCounts = new Map<
    ThreadId,
    { readonly turnId: TurnId; count: number; readonly byOperation: Map<string, number> }
  >();
  const MAX_AUTO_DECLINED_REQUESTS_PER_TURN = 15;
  const MAX_REPEATS_OF_AN_AUTO_DECLINED_REQUEST = 3;

  /**
   * Counts a refusal; `repeats` is how often this same operation was refused this turn. A
   * refusal with no `operation` key can't be compared with another, so it only adds to the count.
   */
  const countAutoDeclinedRequest = (
    threadId: ThreadId,
    turnId: TurnId,
    operation: string | undefined,
  ) =>
    Effect.sync(() => {
      const existing = autoDeclinedRequestCounts.get(threadId);
      const entry =
        existing && existing.turnId === turnId
          ? existing
          : { turnId, count: 0, byOperation: new Map<string, number>() };
      entry.count += 1;
      const repeats = operation === undefined ? 1 : (entry.byOperation.get(operation) ?? 0) + 1;
      if (operation !== undefined) entry.byOperation.set(operation, repeats);
      autoDeclinedRequestCounts.set(threadId, entry);
      return { count: entry.count, repeats };
    });

  const clearAutoDeclinedRequests = (threadId: ThreadId, turnId?: TurnId) =>
    Effect.sync(() => {
      const existing = autoDeclinedRequestCounts.get(threadId);
      if (!existing || (turnId !== undefined && existing.turnId !== turnId)) return;
      autoDeclinedRequestCounts.delete(threadId);
    });

  const profiledFailureStopGraceMs = yield* ProfiledFailureStopGraceMs;
  const profiledFailureInterruptTimeout = yield* ProfiledFailureInterruptTimeout;
  /** Sessions to stop if a profile-failed turn does not settle within the grace period. */
  const profiledFailureStopTimers = new Map<
    ThreadId,
    { readonly turnId: TurnId; readonly timer: ReturnType<typeof setTimeout> }
  >();

  const clearProfiledFailureStopTimer = (threadId: ThreadId, turnId?: TurnId) =>
    Effect.sync(() => {
      const existing = profiledFailureStopTimers.get(threadId);
      if (!existing || (turnId !== undefined && existing.turnId !== turnId)) return;
      clearTimeout(existing.timer);
      profiledFailureStopTimers.delete(threadId);
    });

  /**
   * The turn F5 last failed under a read-only profile, per thread. The session's `lastErrorId`
   * records the same fact durably, but a later `ready` report would clear it while the provider
   * can still complete that turn; this marker outlives such reports until a new turn starts.
   */
  const profileFailedTurns = new Map<ThreadId, TurnId>();

  const isProfileFailedTurn = (
    thread: Pick<OrchestrationThread, "id" | "session">,
    turnId: TurnId,
  ): boolean =>
    profileFailedTurns.get(thread.id) === turnId ||
    (thread.session?.status === "error" &&
      thread.session.lastErrorId === profiledFailureErrorId(turnId));

  /** Whether the thread's latest settled turn is one F5 failed under a read-only profile. */
  const hasProfileFailedTurn = (thread: Pick<OrchestrationThread, "id" | "session">): boolean =>
    profileFailedTurns.has(thread.id) ||
    (thread.session?.status === "error" &&
      (thread.session.lastErrorId?.startsWith(PROFILED_FAILURE_ERROR_ID_PREFIX) ?? false));

  const readSessionGeneration = (threadId: ThreadId) =>
    providerSessionDirectory.getBinding(threadId).pipe(
      Effect.map((binding) =>
        Option.isSome(binding)
          ? readPersistedSessionGeneration(binding.value.runtimePayload)
          : undefined,
      ),
      Effect.orElseSucceed(() => undefined),
    );

  /**
   * Whether the session that ignored the interrupt is still the one bound to the thread and is
   * not running some other turn. A retry or a replacement session on the same thread must never
   * be stopped for the failed turn's sake.
   */
  const shouldStopProfileFailedSession = (
    threadId: ThreadId,
    turnId: TurnId,
    generation: number | undefined,
  ) =>
    Effect.gen(function* () {
      if (profileFailedTurns.get(threadId) !== turnId) return false;
      if ((yield* readSessionGeneration(threadId)) !== generation) return false;
      const session = (yield* providerService.listSessions()).find(
        (entry) => entry.threadId === threadId,
      );
      if (!session) return false;
      return session.activeTurnId === undefined || session.activeTurnId === turnId;
    });

  const armProfiledFailureStopTimer = (threadId: ThreadId, turnId: TurnId) =>
    Effect.gen(function* () {
      yield* clearProfiledFailureStopTimer(threadId);
      const generation = yield* readSessionGeneration(threadId);
      const timer = setTimeout(() => {
        if (profiledFailureStopTimers.get(threadId)?.timer !== timer) return;
        profiledFailureStopTimers.delete(threadId);
        Effect.runFork(
          Effect.gen(function* () {
            if (!(yield* shouldStopProfileFailedSession(threadId, turnId, generation))) return;
            yield* Effect.logWarning("profiled workflow turn ignored interrupt; stopping session", {
              threadId,
              turnId,
              graceMs: profiledFailureStopGraceMs,
            });
            yield* providerService.stopSession({ threadId });
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to stop session after profiled workflow failure", {
                threadId,
                turnId,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        );
      }, profiledFailureStopGraceMs);
      timer.unref?.();
      profiledFailureStopTimers.set(threadId, { turnId, timer });
    });

  const readWorkflowExecutionProfileForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const binding = Option.getOrUndefined(yield* providerSessionDirectory.getBinding(threadId));
    return binding
      ? readPersistedInstructionContext(binding.runtimePayload)?.workflowExecutionProfile
      : undefined;
  });

  const recordProfiledTurnFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly error: string;
    readonly retryable: boolean;
    readonly createdAt: string;
  }) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === input.threadId);
    if (!thread) return;
    // The first failure is the one to report: a provider that keeps going after the interrupt
    // must not overwrite it with a later, less telling one.
    if (isProfileFailedTurn(thread, input.turnId)) return;
    profileFailedTurns.set(input.threadId, input.turnId);

    // Recording the failure must not wait on a provider that never acknowledges the cancel; the
    // stop timer below handles one that keeps running.
    yield* providerService
      .interruptTurn({
        threadId: input.threadId,
        turnId: input.turnId,
      })
      .pipe(
        Effect.timeoutOption(profiledFailureInterruptTimeout),
        Effect.flatMap((result) =>
          Option.isNone(result)
            ? Effect.logWarning("failed to interrupt profiled workflow turn", {
                threadId: input.threadId,
                turnId: input.turnId,
                cause: `interrupt not acknowledged within ${Duration.format(profiledFailureInterruptTimeout)}`,
              })
            : Effect.void,
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to interrupt profiled workflow turn", {
            threadId: input.threadId,
            turnId: input.turnId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    // Only a violation stops the session. A retryable failure (the 30-minute timeout) is retried
    // on the same thread, and that retry must not race a stop meant for the stuck turn.
    if (!input.retryable) yield* armProfiledFailureStopTimer(input.threadId, input.turnId);
    yield* orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(
        `workflow-profile-failure:${input.threadId}:${input.turnId}:${timeOrderedUuid()}`,
      ),
      threadId: input.threadId,
      session: {
        threadId: input.threadId,
        status: "error",
        providerName: thread.session?.providerName ?? null,
        runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
        ...((thread.latestTurn?.workflowExecutionProfile ??
        thread.session?.workflowExecutionProfile)
          ? {
              workflowExecutionProfile:
                thread.latestTurn?.workflowExecutionProfile ??
                thread.session?.workflowExecutionProfile,
            }
          : {}),
        activeTurnId: null,
        lastError: input.error,
        lastErrorId: profiledFailureErrorId(input.turnId),
        lastErrorOccurredAt: input.createdAt,
        lastErrorRetryability: input.retryable ? "retryable" : "non-retryable",
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  /**
   * A profile-failed turn's late completion is not applied, but what the provider spent still
   * counts toward the workflow budget, which reads `turnCostUsd` from session-set events. The
   * cost rides on a copy of the current session so no stage sees a new outcome. It is skipped
   * only while a retryable failure is still showing: repeating it would retry the stage twice.
   */
  const forwardProfileFailedTurnCost = Effect.fnUntraced(function* (
    thread: OrchestrationThread,
    session: NonNullable<OrchestrationThread["session"]>,
    eventId: string,
    turnCostUsd: number,
    now: string,
  ) {
    const safeToRepeat =
      session.status === "starting" ||
      session.status === "running" ||
      (session.status === "error" &&
        session.lastErrorRetryability === "non-retryable" &&
        (session.lastErrorId?.startsWith(PROFILED_FAILURE_ERROR_ID_PREFIX) ?? false));
    if (!safeToRepeat) {
      yield* Effect.logDebug("profile-failed turn cost not forwarded", {
        threadId: thread.id,
        sessionStatus: session.status,
        turnCostUsd,
      });
      return;
    }
    yield* orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(`workflow-profile-failure-cost:${eventId}`),
      threadId: thread.id,
      session: { ...session, turnCostUsd, updatedAt: now },
      createdAt: now,
    });
  });

  const scheduleProfiledTurnWatchdog = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly startedAt: string;
  }) {
    yield* clearProfiledTurnWatchdog(input.threadId);
    const elapsedMs = Math.max(0, Date.now() - Date.parse(input.startedAt));
    const remainingMs = Math.max(0, PROFILED_WORKFLOW_TURN_TIMEOUT_MS - elapsedMs);
    const timer = setTimeout(() => {
      profiledTurnWatchdogs.delete(input.threadId);
      Effect.runFork(
        Effect.gen(function* () {
          const readModel = yield* orchestrationEngine.getReadModel();
          const thread = readModel.threads.find((entry) => entry.id === input.threadId);
          if (
            thread?.session?.status !== "running" ||
            thread.session.activeTurnId !== input.turnId ||
            thread.latestTurn?.state !== "running" ||
            thread.latestTurn.turnId !== input.turnId
          ) {
            return;
          }
          yield* recordProfiledTurnFailure({
            threadId: input.threadId,
            turnId: input.turnId,
            error: "Workflow read-only turn timed out after 30 minutes; this failure is retryable.",
            retryable: true,
            createdAt: new Date().toISOString(),
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("profiled workflow turn watchdog failed", {
              threadId: input.threadId,
              turnId: input.turnId,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      );
    }, remainingMs);
    timer.unref?.();
    profiledTurnWatchdogs.set(input.threadId, { turnId: input.turnId, timer });
  });

  let enqueueAssistantDeltaFlush = (
    _threadId: ThreadId,
    _messageId: MessageId,
    _commandId: CommandId,
  ) => {};
  const coalescingEnabled = process.env.F5_COALESCE_STREAMING_DELTAS !== "false";
  const streamingDeltas = makeStreamingAssistantDeltas(
    (command) => orchestrationEngine.dispatch(command),
    (threadId, messageId, commandId) => enqueueAssistantDeltaFlush(threadId, messageId, commandId),
    isPermanentDispatchRejection,
  );
  const dispatchStreamingDelta = (
    event: ProviderRuntimeEvent,
    command: Parameters<typeof streamingDeltas.append>[0],
  ) =>
    coalescingEnabled && COALESCE_STREAMING_DELTAS_DRIVERS.has(event.provider)
      ? streamingDeltas.append({
          ...command,
          commandId: providerCommandId(event, "assistant-delta-batch"),
        })
      : orchestrationEngine.dispatch(command).pipe(Effect.asVoid);

  const assistantDeliveryModes = yield* Cache.make<ThreadId, AssistantDeliveryMode>({
    capacity: 10000,
    timeToLive: "24 hours",
    lookup: () => Effect.succeed(DEFAULT_ASSISTANT_DELIVERY_MODE),
  });

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
  });

  const runtimeOriginByTurnKey = yield* Cache.make<
    string,
    { generation: number; instanceId?: ProviderInstanceId }
  >({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed({ generation: -1 }),
  });

  const bufferedAssistantTextByMessageId = yield* Cache.make<MessageId, string>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(""),
  });

  const bufferedReasoningTextByTurnKey = yield* Cache.make<string, string>({
    capacity: BUFFERED_REASONING_TEXT_BY_TURN_KEY_CACHE_CAPACITY,
    timeToLive: BUFFERED_REASONING_TEXT_BY_TURN_KEY_TTL,
    lookup: () => Effect.succeed(""),
  });

  const bufferedProposedPlanById = yield* Cache.make<string, { text: string; createdAt: string }>({
    capacity: BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });

  // Per-thread last-dispatched live thinking-token estimate, used to throttle the
  // high-frequency `thread.thinking-tokens.updated` stream (see
  // THINKING_TOKENS_DISPATCH_THRESHOLD). Reset to 0 on turn start/completion so
  // each turn starts blank.
  const lastThinkingTokensByThread = yield* Cache.make<ThreadId, number>({
    capacity: LAST_THINKING_TOKENS_BY_THREAD_CACHE_CAPACITY,
    timeToLive: LAST_THINKING_TOKENS_BY_THREAD_TTL,
    lookup: () => Effect.succeed(0),
  });

  // Per-thread context-token report that was not persisted on its own (see
  // CONTEXT_TOKENS_DISPATCH_MIN_DELTA). Cleared when it is persisted or superseded.
  const pendingContextTokensByThread = yield* Cache.make<ThreadId, PendingContextTokens | null>({
    capacity: LAST_THINKING_TOKENS_BY_THREAD_CACHE_CAPACITY,
    timeToLive: LAST_THINKING_TOKENS_BY_THREAD_TTL,
    lookup: () => Effect.succeed(null),
  });

  // One upserted `reasoning.status` record per turn. The stored sequence and
  // createdAt keep every upsert at the position of the reasoning item that
  // started it; only a new reasoning item moves it.
  const reasoningStatusByTurnKey = yield* Cache.make<string, ReasoningStatusEntry | null>({
    capacity: REASONING_STATUS_BY_TURN_KEY_CACHE_CAPACITY,
    timeToLive: REASONING_STATUS_BY_TURN_KEY_TTL,
    lookup: () => Effect.succeed(null),
  });

  // The last reasoning section appended per turn, so a new item or summary
  // part starts on its own paragraph instead of running into the previous one.
  const reasoningSectionByTurnKey = yield* Cache.make<string, ReasoningSection | null>({
    capacity: REASONING_SECTION_BY_TURN_KEY_CACHE_CAPACITY,
    timeToLive: REASONING_SECTION_BY_TURN_KEY_TTL,
    lookup: () => Effect.succeed(null),
  });

  // Reasoning-token counts follow their reasoning text. Counts reported while
  // the text is still buffered (or before any text) wait here for the message
  // that receives it; leftovers attach to the turn's last message on completion.
  const pendingReasoningTokensByTurnKey = yield* Cache.make<string, PendingReasoningTokens | null>({
    capacity: REASONING_TOKENS_BY_TURN_KEY_CACHE_CAPACITY,
    timeToLive: REASONING_TOKENS_BY_TURN_KEY_TTL,
    lookup: () => Effect.succeed(null),
  });
  // The message that last received reasoning text and has not yet been
  // credited with a count for it. Cleared once credited, so a later count
  // without visible reasoning moves on to the next message.
  const reasoningRecipientByTurnKey = yield* Cache.make<string, MessageId | null>({
    capacity: REASONING_TOKENS_BY_TURN_KEY_CACHE_CAPACITY,
    timeToLive: REASONING_TOKENS_BY_TURN_KEY_TTL,
    lookup: () => Effect.succeed(null),
  });
  // Counts attributed to a message that is still streaming, dispatched once it completes.
  const deferredReasoningTokensByMessageId = yield* Cache.make<
    MessageId,
    (PendingReasoningTokens & { readonly threadId: ThreadId; readonly turnId: TurnId }) | null
  >({
    capacity: REASONING_TOKENS_BY_TURN_KEY_CACHE_CAPACITY,
    timeToLive: REASONING_TOKENS_BY_TURN_KEY_TTL,
    lookup: () => Effect.succeed(null),
  });

  const resolveWorkspaceCwdForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return undefined;
    }
    return resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });
  });

  const isGitRepoForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const workspaceCwd = yield* resolveWorkspaceCwdForThread(threadId);
    if (!workspaceCwd) {
      return false;
    }
    return isGitRepository(workspaceCwd);
  });

  const rememberAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Cache.set(
          turnMessageIdsByTurnKey,
          providerTurnKey(threadId, turnId),
          Option.match(existingIds, {
            onNone: () => new Set([messageId]),
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.add(messageId);
              return nextIds;
            },
          }),
        ),
      ),
    );

  const forgetAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Option.match(existingIds, {
          onNone: () => Effect.void,
          onSome: (ids) => {
            const nextIds = new Set(ids);
            nextIds.delete(messageId);
            if (nextIds.size === 0) {
              return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));
            }
            return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId), nextIds);
          },
        }),
      ),
    );

  const getAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));

  const getLatestAssistantMessageIdForTurn = (threadId: ThreadId, turnId: TurnId) =>
    getAssistantMessageIdsForTurn(threadId, turnId).pipe(
      Effect.map((messageIds) => {
        let lastMessageId: MessageId | undefined;
        for (const messageId of messageIds) {
          lastMessageId = messageId;
        }
        return lastMessageId;
      }),
    );

  const appendBufferedAssistantText = (messageId: MessageId, delta: string) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Effect.gen(function* () {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });
          if (nextText.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
            yield* Cache.set(bufferedAssistantTextByMessageId, messageId, nextText);
            return "";
          }

          // Safety valve: flush full buffered text as an assistant delta to cap memory.
          yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
          return nextText;
        }),
      ),
    );

  const takeBufferedAssistantText = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
          Effect.as(Option.getOrElse(existingText, () => "")),
        ),
      ),
    );

  const clearBufferedAssistantText = (messageId: MessageId) =>
    Cache.invalidate(bufferedAssistantTextByMessageId, messageId);

  const appendBufferedReasoningText = (turnKey: string, delta: string) =>
    Cache.getOption(bufferedReasoningTextByTurnKey, turnKey).pipe(
      Effect.flatMap((existingText) =>
        Effect.gen(function* () {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });
          if (nextText.length <= MAX_BUFFERED_REASONING_CHARS) {
            yield* Cache.set(bufferedReasoningTextByTurnKey, turnKey, nextText);
            return "";
          }

          yield* Cache.invalidate(bufferedReasoningTextByTurnKey, turnKey);
          return nextText;
        }),
      ),
    );

  const takeBufferedReasoningText = (turnKey: string) =>
    Cache.getOption(bufferedReasoningTextByTurnKey, turnKey).pipe(
      Effect.flatMap((existingText) =>
        Cache.invalidate(bufferedReasoningTextByTurnKey, turnKey).pipe(
          Effect.as(Option.getOrElse(existingText, () => "")),
        ),
      ),
    );

  const clearBufferedReasoningText = (turnKey: string) =>
    Cache.invalidate(bufferedReasoningTextByTurnKey, turnKey).pipe(
      Effect.andThen(Cache.invalidate(reasoningSectionByTurnKey, turnKey)),
    );

  const hasBufferedReasoningText = (turnKey: string) =>
    Cache.getOption(bufferedReasoningTextByTurnKey, turnKey).pipe(
      Effect.map(Option.match({ onNone: () => false, onSome: (text) => text.length > 0 })),
    );

  const clearReasoningTokenState = (turnKey: string) =>
    Cache.invalidate(pendingReasoningTokensByTurnKey, turnKey).pipe(
      Effect.andThen(Cache.invalidate(reasoningRecipientByTurnKey, turnKey)),
    );

  const addPendingReasoningTokens = (turnKey: string, tokens: number, estimated: boolean) =>
    Cache.getOption(pendingReasoningTokensByTurnKey, turnKey).pipe(
      Effect.flatMap((existing) => {
        const previous = Option.getOrNull(existing);
        return Cache.set(pendingReasoningTokensByTurnKey, turnKey, {
          tokens: (previous?.tokens ?? 0) + tokens,
          estimated: (previous?.estimated ?? false) || estimated,
        });
      }),
    );

  const takePendingReasoningTokens = (turnKey: string) =>
    Cache.getOption(pendingReasoningTokensByTurnKey, turnKey).pipe(
      Effect.flatMap((existing) =>
        Cache.invalidate(pendingReasoningTokensByTurnKey, turnKey).pipe(
          Effect.as(Option.getOrNull(existing)),
        ),
      ),
    );

  const dispatchReasoningTokens = (input: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly messageId: MessageId;
    readonly tokens: PendingReasoningTokens;
    readonly tag: string;
  }) =>
    Effect.gen(function* () {
      if (input.tokens.tokens <= 0) return;
      const readModel = yield* orchestrationEngine.getReadModel();
      const message = readModel.threads
        .find((thread) => thread.id === input.threadId)
        ?.messages.find((entry) => entry.id === input.messageId);
      // Event compaction folds a streamed message into its final event, so a
      // count recorded before completion would replay ahead of its message.
      if (message === undefined || message.streaming) {
        yield* deferReasoningTokens(input.threadId, input.messageId, input.turnId, input.tokens);
        return;
      }
      const command = {
        type: "thread.message.reasoning-tokens.add",
        commandId: providerCommandId(
          input.event,
          `reasoning-tokens-${input.tag}:${input.messageId}`,
        ),
        threadId: input.threadId,
        messageId: input.messageId,
        turnId: input.turnId,
        tokens: input.tokens.tokens,
        estimated: input.tokens.estimated,
        createdAt: input.event.createdAt,
      } as const;
      // Suspended so each retry issues the dispatch again.
      yield* Effect.suspend(() => orchestrationEngine.dispatch(command)).pipe(
        Effect.asVoid,
        // The count's cache entry is already consumed, so retry transient
        // failures here. The command id is fixed, so a retry after a commit
        // that reported failure is deduplicated by its receipt.
        Effect.retry({
          times: 3,
          schedule: Schedule.exponential("50 millis"),
          while: (error) => !isPermanentDispatchError(error),
        }),
        // Metadata only: a failed count must not block message completion,
        // turn cleanup or history reconciliation.
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : isPermanentDispatchRejection(cause)
              ? Effect.logDebug("provider runtime ingestion dropped reasoning tokens", {
                  threadId: input.threadId,
                  messageId: input.messageId,
                  tokens: input.tokens.tokens,
                })
              : Effect.logWarning("provider runtime ingestion failed to record reasoning tokens", {
                  threadId: input.threadId,
                  messageId: input.messageId,
                  tokens: input.tokens.tokens,
                  cause: Cause.pretty(cause),
                }),
        ),
      );
    });

  const deferReasoningTokens = (
    threadId: ThreadId,
    messageId: MessageId,
    turnId: TurnId,
    tokens: PendingReasoningTokens,
  ) =>
    Cache.getOption(deferredReasoningTokensByMessageId, messageId).pipe(
      Effect.flatMap((existing) => {
        const previous = Option.getOrNull(existing);
        return Cache.set(deferredReasoningTokensByMessageId, messageId, {
          threadId,
          turnId,
          tokens: (previous?.tokens ?? 0) + tokens.tokens,
          estimated: (previous?.estimated ?? false) || tokens.estimated,
        });
      }),
    );

  /** Drops deferred counts whose message never completed, e.g. after an abort or session stop. */
  const dropDeferredReasoningTokens = (threadId: ThreadId, turnId?: TurnId) =>
    Effect.gen(function* () {
      for (const messageId of Array.from(yield* Cache.keys(deferredReasoningTokensByMessageId))) {
        const deferred = Option.getOrNull(
          yield* Cache.getOption(deferredReasoningTokensByMessageId, messageId),
        );
        if (
          !deferred ||
          deferred.threadId !== threadId ||
          (turnId !== undefined && deferred.turnId !== turnId)
        )
          continue;
        yield* Cache.invalidate(deferredReasoningTokensByMessageId, messageId);
        yield* Effect.logDebug(
          "provider runtime ingestion dropped reasoning tokens for an unfinished message",
          { threadId, messageId, turnId: deferred.turnId, tokens: deferred.tokens },
        );
      }
    });

  /** Dispatches counts that waited for this message to complete. */
  const flushDeferredReasoningTokens = (input: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) =>
    Effect.gen(function* () {
      const deferred = Option.getOrNull(
        yield* Cache.getOption(deferredReasoningTokensByMessageId, input.messageId),
      );
      if (!deferred) return;
      yield* Cache.invalidate(deferredReasoningTokensByMessageId, input.messageId);
      yield* dispatchReasoningTokens({
        event: input.event,
        threadId: input.threadId,
        turnId: deferred.turnId,
        messageId: input.messageId,
        tokens: deferred,
        tag: "deferred",
      });
    });

  /** Records the message that just received reasoning text and hands it any waiting count. */
  const noteReasoningRecipient = (input: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly messageId: MessageId;
  }) =>
    Effect.gen(function* () {
      const turnKey = providerTurnKey(input.threadId, input.turnId);
      yield* Cache.set(reasoningRecipientByTurnKey, turnKey, input.messageId);
      if (yield* hasBufferedReasoningText(turnKey)) return;
      const pending = yield* takePendingReasoningTokens(turnKey);
      if (!pending) return;
      // The pending count belongs to earlier reasoning now shown on this
      // message. The recipient stays set so this message's own count still
      // reaches it instead of shifting to a later message.
      yield* dispatchReasoningTokens({ ...input, tokens: pending, tag: "flush" });
    });

  /** On turn completion, credits any uncredited count to the recipient or the turn's last message. */
  const attachLeftoverReasoningTokens = (input: {
    readonly event: ProviderRuntimeEvent;
    readonly thread: Pick<OrchestrationThread, "id" | "messages">;
    readonly turnId: TurnId;
    readonly assistantMessageIds: ReadonlySet<MessageId>;
  }) =>
    Effect.gen(function* () {
      const turnKey = providerTurnKey(input.thread.id, input.turnId);
      const recipient = Option.getOrNull(
        yield* Cache.getOption(reasoningRecipientByTurnKey, turnKey),
      );
      const pending = yield* takePendingReasoningTokens(turnKey);
      yield* clearReasoningTokenState(turnKey);
      if (!pending) return;
      // An uncredited recipient holds the matching reasoning text, so it wins.
      const messageId =
        recipient ??
        [...input.assistantMessageIds].at(-1) ??
        input.thread.messages.findLast(
          (message) => message.role === "assistant" && message.turnId === input.turnId,
        )?.id;
      if (messageId === undefined) {
        yield* Effect.logDebug("provider runtime ingestion dropped unattributed reasoning tokens", {
          threadId: input.thread.id,
          turnId: input.turnId,
          tokens: pending.tokens,
        });
        return;
      }
      yield* dispatchReasoningTokens({
        event: input.event,
        threadId: input.thread.id,
        turnId: input.turnId,
        messageId,
        tokens: pending,
        tag: "turn-end",
      });
    });

  const dispatchReasoningStatus = (input: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly entry: ReasoningStatusEntry;
  }) =>
    Effect.gen(function* () {
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: providerCommandId(input.event, "reasoning-status"),
        threadId: input.threadId,
        activity: {
          id: reasoningStatusActivityId(input.threadId, input.turnId),
          createdAt: input.entry.createdAt,
          tone: "info",
          kind: REASONING_STATUS_ACTIVITY_KIND,
          summary: "Thinking",
          payload: {
            state: input.entry.state,
            ...(input.entry.detail ? { detail: input.entry.detail } : {}),
            ...(input.entry.providerItemId ? { providerItemId: input.entry.providerItemId } : {}),
            // createdAt stays at the first write; this orders the latest change
            // against later activities, such as a reconnect warning.
            updatedAt: input.event.createdAt,
          },
          turnId: input.turnId,
          ...(input.entry.sequence !== undefined ? { sequence: input.entry.sequence } : {}),
        },
        createdAt: input.event.createdAt,
      });
      yield* Cache.set(
        reasoningStatusByTurnKey,
        providerTurnKey(input.threadId, input.turnId),
        input.entry,
      );
    });

  /**
   * Drives the per-turn reasoning status from item lifecycle events, so long
   * reasoning shows progress even when the provider sends no summary text.
   * Writes stay bounded per reasoning item: one start, at most one heading per
   * summary part, and one idle transition.
   */
  const applyReasoningStatus = (
    event: ProviderRuntimeEvent,
    thread: {
      readonly id: ThreadId;
      readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
    },
  ) =>
    Effect.gen(function* () {
      const threadId = thread.id;
      const turnId = toTurnId(event.turnId);
      if (!turnId) return;
      const turnKey = providerTurnKey(threadId, turnId);
      const itemId = event.itemId ? String(event.itemId) : null;
      // After a server restart the cache is empty; the persisted record still
      // says whether this turn is reasoning.
      const current =
        Option.getOrNull(yield* Cache.getOption(reasoningStatusByTurnKey, turnKey)) ??
        restoreReasoningStatusEntry(thread.activities, threadId, turnId);

      if (event.type === "item.started" && event.payload.itemType === "reasoning") {
        // A replayed start for the item already tracked changes nothing.
        if (current && itemId !== null && current.providerItemId === itemId) return;
        const sequence = eventSessionSequence(event);
        yield* dispatchReasoningStatus({
          event,
          threadId,
          turnId,
          entry: {
            providerItemId: itemId,
            state: "active",
            detail: null,
            sequence,
            createdAt: event.createdAt,
            headingParts: {},
          },
        });
        return;
      }

      if (!current || current.state !== "active") return;

      const endsReasoning =
        (event.type === "item.completed" &&
          event.payload.itemType === "reasoning" &&
          itemId === current.providerItemId) ||
        (event.type === "item.started" && isToolLifecycleItemType(event.payload.itemType)) ||
        (event.type === "content.delta" &&
          event.payload.streamKind === "assistant_text" &&
          event.payload.delta.length > 0) ||
        // An interrupt or crash can skip the reasoning item's completion.
        event.type === "turn.completed" ||
        event.type === "turn.aborted";
      if (endsReasoning) {
        yield* dispatchReasoningStatus({
          event,
          threadId,
          turnId,
          entry: { ...current, state: "idle" },
        });
        return;
      }

      if (
        event.type !== "content.delta" ||
        event.payload.streamKind !== "reasoning_summary_text" ||
        itemId === null ||
        itemId !== current.providerItemId
      ) {
        return;
      }
      const partKey = String(event.payload.summaryIndex ?? 0);
      const scanned = current.headingParts[partKey];
      if (scanned === null) return;
      const text = `${scanned ?? ""}${event.payload.delta}`;
      const heading = REASONING_HEADING_REGEX.exec(text)?.[1]?.trim();
      if (heading && heading === current.detail) {
        yield* Cache.set(reasoningStatusByTurnKey, turnKey, {
          ...current,
          headingParts: { ...current.headingParts, [partKey]: null },
        });
        return;
      }
      if (heading) {
        yield* dispatchReasoningStatus({
          event,
          threadId,
          turnId,
          entry: {
            ...current,
            detail: heading,
            headingParts: { ...current.headingParts, [partKey]: null },
          },
        });
        return;
      }
      // No heading yet: keep scanning this part until the cap, then give up
      // without writing anything.
      yield* Cache.set(reasoningStatusByTurnKey, turnKey, {
        ...current,
        headingParts: {
          ...current.headingParts,
          [partKey]: text.length >= REASONING_HEADING_SCAN_CHARS ? null : text,
        },
      });
    });

  // A failed dispatch puts taken text back in front of anything buffered since,
  // so a later finalize delivers it exactly once.
  const restoreBufferedAssistantText = (messageId: MessageId, text: string) =>
    text.length === 0
      ? Effect.void
      : Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
          Effect.flatMap((existing) =>
            Cache.set(
              bufferedAssistantTextByMessageId,
              messageId,
              `${text}${Option.getOrElse(existing, () => "")}`,
            ),
          ),
        );

  const restoreBufferedReasoningText = (turnKey: string, text: string) =>
    text.length === 0
      ? Effect.void
      : Cache.getOption(bufferedReasoningTextByTurnKey, turnKey).pipe(
          Effect.flatMap((existing) =>
            Cache.set(
              bufferedReasoningTextByTurnKey,
              turnKey,
              `${text}${Option.getOrElse(existing, () => "")}`,
            ),
          ),
        );

  const appendBufferedProposedPlan = (planId: string, delta: string, createdAt: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) => {
        const existing = Option.getOrUndefined(existingEntry);
        return Cache.set(bufferedProposedPlanById, planId, {
          text: `${existing?.text ?? ""}${delta}`,
          createdAt:
            existing?.createdAt && existing.createdAt.length > 0 ? existing.createdAt : createdAt,
        });
      }),
    );

  const takeBufferedProposedPlan = (planId: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) =>
        Cache.invalidate(bufferedProposedPlanById, planId).pipe(
          Effect.as(Option.getOrUndefined(existingEntry)),
        ),
      ),
    );

  const clearBufferedProposedPlan = (planId: string) =>
    Cache.invalidate(bufferedProposedPlanById, planId);

  const clearAssistantMessageState = (messageId: MessageId, turnId?: string) =>
    Effect.gen(function* () {
      yield* clearBufferedAssistantText(messageId);
      if (turnId) {
        yield* clearBufferedReasoningText(turnId);
      }
    });

  const finalizeAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    /** The thread's messages as this event saw them, to tell a closed message apart. */
    threadMessages: ReadonlyArray<{
      readonly id: MessageId;
      readonly role: string;
      readonly streaming: boolean;
    }>;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    fallbackText?: string;
    preserveFallbackWhitespace?: boolean;
  }) =>
    Effect.gen(function* () {
      const turnKey = input.turnId ? providerTurnKey(input.threadId, input.turnId) : undefined;
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      const bufferedReasoningText = turnKey ? yield* takeBufferedReasoningText(turnKey) : "";
      const text =
        bufferedText.length > 0
          ? bufferedText
          : (input.preserveFallbackWhitespace
                ? (input.fallbackText?.length ?? 0)
                : (input.fallbackText?.trim().length ?? 0)) > 0
            ? input.fallbackText!
            : "";
      // Same rationale as the content-delta guard: a closed message drops late deltas, and
      // the decider's empty result would fail this event and fence the thread's history.
      const alreadyComplete = input.threadMessages.some(
        (message) =>
          message.id === input.messageId &&
          message.role === "assistant" &&
          message.streaming === false,
      );
      if (alreadyComplete) {
        if (text.length > 0) {
          yield* Effect.logWarning(
            "provider runtime ingestion dropped late assistant finalization on completed message",
            {
              threadId: input.threadId,
              messageId: input.messageId,
              deltaLength: text.length,
              eventId: input.event.eventId,
            },
          );
        }
        // Completing it again would move the message into this turn and restamp it. The
        // turn's buffered reasoning may belong to another message still streaming: keep it.
        if (turnKey && bufferedReasoningText.length > 0) {
          yield* restoreBufferedReasoningText(turnKey, bufferedReasoningText);
        }
        yield* flushDeferredReasoningTokens({
          event: input.event,
          threadId: input.threadId,
          messageId: input.messageId,
        });
        streamingDeltas.forgetMessage(input.threadId, input.messageId);
        yield* clearAssistantMessageState(input.messageId);
        return;
      }

      yield* Effect.gen(function* () {
        if (text.length > 0) {
          yield* orchestrationEngine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: providerCommandId(
              input.event,
              `${input.finalDeltaCommandTag}:${input.messageId}`,
            ),
            threadId: input.threadId,
            messageId: input.messageId,
            delta: text,
            ...(bufferedReasoningText.length > 0 ? { reasoningDelta: bufferedReasoningText } : {}),
            ...(input.turnId ? { turnId: input.turnId } : {}),
            createdAt: input.createdAt,
          });
        }

        if (text.length === 0 && bufferedReasoningText.length > 0) {
          yield* orchestrationEngine.dispatch({
            // Empty delta is safe here; completion immediately follows and closes the message.
            type: "thread.message.assistant.delta",
            commandId: providerCommandId(
              input.event,
              `${input.finalDeltaCommandTag}-reasoning-only:${input.messageId}`,
            ),
            threadId: input.threadId,
            messageId: input.messageId,
            delta: "",
            reasoningDelta: bufferedReasoningText,
            ...(input.turnId ? { turnId: input.turnId } : {}),
            createdAt: input.createdAt,
          });
        }
      }).pipe(
        Effect.onError((cause) =>
          isPermanentDispatchRejection(cause)
            ? Effect.void
            : Effect.andThen(
                restoreBufferedAssistantText(input.messageId, bufferedText),
                turnKey
                  ? restoreBufferedReasoningText(turnKey, bufferedReasoningText)
                  : Effect.void,
              ),
        ),
      );
      if (bufferedReasoningText.length > 0 && input.turnId) {
        yield* noteReasoningRecipient({
          event: input.event,
          threadId: input.threadId,
          turnId: input.turnId,
          messageId: input.messageId,
        });
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: providerCommandId(input.event, `${input.commandTag}:${input.messageId}`),
        threadId: input.threadId,
        messageId: input.messageId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
      yield* flushDeferredReasoningTokens({
        event: input.event,
        threadId: input.threadId,
        messageId: input.messageId,
      });
      streamingDeltas.forgetMessage(input.threadId, input.messageId);
      yield* clearAssistantMessageState(
        input.messageId,
        input.turnId ? providerTurnKey(input.threadId, input.turnId) : undefined,
      );
    });

  const upsertProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    planMarkdown: string | undefined;
    createdAt: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const planMarkdown = normalizeProposedPlanMarkdown(input.planMarkdown);
      if (!planMarkdown) {
        return;
      }

      const existingPlan = input.threadProposedPlans.find((entry) => entry.id === input.planId);
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: providerCommandId(input.event, "proposed-plan-upsert"),
        threadId: input.threadId,
        proposedPlan: {
          id: input.planId,
          turnId: input.turnId ?? null,
          planMarkdown,
          implementedAt: existingPlan?.implementedAt ?? null,
          implementationThreadId: existingPlan?.implementationThreadId ?? null,
          createdAt: existingPlan?.createdAt ?? input.createdAt,
          updatedAt: input.updatedAt,
        },
        createdAt: input.updatedAt,
      });
    });

  const finalizeBufferedProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    fallbackMarkdown?: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const bufferedPlan = yield* takeBufferedProposedPlan(input.planId);
      const bufferedMarkdown = normalizeProposedPlanMarkdown(bufferedPlan?.text);
      const fallbackMarkdown = normalizeProposedPlanMarkdown(input.fallbackMarkdown);
      const planMarkdown = fallbackMarkdown ?? bufferedMarkdown;
      if (!planMarkdown) {
        return;
      }

      yield* upsertProposedPlan({
        event: input.event,
        threadId: input.threadId,
        threadProposedPlans: input.threadProposedPlans,
        planId: input.planId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        planMarkdown,
        createdAt:
          bufferedPlan?.createdAt && bufferedPlan.createdAt.length > 0
            ? bufferedPlan.createdAt
            : input.updatedAt,
        updatedAt: input.updatedAt,
      });
      yield* clearBufferedProposedPlan(input.planId);
    });

  const clearTurnStateForSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const prefix = `${threadId}:`;
      const proposedPlanPrefix = `plan:${threadId}:`;
      const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
      const bufferedReasoningKeys = Array.from(yield* Cache.keys(bufferedReasoningTextByTurnKey));
      const reasoningTokenKeys = Array.from(
        new Set([
          ...(yield* Cache.keys(pendingReasoningTokensByTurnKey)),
          ...(yield* Cache.keys(reasoningRecipientByTurnKey)),
        ]),
      );
      const proposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));
      yield* Effect.forEach(
        turnKeys,
        (key) =>
          Effect.gen(function* () {
            if (!key.startsWith(prefix)) {
              return;
            }

            const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
            if (Option.isSome(messageIds)) {
              yield* Effect.forEach(
                messageIds.value,
                (messageId) => clearAssistantMessageState(messageId),
                {
                  concurrency: 1,
                },
              ).pipe(Effect.asVoid);
            }

            yield* clearBufferedReasoningText(key);
            yield* clearReasoningTokenState(key);
            yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
          }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        bufferedReasoningKeys,
        // Intentional overlap with the turn-key loop above: this also clears
        // orphaned reasoning buffers whose assistant message mapping is gone.
        (key) => (key.startsWith(prefix) ? clearBufferedReasoningText(key) : Effect.void),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        reasoningTokenKeys,
        (key) => (key.startsWith(prefix) ? clearReasoningTokenState(key) : Effect.void),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* dropDeferredReasoningTokens(threadId);
      yield* Effect.forEach(
        proposedPlanKeys,
        (key) =>
          key.startsWith(proposedPlanPrefix)
            ? Cache.invalidate(bufferedProposedPlanById, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
    });

  const openCommandExecutions = new Map<
    OrchestrationCommandExecutionId,
    OpenCommandExecutionState
  >();
  const pendingCommandExecutionOutput = new Map<
    OrchestrationCommandExecutionId,
    PendingCommandExecutionOutputState
  >();
  // Closed commands can still receive provider tails after turn cleanup.
  const closedCommandExecutionTurns = new Map<OrchestrationCommandExecutionId, TurnId>();
  const rememberClosedCommandExecution = (id: OrchestrationCommandExecutionId, turnId: TurnId) => {
    closedCommandExecutionTurns.delete(id);
    closedCommandExecutionTurns.set(id, turnId);
    if (closedCommandExecutionTurns.size > 512) {
      closedCommandExecutionTurns.delete(closedCommandExecutionTurns.keys().next().value!);
    }
  };
  const pendingFileChanges = new Map<OrchestrationFileChangeId, PendingFileChangeState>();
  let enqueueCommandOutputFlush:
    | ((commandExecutionId: OrchestrationCommandExecutionId) => void)
    | null = null;

  const clearAllCommandExecutionFlushTimers = () => {
    for (const commandExecution of openCommandExecutions.values()) {
      clearCommandExecutionFlushTimer(commandExecution);
    }
  };

  const scheduleCommandOutputFlush = (commandExecutionId: OrchestrationCommandExecutionId) => {
    const commandExecution = openCommandExecutions.get(commandExecutionId);
    if (!commandExecution || commandExecution.flushTimer !== null) {
      return;
    }
    commandExecution.flushTimer = setTimeout(() => {
      commandExecution.flushTimer = null;
      enqueueCommandOutputFlush?.(commandExecutionId);
    }, COMMAND_OUTPUT_FLUSH_INTERVAL_MS);
  };

  const flushCommandExecutionOutput = Effect.fnUntraced(function* (
    commandExecutionId: OrchestrationCommandExecutionId,
  ) {
    const commandExecution = openCommandExecutions.get(commandExecutionId);
    if (!commandExecution) {
      return false;
    }
    clearCommandExecutionFlushTimer(commandExecution);
    if (commandExecution.bufferedOutput.length === 0) {
      return true;
    }
    const chunk = commandExecution.bufferedOutput;
    yield* orchestrationEngine.dispatch({
      type: "thread.command-execution.output.append",
      commandId: CommandId.makeUnsafe(`provider:cmd-output:${timeOrderedUuid()}`),
      threadId: commandExecution.threadId,
      commandExecutionId: commandExecution.id,
      chunk,
      updatedAt: commandExecution.updatedAt,
      createdAt: commandExecution.updatedAt,
    });
    commandExecution.bufferedOutput = commandExecution.bufferedOutput.slice(chunk.length);
    return true;
  });

  const flushAllCommandExecutionOutput = Effect.fnUntraced(function* () {
    for (const commandExecutionId of openCommandExecutions.keys()) {
      yield* flushCommandExecutionOutput(commandExecutionId);
    }
  });

  const cleanupClosedCommandExecutions = (input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId;
  }) =>
    Effect.sync(() => {
      for (const commandExecution of openCommandExecutions.values()) {
        if (commandExecution.threadId !== input.threadId) {
          continue;
        }
        if (input.turnId !== undefined && commandExecution.turnId !== input.turnId) {
          continue;
        }
        if (commandExecution.completedAt === null) {
          continue;
        }
        clearCommandExecutionFlushTimer(commandExecution);
        rememberClosedCommandExecution(commandExecution.id, commandExecution.turnId);
        openCommandExecutions.delete(commandExecution.id);
      }
    });

  const recordFileChangeLifecycle = Effect.fnUntraced(function* (input: {
    readonly event: Extract<
      ProviderRuntimeEvent,
      { type: "item.started" | "item.updated" | "item.completed" }
    >;
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly fileChangeId: OrchestrationFileChangeId;
    readonly providerItemId: ProviderItemId;
  }) {
    const existing = pendingFileChanges.get(input.fileChangeId);
    const preview = extractFileChangePreview(input.event);
    const structuredPatch = synthesizeStructuredFileChangePatch(input.event);
    const unknownKinds = extractUnknownStructuredFileChangeKinds(input.event);
    if (unknownKinds.length > 0) {
      yield* Effect.logWarning("file-change lifecycle contained unknown structured change kinds", {
        eventId: input.event.eventId,
        threadId: input.threadId,
        itemId: input.event.itemId,
        kinds: unknownKinds,
      });
    }
    const fileChange: PendingFileChangeState =
      existing ??
      ({
        id: input.fileChangeId,
        threadId: input.threadId,
        providerItemId: input.providerItemId,
        firstSeenAt: input.event.createdAt,
        turnId: input.turnId,
        title: preview.title,
        detail: preview.detail,
        changedFiles: preview.changedFiles,
        startedAt: input.event.type === "item.started" ? input.event.createdAt : null,
        completedAt: null,
        updatedAt: input.event.createdAt,
        exactPatch: structuredPatch ?? "",
        bufferedOutput: "",
        bufferedOutputBytes: 0,
      } satisfies PendingFileChangeState);

    fileChange.firstSeenAt =
      fileChange.firstSeenAt <= input.event.createdAt
        ? fileChange.firstSeenAt
        : input.event.createdAt;
    fileChange.turnId = fileChange.turnId ?? input.turnId;
    fileChange.title = preview.title ?? fileChange.title;
    fileChange.detail = preview.detail ?? fileChange.detail;
    fileChange.changedFiles =
      preview.changedFiles.length > 0 ? preview.changedFiles : fileChange.changedFiles;
    fileChange.startedAt =
      input.event.type === "item.started"
        ? input.event.createdAt
        : (fileChange.startedAt ?? fileChange.firstSeenAt);
    if (structuredPatch && structuredPatch.length > 0) {
      fileChange.exactPatch = structuredPatch;
    }
    fileChange.updatedAt =
      fileChange.updatedAt >= input.event.createdAt ? fileChange.updatedAt : input.event.createdAt;

    if (input.event.type !== "item.completed") {
      pendingFileChanges.set(input.fileChangeId, fileChange);
      return;
    }

    const terminalStatus = fileChangeStatusFromLifecycleEvent(input.event);
    const completedAt = input.event.createdAt;
    yield* orchestrationEngine.dispatch({
      type: "thread.file-change.record",
      commandId: providerCommandId(input.event, "thread-file-change-record"),
      threadId: input.threadId,
      fileChange: {
        id: fileChange.id,
        turnId: fileChange.turnId ?? input.turnId,
        providerItemId: fileChange.providerItemId,
        title: fileChange.title,
        detail: fileChange.detail,
        status: terminalStatus,
        changedFiles: [...fileChange.changedFiles],
        startedAt: fileChange.startedAt ?? fileChange.firstSeenAt,
        completedAt,
        updatedAt: completedAt,
        patch: resolvedFileChangePatch(fileChange),
      },
      createdAt: completedAt,
    });
    pendingFileChanges.delete(input.fileChangeId);
  });

  const appendFileChangeOutput = (input: {
    readonly event: Extract<ProviderRuntimeEvent, { type: "content.delta" }>;
    readonly threadId: ThreadId;
    readonly fileChangeId: OrchestrationFileChangeId;
    readonly providerItemId: ProviderItemId;
  }) =>
    Effect.sync(() => {
      const existing = pendingFileChanges.get(input.fileChangeId);
      const turnId = toTurnId(input.event.turnId);
      const nextState: PendingFileChangeState =
        existing ??
        ({
          id: input.fileChangeId,
          threadId: input.threadId,
          providerItemId: input.providerItemId,
          firstSeenAt: input.event.createdAt,
          turnId: turnId ?? null,
          title: null,
          detail: null,
          changedFiles: [],
          startedAt: null,
          completedAt: null,
          updatedAt: input.event.createdAt,
          exactPatch: "",
          bufferedOutput: "",
          bufferedOutputBytes: 0,
        } satisfies PendingFileChangeState);
      nextState.firstSeenAt =
        nextState.firstSeenAt <= input.event.createdAt
          ? nextState.firstSeenAt
          : input.event.createdAt;
      nextState.turnId = nextState.turnId ?? turnId ?? null;
      nextState.updatedAt =
        nextState.updatedAt >= input.event.createdAt ? nextState.updatedAt : input.event.createdAt;
      const appended = `${nextState.bufferedOutput}${input.event.payload.delta}`;
      const appendedBytes =
        nextState.bufferedOutputBytes + Buffer.byteLength(input.event.payload.delta, "utf8");
      if (appendedBytes > FILE_CHANGE_OUTPUT_TRUNCATE_THRESHOLD_BYTES) {
        const truncated = truncateMiddleByBytes(appended, {
          maxBytes: MAX_FILE_CHANGE_OUTPUT_BYTES,
          headBytes: FILE_CHANGE_OUTPUT_HEAD_BYTES,
          marker: FILE_CHANGE_OUTPUT_TRUNCATION_MARKER,
        }).output;
        nextState.bufferedOutput = truncated;
        nextState.bufferedOutputBytes = Buffer.byteLength(truncated, "utf8");
      } else {
        nextState.bufferedOutput = appended;
        nextState.bufferedOutputBytes = appendedBytes;
      }
      pendingFileChanges.set(input.fileChangeId, nextState);
    });

  const finalizePendingFileChanges = Effect.fnUntraced(function* (input: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly turnId?: TurnId;
    readonly status: Exclude<OrchestrationFileChangeStatus, "completed" | "declined">;
    readonly updatedAt: string;
    readonly commandTag: string;
  }) {
    const matchingChanges = [...pendingFileChanges.values()].filter(
      (fileChange) =>
        fileChange.threadId === input.threadId &&
        (input.turnId === undefined || fileChange.turnId === input.turnId),
    );

    for (const fileChange of matchingChanges) {
      if (!fileChange.turnId) {
        pendingFileChanges.delete(fileChange.id);
        continue;
      }
      yield* orchestrationEngine.dispatch({
        type: "thread.file-change.record",
        commandId: providerCommandId(input.event, `${input.commandTag}:${fileChange.id}`),
        threadId: fileChange.threadId,
        fileChange: {
          id: fileChange.id,
          turnId: fileChange.turnId,
          providerItemId: fileChange.providerItemId,
          title: fileChange.title,
          detail: fileChange.detail,
          status: input.status,
          changedFiles: [...fileChange.changedFiles],
          startedAt: fileChange.startedAt ?? fileChange.firstSeenAt,
          completedAt: input.updatedAt,
          updatedAt: input.updatedAt,
          patch: resolvedFileChangePatch(fileChange),
        },
        createdAt: input.updatedAt,
      });
      pendingFileChanges.delete(fileChange.id);
    }
  });

  const recordCommandExecutionLifecycle = Effect.fnUntraced(function* (input: {
    readonly event: Extract<
      ProviderRuntimeEvent,
      { type: "item.started" | "item.updated" | "item.completed" }
    >;
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly commandExecutionId: OrchestrationCommandExecutionId;
    readonly providerItemId: ProviderItemId;
  }) {
    const existing = openCommandExecutions.get(input.commandExecutionId);
    const pendingOutput = pendingCommandExecutionOutput.get(input.commandExecutionId);
    const status = commandExecutionStatusFromLifecycleEvent(input.event);
    const eventCwd = extractCommandExecutionCwd(input.event);
    const eventDescription = extractCommandExecutionDescription(input.event);
    const command = extractCommandExecutionCommand(input.event);
    const normalizedTitle = normalizeLifecycleCommandExecutionTitle(
      input.event.payload.title,
      command,
    );
    const fallbackCwd =
      eventCwd ?? existing?.cwd ?? (yield* resolveWorkspaceCwdForThread(input.threadId));
    const data = asRecord(input.event.payload.data);
    const nativeThreadId =
      input.event.provider === "codex"
        ? (asString(data?.threadId) ?? asString(data?.thread_id))
        : undefined;
    const commandExecution: OpenCommandExecutionState =
      existing ??
      ({
        id: input.commandExecutionId,
        threadId: input.threadId,
        turnId: input.turnId,
        providerItemId: input.providerItemId,
        ...(nativeThreadId ? { nativeThreadId } : {}),
        command,
        cwd: fallbackCwd,
        description: eventDescription,
        title: normalizedTitle ?? null,
        detail: input.event.payload.detail ?? null,
        status,
        exitCode: extractCommandExecutionExitCode(input.event),
        startedAt: input.event.createdAt,
        completedAt: null,
        updatedAt:
          pendingOutput === undefined
            ? input.event.createdAt
            : laterIsoTimestamp(input.event.createdAt, pendingOutput.updatedAt),
        bufferedOutput: pendingOutput?.bufferedOutput ?? "",
        flushTimer: null,
        pullRequestCreateOutput: null,
      } satisfies OpenCommandExecutionState);

    commandExecution.cwd = eventCwd ?? commandExecution.cwd ?? fallbackCwd;
    commandExecution.command =
      extractRawCommandExecutionCommand(input.event) ?? commandExecution.command;
    commandExecution.description = eventDescription ?? commandExecution.description;
    commandExecution.title = normalizedTitle ?? commandExecution.title;
    commandExecution.detail = input.event.payload.detail ?? commandExecution.detail;
    commandExecution.status = status;
    commandExecution.exitCode = extractCommandExecutionExitCode(input.event);
    commandExecution.updatedAt =
      pendingOutput === undefined
        ? input.event.createdAt
        : laterIsoTimestamp(input.event.createdAt, pendingOutput.updatedAt);
    commandExecution.completedAt =
      input.event.type === "item.completed" ? input.event.createdAt : commandExecution.completedAt;
    // Structured shell input can arrive after the item starts. Keep its full text,
    // even when later lifecycle events carry only a shortened display summary.
    // Output not flushed yet is still in `bufferedOutput`.
    if (
      commandExecution.pullRequestCreateOutput === null &&
      (commandCreatesPullRequest(commandExecution.command) ||
        commandCreatesPullRequest(commandExecution.detail))
    ) {
      commandExecution.pullRequestCreateOutput = appendPullRequestCreateOutput(
        "",
        commandExecution.bufferedOutput,
      );
    }
    openCommandExecutions.set(input.commandExecutionId, commandExecution);
    pendingCommandExecutionOutput.delete(input.commandExecutionId);

    yield* orchestrationEngine.dispatch({
      type: "thread.command-execution.record",
      commandId: providerCommandId(input.event, "thread-command-execution-record"),
      threadId: input.threadId,
      commandExecution: {
        id: commandExecution.id,
        turnId: commandExecution.turnId,
        providerItemId: commandExecution.providerItemId,
        command: commandExecution.command,
        cwd: commandExecution.cwd,
        ...(commandExecution.description ? { description: commandExecution.description } : {}),
        title: commandExecution.title,
        status: commandExecution.status,
        detail: commandExecution.detail,
        exitCode: commandExecution.exitCode,
        startedAt: commandExecution.startedAt,
        completedAt: commandExecution.completedAt,
        updatedAt: commandExecution.updatedAt,
      },
      createdAt: input.event.createdAt,
    });

    if (input.event.type === "item.completed") {
      yield* flushCommandExecutionOutput(input.commandExecutionId);
      yield* recordCreatedPullRequest(input.event, commandExecution);
    }
  });

  /**
   * Links the PR a completed `gh pr create` printed to its thread. Runs on completion and
   * again on output that arrives after it (Codex can stream the tail late), until a PR is
   * found. No network calls.
   */
  const recordCreatedPullRequest = Effect.fnUntraced(function* (
    event: ProviderRuntimeEvent,
    commandExecution: OpenCommandExecutionState,
  ) {
    if (
      commandExecution.pullRequestCreateOutput === null ||
      commandExecution.completedAt === null ||
      commandExecution.status !== "completed" ||
      (commandExecution.exitCode !== null && commandExecution.exitCode !== 0)
    )
      return;
    const allowedGitLabHosts = new Set(["gitlab.com"]);
    if (
      Option.isSome(forgeAccounts) &&
      commandExecution.pullRequestCreateOutput.includes("/-/merge_requests/")
    ) {
      const accounts = yield* forgeAccounts.value
        .listAccounts()
        .pipe(Effect.catch(() => Effect.succeed([])));
      for (const account of accounts)
        if (account.provider === "gitlab") allowedGitLabHosts.add(account.host);
    }
    const pullRequest = detectCreatedPullRequest({
      command: commandExecution.command,
      detail: commandExecution.detail,
      output: commandExecution.pullRequestCreateOutput,
      allowedGitLabHosts,
    });
    if (!pullRequest) return;
    commandExecution.pullRequestCreateOutput = null;
    if (
      pullRequest.provider === "gitlab" &&
      !(yield* serverSettings.getSettings).autoLinkShellCreatedMergeRequests
    )
      return;
    yield* orchestrationEngine
      .dispatch({
        type: "thread.meta.update",
        commandId: providerCommandId(event, "thread-pr-link"),
        threadId: commandExecution.threadId,
        pullRequest,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("could not link the pull request a command created", {
            threadId: commandExecution.threadId,
            pullRequest: pullRequest.url,
            error: String(error),
          }),
        ),
      );
  });

  const appendCommandExecutionOutput = Effect.fnUntraced(function* (input: {
    readonly event: Extract<ProviderRuntimeEvent, { type: "content.delta" }>;
    readonly commandExecutionId: OrchestrationCommandExecutionId;
  }) {
    const commandExecution = openCommandExecutions.get(input.commandExecutionId);
    if (!commandExecution) {
      const existingPendingOutput = pendingCommandExecutionOutput.get(input.commandExecutionId);
      let closedTurnId = closedCommandExecutionTurns.get(input.commandExecutionId);
      if (!closedTurnId && !existingPendingOutput) {
        // One lookup distinguishes a resumed command from output preceding its
        // lifecycle. Further pre-lifecycle chunks reuse the pending buffer.
        const persisted = yield* threadCommandExecutionQuery.getThreadCommandExecution({
          threadId: input.event.threadId,
          commandExecutionId: input.commandExecutionId,
        });
        if (persisted.commandExecution) {
          closedTurnId = persisted.commandExecution.turnId;
          rememberClosedCommandExecution(input.commandExecutionId, closedTurnId);
        }
      }
      if (closedTurnId && closedTurnId !== toTurnId(input.event.turnId)) {
        yield* Effect.logWarning("dropping command output attributed to a different turn", {
          eventId: input.event.eventId,
          commandExecutionId: input.commandExecutionId,
        });
        return;
      }
      if (closedTurnId) {
        yield* orchestrationEngine.dispatch({
          type: "thread.command-execution.output.append",
          commandId: providerCommandId(input.event, "late-command-output"),
          threadId: input.event.threadId,
          commandExecutionId: input.commandExecutionId,
          chunk: input.event.payload.delta,
          updatedAt: input.event.createdAt,
          createdAt: input.event.createdAt,
        });
        return;
      }
      pendingCommandExecutionOutput.set(input.commandExecutionId, {
        bufferedOutput: `${existingPendingOutput?.bufferedOutput ?? ""}${input.event.payload.delta}`,
        updatedAt:
          existingPendingOutput === undefined
            ? input.event.createdAt
            : laterIsoTimestamp(existingPendingOutput.updatedAt, input.event.createdAt),
      });
      return;
    }

    commandExecution.bufferedOutput = `${commandExecution.bufferedOutput}${input.event.payload.delta}`;
    commandExecution.updatedAt = input.event.createdAt;
    if (commandExecution.pullRequestCreateOutput !== null) {
      commandExecution.pullRequestCreateOutput = appendPullRequestCreateOutput(
        commandExecution.pullRequestCreateOutput,
        input.event.payload.delta,
      );
      yield* recordCreatedPullRequest(input.event, commandExecution);
    }

    if (
      Buffer.byteLength(commandExecution.bufferedOutput, "utf8") >=
      COMMAND_OUTPUT_BUFFER_FLUSH_BYTES
    ) {
      yield* flushCommandExecutionOutput(input.commandExecutionId);
      return;
    }

    scheduleCommandOutputFlush(input.commandExecutionId);
  });

  const finalizeOpenCommandExecutions = Effect.fnUntraced(function* (input: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly turnId?: TurnId;
    readonly nativeThreadId?: string;
    readonly excludeTurnId?: TurnId | null;
    readonly status: Exclude<
      OrchestrationCommandExecutionStatus,
      "running" | "completed" | "declined"
    >;
    readonly updatedAt: string;
    readonly commandTag: string;
  }) {
    const matchingExecutions = [...openCommandExecutions.values()].filter(
      (commandExecution) =>
        commandExecution.threadId === input.threadId &&
        (input.turnId === undefined || commandExecution.turnId === input.turnId) &&
        commandExecution.turnId !== input.excludeTurnId &&
        (input.nativeThreadId === undefined ||
          commandExecution.nativeThreadId === input.nativeThreadId) &&
        commandExecution.completedAt === null,
    );

    for (const commandExecution of matchingExecutions) {
      commandExecution.status = input.status;
      commandExecution.completedAt = input.updatedAt;
      commandExecution.updatedAt = input.updatedAt;
      yield* flushCommandExecutionOutput(commandExecution.id);
      yield* orchestrationEngine.dispatch({
        type: "thread.command-execution.record",
        commandId: providerCommandId(input.event, `${input.commandTag}:${commandExecution.id}`),
        threadId: commandExecution.threadId,
        commandExecution: {
          id: commandExecution.id,
          turnId: commandExecution.turnId,
          providerItemId: commandExecution.providerItemId,
          command: commandExecution.command,
          cwd: commandExecution.cwd,
          ...(commandExecution.description ? { description: commandExecution.description } : {}),
          title: commandExecution.title,
          status: commandExecution.status,
          detail: commandExecution.detail,
          exitCode: commandExecution.exitCode,
          startedAt: commandExecution.startedAt,
          completedAt: commandExecution.completedAt,
          updatedAt: commandExecution.updatedAt,
        },
        createdAt: input.updatedAt,
      });
      clearCommandExecutionFlushTimer(commandExecution);
      rememberClosedCommandExecution(commandExecution.id, commandExecution.turnId);
      openCommandExecutions.delete(commandExecution.id);
    }
  });

  const getSourceProposedPlanReferenceForPendingTurnStart = Effect.fnUntraced(function* (
    threadId: ThreadId,
  ) {
    const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
      threadId,
    });
    if (Option.isNone(pendingTurnStart)) {
      return null;
    }

    const sourceThreadId = pendingTurnStart.value.sourceProposedPlanThreadId;
    const sourcePlanId = pendingTurnStart.value.sourceProposedPlanId;
    if (sourceThreadId === null || sourcePlanId === null) {
      return null;
    }

    return {
      sourceThreadId,
      sourcePlanId,
    } as const;
  });

  const getExpectedProviderTurnIdForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const sessions = yield* providerService.listSessions();
    const session = sessions.find((entry) => entry.threadId === threadId);
    return session?.activeTurnId;
  });

  const getSourceProposedPlanReferenceForAcceptedTurnStart = Effect.fnUntraced(function* (
    threadId: ThreadId,
    eventTurnId: TurnId | undefined,
  ) {
    if (eventTurnId === undefined) {
      return null;
    }

    const expectedTurnId = yield* getExpectedProviderTurnIdForThread(threadId);
    if (!sameId(expectedTurnId, eventTurnId)) {
      return null;
    }

    return yield* getSourceProposedPlanReferenceForPendingTurnStart(threadId);
  });

  const markSourceProposedPlanImplemented = Effect.fnUntraced(function* (
    sourceThreadId: ThreadId,
    sourcePlanId: OrchestrationProposedPlanId,
    implementationThreadId: ThreadId,
    implementedAt: string,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const sourceThread = readModel.threads.find((entry) => entry.id === sourceThreadId);
    const sourcePlan = sourceThread?.proposedPlans.find((entry) => entry.id === sourcePlanId);
    if (!sourceThread || !sourcePlan || sourcePlan.implementedAt !== null) {
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.proposed-plan.upsert",
      commandId: CommandId.makeUnsafe(
        `provider:source-proposed-plan-implemented:${implementationThreadId}:${timeOrderedUuid()}`,
      ),
      threadId: sourceThread.id,
      proposedPlan: {
        ...sourcePlan,
        implementedAt,
        implementationThreadId,
        updatedAt: implementedAt,
      },
      createdAt: implementedAt,
    });
  });

  const backfillCodexAssistantMessagesFromProviderSnapshot = Effect.fnUntraced(function* (input: {
    readonly event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>;
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) {
    return yield* reconcileCodexThreadSnapshots(
      {
        orchestrationEngine,
        providerService,
        providerSessionDirectory,
        threadCommandExecutionQuery,
      },
      {
        threadIds: [input.threadId],
        reason: `turn-completed:${input.event.eventId}`,
        mode: "complete-or-extend",
        createdAt: input.event.createdAt,
        turnId: input.turnId,
      },
    );
  });

  const syncProviderBindingLifecycle = Effect.fnUntraced(function* (
    event: Extract<
      ProviderRuntimeEvent,
      { type: "turn.started" | "turn.completed" | "session.exited" }
    >,
  ) {
    const bindingOption = yield* providerSessionDirectory.getBinding(event.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding || binding.provider !== event.provider) {
      return;
    }
    if (
      event.providerInstanceId !== undefined &&
      binding.providerInstanceId !== undefined &&
      binding.providerInstanceId !== null &&
      binding.providerInstanceId !== event.providerInstanceId
    ) {
      return;
    }

    const activeTurnId = event.type === "turn.started" ? toTurnId(event.turnId) : null;
    if (event.type === "turn.started" && activeTurnId === undefined) {
      return;
    }

    if (isProviderTerminalRuntimeEvent(event)) {
      // A settlement for a retired turn has no generation of its own. Update
      // the binding only while it is still inactive and names that turn (or,
      // after a legacy shutdown, no turn); a live replacement or a binding
      // naming another turn is never touched.
      const orphaned = isOrphanedSessionExitEvent(event);
      const persistedTurnId = readPersistedActiveTurnId(binding.runtimePayload);
      if (
        orphaned &&
        (binding.status !== "stopped" ||
          event.turnId === undefined ||
          (persistedTurnId !== undefined && persistedTurnId !== event.turnId))
      )
        return;
      yield* providerSessionDirectory.updateTerminalLifecycleIfCurrent({
        threadId: event.threadId,
        instanceId: binding.providerInstanceId ?? ProviderInstanceId.makeUnsafe(binding.provider),
        generation: orphaned
          ? readPersistedSessionGeneration(binding.runtimePayload)
          : (event.sessionGeneration ?? 0),
        turnId: event.turnId ?? null,
        eventType: event.type,
        createdAt: event.createdAt,
      });
      return;
    }
    yield* providerSessionDirectory.upsert({
      threadId: event.threadId,
      provider: binding.provider,
      providerInstanceId: binding.providerInstanceId ?? event.providerInstanceId ?? null,
      status: "running",
      runtimePayload: {
        activeTurnId,
        lastRuntimeEvent: `provider.${event.type}`,
        lastRuntimeEventAt: event.createdAt,
      },
    });
  });

  /**
   * Read, reduce and dispatch one native Task tool event. The serial ingestion
   * worker orders events per thread; the generation fence in the decider covers
   * a revert landing between the read and the dispatch, in which case the
   * update is recomputed once from the post-revert snapshot.
   */
  /**
   * Read the oversize structured output a Task tool spilled to a thread
   * attachment, so a large TaskList can still resynchronize. Falls back to the
   * envelope as-is (the reducer then marks sync required) when the artifact is
   * missing, too large, or does not match its recorded checksum.
   */
  const hydrateTaskToolCompletion = (
    threadId: ThreadId,
    input: TaskToolLifecycleInput,
  ): Effect.Effect<TaskToolLifecycleInput> => {
    if (input.phase !== "completed") return Effect.succeed(input);
    const { completion } = input;
    const omission = completion.outputOmission;
    const artifact = omission?.artifact;
    if (
      completion.structuredOutput !== undefined ||
      omission?.reason !== "too-large" ||
      !artifact ||
      (omission.bytes ?? 0) > MAX_TASK_TOOL_ARTIFACT_BYTES ||
      !attachmentIdBelongsToThread(artifact.attachmentId, threadId)
    ) {
      return Effect.succeed(input);
    }
    const filePath = resolveAttachmentRelativePath({
      attachmentsDir: serverConfig.attachmentsDir,
      relativePath: `${artifact.attachmentId}.json`,
    });
    if (!filePath) return Effect.succeed(input);
    return Effect.tryPromise(() => NodeFs.readFile(filePath, "utf8")).pipe(
      Effect.map((json): TaskToolLifecycleInput => {
        if (Buffer.byteLength(json, "utf8") > MAX_TASK_TOOL_ARTIFACT_BYTES) return input;
        if (omission.sha256 && createHash("sha256").update(json).digest("hex") !== omission.sha256)
          return input;
        const { outputOmission: _omitted, ...rest } = completion;
        return { ...input, completion: { ...rest, structuredOutput: JSON.parse(json) as unknown } };
      }),
      Effect.catch((cause) =>
        Effect.logWarning("could not read native task tool output artifact", {
          threadId,
          attachmentId: artifact.attachmentId,
          cause: String(cause),
        }).pipe(Effect.as(input)),
      ),
    );
  };

  const applyTaskToolLifecycle = (input: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly input: TaskToolLifecycleInput;
    readonly now: string;
  }) =>
    Effect.gen(function* () {
      const lifecycle = yield* hydrateTaskToolCompletion(input.threadId, input.input);
      yield* applyTaskToolReduction({
        event: input.event,
        threadId: input.threadId,
        turnId: lifecycle.turnId,
        now: input.now,
        // Re-checked on every attempt: a revert that lands between the read
        // and the dispatch discards this turn, so the retry must not apply it.
        reduce: (thread) =>
          isDiscardedTaskToolTurn(thread, lifecycle.turnId)
            ? discardTaskToolCall(
                { tasks: thread.tasks, tracking: thread.tasksTracking ?? null },
                lifecycle,
              )
            : reduceTaskToolLifecycle(
                { tasks: thread.tasks, tracking: thread.tasksTracking ?? null },
                lifecycle,
              ),
      });
    });

  const applyTaskToolReduction = (input: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly now: string;
    readonly reduce: (
      thread: OrchestrationReadModel["threads"][number],
    ) => ReturnType<typeof reduceTaskToolLifecycle>;
  }) => {
    const attempt = (attemptIndex: 0 | 1) =>
      Effect.gen(function* () {
        const readModel = yield* orchestrationEngine.getReadModel();
        const current = readModel.threads.find((entry) => entry.id === input.threadId);
        if (!current) return "done" as const;
        const tracking = current.tasksTracking ?? null;
        const result = input.reduce(current);
        if (!result) return "done" as const;
        const invalid =
          validateThreadTasks(result.tasks) ?? validateThreadTaskTracking(result.tracking);
        if (invalid) {
          yield* Effect.logWarning("skipping invalid native task snapshot", {
            eventId: input.event.eventId,
            threadId: input.threadId,
            detail: invalid,
          });
          return "done" as const;
        }
        return yield* orchestrationEngine
          .dispatch({
            type: "thread.tasks.update",
            commandId: providerCommandId(
              input.event,
              attemptIndex === 0 ? "thread-task-tools-update" : "thread-task-tools-update-retry",
            ),
            threadId: input.threadId,
            tasks: result.tasks,
            ...(input.turnId ? { turnId: input.turnId } : {}),
            tracking: result.tracking,
            expectedTrackingGeneration: tracking?.generation ?? 0,
            createdAt: input.now,
          })
          .pipe(
            Effect.as("done" as const),
            Effect.catchTag("OrchestrationCommandInvariantError", (error) =>
              error.detail.startsWith("Stale task tracking generation")
                ? Effect.succeed("stale" as const)
                : Effect.fail(error),
            ),
          );
      });
    return Effect.gen(function* () {
      if ((yield* attempt(0)) === "done") return;
      if ((yield* attempt(1)) === "done") return;
      yield* Effect.logWarning("dropping native task update after repeated reverts", {
        eventId: input.event.eventId,
        threadId: input.threadId,
      });
    });
  };

  const processRuntimeEvent = (incomingEvent: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const coalescible =
        incomingEvent.type === "content.delta" &&
        coalescingEnabled &&
        COALESCE_STREAMING_DELTAS_DRIVERS.has(incomingEvent.provider) &&
        ["assistant_text", "reasoning_text", "reasoning_summary_text"].includes(
          incomingEvent.payload.streamKind,
        );
      if (!coalescible)
        yield* streamingDeltas.flushThread(incomingEvent.threadId).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("streaming flush failed before runtime event", {
                  threadId: incomingEvent.threadId,
                  cause: Cause.pretty(cause),
                }),
          ),
        );
      // An item update decides per activity below; anything else closes the update window.
      if (incomingEvent.type !== "item.updated") yield* flushToolUpdates(incomingEvent.threadId);
      let event = incomingEvent;
      const lookupStarted = probe ? performance.now() : 0;
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === event.threadId);
      probe?.("ingestion.threadLookup", performance.now() - lookupStarted);
      if (!thread || thread.deletedAt !== null) {
        streamingDeltas.forgetThread(incomingEvent.threadId);
        if (isProviderTerminalRuntimeEvent(incomingEvent))
          yield* providerTerminalEventRepository.markApplied(incomingEvent.eventId);
        return;
      }
      if (
        event.sessionGeneration !== undefined &&
        thread.compaction?.retiredSessionGeneration !== undefined &&
        event.sessionGeneration <= thread.compaction.retiredSessionGeneration
      ) {
        if (isProviderTerminalRuntimeEvent(event))
          yield* providerTerminalEventRepository.markApplied(event.eventId);
        return;
      }
      if (isProviderTerminalRuntimeEvent(event)) {
        const binding = Option.getOrUndefined(
          yield* providerSessionDirectory.getBinding(event.threadId),
        );
        const generation = readPersistedSessionGeneration(binding?.runtimePayload);
        const currentInstance = binding?.providerInstanceId ?? thread.session?.providerInstanceId;
        const runtimePayload = binding?.runtimePayload;
        if (
          event.sessionGeneration !== undefined &&
          runtimePayload &&
          typeof runtimePayload === "object" &&
          "compactionRetiredGeneration" in runtimePayload &&
          typeof runtimePayload.compactionRetiredGeneration === "number" &&
          event.sessionGeneration <= runtimePayload.compactionRetiredGeneration
        ) {
          yield* providerTerminalEventRepository.markApplied(event.eventId);
          return;
        }
        const legacyTurnMatches =
          event.turnId !== undefined &&
          (thread.session?.activeTurnId === event.turnId ||
            (thread.session?.activeTurnId == null && thread.latestTurn?.turnId === event.turnId));
        // F5's settlement for a turn whose provider is gone belongs to that
        // turn, not to a session: it applies only while the projection still
        // holds exactly that turn, whatever generation or instance replaced it,
        // and never to a later session whose latest (settled) turn it names.
        const staleOrigin = isOrphanedSessionExitEvent(event)
          ? event.turnId === undefined || thread.session?.activeTurnId !== event.turnId
          : (event.sessionGeneration === undefined
              ? !legacyTurnMatches
              : event.sessionGeneration !== generation) ||
            (event.providerInstanceId !== undefined &&
              currentInstance != null &&
              currentInstance !== event.providerInstanceId);
        if (staleOrigin) {
          // Retired output remains authoritative for its own turn. Finalize it
          // before acknowledging the receipt, without touching replacement state.
          const retiredTurns = new Set<TurnId>();
          if (event.turnId) retiredTurns.add(TurnId.makeUnsafe(event.turnId));
          else if (event.sessionGeneration !== undefined) {
            const prefix = `${thread.id}:`;
            for (const key of Array.from(yield* Cache.keys(runtimeOriginByTurnKey))) {
              if (!key.startsWith(prefix)) continue;
              const origin = Option.getOrUndefined(
                yield* Cache.getOption(runtimeOriginByTurnKey, key),
              );
              if (
                origin?.generation === event.sessionGeneration &&
                (event.providerInstanceId === undefined ||
                  origin.instanceId === event.providerInstanceId)
              )
                retiredTurns.add(TurnId.makeUnsafe(key.slice(prefix.length)));
            }
          }
          for (const turnId of retiredTurns) {
            if (thread.session?.activeTurnId === turnId) continue;
            const ids = new Set(yield* getAssistantMessageIdsForTurn(thread.id, turnId));
            for (const message of thread.messages)
              if (message.role === "assistant" && message.streaming && message.turnId === turnId)
                ids.add(message.id);
            for (const messageId of ids)
              yield* finalizeAssistantMessage({
                event,
                threadId: thread.id,
                threadMessages: thread.messages,
                messageId,
                turnId,
                createdAt: event.createdAt,
                commandTag: "retired-assistant-complete",
                finalDeltaCommandTag: "retired-assistant-flush",
              });
            yield* finalizeOpenCommandExecutions({
              event,
              threadId: thread.id,
              turnId,
              status:
                event.type === "turn.completed" && runtimeTurnState(event) === "failed"
                  ? "failed"
                  : "interrupted",
              updatedAt: event.createdAt,
              commandTag: "retired-command-finalize",
            });
            yield* finalizePendingFileChanges({
              event,
              threadId: thread.id,
              turnId,
              status: "interrupted",
              updatedAt: event.createdAt,
              commandTag: "retired-file-change-finalize",
            });
            yield* clearAssistantMessageIdsForTurn(thread.id, turnId);
            yield* Cache.invalidate(runtimeOriginByTurnKey, providerTurnKey(thread.id, turnId));
          }
          // Usage is historical and idempotent; lifecycle and thread-wide cleanup belong
          // only to the originating session. Never clear the replacement's active turn.
          const usageFact =
            event.type === "turn.completed"
              ? makeCompletedTurnUsageFact({ event, thread })
              : undefined;
          if (usageFact)
            yield* orchestrationEngine.dispatch({
              type: "thread.usage.record",
              commandId: providerCommandId(event, "thread-usage-record"),
              threadId: thread.id,
              usageFact,
              createdAt: event.createdAt,
            });
          yield* providerTerminalEventRepository.markApplied(event.eventId);
          return;
        }
      }
      if (
        !isProviderTerminalRuntimeEvent(event) &&
        event.sessionGeneration !== undefined &&
        (event.type.startsWith("session.") ||
          event.type === "thread.started" ||
          event.type === "thread.state.changed" ||
          event.type === "thread.token-usage.updated" ||
          event.type === "thread.thinking-tokens.updated" ||
          event.type === "turn.reasoning-tokens.reported" ||
          event.type === "compaction.recommended" ||
          event.type === "turn.started" ||
          event.type.startsWith("runtime.") ||
          event.type.startsWith("request.") ||
          event.type.startsWith("user-input."))
      ) {
        const binding = Option.getOrUndefined(
          yield* providerSessionDirectory.getBinding(event.threadId),
        );
        // Startup may emit requests before startSession publishes the new binding.
        // Prefer that admitted identity so retired events cannot pass during replacement.
        const starting = providerService.getStartingSessionIdentity?.(event.threadId);
        const generation =
          starting?.generation ?? readPersistedSessionGeneration(binding?.runtimePayload);
        const instance = starting?.instanceId ?? binding?.providerInstanceId;
        if (
          event.sessionGeneration !== generation ||
          (event.providerInstanceId !== undefined &&
            instance != null &&
            event.providerInstanceId !== instance)
        )
          return;
      }
      if (
        !isProviderTerminalRuntimeEvent(event) &&
        event.turnId &&
        event.sessionGeneration !== undefined
      )
        yield* Cache.set(
          runtimeOriginByTurnKey,
          providerTurnKey(thread.id, TurnId.makeUnsafe(event.turnId)),
          {
            generation: event.sessionGeneration,
            ...(event.providerInstanceId ? { instanceId: event.providerInstanceId } : {}),
          },
        );
      const previousLimit = thread.session?.usageLimit;
      if (
        (event.type === "runtime.error" || event.type === "turn.completed") &&
        event.payload?.usageLimit &&
        !event.payload.usageLimit.resetsAt &&
        event.turnId &&
        previousLimit?.turnId === event.turnId &&
        previousLimit.resetsAt
      ) {
        const usageLimit = {
          windows: previousLimit.windows,
          resetsAt: previousLimit.resetsAt,
          resetSource: previousLimit.resetSource,
          evidence: event.payload.usageLimit.evidence,
        };
        event =
          event.type === "runtime.error"
            ? { ...event, payload: { ...event.payload, usageLimit } }
            : { ...event, payload: { ...event.payload, usageLimit } };
      }

      yield* threadBackgroundWork.recordProviderEvent(event).pipe(
        Effect.catchCause((cause) =>
          increment(providerProjectionWriteFailuresTotal, {
            projection: "background_work",
            provider: event.provider,
            eventType: event.type,
          }).pipe(
            Effect.andThen(
              Effect.logWarning("provider runtime ingestion failed to persist background work", {
                eventId: event.eventId,
                eventType: event.type,
                threadId: event.threadId,
                cause: Cause.pretty(cause),
              }),
            ),
            Effect.andThen(
              isProviderTerminalRuntimeEvent(event) ? Effect.failCause(cause) : Effect.void,
            ),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        if (event.type !== "thread.started") {
          return;
        }

        const bindingOption = yield* providerSessionDirectory.getBinding(event.threadId);
        const binding = Option.getOrUndefined(bindingOption);
        const resumeCursorRefresh = nextResumeCursorFromThreadStartedEvent(
          event,
          binding?.resumeCursor,
        );
        if (resumeCursorRefresh === undefined) {
          return;
        }

        const invalidClaudeResumeToken = resumeCursorRefresh.ignoredInvalidClaudeResumeToken;
        if (invalidClaudeResumeToken?.preservedExistingResume) {
          yield* Effect.logInfo(
            "provider runtime ingestion preserved Claude resume cursor after invalid thread.started token",
            {
              eventId: event.eventId,
              threadId: event.threadId,
              reason: invalidClaudeResumeToken.reason,
            },
          );
        }

        yield* providerSessionDirectory.upsert({
          threadId: event.threadId,
          provider: event.provider,
          ...(thread.session?.runtimeMode ? { runtimeMode: thread.session.runtimeMode } : {}),
          resumeCursor: resumeCursorRefresh.resumeCursor,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider runtime ingestion failed to refresh resume cursor", {
            provider: event.provider,
            threadId: event.threadId,
            eventType: event.type,
            cause: Cause.pretty(cause),
          }),
        ),
      );

      yield* Effect.gen(function* () {
        if (event.type !== "thread.started" || event.provider !== "codex") {
          return;
        }

        const reconciliation = yield* reconcileCodexThreadSnapshots(
          {
            orchestrationEngine,
            providerService,
            providerSessionDirectory,
            threadCommandExecutionQuery,
          },
          {
            threadIds: [event.threadId],
            reason: `thread-started:${event.eventId}`,
            mode: "missing-only",
            createdAt: event.createdAt,
          },
        );
        if (reconciliation.candidateThreadCount > 0 || reconciliation.backfilledMessageCount > 0) {
          yield* Effect.logInfo(
            "provider runtime ingestion reconciled codex snapshot on thread start",
            {
              eventId: event.eventId,
              threadId: event.threadId,
              candidateThreadCount: reconciliation.candidateThreadCount,
              providerReadCount: reconciliation.providerReadCount,
              backfilledMessageCount: reconciliation.backfilledMessageCount,
            },
          );
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider runtime ingestion failed to reconcile codex snapshot", {
            provider: event.provider,
            threadId: event.threadId,
            eventType: event.type,
            cause: Cause.pretty(cause),
          }),
        ),
      );

      const now = event.createdAt;
      const eventTurnId = toTurnId(event.turnId);
      const activeTurnId = thread.session?.activeTurnId ?? null;
      const profiledTurnId = eventTurnId ?? activeTurnId ?? undefined;
      let workflowExecutionProfile =
        profiledTurnId && thread.latestTurn?.turnId === profiledTurnId
          ? thread.latestTurn.workflowExecutionProfile
          : profiledTurnId && thread.session?.activeTurnId === profiledTurnId
            ? thread.session.workflowExecutionProfile
            : undefined;
      if (
        workflowExecutionProfile === undefined &&
        (event.type === "turn.started" ||
          event.type === "request.opened" ||
          event.type === "user-input.requested")
      ) {
        workflowExecutionProfile = yield* readWorkflowExecutionProfileForThread(thread.id);
      }

      if (
        workflowExecutionProfile &&
        event.type === "request.opened" &&
        event.payload.autoDeclined === true &&
        profiledTurnId
      ) {
        // The adapter already refused this operation and told the model no; nothing ran and
        // nothing is pending. Killing the turn would discard the work it already did, so the
        // refusal is recorded and the stage only fails when the model keeps trying. The
        // watchdog stays armed: the turn is still unattended and time-bounded.
        const declined = yield* countAutoDeclinedRequest(
          thread.id,
          profiledTurnId,
          autoDeclinedOperationKey(event.payload.requestType, event.payload.detail),
        );
        // The raw command or URL stays out of the server log; it is in the thread's activity.
        yield* Effect.logInfo("read-only workflow stage attempted a refused operation", {
          threadId: thread.id,
          turnId: profiledTurnId,
          requestId: event.requestId,
          requestType: event.payload.requestType,
          declinedCount: declined.count,
          repeats: declined.repeats,
        });
        const stuck = declined.repeats >= MAX_REPEATS_OF_AN_AUTO_DECLINED_REQUEST;
        if (stuck || declined.count >= MAX_AUTO_DECLINED_REQUESTS_PER_TURN) {
          const detail = profileViolationDetail(event.payload.detail);
          const operation = `${event.payload.requestType}${detail ? `: ${detail}` : ""}`;
          yield* clearProfiledTurnWatchdog(thread.id, profiledTurnId);
          yield* clearAutoDeclinedRequests(thread.id, profiledTurnId);
          yield* recordProfiledTurnFailure({
            threadId: thread.id,
            turnId: profiledTurnId,
            error: stuck
              ? `Workflow read-only profile violation: the provider asked ${declined.repeats} times for the same operation, which is not allowed in a read-only stage (${operation}). The turn was interrupted.`
              : `Workflow read-only profile violation: the provider attempted ${declined.count} operations that are not allowed in a read-only stage (last: ${operation}). The turn was interrupted.`,
            retryable: false,
            createdAt: now,
          });
          return;
        }
      } else if (workflowExecutionProfile && event.type === "request.opened" && profiledTurnId) {
        if (event.requestId !== undefined) {
          yield* providerService
            .respondToRequest({
              threadId: thread.id,
              requestId: ApprovalRequestId.makeUnsafe(String(event.requestId)),
              decision: "decline",
            })
            .pipe(
              // An adapter that settled the request itself registered no pending entry.
              Effect.catchTag("ProviderAdapterRequestError", (error) =>
                Effect.logDebug("profiled workflow approval request had no pending entry", {
                  threadId: thread.id,
                  turnId: profiledTurnId,
                  requestId: event.requestId,
                  detail: error.detail,
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to decline profiled workflow approval request", {
                  threadId: thread.id,
                  turnId: profiledTurnId,
                  requestId: event.requestId,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
        }
        const detail = profileViolationDetail(event.payload.detail);
        yield* clearProfiledTurnWatchdog(thread.id, profiledTurnId);
        yield* recordProfiledTurnFailure({
          threadId: thread.id,
          turnId: profiledTurnId,
          error: `Workflow read-only profile violation: provider requested '${event.payload.requestType}'${detail ? ` (${detail})` : ""}. The attempted operation was declined and the turn was interrupted.`,
          retryable: false,
          createdAt: now,
        });
        return;
      }
      if (
        workflowExecutionProfile === "unattended-readonly" &&
        event.type === "user-input.requested" &&
        event.payload.responseMode !== "message" &&
        profiledTurnId
      ) {
        // An unattended stage has no reply path, but asking once is a
        // recoverable mistake, not a fatal one: killing the turn discards all
        // the work it already completed. Settle the request with empty answers
        // so the provider unblocks and can choose a conservative default.
        //
        // The watchdog is deliberately NOT cleared here — unlike the attended
        // case below, this turn is still unattended and must stay time-bounded.
        const declineCount = yield* countUnattendedDecline(thread.id, profiledTurnId);
        yield* Effect.logInfo("unattended workflow stage attempted to ask a question", {
          threadId: thread.id,
          turnId: profiledTurnId,
          requestId: event.requestId,
          declineCount,
        });
        const elicitation = event.payload.elicitation;
        if (event.requestId !== undefined && elicitation) {
          // A form request is cancelled, never answered: there is nobody to
          // supply its values. Claude already cancelled it in the adapter, so
          // a refusal here is expected.
          yield* providerService
            .respondToElicitation({
              threadId: thread.id,
              requestId: ApprovalRequestId.makeUnsafe(String(event.requestId)),
              generation: elicitation.generation ?? 0,
              action: "cancel",
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logDebug("unattended workflow elicitation was not cancelled", {
                  threadId: thread.id,
                  turnId: profiledTurnId,
                  requestId: event.requestId,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
        } else if (event.requestId !== undefined) {
          // Codex and OpenCode have no adapter-side short-circuit and depend on
          // this to unblock. Claude and Cursor already declined synchronously
          // and registered no pending entry, so for them this call fails with
          // `ProviderAdapterRequestError` ("Unknown pending user-input
          // request") — an expected outcome on the success path, not a fault.
          yield* providerService
            .respondToUserInput({
              threadId: thread.id,
              requestId: ApprovalRequestId.makeUnsafe(String(event.requestId)),
              answers: {},
            })
            .pipe(
              Effect.catchTag("ProviderAdapterRequestError", (error) =>
                Effect.logDebug("unattended workflow user input had no pending request", {
                  threadId: thread.id,
                  turnId: profiledTurnId,
                  requestId: event.requestId,
                  detail: error.detail,
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to settle unattended workflow user input", {
                  threadId: thread.id,
                  turnId: profiledTurnId,
                  requestId: event.requestId,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
        }
        // A model that keeps re-asking after each empty answer would otherwise
        // loop until the watchdog fires. Fail the stage once the allowance is
        // spent so the failure is loud and attributable.
        if (declineCount >= MAX_UNATTENDED_DECLINES_PER_TURN) {
          yield* clearProfiledTurnWatchdog(thread.id, profiledTurnId);
          yield* clearUnattendedDeclines(thread.id, profiledTurnId);
          yield* recordProfiledTurnFailure({
            threadId: thread.id,
            turnId: profiledTurnId,
            error: `Workflow unattended read-only profile violation: the provider requested user input ${declineCount} times even though no reply path exists. The turn was interrupted.`,
            retryable: false,
            createdAt: now,
          });
          return;
        }
      }
      if (
        workflowExecutionProfile === "attended-readonly" &&
        event.type === "user-input.requested" &&
        isBlockingUserInput(event.payload) &&
        profiledTurnId
      ) {
        // A pending author/investigator question is intentionally unbounded by
        // the execution watchdog. The persisted request is itself the user
        // notification and remains visible until answered.
        yield* clearProfiledTurnWatchdog(thread.id, profiledTurnId);
      }

      const conflictsWithActiveTurn =
        activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
      const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;
      // A turn F5 failed under a read-only workflow profile stays failed. A provider that ignores
      // the interrupt can still finish it normally; that completion must not settle the session
      // as ready and let the workflow consume the failed stage's output.
      const settlesProfileFailedTurn =
        (event.type === "turn.started" || event.type === "turn.completed") &&
        eventTurnId !== undefined &&
        isProfileFailedTurn(thread, eventTurnId);
      // Nor may a generic `ready`/`running` report or a session/thread start notification from
      // that provider clear the failure while no new turn has started: the session would read as
      // healthy, and a `ready` session lets the projection repair the errored turn as completed.
      const reopensProfileFailedSession =
        activeTurnId === null &&
        (event.type === "session.started" ||
          event.type === "thread.started" ||
          (event.type === "session.state.changed" &&
            ["ready", "running", "starting", "interrupted"].includes(
              orchestrationSessionStatusFromRuntimeState(event.payload.state),
            ))) &&
        hasProfileFailedTurn(thread);

      const shouldApplyThreadLifecycle = (() => {
        if (settlesProfileFailedTurn || reopensProfileFailedSession) {
          return false;
        }
        if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
          return true;
        }
        switch (event.type) {
          case "session.exited":
            return true;
          case "session.started":
          case "thread.started":
            return true;
          case "turn.started":
            return !conflictsWithActiveTurn;
          case "turn.completed":
            if (conflictsWithActiveTurn || missingTurnForActiveTurn) {
              return false;
            }
            // Only the active turn may close the lifecycle state.
            if (activeTurnId !== null && eventTurnId !== undefined) {
              return sameId(activeTurnId, eventTurnId);
            }
            // Without an active turn, only a named completion can establish ownership.
            // Resume handshakes must not overwrite a pending turn's starting state.
            return eventTurnId !== undefined;
          default:
            return true;
        }
      })();
      if (
        event.type === "turn.started" &&
        event.turnId &&
        shouldApplyThreadLifecycle &&
        Option.isSome(computerAutomationBroker)
      )
        computerAutomationBroker.value.beginTurn(thread.id, event.turnId);
      const acceptedTurnStartedSourcePlan =
        event.type === "turn.started" && shouldApplyThreadLifecycle
          ? yield* getSourceProposedPlanReferenceForAcceptedTurnStart(thread.id, eventTurnId)
          : null;
      const completedTurnUsageFact =
        event.type === "turn.completed" ? makeCompletedTurnUsageFact({ event, thread }) : undefined;

      if (
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        event.type === "turn.completed"
      ) {
        const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
          threadId: thread.id,
        });
        const hasPendingTurnStart =
          Option.isSome(pendingTurnStart) && thread.session?.status === "starting";
        const reportedStatus = (() => {
          switch (event.type) {
            case "session.state.changed": {
              const status = orchestrationSessionStatusFromRuntimeState(event.payload.state);
              return hasPendingTurnStart && status === "ready" ? "starting" : status;
            }
            case "turn.started":
              return "running";
            case "session.exited":
              return "stopped";
            case "turn.completed":
              return runtimeTurnState(event) === "failed" ? "error" : "ready";
            case "session.started":
            case "thread.started":
              // Provider thread/session start notifications can arrive during an
              // active turn; preserve turn-running state in that case.
              return activeTurnId !== null ? "running" : hasPendingTurnStart ? "starting" : "ready";
          }
        })();
        // Providers can emit generic `ready` transitions for setup milestones
        // while a turn is still running (Codex does this after Windows sandbox
        // setup). Only explicit terminal events may settle an active turn.
        const status =
          event.type === "session.state.changed" &&
          activeTurnId !== null &&
          reportedStatus === "ready"
            ? "running"
            : reportedStatus;
        const nextActiveTurnId =
          event.type === "turn.started"
            ? (eventTurnId ?? null)
            : event.type === "turn.completed" || event.type === "session.exited"
              ? null
              : event.type === "session.state.changed" &&
                  reportedStatus !== "starting" &&
                  reportedStatus !== "running" &&
                  reportedStatus !== "ready"
                ? null
                : activeTurnId;
        const lastError =
          event.type === "session.state.changed" && event.payload.state === "error"
            ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
            : event.type === "turn.completed" && runtimeTurnState(event) === "failed"
              ? (runtimeTurnErrorMessage(event) ?? thread.session?.lastError ?? "Turn failed")
              : status === "ready"
                ? null
                : (thread.session?.lastError ?? null);
        const isNewFailure =
          (event.type === "session.state.changed" && event.payload.state === "error") ||
          (event.type === "turn.completed" && runtimeTurnState(event) === "failed");
        const lastErrorId =
          lastError === null
            ? null
            : isNewFailure
              ? event.eventId
              : (thread.session?.lastErrorId ?? event.eventId);
        const lastErrorOccurredAt =
          lastError === null
            ? null
            : isNewFailure
              ? now
              : (thread.session?.lastErrorOccurredAt ?? now);
        // Settling a turn must not hide that sends are still fenced by an
        // incomplete-history marker.
        const incompleteHistory =
          shouldApplyThreadLifecycle && lastError === null
            ? yield* providerSessionDirectory.getBinding(thread.id).pipe(
                Effect.map((binding) =>
                  readIncompleteHistory(Option.getOrUndefined(binding)?.runtimePayload),
                ),
                Effect.orElseSucceed(() => undefined),
              )
            : undefined;

        if (shouldApplyThreadLifecycle) {
          // Reset the live thinking-token estimate at turn boundaries so each turn
          // starts blank and the throttle baseline restarts from 0.
          const resetThinkingTokens =
            event.type === "turn.started" || event.type === "turn.completed";
          if (resetThinkingTokens) {
            yield* Cache.set(lastThinkingTokensByThread, thread.id, 0);
          }
          const turnCostUsd =
            event.type === "turn.completed" ? event.payload?.totalCostUsd : undefined;
          // This dispatch carries the latest context-token report that was not persisted on
          // its own, so no separate event is needed for it.
          const heldContextTokens = yield* Cache.get(pendingContextTokensByThread, thread.id);
          if (heldContextTokens !== null) {
            yield* Cache.set(pendingContextTokensByThread, thread.id, null);
          }
          const pendingContextTokens = currentPendingContextTokens(heldContextTokens, thread);
          const providerReportedContextTokens =
            event.type === "turn.completed" ? extractTurnCompletedContextTokens(event) : undefined;
          const estimatedContextTokens =
            mergeProviderReportedContextTokens({
              provider: event.provider,
              eventType: "turn.completed",
              providerReportedContextTokens,
              previousEstimatedContextTokens:
                pendingContextTokens?.estimatedContextTokens ??
                thread.estimatedContextTokens ??
                null,
            }) ?? pendingContextTokens?.estimatedContextTokens;
          const tokenUsageSource =
            estimatedContextTokens === undefined
              ? undefined
              : providerReportedContextTokens === undefined
                ? pendingContextTokens?.tokenUsageSource
                : estimatedContextTokens === providerReportedContextTokens
                  ? ("provider" as const)
                  : ("estimated" as const);
          if (event.type === "turn.started" && acceptedTurnStartedSourcePlan !== null) {
            yield* markSourceProposedPlanImplemented(
              acceptedTurnStartedSourcePlan.sourceThreadId,
              acceptedTurnStartedSourcePlan.sourcePlanId,
              thread.id,
              now,
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "provider runtime ingestion failed to mark source proposed plan",
                  {
                    eventId: event.eventId,
                    eventType: event.type,
                    cause: Cause.pretty(cause),
                  },
                ),
              ),
            );
          }

          if (event.type === "turn.completed") {
            const command = makeTurnCompletedSessionSetCommand({ event, thread, createdAt: now });
            yield* orchestrationEngine.dispatch({
              ...command,
              session: retainIncompleteHistoryError(
                // Without a pending report this repeats the command's own values.
                estimatedContextTokens !== undefined
                  ? { ...command.session, estimatedContextTokens, tokenUsageSource }
                  : command.session,
                thread.session,
                incompleteHistory,
                now,
              ),
            });
          } else {
            yield* orchestrationEngine.dispatch({
              type: "thread.session.set",
              commandId: providerCommandId(event, "thread-session-set"),
              threadId: thread.id,
              ...(event.type === "session.exited" && activeTurnId !== null
                ? { settledTurnId: activeTurnId }
                : {}),
              session: retainIncompleteHistoryError(
                {
                  threadId: thread.id,
                  status,
                  providerName: event.provider,
                  providerInstanceId:
                    event.providerInstanceId ?? thread.session?.providerInstanceId ?? null,
                  runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
                  ...(workflowExecutionProfile ? { workflowExecutionProfile } : {}),
                  activeTurnId: nextActiveTurnId,
                  lastError,
                  lastErrorId,
                  lastErrorOccurredAt,
                  ...(turnCostUsd !== undefined ? { turnCostUsd } : {}),
                  ...(estimatedContextTokens !== undefined
                    ? { estimatedContextTokens, tokenUsageSource }
                    : {}),
                  ...(resetThinkingTokens ? { estimatedThinkingTokens: 0 } : {}),
                  updatedAt: now,
                },
                thread.session,
                incompleteHistory,
                now,
              ),
              createdAt: now,
            });
          }
        }
      }

      if (
        event.type === "turn.completed" &&
        settlesProfileFailedTurn &&
        thread.session &&
        event.payload?.totalCostUsd !== undefined
      ) {
        yield* forwardProfileFailedTurnCost(
          thread,
          thread.session,
          event.eventId,
          event.payload.totalCostUsd,
          now,
        );
      }
      if (
        event.type === "turn.started" &&
        shouldApplyThreadLifecycle &&
        eventTurnId !== undefined
      ) {
        // A new turn supersedes the failed one; only that turn's late events stay ignored, and the
        // session now running the new turn must not be stopped on the old one's behalf.
        profileFailedTurns.delete(thread.id);
        const pendingStop = profiledFailureStopTimers.get(thread.id);
        if (pendingStop && !sameId(pendingStop.turnId, eventTurnId))
          yield* clearProfiledFailureStopTimer(thread.id);
      }
      if (
        event.type === "turn.started" &&
        shouldApplyThreadLifecycle &&
        eventTurnId !== undefined &&
        workflowExecutionProfile !== undefined
      ) {
        yield* scheduleProfiledTurnWatchdog({
          threadId: thread.id,
          turnId: eventTurnId,
          startedAt: now,
        });
      }
      if (
        (event.type === "turn.completed" || event.type === "turn.aborted") &&
        eventTurnId !== undefined
      ) {
        yield* clearProfiledTurnWatchdog(thread.id, eventTurnId);
        yield* clearUnattendedDeclines(thread.id, eventTurnId);
        yield* clearAutoDeclinedRequests(thread.id, eventTurnId);
        // The provider did settle the failed turn, even though the projection ignores it.
        yield* clearProfiledFailureStopTimer(thread.id, eventTurnId);
      }
      if (event.type === "session.exited") {
        yield* clearProfiledTurnWatchdog(thread.id);
        yield* clearUnattendedDeclines(thread.id);
        yield* clearAutoDeclinedRequests(thread.id);
        yield* clearProfiledFailureStopTimer(thread.id);
      }

      if (
        event.type === "turn.started" ||
        event.type === "turn.completed" ||
        event.type === "session.exited"
      ) {
        const syncBinding = syncProviderBindingLifecycle(event);
        yield* isProviderTerminalRuntimeEvent(event)
          ? syncBinding
          : syncBinding.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("provider runtime ingestion failed to sync provider binding", {
                  eventId: event.eventId,
                  eventType: event.type,
                  threadId: event.threadId,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
      }

      // Lifecycle settlement happens first, but the durable receipt remains
      // pending until every replay-critical projection has succeeded. Command
      // ids are deterministic, so a replay safely fills in any work that
      // failed after the session itself was settled.
      if (completedTurnUsageFact !== undefined) {
        yield* orchestrationEngine
          .dispatch({
            type: "thread.usage.record",
            commandId: providerCommandId(event, "thread-usage-record"),
            threadId: thread.id,
            usageFact: completedTurnUsageFact,
            createdAt: now,
          })
          .pipe(
            Effect.catchCause((cause) =>
              increment(providerProjectionWriteFailuresTotal, {
                projection: "usage",
                provider: event.provider,
                eventType: event.type,
              }).pipe(Effect.andThen(Effect.failCause(cause))),
            ),
          );
      }

      if (event.type === "thread.state.changed" && event.payload.state === "closed") {
        if (event.provider === "codex") {
          const detail = asRecord(event.payload.detail);
          const nativeThreadId = asString(detail?.threadId) ?? asString(detail?.thread_id);
          if (nativeThreadId) {
            yield* finalizeOpenCommandExecutions({
              event,
              threadId: thread.id,
              nativeThreadId,
              excludeTurnId:
                activeTurnId ??
                (thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : null),
              status: "interrupted",
              updatedAt: now,
              commandTag: "command-execution-thread-closed-finalize",
            });
          }
        }
        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: providerCommandId(event, "thread-provider-state-set"),
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "stopped",
            providerName: event.provider,
            providerInstanceId:
              event.providerInstanceId ?? thread.session?.providerInstanceId ?? null,
            runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
            activeTurnId: null,
            lastError: null,
            lastErrorId: null,
            lastErrorOccurredAt: null,
            updatedAt: now,
          },
          createdAt: now,
        });
      }

      if (event.type === "thread.thinking-tokens.updated") {
        const estimatedThinkingTokens = event.payload.estimatedTokens;
        const lastDispatched = yield* Cache.get(lastThinkingTokensByThread, thread.id);
        // Coalesce high-frequency frames: dispatch only when the estimate grows
        // past the threshold, or drops (a new thinking block within the turn).
        const grewPastThreshold =
          estimatedThinkingTokens >= lastDispatched + THINKING_TOKENS_DISPATCH_THRESHOLD;
        const droppedToNewBlock = estimatedThinkingTokens < lastDispatched;
        if (grewPastThreshold || droppedToNewBlock) {
          yield* Cache.set(lastThinkingTokensByThread, thread.id, estimatedThinkingTokens);
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "thread-thinking-tokens-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: thread.session?.status ?? "ready",
              providerName: event.provider,
              providerInstanceId:
                event.providerInstanceId ?? thread.session?.providerInstanceId ?? null,
              runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
              activeTurnId: thread.session?.activeTurnId ?? null,
              lastError: thread.session?.lastError ?? null,
              lastErrorId: thread.session?.lastErrorId ?? null,
              lastErrorOccurredAt: thread.session?.lastErrorOccurredAt ?? null,
              estimatedThinkingTokens,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      if (event.type === "turn.reasoning-tokens.reported") {
        const turnId = toTurnId(event.turnId);
        if (turnId && event.payload.tokens > 0) {
          const turnKey = providerTurnKey(thread.id, turnId);
          const recipient = Option.getOrNull(
            yield* Cache.getOption(reasoningRecipientByTurnKey, turnKey),
          );
          if (recipient === null || (yield* hasBufferedReasoningText(turnKey))) {
            yield* addPendingReasoningTokens(
              turnKey,
              event.payload.tokens,
              event.payload.estimated,
            );
          } else {
            yield* Cache.invalidate(reasoningRecipientByTurnKey, turnKey);
            yield* dispatchReasoningTokens({
              event,
              threadId: thread.id,
              turnId,
              messageId: recipient,
              tokens: { tokens: event.payload.tokens, estimated: event.payload.estimated },
              tag: "report",
            });
          }
        }
      }

      if (event.type === "thread.token-usage.updated") {
        const normalizedContextTokens = event.payload.contextTokens;
        const providerReportedContextTokens =
          normalizedContextTokens ?? extractThreadTokenUsageContextTokens(event.payload?.usage);
        const storedContextTokens = thread.estimatedContextTokens ?? null;
        const pendingContextTokens = currentPendingContextTokens(
          yield* Cache.get(pendingContextTokensByThread, thread.id),
          thread,
        );
        const estimatedContextTokens = mergeProviderReportedContextTokens({
          provider: event.provider,
          eventType: "thread.token-usage.updated",
          providerReportedContextTokens,
          // An unpersisted report is still the previous value this one builds on.
          previousEstimatedContextTokens:
            pendingContextTokens?.estimatedContextTokens ?? storedContextTokens,
          authoritativeSnapshot: normalizedContextTokens !== undefined,
        });
        const modelContextWindowTokens = event.payload.modelContextWindowTokens;
        const autoCompactThreshold = event.payload.autoCompactThreshold ?? null;
        const tokenUsageSource =
          estimatedContextTokens === providerReportedContextTokens
            ? ("provider" as const)
            : ("estimated" as const);
        // Only a running turn is certain to end in a lifecycle dispatch that carries the
        // report; a changed source or context window is persisted at once.
        const persistedLater =
          estimatedContextTokens !== undefined &&
          storedContextTokens !== null &&
          thread.session?.status === "running" &&
          thread.session.activeTurnId !== null &&
          thread.session.tokenUsageSource === tokenUsageSource &&
          autoCompactThreshold === (thread.session.autoCompactThreshold ?? null) &&
          (modelContextWindowTokens === undefined ||
            modelContextWindowTokens === thread.session.modelContextWindowTokens) &&
          Math.abs(estimatedContextTokens - storedContextTokens) <
            contextTokensDispatchThreshold(
              modelContextWindowTokens ?? thread.session.modelContextWindowTokens ?? null,
            );
        if (estimatedContextTokens !== undefined) {
          yield* Cache.set(
            pendingContextTokensByThread,
            thread.id,
            persistedLater
              ? { estimatedContextTokens, tokenUsageSource, storedContextTokens }
              : null,
          );
        }
        if (
          !persistedLater &&
          (estimatedContextTokens !== undefined || modelContextWindowTokens !== undefined)
        ) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "thread-token-usage-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: thread.session?.status ?? "ready",
              providerName: event.provider,
              providerInstanceId:
                event.providerInstanceId ?? thread.session?.providerInstanceId ?? null,
              runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
              activeTurnId: thread.session?.activeTurnId ?? null,
              lastError: thread.session?.lastError ?? null,
              lastErrorId: thread.session?.lastErrorId ?? null,
              lastErrorOccurredAt: thread.session?.lastErrorOccurredAt ?? null,
              ...(estimatedContextTokens !== undefined
                ? { estimatedContextTokens, tokenUsageSource }
                : {}),
              ...(modelContextWindowTokens !== undefined ? { modelContextWindowTokens } : {}),
              autoCompactThreshold,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      const commandExecutionLifecycleEvent =
        (event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed") &&
        event.payload.itemType === "command_execution"
          ? event
          : undefined;

      if (commandExecutionLifecycleEvent) {
        if (!event.itemId) {
          yield* Effect.logWarning(
            "skipping command transcript lifecycle event without provider item id",
            {
              eventId: event.eventId,
              eventType: event.type,
              threadId: thread.id,
            },
          );
        } else {
          const turnId = eventTurnId ?? activeTurnId ?? undefined;
          if (!turnId) {
            yield* Effect.logWarning(
              "skipping command transcript lifecycle event without turn id",
              {
                eventId: event.eventId,
                eventType: event.type,
                threadId: thread.id,
                itemId: event.itemId,
              },
            );
          } else {
            yield* recordCommandExecutionLifecycle({
              event: commandExecutionLifecycleEvent,
              threadId: thread.id,
              turnId,
              commandExecutionId: commandExecutionIdForRuntimeItem(thread.id, event.itemId),
              providerItemId: ProviderItemId.makeUnsafe(event.itemId),
            });
          }
        }
      }

      const fileChangeLifecycleEvent =
        (event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed") &&
        event.payload.itemType === "file_change"
          ? event
          : undefined;

      if (fileChangeLifecycleEvent) {
        if (!event.itemId) {
          yield* Effect.logWarning(
            "skipping file-change lifecycle event without provider item id",
            {
              eventId: event.eventId,
              eventType: event.type,
              threadId: thread.id,
            },
          );
        } else {
          const fileChangeId = fileChangeIdForRuntimeItem(thread.id, event.itemId);
          const turnId =
            eventTurnId ??
            activeTurnId ??
            pendingFileChanges.get(fileChangeId)?.turnId ??
            undefined;
          if (!turnId) {
            yield* Effect.logWarning("skipping file-change lifecycle event without turn id", {
              eventId: event.eventId,
              eventType: event.type,
              threadId: thread.id,
              itemId: event.itemId,
            });
          } else {
            yield* recordFileChangeLifecycle({
              event: fileChangeLifecycleEvent,
              threadId: thread.id,
              turnId,
              fileChangeId,
              providerItemId: ProviderItemId.makeUnsafe(event.itemId),
            });
          }
        }
      }

      if (event.type === "content.delta" && event.payload.streamKind === "command_output") {
        if (!event.itemId) {
          yield* Effect.logWarning("dropping command output without provider item id", {
            eventId: event.eventId,
            threadId: thread.id,
          });
        } else {
          yield* appendCommandExecutionOutput({
            event,
            commandExecutionId: commandExecutionIdForRuntimeItem(thread.id, event.itemId),
          });
        }
      }

      if (event.type === "content.delta" && event.payload.streamKind === "file_change_output") {
        if (!event.itemId) {
          yield* Effect.logWarning("dropping file-change output without provider item id", {
            eventId: event.eventId,
            threadId: thread.id,
          });
        } else {
          yield* appendFileChangeOutput({
            event,
            threadId: thread.id,
            fileChangeId: fileChangeIdForRuntimeItem(thread.id, event.itemId),
            providerItemId: ProviderItemId.makeUnsafe(event.itemId),
          });
        }
      }

      const todoWriteTasks =
        event.type === "item.started" ||
        event.type === "item.updated" ||
        event.type === "item.completed"
          ? extractTodoWriteTasksFromLifecycleEvent(event)
          : undefined;
      if (todoWriteTasks !== undefined) {
        const taskValidationError = validateThreadTasks(todoWriteTasks);
        if (taskValidationError) {
          yield* Effect.logWarning("skipping invalid TodoWrite task snapshot", {
            eventId: event.eventId,
            eventType: event.type,
            threadId: thread.id,
            detail: taskValidationError,
          });
        } else if (!areTaskListsEqual(thread.tasks, todoWriteTasks) || thread.tasksTracking) {
          yield* orchestrationEngine.dispatch({
            type: "thread.tasks.update",
            commandId: providerCommandId(event, "thread-tasks-update"),
            threadId: thread.id,
            tasks: [...todoWriteTasks],
            ...(eventTurnId ? { turnId: eventTurnId } : {}),
            // A TodoWrite snapshot replaces native Task tool state entirely.
            ...(thread.tasksTracking ? { tracking: null } : {}),
            createdAt: now,
          });
        }
      }

      const taskToolInput =
        event.type === "item.started" || event.type === "item.completed"
          ? taskToolLifecycleInput(event, eventTurnId ?? null)
          : undefined;
      if (taskToolInput) {
        yield* applyTaskToolLifecycle({ event, threadId: thread.id, input: taskToolInput, now });
      }
      // A session that ends or (re)starts can no longer deliver results for
      // calls still pending, e.g. after a crash that never sent item.completed.
      if (
        (event.type === "session.started" || event.type === "session.exited") &&
        (thread.tasksTracking?.pendingCalls.length ?? 0) > 0
      ) {
        yield* applyTaskToolReduction({
          event,
          threadId: thread.id,
          turnId: null,
          now,
          reduce: (current) =>
            abandonPendingTaskToolCalls({
              tasks: current.tasks,
              tracking: current.tasksTracking ?? null,
            }),
        });
      }

      if (event.type === "compaction.recommended") {
        yield* orchestrationEngine.dispatch({
          type: "thread.compact.request",
          commandId: providerCommandId(event, "thread-compact-request"),
          threadId: thread.id,
          trigger: "automatic",
          createdAt: now,
        });
      }

      // Progress only: a failed status write must not drop the event's content.
      yield* applyReasoningStatus(event, thread).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider runtime ingestion failed to update reasoning status", {
            eventId: event.eventId,
            threadId: thread.id,
            cause: Cause.pretty(cause),
          }),
        ),
      );

      const assistantDelta =
        event.type === "content.delta" && event.payload.streamKind === "assistant_text"
          ? event.payload.delta
          : undefined;
      const reasoningDelta =
        event.type === "content.delta" &&
        (event.payload.streamKind === "reasoning_text" ||
          event.payload.streamKind === "reasoning_summary_text")
          ? event.payload.delta
          : undefined;
      const proposedPlanDelta =
        event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

      if (assistantDelta && assistantDelta.length > 0) {
        const assistantMessageId = MessageId.makeUnsafe(
          `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
        );
        const existingAssistantMessage = thread.messages.find(
          (entry) => entry.id === assistantMessageId,
        );
        if (existingAssistantMessage?.streaming === false) {
          // Same rationale as the decider guard: the message has already been
          // closed (usually by snapshot reconciliation). Drop the ingested
          // delta but log it so legitimate late-arriving content - e.g. from
          // an out-of-order runtime event - does not vanish silently.
          yield* Effect.logWarning(
            "provider runtime ingestion dropped late assistant delta on completed message",
            {
              threadId: thread.id,
              messageId: assistantMessageId,
              deltaLength: assistantDelta.length,
              eventId: event.eventId,
            },
          );
          return;
        }
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }

        const assistantDeliveryMode = yield* Cache.get(assistantDeliveryModes, thread.id);
        if (assistantDeliveryMode === "buffered") {
          const spillChunk = yield* appendBufferedAssistantText(assistantMessageId, assistantDelta);
          if (spillChunk.length > 0) {
            yield* orchestrationEngine.dispatch({
              type: "thread.message.assistant.delta",
              commandId: providerCommandId(event, "assistant-delta-buffer-spill"),
              threadId: thread.id,
              messageId: assistantMessageId,
              delta: spillChunk,
              ...(turnId ? { turnId } : {}),
              createdAt: now,
            });
          }
        } else {
          yield* dispatchStreamingDelta(event, {
            type: "thread.message.assistant.delta",
            commandId: providerCommandId(event, "assistant-delta"),
            threadId: thread.id,
            messageId: assistantMessageId,
            delta: assistantDelta,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
          });
        }
      }

      if (reasoningDelta && reasoningDelta.length > 0 && event.turnId) {
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          const turnKey = providerTurnKey(thread.id, turnId);
          const assistantDeliveryMode = yield* Cache.get(assistantDeliveryModes, thread.id);
          const assistantMessageId =
            assistantDeliveryMode === "streaming"
              ? yield* getLatestAssistantMessageIdForTurn(thread.id, turnId)
              : undefined;
          // A new item or summary part starts a new paragraph, but only when it
          // lands after earlier reasoning in the same buffer or streamed message.
          const sectionKey =
            event.type === "content.delta"
              ? `${event.itemId ?? ""}\u0000${event.payload.streamKind}\u0000${event.payload.summaryIndex ?? ""}`
              : "";
          const previousSection = Option.getOrNull(
            yield* Cache.getOption(reasoningSectionByTurnKey, turnKey),
          );
          const hasBufferedReasoning = Option.match(
            yield* Cache.getOption(bufferedReasoningTextByTurnKey, turnKey),
            { onNone: () => false, onSome: (text) => text.length > 0 },
          );
          const separator =
            previousSection &&
            previousSection.key !== sectionKey &&
            (hasBufferedReasoning ||
              (assistantMessageId !== undefined &&
                previousSection.messageId === assistantMessageId))
              ? "\n\n"
              : "";
          const spillChunk = yield* appendBufferedReasoningText(
            turnKey,
            `${separator}${reasoningDelta}`,
          );
          yield* Cache.set(reasoningSectionByTurnKey, turnKey, {
            key: sectionKey,
            messageId: assistantMessageId ?? null,
          });
          if (assistantDeliveryMode === "streaming") {
            if (assistantMessageId && spillChunk.length > 0) {
              yield* dispatchStreamingDelta(event, {
                // Empty assistant deltas are safe because assistant completion always follows.
                type: "thread.message.assistant.delta",
                commandId: providerCommandId(event, "assistant-reasoning-buffer-spill"),
                threadId: thread.id,
                messageId: assistantMessageId,
                delta: "",
                reasoningDelta: spillChunk,
                turnId,
                createdAt: now,
              }).pipe(
                Effect.onError((cause) =>
                  isPermanentDispatchRejection(cause)
                    ? Effect.void
                    : restoreBufferedReasoningText(turnKey, spillChunk),
                ),
              );
              yield* noteReasoningRecipient({
                event,
                threadId: thread.id,
                turnId,
                messageId: assistantMessageId,
              });
            } else if (spillChunk.length > 0) {
              const cappedReasoningText = capBufferedReasoningText(spillChunk);
              if (cappedReasoningText.length < spillChunk.length) {
                yield* Effect.logWarning("reasoning buffer exceeded cap before assistant message", {
                  eventId: event.eventId,
                  threadId: thread.id,
                  turnId,
                  maxChars: MAX_BUFFERED_REASONING_CHARS,
                });
              }
              yield* Cache.set(bufferedReasoningTextByTurnKey, turnKey, cappedReasoningText);
            }

            if (assistantMessageId && spillChunk.length === 0) {
              const reasoningText = yield* takeBufferedReasoningText(turnKey);
              yield* dispatchStreamingDelta(event, {
                // Empty assistant deltas are safe because assistant completion always follows.
                type: "thread.message.assistant.delta",
                commandId: providerCommandId(event, "assistant-reasoning-delta"),
                threadId: thread.id,
                messageId: assistantMessageId,
                delta: "",
                reasoningDelta: reasoningText,
                turnId,
                createdAt: now,
              }).pipe(
                Effect.onError((cause) =>
                  isPermanentDispatchRejection(cause)
                    ? Effect.void
                    : restoreBufferedReasoningText(turnKey, reasoningText),
                ),
              );
              yield* noteReasoningRecipient({
                event,
                threadId: thread.id,
                turnId,
                messageId: assistantMessageId,
              });
            }
          } else if (spillChunk.length > 0) {
            const cappedReasoningText = capBufferedReasoningText(spillChunk);
            if (cappedReasoningText.length < spillChunk.length) {
              yield* Effect.logWarning(
                "reasoning buffer exceeded cap before assistant completion",
                {
                  eventId: event.eventId,
                  threadId: thread.id,
                  turnId,
                  maxChars: MAX_BUFFERED_REASONING_CHARS,
                },
              );
            }
            yield* Cache.set(bufferedReasoningTextByTurnKey, turnKey, cappedReasoningText);
          }
        }
      }

      if (proposedPlanDelta && proposedPlanDelta.length > 0) {
        const planId = proposedPlanIdFromEvent(event, thread.id);
        yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
      }

      const assistantCompletion =
        event.type === "item.completed" && event.payload.itemType === "assistant_message"
          ? {
              messageId: MessageId.makeUnsafe(
                `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
              ),
              // Codex's display detail is trimmed. Its native item is the exact
              // full-text recovery source, including leading/trailing whitespace.
              fallbackText:
                event.provider === "codex" &&
                typeof asRecord(asRecord(event.payload.data)?.item)?.text === "string"
                  ? (asRecord(asRecord(event.payload.data)?.item)!.text as string)
                  : event.provider === "claudeAgent" &&
                      typeof asRecord(event.payload.data)?.text === "string"
                    ? (asRecord(event.payload.data)!.text as string)
                    : event.payload.detail,
            }
          : undefined;
      const proposedPlanCompletion =
        event.type === "turn.proposed.completed"
          ? {
              planId: proposedPlanIdFromEvent(event, thread.id),
              turnId: toTurnId(event.turnId),
              planMarkdown: event.payload.planMarkdown,
            }
          : undefined;

      if (assistantCompletion) {
        const assistantMessageId = assistantCompletion.messageId;
        const turnId = toTurnId(event.turnId);
        const existingAssistantMessage = thread.messages.find(
          (entry) => entry.id === assistantMessageId,
        );
        const presentation =
          event.type === "item.completed" && event.provider === "codex"
            ? codexMessagePresentation(asRecord(event.payload.data)?.item)
            : { replace: false };
        if (presentation.replace) {
          // Discard queued provisional chunks before atomically replacing persisted text.
          yield* takeBufferedAssistantText(assistantMessageId);
          const resolvedTurnId = turnId ?? existingAssistantMessage?.turnId ?? undefined;
          const turnKey = resolvedTurnId ? providerTurnKey(thread.id, resolvedTurnId) : undefined;
          const reasoningSuffix = turnKey ? yield* takeBufferedReasoningText(turnKey) : "";
          yield* orchestrationEngine.dispatch({
            type: "thread.message.assistant.moderate",
            commandId: providerCommandId(event, "moderation:" + assistantMessageId),
            threadId: thread.id,
            messageId: assistantMessageId,
            ...(resolvedTurnId ? { turnId: resolvedTurnId } : {}),
            text: presentation.text ?? "",
            clearReasoning: presentation.mode !== "show",
            reasoningSuffix,
            createdAt: now,
          });
          streamingDeltas.forgetMessage(thread.id, assistantMessageId);
          yield* flushDeferredReasoningTokens({
            event,
            threadId: thread.id,
            messageId: assistantMessageId,
          });
          yield* clearAssistantMessageState(assistantMessageId, turnKey);
          return;
        }
        const finalText = assistantCompletion.fallbackText;
        const persistedText = existingAssistantMessage?.text ?? "";
        const recoverableSuffix =
          (COALESCE_STREAMING_DELTAS_DRIVERS.has(event.provider) ||
            event.provider === "claudeAgent") &&
          finalText !== undefined &&
          finalText.startsWith(persistedText)
            ? finalText.slice(persistedText.length)
            : undefined;
        const shouldApplyFallbackCompletionText =
          persistedText.length === 0 || recoverableSuffix !== undefined;
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }

        yield* finalizeAssistantMessage({
          event,
          threadId: thread.id,
          threadMessages: thread.messages,
          messageId: assistantMessageId,
          ...(turnId ? { turnId } : {}),
          createdAt: now,
          commandTag: "assistant-complete",
          finalDeltaCommandTag: "assistant-delta-finalize",
          ...(assistantCompletion.fallbackText !== undefined && shouldApplyFallbackCompletionText
            ? {
                fallbackText: recoverableSuffix ?? assistantCompletion.fallbackText,
                ...(recoverableSuffix !== undefined ? { preserveFallbackWhitespace: true } : {}),
              }
            : {}),
        });

        if (turnId) {
          yield* forgetAssistantMessageId(thread.id, turnId, assistantMessageId);
        }
      }

      if (proposedPlanCompletion) {
        yield* finalizeBufferedProposedPlan({
          event,
          threadId: thread.id,
          threadProposedPlans: thread.proposedPlans,
          planId: proposedPlanCompletion.planId,
          ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
          fallbackMarkdown: proposedPlanCompletion.planMarkdown,
          updatedAt: now,
        });
      }

      if (event.type === "turn.completed" || event.type === "turn.aborted") {
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          const pending = new Set<string>(
            (thread.pendingUserInputs ?? [])
              .filter((input) => isBlockingUserInput(input) && input.turnId === turnId)
              .map((input) => input.requestId),
          );
          // Non-blocking questions keep their native request open after the
          // turn; they close on answer, native resolution or session end.
          for (const activity of thread.activities) {
            const payload = activity.payload as Record<string, unknown> | null;
            const requestId = payload?.requestId;
            if (typeof requestId !== "string") continue;
            if (
              activity.kind === "user-input.requested" &&
              activity.turnId === turnId &&
              isBlockingUserInput({
                ...(payload?.responseMode === "message" ? { responseMode: "message" } : {}),
                ...(payload?.blocking === false ? { blocking: false } : {}),
              })
            ) {
              pending.add(requestId);
            } else if (activity.kind === "user-input.resolved") {
              pending.delete(requestId);
            }
          }
          for (const requestId of pending) {
            yield* orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId: providerCommandId(event, `terminal-user-input-resolved:${requestId}`),
              threadId: thread.id,
              activity: {
                id: EventId.make(`${event.eventId}:user-input-resolved:${requestId}`),
                createdAt: now,
                tone: "info",
                kind: "user-input.resolved",
                summary: "User input dismissed because its turn ended",
                payload: { requestId, resolution: "dismissed" },
                turnId,
              },
              createdAt: now,
            });
          }
        }
      }

      if (event.type === "turn.completed") {
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          const openCommandStatus = runtimeTurnState(event) === "failed" ? "failed" : "interrupted";
          yield* finalizeOpenCommandExecutions({
            event,
            threadId: thread.id,
            turnId,
            status: openCommandStatus,
            updatedAt: now,
            commandTag: "command-execution-turn-complete-finalize",
          });
          yield* finalizePendingFileChanges({
            event,
            threadId: thread.id,
            turnId,
            status: runtimeTurnState(event) === "failed" ? "failed" : "interrupted",
            updatedAt: now,
            commandTag: "file-change-turn-complete-finalize",
          });
          yield* flushAllCommandExecutionOutput();
          yield* cleanupClosedCommandExecutions({
            threadId: thread.id,
            turnId,
          });

          const assistantMessageIds = yield* getAssistantMessageIdsForTurn(thread.id, turnId);
          yield* Effect.forEach(
            assistantMessageIds,
            (assistantMessageId) =>
              finalizeAssistantMessage({
                event,
                threadId: thread.id,
                threadMessages: thread.messages,
                messageId: assistantMessageId,
                turnId,
                createdAt: now,
                commandTag: "assistant-complete-finalize",
                finalDeltaCommandTag: "assistant-delta-finalize-fallback",
              }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          yield* attachLeftoverReasoningTokens({
            event,
            thread,
            turnId,
            assistantMessageIds,
          });
          yield* dropDeferredReasoningTokens(thread.id, turnId);
          yield* clearAssistantMessageIdsForTurn(thread.id, turnId);
          if (event.provider === "codex") {
            const reconciliation = yield* backfillCodexAssistantMessagesFromProviderSnapshot({
              event,
              threadId: thread.id,
              turnId,
            });
            if (
              reconciliation.candidateThreadCount > 0 ||
              reconciliation.backfilledMessageCount > 0
            ) {
              yield* Effect.logInfo(
                "provider runtime ingestion reconciled codex snapshot on turn completion",
                {
                  eventId: event.eventId,
                  threadId: thread.id,
                  turnId,
                  candidateThreadCount: reconciliation.candidateThreadCount,
                  providerReadCount: reconciliation.providerReadCount,
                  backfilledMessageCount: reconciliation.backfilledMessageCount,
                },
              );
            }
          }

          if (runtimeTurnState(event) === "completed")
            yield* finalizeBufferedProposedPlan({
              event,
              threadId: thread.id,
              threadProposedPlans: thread.proposedPlans,
              planId: proposedPlanIdForTurn(thread.id, turnId),
              turnId,
              updatedAt: now,
            });
          else yield* clearBufferedProposedPlan(proposedPlanIdForTurn(thread.id, turnId));
        }
      }

      if (event.type === "session.exited" || event.type === "turn.aborted") {
        // A killed source (notably Windows termination) may never send item.completed.
        // Preserve buffered output and close persisted streams before discarding caches.
        const pendingMessages = new Map<MessageId, TurnId | undefined>();
        for (const message of thread.messages) {
          if (
            message.role === "assistant" &&
            message.streaming &&
            (event.type === "session.exited" || !eventTurnId || message.turnId === eventTurnId)
          )
            pendingMessages.set(message.id, message.turnId ?? undefined);
        }
        const prefix = `${thread.id}:`;
        for (const key of Array.from(yield* Cache.keys(turnMessageIdsByTurnKey))) {
          if (!key.startsWith(prefix)) continue;
          const turnId = TurnId.makeUnsafe(key.slice(prefix.length));
          if (event.type === "turn.aborted" && eventTurnId && turnId !== eventTurnId) continue;
          for (const id of yield* getAssistantMessageIdsForTurn(thread.id, turnId))
            pendingMessages.set(id, turnId);
        }
        for (const [messageId, turnId] of pendingMessages)
          yield* finalizeAssistantMessage({
            event,
            threadId: thread.id,
            threadMessages: thread.messages,
            messageId,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
            commandTag: "assistant-interrupted-finalize",
            finalDeltaCommandTag: "assistant-interrupted-flush",
          });
        if (event.type === "turn.aborted" && eventTurnId) {
          yield* attachLeftoverReasoningTokens({
            event,
            thread,
            turnId: eventTurnId,
            assistantMessageIds: yield* getAssistantMessageIdsForTurn(thread.id, eventTurnId),
          });
          yield* dropDeferredReasoningTokens(thread.id, eventTurnId);
        }
      }

      if (event.type === "turn.aborted") {
        yield* finalizeOpenCommandExecutions({
          event,
          threadId: thread.id,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
          status: "interrupted",
          updatedAt: now,
          commandTag: "command-execution-turn-aborted-finalize",
        });
        yield* finalizePendingFileChanges({
          event,
          threadId: thread.id,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
          status: "interrupted",
          updatedAt: now,
          commandTag: "file-change-turn-aborted-finalize",
        });
        yield* flushAllCommandExecutionOutput();
        yield* cleanupClosedCommandExecutions({
          threadId: thread.id,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
        });
      }

      if (event.type === "session.exited") {
        yield* finalizeOpenCommandExecutions({
          event,
          threadId: thread.id,
          status: event.payload.exitKind === "error" ? "failed" : "interrupted",
          updatedAt: now,
          commandTag: "command-execution-session-exited-finalize",
        });
        yield* finalizePendingFileChanges({
          event,
          threadId: thread.id,
          status: event.payload.exitKind === "error" ? "failed" : "interrupted",
          updatedAt: now,
          commandTag: "file-change-session-exited-finalize",
        });
        yield* flushAllCommandExecutionOutput();
        yield* cleanupClosedCommandExecutions({
          threadId: thread.id,
        });
        yield* clearTurnStateForSession(thread.id);
      }

      if (event.type === "runtime.error") {
        yield* finalizeOpenCommandExecutions({
          event,
          threadId: thread.id,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
          status: "failed",
          updatedAt: now,
          commandTag: "command-execution-runtime-error-finalize",
        });
        yield* finalizePendingFileChanges({
          event,
          threadId: thread.id,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
          status: "failed",
          updatedAt: now,
          commandTag: "file-change-runtime-error-finalize",
        });
        yield* flushAllCommandExecutionOutput();
        yield* cleanupClosedCommandExecutions({
          threadId: thread.id,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
        });
        const runtimeErrorMessage = runtimeErrorMessageFromEvent(event) ?? "Provider runtime error";

        const shouldApplyRuntimeError = !STRICT_PROVIDER_LIFECYCLE_GUARD
          ? true
          : activeTurnId === null || eventTurnId === undefined || sameId(activeTurnId, eventTurnId);

        if (shouldApplyRuntimeError) {
          const errorProviderInstanceId =
            event.providerInstanceId ?? thread.session?.providerInstanceId ?? null;
          const authFailure =
            event.payload.class === "auth_error" && errorProviderInstanceId
              ? {
                  providerInstanceId: errorProviderInstanceId,
                  turnId: eventTurnId ?? activeTurnId ?? null,
                  occurredAt: now,
                }
              : undefined;
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "runtime-error-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "error",
              providerName: event.provider,
              providerInstanceId: errorProviderInstanceId,
              ...(authFailure ? { authFailure } : {}),
              runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
              activeTurnId:
                activeTurnId === null && thread.session?.usageLimit?.turnId === eventTurnId
                  ? null
                  : (eventTurnId ?? null),
              lastError: runtimeErrorMessage,
              lastErrorId: event.eventId,
              usageLimit: toOrchestrationUsageLimit(event.payload.usageLimit, event, thread),
              lastErrorOccurredAt: now,
              updatedAt: now,
            },
            createdAt: now,
          });
          // Re-probe the account so Settings and the picker show it signed out too.
          if (authFailure && Option.isSome(providerRegistry)) {
            yield* Effect.forkIn(
              providerRegistry.value
                .refreshInstance(authFailure.providerInstanceId)
                .pipe(Effect.ignoreCause({ log: true })),
              ingestionScope,
            );
          }
        }
      }

      if (event.type === "session.state.changed" && event.payload.state === "error") {
        yield* finalizeOpenCommandExecutions({
          event,
          threadId: thread.id,
          status: "failed",
          updatedAt: now,
          commandTag: "command-execution-session-error-finalize",
        });
        yield* finalizePendingFileChanges({
          event,
          threadId: thread.id,
          status: "failed",
          updatedAt: now,
          commandTag: "file-change-session-error-finalize",
        });
        yield* flushAllCommandExecutionOutput();
        yield* cleanupClosedCommandExecutions({
          threadId: thread.id,
        });
      }

      if (
        event.type === "thread.metadata.updated" &&
        event.payload.metadata &&
        ("nativeAttachment" in event.payload.metadata ||
          "nativeGoal" in event.payload.metadata ||
          "nativeAside" in event.payload.metadata)
      ) {
        const aside = event.payload.metadata.nativeAside;
        if (aside && typeof aside === "object") {
          const value = aside as Record<string, unknown>;
          const tokens = (input: unknown) =>
            typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : null;
          const inputTokens = tokens(value.inputTokens);
          const outputTokens = tokens(value.outputTokens);
          yield* orchestrationEngine.dispatch({
            type: "thread.usage.record",
            commandId: providerCommandId(event, "aside-usage"),
            threadId: thread.id,
            usageFact: {
              turnId: TurnId.makeUnsafe(USAGE_ASIDE_TURN_ID_PREFIX + event.eventId),
              threadId: thread.id,
              projectId: thread.projectId,
              provider: event.provider,
              providerInstanceId:
                event.providerInstanceId ?? thread.session?.providerInstanceId ?? null,
              model: typeof value.model === "string" && value.model.trim() ? value.model : null,
              inputTokens,
              outputTokens,
              cacheReadTokens: tokens(value.cachedInputTokens),
              cacheWriteTokens: null,
              totalTokens:
                inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
              providerReportedCostUsd: null,
              tokenProvenance: "provider-reported",
              costProvenance: "unreported",
              completedAt: now,
              sourceEventId: event.eventId,
            },
            createdAt: now,
          });
        }
        yield* orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: providerCommandId(event, "native-metadata"),
          threadId: thread.id,
          activity: {
            id: EventId.makeUnsafe(`${event.eventId}:native-metadata`),
            kind: "nativeAside" in event.payload.metadata ? "native.aside" : "native.metadata",
            tone: "info",
            summary:
              "nativeAside" in event.payload.metadata ? "Aside" : "Provider metadata updated",
            payload: event.payload.metadata,
            turnId: null,
            createdAt: now,
          },
          createdAt: now,
        });
      }
      if (event.type === "thread.metadata.updated" && event.payload.metadata?.promptSuggestion) {
        const suggestion = event.payload.metadata.promptSuggestion;
        if (
          typeof suggestion === "object" &&
          suggestion !== null &&
          "text" in suggestion &&
          typeof suggestion.text === "string"
        )
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: providerCommandId(event, "prompt-suggestion"),
            threadId: thread.id,
            activity: {
              id: EventId.makeUnsafe(`${event.eventId}:prompt-suggestion`),
              kind: "prompt.suggestion",
              tone: "info",
              summary: suggestion.text.slice(0, 4000),
              payload: { provider: event.provider },
              turnId: null,
              createdAt: now,
            },
            createdAt: now,
          });
      }
      // A provider name only fills a thread that still has its default title: it must not
      // overwrite a title the user typed or F5 generated.
      if (
        event.type === "thread.metadata.updated" &&
        event.payload.name &&
        thread.titleSource === "default"
      ) {
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: providerCommandId(event, "thread-meta-update"),
          threadId: thread.id,
          title: event.payload.name,
          titleOrigin: "provider",
        });
      }

      if (event.type === "session.configured") {
        if (
          event.provider === "pi" &&
          thread.session &&
          Schema.is(ProviderExtensionStatuses)(event.payload.config.extensionStatuses)
        ) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "extension-status-set"),
            createdAt: now,
            threadId: thread.id,
            session: {
              ...thread.session,
              extensionStatuses: event.payload.config.extensionStatuses,
              updatedAt: now,
            },
          });
        }
        const configuredConfig =
          typeof event.payload.config === "object" && event.payload.config !== null
            ? event.payload.config
            : null;
        const configuredModel =
          configuredConfig &&
          "model" in configuredConfig &&
          typeof configuredConfig.model === "string" &&
          configuredConfig.model.trim().length > 0
            ? configuredConfig.model.trim()
            : null;
        const modelContextWindowTokens = resolveModelContextWindowTokens({
          provider: event.provider,
          model: configuredModel ?? thread.model,
          reportedModelContextWindowTokens: configuredConfig
            ? readConfiguredModelContextWindowTokens(configuredConfig)
            : undefined,
        });

        if (configuredModel !== null && configuredModel !== thread.model) {
          yield* orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: providerCommandId(event, "thread-model-update"),
            threadId: thread.id,
            model: configuredModel,
          });
        }

        if (
          thread.session?.modelContextWindowTokens !== modelContextWindowTokens ||
          thread.modelContextWindowTokens !== modelContextWindowTokens
        ) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "thread-model-context-window-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: thread.session?.status ?? "ready",
              providerName: event.provider,
              providerInstanceId:
                event.providerInstanceId ?? thread.session?.providerInstanceId ?? null,
              runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
              activeTurnId: thread.session?.activeTurnId ?? null,
              lastError: thread.session?.lastError ?? null,
              lastErrorId: thread.session?.lastErrorId ?? null,
              lastErrorOccurredAt: thread.session?.lastErrorOccurredAt ?? null,
              ...(thread.session?.estimatedContextTokens !== undefined
                ? { estimatedContextTokens: thread.session.estimatedContextTokens }
                : {}),
              ...(thread.session?.tokenUsageSource !== undefined
                ? { tokenUsageSource: thread.session.tokenUsageSource }
                : {}),
              modelContextWindowTokens,
              updatedAt: now,
            },
            createdAt: now,
          });
        }

        // A published command catalog ends native discovery; re-snapshot the
        // session so the browser learns which session actions are now available.
        if (configuredConfig && "slashCommands" in configuredConfig) {
          const capabilities = yield* providerService
            .getSessionCapabilities(thread.id)
            .pipe(Effect.orElseSucceed(() => null));
          if (
            capabilities &&
            thread.session &&
            !sameSessionCapabilities(thread.session.capabilities ?? null, capabilities)
          ) {
            // Only the snapshot changes; every other session field (usage
            // limit, retryability, token usage) stays as projected.
            yield* orchestrationEngine.dispatch({
              type: "thread.session.set",
              commandId: providerCommandId(event, "thread-session-capabilities-set"),
              threadId: thread.id,
              session: { ...thread.session, capabilities, updatedAt: now },
              createdAt: now,
            });
          }
        }
      }

      // Claude reports its cache-write split with each result; re-snapshot so the
      // runtime panel shows the latest session figures.
      if (event.type === "turn.completed" && event.provider === "claudeAgent") {
        const capabilities = yield* providerService
          .getSessionCapabilities(thread.id)
          .pipe(Effect.orElseSucceed(() => null));
        // Turn completion already updated the session above; build on the current one.
        const session = (yield* orchestrationEngine.getReadModel()).threads.find(
          (entry) => entry.id === thread.id,
        )?.session;
        if (
          capabilities &&
          session &&
          !sameSessionCapabilities(session.capabilities ?? null, capabilities)
        ) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "thread-session-capabilities-turn"),
            threadId: thread.id,
            session: { ...session, capabilities, updatedAt: now },
            createdAt: now,
          });
        }
      }

      if (
        event.type === "compaction.recommended" &&
        (thread.session?.modelContextWindowTokens !== event.payload.modelContextWindowTokens ||
          thread.modelContextWindowTokens !== event.payload.modelContextWindowTokens)
      ) {
        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: providerCommandId(event, "thread-compaction-window-set"),
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: thread.session?.status ?? "ready",
            providerName: event.provider,
            providerInstanceId:
              event.providerInstanceId ?? thread.session?.providerInstanceId ?? null,
            runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
            activeTurnId: thread.session?.activeTurnId ?? null,
            lastError: thread.session?.lastError ?? null,
            lastErrorId: thread.session?.lastErrorId ?? null,
            lastErrorOccurredAt: thread.session?.lastErrorOccurredAt ?? null,
            ...(thread.session?.estimatedContextTokens !== undefined
              ? { estimatedContextTokens: thread.session.estimatedContextTokens }
              : {}),
            ...(thread.session?.tokenUsageSource !== undefined
              ? { tokenUsageSource: thread.session.tokenUsageSource }
              : {}),
            modelContextWindowTokens: event.payload.modelContextWindowTokens,
            updatedAt: now,
          },
          createdAt: now,
        });
      }

      if (event.type === "model.rerouted") {
        const reroutedModel =
          typeof event.payload.toModel === "string" && event.payload.toModel.trim().length > 0
            ? event.payload.toModel.trim()
            : null;

        if (reroutedModel !== null && reroutedModel !== thread.model) {
          yield* orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: providerCommandId(event, "thread-model-rerouted-update"),
            threadId: thread.id,
            model: reroutedModel,
          });
        }
      }

      if (event.type === "turn.diff.updated") {
        const turnId = toTurnId(event.turnId);
        if (
          turnId &&
          thread.latestTurn?.turnId === turnId &&
          thread.latestTurn.state === "running" &&
          (yield* isGitRepoForThread(thread.id))
        ) {
          // Allocate one placeholder. Capture the final filesystem state when
          // the turn ends, after its last edit, rather than on each diff update.
          const existingCheckpoint = thread.checkpoints.find(
            (checkpoint) => checkpoint.turnId === turnId,
          );
          if (!existingCheckpoint) {
            const assistantMessageId = MessageId.makeUnsafe(
              `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
            );
            const maxTurnCount = thread.checkpoints.reduce(
              (max, c) => Math.max(max, c.checkpointTurnCount),
              0,
            );
            yield* orchestrationEngine.dispatch({
              type: "thread.turn.diff.complete",
              commandId: providerCommandId(event, "thread-turn-diff-complete"),
              threadId: thread.id,
              turnId,
              completedAt: now,
              checkpointRef: CheckpointRef.makeUnsafe(`provider-diff:${event.eventId}`),
              status: "missing",
              files: [],
              assistantMessageId,
              checkpointTurnCount: maxTurnCount + 1,
              createdAt: now,
            });
          }
        }
      }

      if (Option.isSome(computerAutomationBroker)) {
        if ((event.type === "turn.completed" || event.type === "turn.aborted") && event.turnId)
          computerAutomationBroker.value.endTurn(thread.id, event.turnId);
      }
      const lifecycle = yield* extractLifecycleImages(thread.id, event, thread.interactionMode);
      const activities = runtimeEventToActivities(
        lifecycle.event,
        lifecycle.images,
        isPreparedComputerEvent(event),
      );
      const toolUpdateKey = event.itemId ? `${thread.id}\u0000${event.itemId}` : undefined;
      if (toolUpdateKey && event.type === "item.completed") lastToolUpdates.delete(toolUpdateKey);
      // Updates that own extracted images or computer evidence are never superseded.
      const canCoalesceToolUpdate =
        toolUpdateCoalescingEnabled &&
        event.type === "item.updated" &&
        !lifecycle.images?.mcpImages?.length &&
        !isPreparedComputerEvent(event);
      yield* Effect.forEach(activities, (activity) =>
        Effect.gen(function* () {
          const signature =
            toolUpdateKey && activity.kind === "tool.updated"
              ? JSON.stringify([activity.tone, activity.summary, activity.turnId, activity.payload])
              : undefined;
          if (signature && canCoalesceToolUpdate && isSupersedableToolUpdate(activity.payload)) {
            const coalescingKey = `${activity.turnId ?? ""}\u0000${toolUpdateKey!}`;
            // A repeat of the last append drops the pending state it supersedes. Otherwise the
            // offer replaces it in place, so the open window keeps its original deadline.
            if (lastToolUpdates.get(toolUpdateKey!) === signature) {
              pendingToolUpdates.discard(thread.id, coalescingKey);
              return;
            }
            const full = pendingToolUpdates.offer(thread.id, coalescingKey, {
              event,
              activity,
              trackingKey: toolUpdateKey!,
              signature,
            });
            if (full) yield* flushToolUpdates(thread.id);
            return;
          }
          yield* flushToolUpdates(thread.id);
          if (signature && lastToolUpdates.get(toolUpdateKey!) === signature) return;
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: providerCommandId(event, `thread-activity-append:${activity.id}`),
            threadId: thread.id,
            activity,
            createdAt: activity.createdAt,
          });
          // Recorded only after the append succeeds, so a retried event is not skipped.
          if (signature) recordToolUpdate(toolUpdateKey!, signature);
        }),
      ).pipe(Effect.asVoid);

      if (event.type === "mcp.status.updated" && Option.isSome(mcpEventBus)) {
        const projectId = thread.projectId;
        const instanceId = event.payload.status.providerInstanceId;
        const existing = pendingMcpPushes.get(projectId);
        if (existing) {
          existing.add(instanceId ?? null);
        } else {
          const instances = new Set([instanceId ?? null]);
          pendingMcpPushes.set(projectId, instances);
          yield* Effect.forkIn(
            Effect.gen(function* () {
              yield* Effect.sleep("1 second");
              pendingMcpPushes.delete(projectId);
              yield* mcpEventBus.value.publishStatusUpdated({
                scope: "project",
                projectId,
                reason: "runtime",
                ...(instances.size === 1 && [...instances][0]
                  ? { instanceId: [...instances][0]! }
                  : {}),
              });
            }),
            ingestionScope,
          );
        }
      }
      if (isProviderTerminalRuntimeEvent(event)) {
        yield* providerTerminalEventRepository.markApplied(event.eventId);
      }
      if (
        (event.type === "runtime.error" || event.type === "turn.completed") &&
        event.payload?.usageLimit &&
        !event.payload.usageLimit.resetsAt
      ) {
        const limit = toOrchestrationUsageLimit(event.payload.usageLimit, event, thread);
        if (limit) {
          const key = `${limit.providerInstanceId}:${limit.turnId}`;
          if (refreshedUsageFailures.get(thread.id) !== key) {
            rememberRefreshedUsageFailure(thread.id, key);
            const failure = event;
            yield* Effect.forkIn(
              Effect.gen(function* () {
                let resolved = failure.payload!.usageLimit!;
                if (Option.isSome(usageService)) {
                  const refreshed = yield* usageService.value
                    .refreshAccount(limit.providerInstanceId)
                    .pipe(Effect.catchCause(() => Effect.succeed(null)));
                  if (refreshed?.fresh && refreshed.snapshot) {
                    resolved = resolveAccountUsageLimit(
                      resolved,
                      refreshed.snapshot,
                      failure.createdAt,
                    );
                  }
                }
                if (!resolved.resetsAt && failure.provider === "codex") {
                  const message =
                    failure.type === "runtime.error"
                      ? failure.payload.message
                      : (failure.payload.errorMessage ?? "");
                  const reset = parseCodexTryAgainAt(message, failure.createdAt);
                  if (reset) resolved = { ...resolved, resetsAt: reset, resetSource: "message" };
                }
                if (resolved.resetsAt)
                  yield* enqueueResolvedUsageLimit({
                    source: "usage-limit-resolved",
                    threadId: thread.id,
                    limit: { ...limit, ...resolved },
                    event: failure,
                  });
              }),
              ingestionScope,
            );
          }
        }
      }
    });

  const processDomainEvent = (event: TurnStartRequestedDomainEvent) =>
    Effect.gen(function* () {
      const global = yield* serverSettings.getSettings;
      const model = yield* orchestrationEngine.getReadModel();
      const thread = model.threads.find((t) => t.id === event.payload.threadId);
      const project = model.projects.find(
        (p) => p.id === thread?.projectId && p.deletedAt === null,
      );
      const resolved = project ? yield* readProjectSettings(global, project) : null;
      const projectControlsStreaming =
        resolved &&
        ["project", "f5.json", "t3.json"].includes(resolved.sources.enableAssistantStreaming);
      const defaultMode = (resolved?.settings ?? global).enableAssistantStreaming
        ? "streaming"
        : "buffered";
      yield* Cache.set(
        assistantDeliveryModes,
        event.payload.threadId,
        projectControlsStreaming
          ? defaultMode
          : (event.payload.assistantDeliveryMode ?? defaultMode),
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Unable to resolve project streaming preference", { error }).pipe(
          Effect.andThen(
            Cache.set(
              assistantDeliveryModes,
              event.payload.threadId,
              event.payload.assistantDeliveryMode ?? DEFAULT_ASSISTANT_DELIVERY_MODE,
            ),
          ),
        ),
      ),
    );

  const processInput = (input: RuntimeIngestionInput) =>
    input.source === "assistant-delta-flush"
      ? streamingDeltas.flush(input.threadId, input.messageId, input.commandId)
      : input.source === "assistant-delta-flush-thread"
        ? streamingDeltas.flushThread(input.threadId)
        : input.source === "assistant-delta-flush-all"
          ? streamingDeltas.flushAll()
          : input.source === "usage-limit-resolved"
            ? Effect.gen(function* () {
                const model = yield* orchestrationEngine.getReadModel();
                const thread = model.threads.find((entry) => entry.id === input.threadId);
                const session = thread?.session;
                const current = session?.usageLimit;
                // Apply through the same worker, so later turns and unrelated errors cannot be overwritten.
                if (
                  !session ||
                  !current ||
                  current.turnId !== input.limit.turnId ||
                  current.providerInstanceId !== input.limit.providerInstanceId ||
                  !session.lastError ||
                  current.resetsAt ||
                  session.status === "running" ||
                  session.status === "starting" ||
                  (session.activeTurnId !== null && session.activeTurnId !== input.limit.turnId)
                )
                  return;
                yield* orchestrationEngine.dispatch({
                  type: "thread.session.set",
                  commandId: providerCommandId(input.event, "usage-limit-reset-resolved"),
                  threadId: input.threadId,
                  session: { ...session, usageLimit: input.limit },
                  createdAt: new Date().toISOString(),
                });
              })
            : input.source === "runtime"
              ? processRuntimeEvent(input.event)
              : input.source === "domain"
                ? flushToolUpdates(input.event.payload.threadId).pipe(
                    Effect.andThen(processDomainEvent(input.event)),
                  )
                : input.source === "command-output-flush"
                  ? flushCommandExecutionOutput(input.commandExecutionId).pipe(Effect.asVoid)
                  : input.source === "command-output-flush-all"
                    ? flushAllCommandExecutionOutput()
                    : input.source === "tool-update-flush"
                      ? flushToolUpdates(input.threadId)
                      : flushAllToolUpdates;

  const pendingTerminalEventIds = new Set<string>();
  const processInputSafely = (
    input: RuntimeIngestionInput,
    process: ReturnType<typeof processInput> = processInput(input),
  ) =>
    process.pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        const prettyCause = Cause.pretty(cause);
        const markTerminalFailure =
          input.source === "runtime" && isProviderTerminalRuntimeEvent(input.event)
            ? providerTerminalEventRepository
                .markFailed({ eventId: input.event.eventId, error: prettyCause })
                .pipe(
                  Effect.catchCause((markCause) =>
                    Effect.logWarning(
                      "provider runtime ingestion failed to retain terminal event failure",
                      {
                        eventId: input.event.eventId,
                        eventType: input.event.type,
                        cause: Cause.pretty(markCause),
                      },
                    ),
                  ),
                )
            : Effect.void;
        const markIncompleteHistory =
          input.source === "runtime" && !isProviderTerminalRuntimeEvent(input.event)
            ? (providerService.requireHistoryReconciliation?.(input.event) ?? Effect.void).pipe(
                Effect.catchCause((markCause) =>
                  Effect.logError("could not persist incomplete provider history marker", {
                    eventId: input.event.eventId,
                    cause: Cause.pretty(markCause),
                  }),
                ),
              )
            : Effect.void;
        return markTerminalFailure.pipe(
          Effect.andThen(markIncompleteHistory),
          Effect.andThen(
            Effect.logWarning("provider runtime ingestion failed to process event", {
              source: input.source,
              ...(input.source === "runtime" || input.source === "domain"
                ? {
                    eventId: input.event.eventId,
                    eventType: input.event.type,
                  }
                : input.source === "command-output-flush"
                  ? {
                      commandExecutionId: input.commandExecutionId,
                    }
                  : {}),
              cause: prettyCause,
            }),
          ),
        );
      }),
    );

  const worker = yield* makeBackgroundWorker(
    (input: RuntimeIngestionInput) =>
      processInputSafely(
        input,
        input.source === "runtime" && isProviderTerminalRuntimeEvent(input.event)
          ? tryWithProviderThreadAccess(input.event.threadId, processInput(input)).pipe(
              Effect.flatMap((processed) =>
                Option.isSome(processed)
                  ? Effect.void
                  : // A launch can need an elicitation queued behind this event. Never
                    // wait on its lock in the shared worker; retry the durable receipt.
                    providerTerminalEventRepository.record(
                      input.event as import("../../persistence/Services/ProviderTerminalEvents.ts").ProviderTerminalRuntimeEvent,
                    ),
              ),
            )
          : processInput(input),
      ).pipe(
        Effect.provideService(AcceptedShutdownWork, true),
        Effect.provideService(LosslessCommandAdmission, true),
        Effect.ensuring(
          Effect.sync(() => {
            if (input.source === "runtime" && isProviderTerminalRuntimeEvent(input.event))
              pendingTerminalEventIds.delete(input.event.eventId);
          }),
        ),
      ),
    { name: "ProviderRuntimeIngestion" },
  );
  let pendingRuntimeAdmissions = 0;
  const enqueueRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        pendingRuntimeAdmissions++;
      }),
      () =>
        Effect.suspend(() => {
          if (!isProviderTerminalRuntimeEvent(event))
            return worker.enqueue({ source: "runtime", event });
          if (pendingTerminalEventIds.has(event.eventId)) return Effect.void;
          pendingTerminalEventIds.add(event.eventId);
          return worker
            .enqueue({ source: "runtime", event })
            .pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? Effect.sync(() => pendingTerminalEventIds.delete(event.eventId))
                  : Effect.void,
              ),
            );
        }),
      () =>
        Effect.sync(() => {
          pendingRuntimeAdmissions--;
        }),
    );

  enqueueResolvedUsageLimit = worker.enqueue;
  enqueueAssistantDeltaFlush = (threadId, messageId, commandId) => {
    enqueueBackgroundWork(
      worker.enqueue({ source: "assistant-delta-flush", threadId, messageId, commandId }),
    );
  };
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      streamingDeltas.cancelTimers();
      pendingToolUpdates.cancelTimers();
      yield* worker.enqueue({ source: "tool-update-flush-all" });
      yield* worker.enqueue({ source: "assistant-delta-flush-all" });
      yield* worker.drain.pipe(Effect.orDie);
    }),
  );
  enqueueCommandOutputFlush = (commandExecutionId) => {
    enqueueBackgroundWork(worker.enqueue({ source: "command-output-flush", commandExecutionId }));
  };
  enqueueToolUpdateFlush = (threadId) => {
    enqueueBackgroundWork(worker.enqueue({ source: "tool-update-flush", threadId }));
  };

  const surfaceExhaustedTerminalReceipts = (threadIds?: ReadonlySet<ThreadId>) =>
    Effect.gen(function* () {
      // Normal completions do not scan bindings/sessions. A full repair scan is
      // reserved for startup or dirty-set overflow, and only reads exhausted ids.
      if (!(yield* providerTerminalEventRepository.hasExhausted())) return;
      const readModel = yield* orchestrationEngine.getReadModel();
      for (const thread of readModel.threads) {
        if (thread.deletedAt !== null || (threadIds && !threadIds.has(thread.id))) continue;
        if (!(yield* providerTerminalEventRepository.hasExhausted(thread.id))) continue;
        const currentBinding = Option.getOrUndefined(
          yield* providerSessionDirectory.getBinding(thread.id),
        );
        const origin = {
          sessionGeneration: readPersistedSessionGeneration(currentBinding?.runtimePayload),
        };
        const repairId = `server:terminal-receipt-repair:${thread.id}:${origin.sessionGeneration}`;
        const repairedAt = new Date().toISOString();
        yield* orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(repairId),
          threadId: thread.id,
          createdAt: repairedAt,
          activity: {
            id: EventId.makeUnsafe(repairId),
            kind: "provider.receipt.repair-required",
            tone: "error",
            summary:
              "Provider completion could not be recovered. History repair is required before retrying an uncertain turn.",
            payload: { requiresHistoryRepair: true },
            turnId: thread.session?.activeTurnId ?? null,
            createdAt: repairedAt,
          },
        });
      }
    });

  const reconcileOrphanedProviderTurnsOnStartup = () =>
    Effect.gen(function* () {
      const [readModel, bindings, liveSessions] = yield* Effect.all([
        orchestrationEngine.getReadModel(),
        providerSessionDirectory.listBindings(),
        providerService.listSessions(),
      ]);
      const bindingsByThreadId = new Map(bindings.map((binding) => [binding.threadId, binding]));
      const liveThreadIds = new Set(liveSessions.map((session) => session.threadId));
      if (Option.isSome(sqlOption))
        yield* recoverRestartBackgroundWork({
          bindings,
          liveThreadIds,
          settings: yield* serverSettings.getSettings,
        }).pipe(Effect.provideService(SqlClient.SqlClient, sqlOption.value));
      let recoveredCount = 0;
      for (const thread of readModel.threads) {
        if (thread.deletedAt !== null || providerService.getStartingSessionIdentity?.(thread.id))
          continue;
        const currentBinding = bindingsByThreadId.get(thread.id);
        const origin = {
          providerInstanceId: currentBinding?.providerInstanceId ?? null,
          sessionGeneration: readPersistedSessionGeneration(currentBinding?.runtimePayload),
        };
        // Sessions can be orphaned before a turn id was allocated. They have no
        // terminal receipt to replay, but must not remain "starting" forever.
        if (
          thread.session &&
          !liveThreadIds.has(thread.id) &&
          (thread.session.status === "starting" || thread.session.status === "running") &&
          thread.session.activeTurnId === null &&
          !(yield* providerTerminalEventRepository.hasPending(thread.id, null, origin))
        ) {
          const reconciledAt = new Date().toISOString();
          const binding = bindingsByThreadId.get(thread.id);
          if (binding)
            yield* providerSessionDirectory.upsert({
              ...binding,
              status: "stopped",
              runtimePayload: {
                ...(binding.runtimePayload && typeof binding.runtimePayload === "object"
                  ? binding.runtimePayload
                  : {}),
                activeTurnId: null,
              },
            });
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe(
              `server:orphaned-session:${thread.id}:${thread.session.updatedAt}`,
            ),
            threadId: thread.id,
            createdAt: reconciledAt,
            session: {
              ...thread.session,
              status: "error",
              activeTurnId: null,
              lastError:
                "Provider session did not survive a server restart. Send a new message to continue.",
              updatedAt: reconciledAt,
            },
          });
          continue;
        }
        const activeTurnId = thread.session?.activeTurnId;
        // A failed or interrupted session can also keep an active turn whose
        // terminal never arrived (for example a runtime.error that expected a
        // turn.completed). With no live provider nothing else will settle it,
        // and the queue waits on it forever.
        const sessionRunning = thread.session?.status === "running";
        if (
          !thread.session ||
          thread.session.status === "stopped" ||
          activeTurnId === null ||
          activeTurnId === undefined ||
          !thread.latestTurn ||
          thread.latestTurn.turnId !== activeTurnId ||
          (sessionRunning && thread.latestTurn.state !== "running") ||
          liveThreadIds.has(thread.id)
        ) {
          continue;
        }

        const binding = bindingsByThreadId.get(thread.id);
        if (!binding || binding.provider !== thread.session.providerName) {
          continue;
        }
        if (yield* providerTerminalEventRepository.hasPending(thread.id, activeTurnId, origin)) {
          continue;
        }

        const persistedActiveTurnId = readPersistedActiveTurnId(binding.runtimePayload);
        const exactPersistedMatch = persistedActiveTurnId === activeTurnId;
        const lastRuntimeEvent = readPersistedLastRuntimeEvent(binding.runtimePayload);
        const shutdownAt = readPersistedLastRuntimeEventAt(binding.runtimePayload);
        const turnBeganAt =
          thread.latestTurn.startedAt ?? thread.latestTurn.requestedAt ?? thread.updatedAt;
        const shutdownAfterTurnStarted =
          shutdownAt !== undefined &&
          Number.isFinite(Date.parse(shutdownAt)) &&
          Date.parse(shutdownAt) >= Date.parse(turnBeganAt);
        // Older bundles cleared activeTurnId during provider.stopAll. Accept
        // that one narrowly-scoped legacy marker so the deployment of this fix
        // can repair turns orphaned by the shutdown that installs it.
        const legacyShutdownMatch =
          sessionRunning &&
          persistedActiveTurnId === undefined &&
          binding.status === "stopped" &&
          lastRuntimeEvent !== undefined &&
          PROVIDER_SHUTDOWN_RUNTIME_EVENTS.has(lastRuntimeEvent) &&
          shutdownAfterTurnStarted;
        if (!exactPersistedMatch && !legacyShutdownMatch) {
          continue;
        }

        const orphanedEvent = makeOrphanedSessionExitedEvent({
          threadId: thread.id,
          turnId: activeTurnId,
          provider: binding.provider,
          providerInstanceId: binding.providerInstanceId,
          createdAt: new Date().toISOString(),
        });
        const event = {
          ...orphanedEvent,
          sessionGeneration: readPersistedSessionGeneration(binding.runtimePayload),
        };
        // One thread's failure must not abandon the rest of the scan. A
        // committed receipt is replayed by receipt retries; an uncommitted one
        // is found again by the next scan under the same deterministic id.
        const repaired = yield* providerTerminalEventRepository.record(event).pipe(
          Effect.andThen(enqueueRuntimeEvent(event)),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("startup orphaned turn repair failed for thread", {
                  threadId: thread.id,
                  turnId: activeTurnId,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as(false)),
          ),
        );
        if (repaired) recoveredCount += 1;
      }

      if (recoveredCount > 0) {
        yield* Effect.logInfo("queued orphaned provider turns for startup recovery", {
          count: recoveredCount,
        });
      }
    });

  const reconcileProfiledTurnWatchdogsOnStartup = Effect.gen(function* () {
    const [readModel, bindings] = yield* Effect.all([
      orchestrationEngine.getReadModel(),
      providerSessionDirectory.listBindings(),
    ]);
    const bindingsByThreadId = new Map(bindings.map((binding) => [binding.threadId, binding]));
    for (const thread of readModel.threads) {
      const turnId = thread.session?.activeTurnId ?? null;
      if (
        thread.session?.status !== "running" ||
        turnId === null ||
        thread.latestTurn?.state !== "running" ||
        thread.latestTurn.turnId !== turnId
      ) {
        continue;
      }
      const binding = bindingsByThreadId.get(thread.id);
      const profile =
        thread.latestTurn.workflowExecutionProfile ??
        thread.session.workflowExecutionProfile ??
        (binding
          ? readPersistedInstructionContext(binding.runtimePayload)?.workflowExecutionProfile
          : undefined);
      if (!profile) continue;
      yield* scheduleProfiledTurnWatchdog({
        threadId: thread.id,
        turnId,
        startedAt: thread.latestTurn.startedAt ?? thread.latestTurn.requestedAt,
      });
    }
  });

  const start: ProviderRuntimeIngestionShape["start"] = Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(clearAllCommandExecutionFlushTimers));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const watchdog of profiledTurnWatchdogs.values()) {
          clearTimeout(watchdog.timer);
        }
        profiledTurnWatchdogs.clear();
        for (const pending of profiledFailureStopTimers.values()) {
          clearTimeout(pending.timer);
        }
        profiledFailureStopTimers.clear();
      }),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) => enqueueRuntimeEvent(event)),
    );
    yield* reconcileOrphanedProviderTurnsOnStartup().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to reconcile provider turns at startup", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    const recoveryThreadIds = new Set<ThreadId>();
    let recoverAllThreads = false;
    yield* startTerminalReceiptRetries(
      providerTerminalEventRepository,
      enqueueRuntimeEvent,
      Effect.gen(function* () {
        const ids = yield* providerTerminalEventRepository.takeRecoveryThreadIds;
        if (ids === null) recoverAllThreads = true;
        else
          for (const id of ids) {
            if (recoveryThreadIds.size < 256) recoveryThreadIds.add(id);
            else recoverAllThreads = true;
          }
        if (recoverAllThreads || recoveryThreadIds.size > 0) {
          // Keep candidates until all repair effects succeed, so a transient
          // dispatch/storage failure cannot consume the only recovery wakeup.
          yield* surfaceExhaustedTerminalReceipts(
            recoverAllThreads ? undefined : recoveryThreadIds,
          );
          recoveryThreadIds.clear();
          recoverAllThreads = false;
        }
      }),
    );
    yield* reconcileProfiledTurnWatchdogsOnStartup.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to reconcile profiled workflow turn watchdogs", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    yield* reconcileElicitationsOnStartup(orchestrationEngine).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to settle provider input requests from before the restart", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type === "thread.turn-interrupt-requested" ||
          event.type === "thread.session-stop-requested"
        ) {
          return worker
            .enqueue({ source: "tool-update-flush", threadId: event.payload.threadId })
            .pipe(
              Effect.andThen(
                worker.enqueue({
                  source: "assistant-delta-flush-thread",
                  threadId: event.payload.threadId,
                }),
              ),
            );
        }
        if (event.type !== "thread.turn-start-requested") return Effect.void;
        return worker.enqueue({ source: "domain", event });
      }),
      { startImmediately: true },
    );
  });

  const drain = Effect.gen(function* () {
    while (pendingRuntimeAdmissions > 0) {
      yield* worker.drain;
      yield* Effect.yieldNow;
    }
    yield* worker.enqueue({ source: "tool-update-flush-all" });
    yield* worker.enqueue({ source: "command-output-flush-all" });
    yield* worker.enqueue({ source: "assistant-delta-flush-all" });
    yield* worker.drain;
  });
  yield* registerShutdown(
    "provider-ingestion",
    "drain",
    () =>
      Effect.sync(() => {
        streamingDeltas.cancelTimers();
        pendingToolUpdates.cancelTimers();
        clearAllCommandExecutionFlushTimers();
      }).pipe(Effect.andThen(drain)),
    ["provider-event-delivery"],
  );

  return { start, drain } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make,
).pipe(
  Layer.provide(ProjectionTurnRepositoryLive),
  Layer.provideMerge(ProviderTerminalEventRepositoryLive),
);
