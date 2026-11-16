import { timeOrderedUuid } from "@t3tools/shared/ids";
import { assertScheduledDeliveryAllowed } from "../../scheduledTasks/deliveryGate.ts";
import { readMcpAppModelContext } from "../../mcpApps/McpAppContext.ts";
import { MCP_APP_PROVIDERS } from "@t3tools/shared/mcpApp";
import { registerShutdown } from "../../shutdown.ts";
import { ProviderControlTarget } from "../../provider/controlTarget.ts";
import { isControlEvent } from "../commandAdmission.ts";
import { ServerConfig } from "../../config.ts";
import { withRepositoryLifecycleLock } from "../../project/Layers/WorktreeLifecycleCoordinator.ts";
import { dispatchVerifiedWorkspace } from "../../project/workspaceTransitionContext.ts";
import { buildGeneratedWorktreeBranchName } from "../../git/worktreeBranchNames.ts";
import { WorktreePreparation } from "../../project/Services/WorktreePreparation.ts";
import { deriveProviderInstanceConfigMap } from "../../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { makeOperationGate } from "../../provider/operationGate.ts";
import { resolveBindingInstanceId } from "../../provider/bindingIdentity.ts";
import { readPersistedSessionGeneration } from "../../provider/sessionCapabilities.ts";
import { isOpenCodeHistoryContinuation } from "../../provider/openCodeResume.ts";
import { withWorktreeLifecycleLock } from "../../project/Layers/WorktreeLifecycleCoordinator.ts";
import {
  assertWorktreeReady,
  WorktreeInspectionError,
  WorktreeNotReadyError,
} from "../../project/worktreeReadiness.ts";
import { assertMcpRuntimeConfig, mcpConfigErrorMessage } from "@t3tools/shared/mcpValidation";
import { readCodexMcpOAuthCallbackConfig } from "@t3tools/shared/mcpTranslation";
import { readSubmissionSource } from "../../provider/submissionProvenance.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { readProjectSettings } from "../../project/projectSettings";
import { isTemporaryWorktreeBranch } from "../../git/worktreePaths.ts";
import { ensureWorkspaceDirectory } from "../../provider/workspaceDirectory.ts";
import {
  PROVIDER_CONTEXT_HANDOFF_ACTIVITY_KIND,
  PROVIDER_DISPLAY_NAMES,
  type ChatAttachment,
  CommandId,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_NEW_THREAD_TITLE,
  defaultInstanceIdForDriver,
  EventId,
  type ModelSelection,
  type McpApplyToLiveSessionsResult,
  type McpLiveSessionReloadFailure,
  type McpReloadResult,
  type McpSessionReloadOutcome,
  MessageId,
  type OrchestrationEvent,
  ProjectId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProjectMemory,
  type OrchestrationThread,
  type ProviderModelOptions,
  type ProviderKind,
  type ProviderStartOptions,
  type OrchestrationSession,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  type TurnId,
  type WorkflowTurnExecutionProfile,
} from "@t3tools/contracts";
import { Cause, Effect, Layer, Option, Schema, Scope, Stream } from "effect";
import { makeBackgroundWorker } from "../../backgroundWorker.ts";
import { estimateMessageContextCharacters, inferProviderForModel } from "@t3tools/shared/model";
import { getProviderTurnInputLengthIssue } from "@t3tools/shared/providerInput";
import { threadReferencesToLabels } from "@t3tools/shared/threadReferences";
import { projectProviderInput } from "../threadReferenceGrants.ts";
import {
  areProviderModelOptionsEqual,
  areProviderStartOptionsEqual,
  getProviderEnvironmentKey,
  getProviderSessionRestartOptions,
  normalizeProviderStartOptions,
} from "@t3tools/shared/providerOptions";

import { isScratchProject, isScratchThreadFolder } from "@t3tools/shared/scratchProject";
import { resolveThreadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";
import { GitCore } from "../../git/Services/GitCore.ts";
import {
  increment,
  orchestrationEventsProcessedTotal,
  providerContextHandoffsTotal,
  providerSessionContextResetsTotal,
} from "../../observability/Metrics.ts";
import {
  handoffableMessages,
  hasHandoffableConversation,
} from "@t3tools/shared/conversationHandoff";
import { MAX_THREAD_MESSAGES } from "@t3tools/shared/orchestrationRetention";
import {
  ProviderHandoffStateRepository,
  type ParkedNativeSession,
  type PendingProviderHandoff,
  type ProviderHandoffStateRepositoryShape,
} from "../../persistence/Services/ProviderHandoffState.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { ThreadBackgroundWork } from "../Services/ThreadBackgroundWork.ts";
import {
  ProviderTurnDeliveryRepository,
  type DeliveryHandoff,
} from "../Services/ProviderTurnDeliveryRepository.ts";
import { DeliveryAttemptContext } from "../../provider/deliveryAttemptContext.ts";
import {
  isSameNativeSession,
  nativeSessionIdentity,
} from "../../provider/nativeSessionIdentity.ts";
import { isProviderResumeFailureText } from "../../provider/resumeFailure.ts";
import { DEFAULT_INACTIVITY_THRESHOLD_MS } from "../../provider/Layers/ProviderSessionReaper.ts";
import { pendingApprovalActivities } from "../pendingApprovals.ts";
import {
  canResumeParkedSession,
  composeHandoffInput,
  computeHandoffAllowanceChars,
  handoffMessageChars,
  HANDOFF_RENDERER_VERSION,
  renderProviderHandoff,
  selectHandoffSource,
} from "../providerHandoff.ts";
import {
  asPreSendDeliveryError,
  isNotSentProviderError,
  ProviderAdapterRequestError,
  ProviderServiceError,
  ProviderTurnDeliveryError,
} from "../../provider/Errors.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import {
  ProjectMcpConfigService,
  ProjectMcpConfigServiceError,
  type StoredEffectiveMcpConfig,
} from "../../mcp/ProjectMcpConfigService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import type { SharedInstructionInput } from "../../provider/sharedAssistantContract.ts";
import { estimateProviderInstructionTokens } from "../../provider/contextTokenEstimate.ts";
import { resolveModelContextWindowTokens } from "../../provider/modelContextWindowMetadata.ts";
import type { ProviderRuntimeBinding } from "../../provider/Services/ProviderSessionDirectory.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { buildThreadResumeContext, buildThreadCompactionTranscript } from "../compactionService.ts";
import { formatCompactSummary, getCompactPrompt } from "../compactionPrompts.ts";
import { resolveOneOffPromptRoute } from "../oneOffPromptRouting.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { toCodexProviderStartOptions } from "../../provider/codexProviderOptions.ts";
import {
  readThreadPullRequestLinks,
  threadTitlePullRequestContext,
} from "../../prHub/threadLinks.ts";
import { resolveEffectiveStartConfig } from "../../provider/effectiveStartConfig.ts";
import {
  readPersistedCwd,
  readPersistedInstructionContext,
  readPersistedProviderOptions,
  readPersistedStartConfig,
  readPersistedUnconvergedMcpConfigVersion,
  startConfigValueOrUndefined,
} from "../../provider/runtimePayload.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ComputerAutomationBroker } from "../../computer/ComputerAutomationBroker";
import { resolveAgentBrowserPolicy } from "../../mcp/browserAccess";
import { resolveProviderComputerBackendSelection } from "../../computer/computerBackendPolicy";
import { chromeSessionFingerprint } from "../../provider/chromeSessionRuntimeFactory";
import { codexChromeFingerprint } from "../../provider/codexChromeIntegration";
import {
  formatThreadTitleRegenerationContext,
  resolveBestEffortGeneratedTitleResult,
  userMessageTitleText,
} from "../../threadTitle.ts";

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.meta-updated"
      | "thread.title-regeneration-started"
      | "thread.turn-processing-quiesced"
      | "thread.title-regenerated"
      | "thread.deleted"
      | "thread.turn-start-requested"
      | "thread.turn-steer-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested"
      | "thread.archived";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function providerDisplayName(provider: ProviderKind): string {
  return PROVIDER_DISPLAY_NAMES[provider];
}

function providerFromSessionName(value: string | null | undefined): ProviderKind | undefined {
  switch (value) {
    case "codex":
    case "claudeAgent":
    case "cursor":
    case "opencode":
    case "grok":
    case "antigravity":
    case "muse":
    case "pi":
    case "acp":
      return value;
    default:
      return undefined;
  }
}

function defaultInstanceForProvider(provider: ProviderKind): ProviderInstanceId {
  return defaultInstanceIdForDriver(ProviderDriverKind.make(provider));
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${timeOrderedUuid()}`);

function threadMessageContextCharacters(thread: OrchestrationThread): number {
  return thread.messages.reduce(
    (sum, message) =>
      sum +
      estimateMessageContextCharacters({
        text: message.text,
        reasoningText: message.reasoningText,
        attachmentNames: message.attachments?.map((attachment) => attachment.name),
      }),
    0,
  );
}

function hasEligibleFirstUserMessage(thread: OrchestrationThread, messageId: string): boolean {
  const userMessages = thread.messages.filter((message) => message.role === "user");
  return (
    thread.title === DEFAULT_NEW_THREAD_TITLE &&
    thread.titleSource === "default" &&
    thread.titleRegeneration === null &&
    userMessages.length === 1 &&
    userMessages[0]?.id === messageId
  );
}

function deriveThreadTurnCount(thread: OrchestrationThread): number {
  const turnIds = new Set<string>();
  if (thread.latestTurn) {
    turnIds.add(thread.latestTurn.turnId);
  }
  for (const message of thread.messages) {
    if (message.turnId) {
      turnIds.add(message.turnId);
    }
  }
  for (const activity of thread.activities) {
    if (activity.turnId) {
      turnIds.add(activity.turnId);
    }
  }
  const checkpointTurnCount = thread.checkpoints.reduce(
    (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
    0,
  );
  return Math.max(turnIds.size, checkpointTurnCount);
}

function hasPriorConversationContext(thread: OrchestrationThread): boolean {
  return (
    thread.messages.some((message) => message.role === "assistant") ||
    deriveThreadTurnCount(thread) > 1
  );
}

function buildThreadInstructionContext(input: {
  readonly thread: OrchestrationThread;
  readonly projectTitle?: string;
  readonly projectMemories: ReadonlyArray<ProjectMemory>;
  readonly cwd?: string;
  readonly turnCount: number;
  readonly workflowExecutionProfile?: WorkflowTurnExecutionProfile;
}): Partial<SharedInstructionInput> {
  return {
    ...(input.projectTitle ? { projectTitle: input.projectTitle } : {}),
    ...(input.projectMemories.length > 0 ? { projectMemories: input.projectMemories } : {}),
    threadTitle: input.thread.title,
    turnCount: input.turnCount,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    runtimeMode: input.thread.runtimeMode,
    ...(input.workflowExecutionProfile
      ? { workflowExecutionProfile: input.workflowExecutionProfile }
      : {}),
    ...buildThreadResumeContext(input.thread),
  };
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = Cause.squash(cause);
  if (Schema.is(ProviderAdapterRequestError)(error)) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request") ||
      detail.includes("unknown pending codex approval request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request") ||
    message.includes("unknown pending codex approval request")
  );
}

/**
 * Maps a turn-start failure to a durable delivery outcome. Only failures that
 * prove the input never reached the model are `not_sent`; anything else is
 * ambiguous so the user rechecks provider history before retrying.
 */
export function toProviderTurnDeliveryError(error: unknown): ProviderTurnDeliveryError {
  if (Schema.is(ProviderTurnDeliveryError)(error)) return error;
  if (error instanceof WorktreeInspectionError || error instanceof WorktreeNotReadyError)
    return new ProviderTurnDeliveryError({
      certainty: "not_sent",
      retryable: error instanceof WorktreeInspectionError,
      detail: error.message,
    });
  let rejectedUsageLimit: import("@t3tools/contracts").RuntimeUsageLimit | undefined;
  let rejectedMessage: string | undefined;
  let adapterNotSent: ProviderAdapterRequestError | undefined;
  let nested: unknown = error;
  const seen = new Set<unknown>();
  while (nested && typeof nested === "object" && !seen.has(nested)) {
    seen.add(nested);
    if (
      Schema.is(ProviderAdapterRequestError)(nested) &&
      nested.usageLimit &&
      nested.method === "turn/start"
    ) {
      rejectedUsageLimit = nested.usageLimit;
      rejectedMessage = nested.message;
      break;
    }
    if (
      Schema.is(ProviderAdapterRequestError)(nested) &&
      nested.deliveryCertainty === "not_sent" &&
      adapterNotSent === undefined
    ) {
      adapterNotSent = nested;
    }
    nested = "cause" in nested ? nested.cause : undefined;
  }
  if (!rejectedUsageLimit && adapterNotSent) {
    // The adapter proved the input never reached the model.
    return new ProviderTurnDeliveryError({
      certainty: "not_sent",
      retryable: adapterNotSent.deliveryRetryable === true,
      detail: adapterNotSent.detail,
      cause: error,
    });
  }
  const definitelyNotSent = !!rejectedUsageLimit || isNotSentProviderError(error);
  const detail =
    rejectedMessage ??
    (definitelyNotSent
      ? error instanceof Error
        ? error.message
        : "The provider rejected the turn before it was sent."
      : "The provider delivery outcome is unknown. Recheck provider history before retrying.");
  return new ProviderTurnDeliveryError({
    certainty: definitelyNotSent ? "not_sent" : "unknown",
    ...(rejectedUsageLimit ? { usageLimit: rejectedUsageLimit } : {}),
    retryable: false,
    detail,
    cause: error,
  });
}

/** Maps a failure that happened before the provider send; it keeps known not-sent mappings. */
export function toPreSendDeliveryError(error: unknown): ProviderTurnDeliveryError {
  const mapped = toProviderTurnDeliveryError(error);
  return mapped.certainty === "not_sent" ? mapped : asPreSendDeliveryError(error);
}

/** Room the adapters' own per-turn runtime context takes next to the request. */
const HANDOFF_RUNTIME_CONTEXT_CHARS = 2_000;

function providerSwitchRefused(detail: string, retryable = true): ProviderTurnDeliveryError {
  return new ProviderTurnDeliveryError({ certainty: "not_sent", retryable, detail });
}

function handoffEndpointLabel(provider: ProviderKind, model: string | null | undefined): string {
  return model ? `${providerDisplayName(provider)} · ${model}` : providerDisplayName(provider);
}

/** A provider-native goal that is still running or paused binds the thread to its session. */
function hasNonterminalNativeGoal(thread: OrchestrationThread): boolean {
  const payload = thread.activities.findLast(
    (activity) =>
      activity.kind === "native.metadata" &&
      activity.payload !== null &&
      typeof activity.payload === "object" &&
      "nativeGoal" in activity.payload,
  )?.payload as { nativeGoal?: { status?: unknown } | null } | undefined;
  const status = payload?.nativeGoal?.status;
  return status === "active" || status === "paused";
}

/** Every message and detail along an error's cause chain. */
/**
 * Instructions without the restored compaction summary and preserved
 * transcripts. Those are unbounded and overlap the handoff block, which carries
 * the same history within the target's budget.
 */
function withoutRestoredHistory(
  context: Partial<SharedInstructionInput>,
): Partial<SharedInstructionInput> {
  const {
    priorWorkSummary: _summary,
    preservedTranscriptBefore: _before,
    preservedTranscriptAfter: _after,
    ...rest
  } = context;
  return rest;
}

/** The resume cursor without Claude's lost-transcript flag (cleared once a summary is delivered). */
export function withoutTranscriptIncomplete(cursor: unknown): unknown {
  if (!cursor || typeof cursor !== "object" || !("transcriptIncomplete" in cursor)) return cursor;
  const { transcriptIncomplete: _cleared, ...rest } = cursor as Record<string, unknown>;
  return rest;
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { message?: unknown; detail?: unknown; cause?: unknown };
    for (const part of [record.message, record.detail])
      if (typeof part === "string") parts.push(part);
    current = record.cause;
  }
  if (typeof current === "string") parts.push(current);
  return parts.join("\n");
}

/**
 * A send the provider refused because the resumed native session cannot be
 * loaded. Claude, for one, only confirms a resume once the first prompt reaches
 * the CLI, so this surfaces from sendTurn rather than from startSession.
 */
function isNotSentResumeFailure(error: unknown): boolean {
  const value = error as { deliveryCertainty?: unknown; certainty?: unknown } | null;
  return (
    (value?.deliveryCertainty === "not_sent" || value?.certainty === "not_sent") &&
    isProviderResumeFailureText(errorText(error))
  );
}

const make = Effect.gen(function* () {
  const reactorScope = yield* Scope.Scope;
  // Serializes turn delivery with archive stops and MCP-apply restarts per thread, so Apply
  // never stops a session between its idle check and a new turn. Separate
  // from `withProviderThreadAccess`, which startSession takes itself.
  const activeSubmissions = new Map<ThreadId, number>();
  const withThreadTurnGate = makeOperationGate<ThreadId>();
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
  // Optional so narrow test layers keep today's reset-on-switch behavior.
  const handoffStates = yield* Effect.serviceOption(ProviderHandoffStateRepository);
  const deliveryRepository = yield* Effect.serviceOption(ProviderTurnDeliveryRepository);
  const instanceRegistry = yield* Effect.serviceOption(ProviderInstanceRegistry);
  const backgroundWork = yield* Effect.serviceOption(ThreadBackgroundWork);
  const appContextForTurn = (threadId: ThreadId, provider: ProviderKind | undefined) =>
    provider !== undefined && MCP_APP_PROVIDERS.has(provider) && Option.isSome(sqlOption)
      ? readMcpAppModelContext(threadId, provider).pipe(
          Effect.provideService(SqlClient.SqlClient, sqlOption.value),
        )
      : Effect.succeed("");
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const projectMcpConfigService = yield* ProjectMcpConfigService;
  const git = yield* GitCore;
  const workspaceConfig = yield* ServerConfig;
  const preparation = yield* Effect.serviceOption(WorktreePreparation);
  const textGeneration = yield* TextGeneration;
  const serverSettings = yield* ServerSettingsService;
  const computerBroker = yield* Effect.serviceOption(ComputerAutomationBroker);
  const computerSelections = new Map<string, string>();
  const threadProviderOptions = new Map<string, ProviderStartOptions>();
  const settingsForThread = (thread: { projectId: ProjectId; worktreePath: string | null }) =>
    Effect.gen(function* () {
      const global = yield* serverSettings.getSettings;
      const model = yield* orchestrationEngine.getReadModel();
      const project = model.projects.find((p) => p.id === thread.projectId && p.deletedAt === null);
      return project ? (yield* readProjectSettings(global, project)).settings : global;
    });
  const threadModelOptions = new Map<string, ProviderModelOptions>();
  // Keep failed shutdowns until the adapter confirms success. Tombstones seed
  // this work again at startup, so a restart cannot forget a surviving runtime.
  const deletedSessionStops = new Map<ThreadId, { attempts: number; retryAt: number }>();
  const stopDeletedSession = (threadId: ThreadId) =>
    withThreadTurnGate(
      threadId,
      providerService.stopSession({ threadId }).pipe(
        Effect.tap(() => Effect.sync(() => deletedSessionStops.delete(threadId))),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
          return Effect.sync(() => {
            const attempts = (deletedSessionStops.get(threadId)?.attempts ?? 0) + 1;
            deletedSessionStops.set(threadId, {
              attempts,
              retryAt: Date.now() + Math.min(30_000, 1_000 * 2 ** Math.min(attempts - 1, 5)),
            });
          }).pipe(
            Effect.andThen(
              Effect.logError("Failed to stop provider for deleted thread; shutdown will retry", {
                threadId,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        }),
        Effect.ensuring(
          Effect.sync(() => {
            threadProviderOptions.delete(threadId);
            threadModelOptions.delete(threadId);
          }),
        ),
      ),
    );

  const requireDeliverableThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const thread = yield* resolveThread(threadId);
    if (!thread || thread.deletedAt !== null || thread.archivedAt !== null)
      return yield* new ProviderTurnDeliveryError({
        certainty: "not_sent",
        retryable: false,
        detail: "The queued turn's thread is missing, deleted, or archived.",
      });
    return thread;
  });

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly deliveryId?: CommandId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.steer.failed"
      | "provider.turn.continuation.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("provider-failure-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(timeOrderedUuid()),
        tone: "error",
        kind: input.kind,
        summary: input.summary,
        payload: {
          detail: input.detail,
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const appendProviderContextResetActivity = (input: {
    readonly threadId: ThreadId;
    readonly provider: ProviderKind;
    readonly reason: string;
    readonly restartReasons: ReadonlyArray<string>;
    readonly createdAt: string;
  }) =>
    orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: serverCommandId("provider-context-reset-activity"),
        threadId: input.threadId,
        activity: {
          id: EventId.makeUnsafe(timeOrderedUuid()),
          tone: "info",
          kind: "runtime.warning",
          summary: "Session context reset",
          payload: {
            message: `Started a new ${providerDisplayName(input.provider)} session (${input.reason}); the earlier conversation is no longer in the agent's context.`,
            category: "provider",
            actionable: true,
            detail: {
              reason: input.reason,
              restartReasons: input.restartReasons,
            },
          },
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      })
      .pipe(
        Effect.tap(() =>
          increment(providerSessionContextResetsTotal, {
            provider: input.provider,
            reason: input.reason,
          }),
        ),
      );

  /**
   * Refuses a provider switch before the source session is touched while that
   * session still owns something the switch would silently drop. Nothing is
   * answered, cleared or stopped on the user's behalf.
   */
  const assertProviderSwitchAllowed = Effect.fnUntraced(function* (input: {
    readonly thread: OrchestrationThread;
    readonly targetInstanceId: ProviderInstanceId;
    readonly userText: string;
  }) {
    const { thread } = input;
    if (Option.isSome(instanceRegistry)) {
      const instance = yield* instanceRegistry.value.getInstance(input.targetInstanceId);
      if (!instance || !instance.enabled)
        return yield* providerSwitchRefused(
          `The selected provider instance '${input.targetInstanceId}' is not available.`,
          false,
        );
    }
    if (pendingApprovalActivities(thread).length > 0 || (thread.pendingUserInputs?.length ?? 0) > 0)
      return yield* providerSwitchRefused(
        "Answer the open approval or question before switching providers.",
      );
    if (hasNonterminalNativeGoal(thread))
      return yield* providerSwitchRefused(
        "Finish or clear the provider's goal before switching providers.",
      );
    const rewindPending = (thread.rewindDrafts ?? []).some((draft) => draft.state !== "completed");
    if (Option.isSome(sqlOption)) {
      const sql = sqlOption.value;
      // Queried directly: the thread listing is capped and could hide an old operation.
      if (
        (yield* sql`SELECT 1 FROM native_operations WHERE thread_id = ${thread.id}
          AND state IN ('requested', 'dispatched', 'running', 'indeterminate') LIMIT 1`).length > 0
      )
        return yield* providerSwitchRefused(
          "A provider operation is still running. Wait for it to finish before switching providers.",
        );
      if (
        rewindPending ||
        (yield* sql`SELECT 1 FROM rewind_operations WHERE thread_id = ${thread.id}
          AND state <> 'completed' LIMIT 1`).length > 0
      )
        return yield* providerSwitchRefused(
          "Finish the rewind in progress before switching providers.",
        );
    } else if (rewindPending)
      return yield* providerSwitchRefused(
        "Finish the rewind in progress before switching providers.",
      );
    if (
      Option.isSome(backgroundWork) &&
      (yield* backgroundWork.value.hasFreshProtectingWork({
        threadId: thread.id,
        freshSince: new Date(Date.now() - DEFAULT_INACTIVITY_THRESHOLD_MS).toISOString(),
      }))
    )
      return yield* providerSwitchRefused(
        "Background work of the current provider is still running. Wait for it or stop it before switching providers.",
      );
    const classification = providerService.classifyTurnInput
      ? yield* providerService.classifyTurnInput({
          threadId: thread.id,
          instanceId: input.targetInstanceId,
          text: input.userText,
          cwd:
            resolveThreadWorkspaceCwd({
              thread,
              projects: (yield* orchestrationEngine.getReadModel()).projects,
            }) ?? undefined,
        })
      : "prompt";
    if (classification === "native-command")
      return yield* providerSwitchRefused(
        "A provider command cannot start a provider switch. Send an ordinary message first.",
        false,
      );
  });

  /**
   * Bookkeeping after a handoff reached the provider; failures never fail the turn.
   * Every failure here errs towards sending history again rather than losing it:
   * an ambiguous delivery or a lost marker clear leaves the marker for the next turn.
   */
  const recordHandoffDelivered = (input: {
    readonly threadId: ThreadId;
    readonly deliveryId: CommandId | undefined;
    readonly handoff: DeliveryHandoff;
    /** False when no durable delivery cleared the marker with the receipt. */
    readonly consumedWithReceipt: boolean;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const { handoff } = input;
      if (!input.consumedWithReceipt && Option.isSome(handoffStates)) {
        const repository = handoffStates.value;
        const clear = Effect.gen(function* () {
          const state = yield* repository.get(input.threadId);
          if (state?.pending?.id !== handoff.id) return true;
          const cleared = yield* repository.compareAndSet({
            threadId: input.threadId,
            expectedRevision: state.revision,
            pending: null,
            parked: state.parked,
          });
          return cleared !== null;
        });
        if (!((yield* clear) || (yield* clear)))
          yield* Effect.logWarning(
            "provider command reactor could not clear a delivered handoff marker; the next turn hands off again",
            { threadId: input.threadId, handoffId: handoff.id },
          );
      }
      const from = handoffEndpointLabel(handoff.fromProvider as ProviderKind, handoff.fromModel);
      const to = handoffEndpointLabel(handoff.toProvider as ProviderKind, handoff.toModel);
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: serverCommandId("provider-context-handoff"),
        threadId: input.threadId,
        activity: {
          // One activity per delivery: a marker an ambiguous delivery kept can be
          // delivered again by a later turn.
          id: EventId.makeUnsafe(
            `provider-handoff:${handoff.id}:${input.deliveryId ?? timeOrderedUuid()}`,
          ),
          tone: "info",
          kind: PROVIDER_CONTEXT_HANDOFF_ACTIVITY_KIND,
          summary:
            handoff.effectiveMode === "delta"
              ? `${to} resumed its earlier session`
              : `Context handed off from ${from} to ${to}`,
          payload: {
            fromProvider: handoff.fromProvider,
            fromInstanceId: handoff.fromInstanceId,
            fromModel: handoff.fromModel,
            toProvider: handoff.toProvider,
            toInstanceId: handoff.toInstanceId,
            toModel: handoff.toModel,
            requestedMode: handoff.requestedMode,
            effectiveMode: handoff.effectiveMode,
            includedCount: handoff.includedCount,
            omittedCount: handoff.omittedCount,
            summaryIncluded: handoff.summaryIncluded,
          },
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
      yield* increment(providerContextHandoffsTotal, {
        from: handoff.fromProvider,
        to: handoff.toProvider,
        requestedMode: handoff.requestedMode,
        effectiveMode: handoff.effectiveMode,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("provider command reactor failed to record a context handoff", {
              threadId: input.threadId,
              handoffId: input.handoff.id,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  /**
   * A delta handoff whose resumed session the provider could not load: the
   * marker becomes a full handoff and the binding loses its cursor, so the retry
   * starts the target fresh with the whole conversation. Fails with a retryable
   * not-sent error once that is in place, otherwise with the provider's error.
   */
  const fallBackToFullHandoff = <E>(input: {
    readonly threadId: ThreadId;
    readonly handoff: DeliveryHandoff;
    readonly error: E;
  }) =>
    Effect.gen(function* () {
      const { handoff } = input;
      if (Option.isNone(handoffStates)) return yield* Effect.fail(input.error);
      const repository = handoffStates.value;
      let dropped: ParkedNativeSession | undefined;
      const promote = Effect.gen(function* () {
        const state = yield* repository.get(input.threadId);
        if (state?.pending?.id !== handoff.id) return false;
        const parked = { ...state.parked };
        dropped = parked[handoff.toInstanceId];
        delete parked[handoff.toInstanceId];
        const written = yield* repository.compareAndSet({
          threadId: input.threadId,
          expectedRevision: state.revision,
          pending: {
            ...state.pending,
            mode: "full",
            sinceMessageId: null,
            expectedNativeIdentity: null,
          },
          parked,
        });
        return written !== null;
      });
      const ready = yield* Effect.gen(function* () {
        if (!((yield* promote) || (yield* promote))) return false;
        // The session that could not resume, and any parked one, are unreachable now.
        const unresumable = yield* providerSessionDirectory
          .getBinding(input.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        yield* retireNativeSessions(input.threadId, [
          ...(dropped ? [dropped] : []),
          ...(unresumable
            ? [
                {
                  provider: unresumable.provider,
                  providerInstanceId:
                    unresumable.providerInstanceId ?? (handoff.toInstanceId as ProviderInstanceId),
                  resumeCursor: unresumable.resumeCursor,
                },
              ]
            : []),
        ]);
        yield* providerService.stopSession({ threadId: input.threadId }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("provider handoff fallback could not stop the unresumable session", {
              threadId: input.threadId,
              cause,
            }),
          ),
        );
        yield* providerSessionDirectory.upsert({
          threadId: input.threadId,
          provider: handoff.toProvider as ProviderKind,
          providerInstanceId: handoff.toInstanceId as ProviderInstanceId,
          resumeCursor: null,
        });
        return true;
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("provider handoff could not fall back to a full handoff", {
                threadId: input.threadId,
                handoffId: handoff.id,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
        ),
      );
      if (!ready) return yield* Effect.fail(input.error);
      yield* Effect.logWarning("provider handoff resume failed; retrying with a full handoff", {
        threadId: input.threadId,
        handoffId: handoff.id,
        instanceId: handoff.toInstanceId,
      });
      return yield* new ProviderTurnDeliveryError({
        certainty: "not_sent",
        retryable: true,
        detail: `${handoffEndpointLabel(handoff.toProvider as ProviderKind, handoff.toModel)} could not resume its earlier session, so this message was not sent. Retrying it starts a fresh session with the full conversation.`,
      });
    });

  /**
   * Records native sessions a switch discarded without resuming, so deleting the
   * thread still removes their transcripts. Best effort: never fails the turn.
   */
  const retireNativeSessions = (
    threadId: ThreadId,
    sessions: ReadonlyArray<{
      readonly provider: ProviderKind;
      readonly providerInstanceId: ProviderInstanceId;
      readonly resumeCursor: unknown;
    }>,
  ) => {
    const retired = sessions.filter(
      (session) => session.resumeCursor !== undefined && session.resumeCursor !== null,
    );
    if (Option.isNone(handoffStates) || retired.length === 0) return Effect.void;
    const retiredAt = new Date().toISOString();
    return handoffStates.value
      .retire({
        threadId,
        sessions: retired.map((session) => ({
          provider: session.provider,
          providerInstanceId: session.providerInstanceId,
          resumeCursor: session.resumeCursor,
          retiredAt,
        })),
      })
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("provider switch could not record a discarded native session", {
                threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      );
  };

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: serverCommandId("provider-session-set"),
      threadId: input.threadId,
      session: input.session,
      createdAt: input.createdAt,
    });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    return readModel.threads.find((entry) => entry.id === threadId);
  });

  const resolveActiveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const thread = yield* resolveThread(threadId);
    return thread?.deletedAt === null ? thread : null;
  });

  const resolveThreadWorkspaceContext = Effect.fnUntraced(function* (
    threadId: ThreadId,
    operation: "start" | "steer" | "continuation" = "start",
    reportFailure = true,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return yield* new ProviderTurnDeliveryError({
        certainty: "not_sent",
        retryable: false,
        detail: "The thread was not found in the read model.",
      });
    }

    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });
    const project = readModel.projects.find(
      (project) => project.id === thread.projectId && project.deletedAt === null,
    );
    const scratch = isScratchProject(project);
    if (
      (scratch &&
        (!thread.scratchPath ||
          !isScratchThreadFolder(project!.workspaceRoot, thread.scratchPath) ||
          thread.branch !== null ||
          thread.worktreePath !== null)) ||
      (!project && thread.scratchPath)
    ) {
      const detail = "The thread without a project has an invalid workspace folder or Git state.";
      if (reportFailure)
        yield* appendProviderFailureActivity({
          threadId,
          kind: `provider.turn.${operation}.failed`,
          summary: `Provider turn ${operation} failed`,
          detail,
          turnId: null,
          createdAt: new Date().toISOString(),
        });
      return yield* new ProviderTurnDeliveryError({
        certainty: "not_sent",
        retryable: false,
        detail,
      });
    }
    return { thread, project, effectiveCwd, scratch };
  });

  const resolveThreadInstructionContext = Effect.fnUntraced(function* (
    threadId: ThreadId,
    workflowExecutionProfile?: WorkflowTurnExecutionProfile,
    reportWorkspaceFailure = true,
  ) {
    const { thread, project, effectiveCwd, scratch } = yield* resolveThreadWorkspaceContext(
      threadId,
      "start",
      reportWorkspaceFailure,
    );
    yield* Effect.logInfo("provider command reactor resolved thread session start context", {
      threadId,
      threadWorktreePath: thread.worktreePath,
      projectWorkspaceRoot: project?.workspaceRoot ?? null,
      effectiveCwd: effectiveCwd ?? null,
    });
    const activeProjectMemories = (scratch ? [] : (project?.memories ?? [])).filter(
      (memory) => memory.deletedAt === null,
    );
    const instructionContext = buildThreadInstructionContext({
      thread,
      ...(!scratch && project?.title ? { projectTitle: project.title } : {}),
      projectMemories: activeProjectMemories,
      ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
      turnCount: deriveThreadTurnCount(thread),
      ...(workflowExecutionProfile ? { workflowExecutionProfile } : {}),
    });
    return { thread, instructionContext, effectiveCwd };
  });

  const resolveThreadSessionStartContext = Effect.fnUntraced(function* (
    threadId: ThreadId,
    resolvedContext?: Effect.Success<ReturnType<typeof resolveThreadInstructionContext>>,
    reportWorkspaceFailure = true,
  ) {
    const { thread, instructionContext } =
      resolvedContext ??
      (yield* resolveThreadInstructionContext(threadId, undefined, reportWorkspaceFailure));
    const persistedBindingOption = yield* providerSessionDirectory.getBinding(threadId);

    return {
      thread,
      instructionContext,
      persistedBinding: Option.getOrUndefined(persistedBindingOption),
      desiredRuntimeMode: thread.runtimeMode,
      desiredModel: thread.model,
    };
  });

  const bindSessionToThreadWithContext = (input: {
    readonly thread: OrchestrationThread;
    readonly session: ProviderSession;
    readonly createdAt: string;
    readonly desiredRuntimeMode: RuntimeMode;
    readonly desiredModel?: string;
    readonly instructionContext: Partial<SharedInstructionInput>;
  }) =>
    Effect.promise(() =>
      estimateProviderInstructionTokens({
        provider: input.session.provider,
        interactionMode: input.thread.interactionMode,
        instructionContext: input.instructionContext,
        model: input.session.model ?? input.desiredModel ?? input.thread.model,
      }),
    ).pipe(
      Effect.flatMap((instructionTokens) =>
        Effect.sync(() => {
          const estimatedContextTokens =
            instructionTokens + threadMessageContextCharacters(input.thread);
          const modelContextWindowTokens = resolveModelContextWindowTokens({
            provider: input.session.provider,
            model: input.session.model ?? input.desiredModel ?? input.thread.model,
          });
          const providerContextTokens =
            input.thread.session?.estimatedContextTokens ??
            input.thread.estimatedContextTokens ??
            undefined;
          const providerWindowTokens =
            input.thread.session?.modelContextWindowTokens ??
            input.thread.modelContextWindowTokens ??
            undefined;
          const shouldPreserveProviderTokenUsage =
            input.thread.session?.tokenUsageSource === "provider" &&
            input.thread.session.providerName === input.session.provider &&
            providerContextTokens !== undefined;
          const providerLastError = input.session.lastError ?? null;
          const isSameProjectedFailure =
            providerLastError !== null && input.thread.session?.lastError === providerLastError;
          const fallbackErrorId = providerLastError
            ? `provider-session:${input.thread.id}:${input.session.updatedAt}`
            : null;

          return {
            tokenUsage: {
              estimatedContextTokens: shouldPreserveProviderTokenUsage
                ? providerContextTokens
                : estimatedContextTokens,
              modelContextWindowTokens: shouldPreserveProviderTokenUsage
                ? (providerWindowTokens ?? modelContextWindowTokens)
                : modelContextWindowTokens,
              tokenUsageSource: shouldPreserveProviderTokenUsage
                ? ("provider" as const)
                : ("estimated" as const),
            },
            providerLastError,
            lastErrorId: isSameProjectedFailure
              ? (input.thread.session?.lastErrorId ?? fallbackErrorId)
              : fallbackErrorId,
            lastErrorOccurredAt: isSameProjectedFailure
              ? (input.thread.session?.lastErrorOccurredAt ?? input.session.updatedAt)
              : providerLastError
                ? input.session.updatedAt
                : null,
          };
        }).pipe(
          Effect.flatMap((tokenUsage) =>
            setThreadSession({
              threadId: input.thread.id,
              session: {
                threadId: input.thread.id,
                status: mapProviderSessionStatusToOrchestrationStatus(input.session.status),
                providerName: input.session.provider,
                providerInstanceId: input.session.providerInstanceId ?? null,
                runtimeMode: input.desiredRuntimeMode,
                activeTurnId: null,
                lastError: tokenUsage.providerLastError,
                lastErrorId: tokenUsage.lastErrorId,
                lastErrorOccurredAt: tokenUsage.lastErrorOccurredAt,
                ...tokenUsage.tokenUsage,
                // Started or resumed sessions carry their generation's snapshot;
                // re-binding an already running session keeps the projected one.
                ...(input.session.capabilities ? { capabilities: input.session.capabilities } : {}),
                updatedAt: input.session.updatedAt,
              },
              createdAt: input.createdAt,
            }),
          ),
        ),
      ),
    );

  const ensureSessionForThread = Effect.fnUntraced(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly provider?: ProviderKind;
      readonly model?: string;
      readonly modelSelection?: ModelSelection;
      readonly preferredInstanceId?: ProviderInstanceId;
      readonly modelOptions?: ProviderModelOptions;
      readonly providerOptions?: ProviderStartOptions;
      readonly workflowExecutionProfile?: WorkflowTurnExecutionProfile;
      readonly keepWorkflowExecutionProfile?: boolean;
      readonly reportWorkspaceFailure?: boolean;
      /** For an automation's turn: a new session asks no consent, and none restarts for one. */
      readonly unattended?: boolean;
      /**
       * Set only for an ordinary turn. A switch to another provider instance then
       * hands this conversation off instead of resetting the agent's context.
       */
      readonly handoff?: { readonly messageId: string; readonly userText: string };
      readonly resolvedContext?: Effect.Success<ReturnType<typeof resolveThreadInstructionContext>>;
    },
  ) {
    return yield* Effect.gen(function* () {
      const sessionContext = yield* resolveThreadSessionStartContext(
        threadId,
        options?.resolvedContext,
        options?.reportWorkspaceFailure !== false,
      );
      const {
        thread,
        instructionContext: baseInstructionContext,
        persistedBinding,
        desiredRuntimeMode,
      } = sessionContext;
      if (thread.worktreePath) {
        const project = (yield* orchestrationEngine.getReadModel()).projects.find(
          (entry) => entry.id === thread.projectId,
        );
        if (!project) return yield* Effect.fail(new Error("Unknown project"));
        yield* assertWorktreeReady(git, {
          projectCwd: project.workspaceRoot,
          worktreePath: thread.worktreePath,
          branch: thread.branch,
        });
        if (thread.branch && Option.isSome(preparation))
          yield* preparation.value.prepare({
            threadId: thread.id,
            projectId: project.id,
            worktreePath: thread.worktreePath,
            branch: thread.branch,
          });
      }
      const activeWorkflowExecutionProfile = readPersistedInstructionContext(
        persistedBinding?.runtimePayload,
      )?.workflowExecutionProfile;
      const desiredWorkflowExecutionProfile = options?.keepWorkflowExecutionProfile
        ? activeWorkflowExecutionProfile
        : options?.workflowExecutionProfile;
      const instructionContext: Partial<SharedInstructionInput> = {
        ...baseInstructionContext,
        ...(desiredWorkflowExecutionProfile
          ? { workflowExecutionProfile: desiredWorkflowExecutionProfile }
          : {}),
      };
      let recoveredPriorWorkSummary: string | undefined;
      const currentProvider = providerFromSessionName(thread.session?.providerName);
      const currentInstanceId =
        thread.session?.providerInstanceId ??
        persistedBinding?.providerInstanceId ??
        (currentProvider ? defaultInstanceForProvider(currentProvider) : undefined);
      const threadSelectionProvider = thread.modelSelection?.model
        ? inferProviderForModel(thread.modelSelection.model)
        : undefined;
      // A refresh never switches instances under a handoffable conversation; the
      // next ordinary turn switches with a handoff instead of resetting context.
      const deferInstanceSwitch =
        options?.handoff === undefined &&
        Option.isSome(handoffStates) &&
        hasHandoffableConversation(thread.messages);
      const sameProviderThreadSelectionInstanceId =
        !deferInstanceSwitch &&
        threadSelectionProvider !== undefined &&
        threadSelectionProvider === currentProvider
          ? thread.modelSelection?.instanceId
          : undefined;
      // The requested selection, not the current session, decides the target: a
      // command that names only another driver's instance still switches to it.
      const explicitInstanceId =
        options?.preferredInstanceId ?? options?.modelSelection?.instanceId;
      const explicitInstance =
        explicitInstanceId !== undefined && Option.isSome(instanceRegistry)
          ? yield* instanceRegistry.value.getInstance(explicitInstanceId)
          : undefined;
      const requestedProvider: ProviderKind | undefined =
        options?.provider ?? providerFromSessionName(explicitInstance?.driverKind);
      const preferredInstanceId =
        explicitInstanceId ??
        (requestedProvider !== undefined && requestedProvider !== currentProvider
          ? defaultInstanceForProvider(requestedProvider)
          : (sameProviderThreadSelectionInstanceId ?? currentInstanceId));
      const preferredProvider: ProviderKind | undefined = requestedProvider ?? currentProvider;
      const persistedStartConfig = readPersistedStartConfig(persistedBinding?.runtimePayload);
      const memoryStartConfig = {
        ...(threadProviderOptions.has(threadId)
          ? { providerOptions: threadProviderOptions.get(threadId) }
          : {}),
        ...(threadModelOptions.has(threadId)
          ? { modelOptions: threadModelOptions.get(threadId) }
          : {}),
        ...((thread.modelSelection?.model ?? sessionContext.desiredModel)
          ? { model: thread.modelSelection?.model ?? sessionContext.desiredModel }
          : {}),
      };
      const commandModel = options?.model ?? options?.modelSelection?.model;
      const commandStartConfig = {
        ...(options && Object.hasOwn(options, "providerOptions")
          ? { providerOptions: options.providerOptions }
          : {}),
        ...(options && Object.hasOwn(options, "modelOptions")
          ? { modelOptions: options.modelOptions }
          : {}),
        ...(commandModel !== undefined ? { model: commandModel } : {}),
      };
      const baselineStartConfig = resolveEffectiveStartConfig({
        memory: memoryStartConfig,
        persisted: persistedStartConfig,
      });
      const unresolvedEffectiveStartConfig = resolveEffectiveStartConfig({
        command: commandStartConfig,
        memory: memoryStartConfig,
        persisted: persistedStartConfig,
      });
      const projectRuntimeSettings = yield* settingsForThread(thread);
      const effectiveStartConfig = {
        ...unresolvedEffectiveStartConfig,
        providerOptions: preferredProvider
          ? normalizeProviderStartOptions(
              preferredProvider,
              unresolvedEffectiveStartConfig.providerOptions,
            )
          : unresolvedEffectiveStartConfig.providerOptions,
      };
      if (
        preferredProvider === "claudeAgent" &&
        effectiveStartConfig.providerOptions?.claudeAgent?.promptSuggestions === undefined &&
        projectRuntimeSettings.enableClaudePromptSuggestions
      ) {
        effectiveStartConfig.providerOptions = {
          ...effectiveStartConfig.providerOptions,
          claudeAgent: {
            ...effectiveStartConfig.providerOptions?.claudeAgent,
            promptSuggestions: true,
          },
        };
      }
      const desiredModel = effectiveStartConfig.model;
      const recordEffectiveStartConfig = () =>
        Effect.sync(() => {
          if (effectiveStartConfig.providerOptions !== undefined) {
            threadProviderOptions.set(threadId, effectiveStartConfig.providerOptions);
          } else {
            threadProviderOptions.delete(threadId);
          }
          if (effectiveStartConfig.modelOptions !== undefined) {
            threadModelOptions.set(threadId, effectiveStartConfig.modelOptions);
          } else {
            threadModelOptions.delete(threadId);
          }
        });
      yield* Effect.annotateCurrentSpan({
        "provider.thread_id": threadId,
        "provider.operation": "ensure-session",
        ...(preferredProvider ? { "provider.desired_kind": preferredProvider } : {}),
        ...(desiredModel ? { "provider.desired_model": desiredModel } : {}),
      });
      const readModel = yield* orchestrationEngine.getReadModel();
      const project = readModel.projects.find(
        (project) => project.id === thread.projectId && project.deletedAt === null,
      );

      const currentProjectMcpSnapshot = project
        ? yield* projectMcpConfigService.readEffectiveRuntimeConfig(project.id).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not read project MCP config", {
                projectId: project.id,
                detail: error.message,
              }).pipe(Effect.as(undefined)),
            ),
          )
        : undefined;
      // Validate new client input even when an existing session can otherwise be reused.
      if (effectiveStartConfig.providerOptionsSource === "command")
        yield* Effect.try({
          try: () => assertMcpRuntimeConfig(effectiveStartConfig.providerOptions?.mcpServers),
          catch: (cause) =>
            new ProjectMcpConfigServiceError({
              code: "validation",
              message: mcpConfigErrorMessage(cause),
            }),
        });

      const resolveActiveSession = (threadId: ThreadId) =>
        providerService
          .listSessions()
          .pipe(
            Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)),
          );

      const startProviderSession = (input?: {
        readonly resumeCursor?: unknown;
        readonly provider?: ProviderKind;
        /**
         * The session's first turn carries a context handoff, which delivers the
         * conversation within its own budget: never summarize it a second time, and
         * never restore the compaction summary and transcripts next to it.
         */
        readonly carriesHandoff?: boolean;
      }) => {
        const providerForStart = input?.provider ?? preferredProvider;
        const startInstructionContext = input?.carriesHandoff
          ? withoutRestoredHistory(instructionContext)
          : instructionContext;

        return Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({
            "provider.operation": "start-session",
            "provider.thread_id": threadId,
            ...(providerForStart ? { "provider.kind": providerForStart } : {}),
            ...(desiredModel ? { "provider.model": desiredModel } : {}),
            "provider.has_resume_cursor": input?.resumeCursor !== undefined,
          });
          yield* Effect.try({
            try: () => {
              const servers =
                currentProjectMcpSnapshot?.servers ??
                effectiveStartConfig.providerOptions?.mcpServers;
              assertMcpRuntimeConfig(servers, providerForStart ?? currentProvider);
              if ((providerForStart ?? currentProvider) === "codex")
                readCodexMcpOAuthCallbackConfig(servers);
            },
            catch: (cause) =>
              new ProjectMcpConfigServiceError({
                code: "validation",
                message: mcpConfigErrorMessage(cause),
              }),
          });
          const needsNativeRecovery =
            input?.carriesHandoff !== true &&
            thread.compaction?.kind === "native" &&
            instructionContext.priorWorkSummary === undefined;
          const recoverSummary = () =>
            Effect.gen(function* () {
              const transcript = buildThreadCompactionTranscript({
                thread,
                direction: null,
                pivotMessageId: null,
              });
              const route = resolveOneOffPromptRoute({
                model: thread.model,
                sessionProviderName: thread.session?.providerName ?? null,
              });
              const result = yield* providerService.runOneOffPrompt({
                threadId,
                provider: route.provider,
                model: route.model,
                prompt: `${getCompactPrompt()}\n\n## Conversation Context\n${transcript.transcript}`,
                ...(instructionContext.cwd ? { cwd: instructionContext.cwd } : {}),
                runtimeMode: desiredRuntimeMode,
              });
              const summary = formatCompactSummary(result.text);
              if (!summary)
                yield* Effect.logWarning("Native compaction recovery returned an empty summary", {
                  threadId,
                });
              if (summary && thread.compaction) {
                recoveredPriorWorkSummary = summary;
                yield* orchestrationEngine.dispatch({
                  type: "thread.compacted.record",
                  commandId: serverCommandId("native-compaction-recovery"),
                  threadId,
                  compaction: {
                    ...thread.compaction,
                    kind: "summary",
                    summary,
                    createdAt: new Date().toISOString(),
                  },
                  createdAt: new Date().toISOString(),
                });
              }
              return summary || undefined;
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Native compaction recovery summary failed", {
                  threadId,
                  cause,
                }).pipe(Effect.as(undefined)),
              ),
            );
          // Claude reported lost transcript writes: the resumed conversation can miss
          // recent messages, so it also carries F5's summary of the thread.
          const transcriptIncomplete =
            input?.carriesHandoff !== true &&
            instructionContext.priorWorkSummary === undefined &&
            (input?.resumeCursor as { transcriptIncomplete?: unknown } | undefined)
              ?.transcriptIncomplete === true;
          let recoverySummary =
            (needsNativeRecovery && input?.resumeCursor === undefined) || transcriptIncomplete
              ? yield* recoverSummary()
              : undefined;
          // One-shot: once the summary is delivered, the cursor drops the flag so later
          // starts resume normally instead of paying for another whole-thread summary.
          const resumeCursor =
            transcriptIncomplete && recoverySummary
              ? withoutTranscriptIncomplete(input?.resumeCursor)
              : input?.resumeCursor;
          const startInput = {
            threadId,
            projectId: thread.projectId,
            ...(providerForStart ? { provider: providerForStart } : {}),
            ...(preferredInstanceId ? { providerInstanceId: preferredInstanceId } : {}),
            ...startInstructionContext,
            ...(recoverySummary ? { priorWorkSummary: recoverySummary } : {}),
            ...(desiredModel ? { model: desiredModel } : {}),
            ...(options?.modelSelection !== undefined
              ? { modelSelection: options.modelSelection }
              : thread.modelSelection !== undefined
                ? { modelSelection: thread.modelSelection }
                : {}),
            ...(effectiveStartConfig.modelOptionsSource === "command"
              ? { modelOptions: effectiveStartConfig.modelOptions ?? {} }
              : effectiveStartConfig.modelOptions !== undefined
                ? { modelOptions: effectiveStartConfig.modelOptions }
                : {}),
            ...(effectiveStartConfig.providerOptionsSource === "command"
              ? { providerOptions: effectiveStartConfig.providerOptions ?? {} }
              : effectiveStartConfig.providerOptions !== undefined
                ? { providerOptions: effectiveStartConfig.providerOptions }
                : {}),
            ...(resumeCursor !== undefined ? { resumeCursor } : {}),
            ...(options?.unattended ? { unattended: true } : {}),
            runtimeMode: desiredRuntimeMode,
          };
          yield* requireDeliverableThread(threadId);
          const started = yield* providerService.startSession(threadId, startInput);
          const expectedIdentity = nativeSessionIdentity(started.provider, input?.resumeCursor);
          if (
            needsNativeRecovery &&
            !recoverySummary &&
            expectedIdentity !== undefined &&
            nativeSessionIdentity(started.provider, started.resumeCursor) !== expectedIdentity &&
            !(
              started.provider === "opencode" &&
              isOpenCodeHistoryContinuation(input?.resumeCursor, started.resumeCursor)
            )
          ) {
            // A valid-looking cursor can still be missing from the isolated provider store.
            // Summarize only after the adapter actually falls back, then install it before dispatch.
            recoverySummary = yield* recoverSummary();
            if (recoverySummary) {
              yield* providerService.stopSession({ threadId });
              yield* requireDeliverableThread(threadId);
              return yield* providerService.startSession(threadId, {
                ...startInput,
                resumeCursor: {
                  ...(started.resumeCursor as Record<string, unknown>),
                  f5ResumedContextPending: true,
                },
                priorWorkSummary: recoverySummary,
              });
            }
          }
          return started;
        }).pipe(Effect.withSpan("provider.start-session"));
      };

      const bindSessionToThread = (session: ProviderSession) =>
        bindSessionToThreadWithContext({
          thread,
          session,
          createdAt,
          desiredRuntimeMode,
          ...(desiredModel ? { desiredModel } : {}),
          instructionContext: {
            ...instructionContext,
            ...(recoveredPriorWorkSummary ? { priorWorkSummary: recoveredPriorWorkSummary } : {}),
          },
        });

      const activeSession = yield* resolveActiveSession(threadId);
      const computerPolicy = yield* resolveAgentBrowserPolicy(threadId);
      const supportsComputer = preferredProvider === "claudeAgent" || preferredProvider === "codex";
      const computerSelection = (yield* resolveProviderComputerBackendSelection(preferredProvider, {
        // Adapters expose computer tools only in desktop sessions. Use the same gate
        // here so enabled-by-default settings do not restart a web session mid-turn.
        enabled: workspaceConfig.mode === "desktop" && computerPolicy.computerUse,
        fullAccess: thread.runtimeMode === "full-access",
        nativeStatus: Option.isSome(computerBroker)
          ? computerBroker.value.host.status()
          : { available: false, reason: "no-host" },
      }))?.fingerprint;
      const previousComputerSelection =
        activeSession?.computerConfigurationFingerprint ?? computerSelections.get(threadId);
      const shouldRestartForComputerUseChange =
        supportsComputer &&
        previousComputerSelection !== undefined &&
        previousComputerSelection !== computerSelection;
      if (computerSelection !== undefined) computerSelections.set(threadId, computerSelection);
      else computerSelections.delete(threadId);
      // A Chrome change waits for a person's turn: an automation's turn never restarts a
      // session for it (and a session it starts has no Chrome, until a person's turn).
      const shouldRestartForChromeLaunchChange =
        !options?.unattended &&
        activeSession?.chromeConfigurationFingerprint !== undefined &&
        ((activeSession.provider === "claudeAgent" &&
          activeSession.chromeConfigurationFingerprint !==
            chromeSessionFingerprint(threadId, computerPolicy.claudeInChrome)) ||
          (activeSession.provider === "codex" &&
            activeSession.chromeConfigurationFingerprint !==
              codexChromeFingerprint(computerPolicy.codexChrome)));
      /**
       * Switches the thread to another provider instance with a context handoff.
       * The outgoing session is parked so switching back can resume it; the
       * pending marker is written before anything starts, so a crash or failed
       * start can only leave a fresh, full handoff behind, never a lost one.
       */
      const runProviderSwitch = Effect.fnUntraced(function* (input: {
        readonly repository: ProviderHandoffStateRepositoryShape;
        readonly messageId: string;
        readonly userText: string;
        readonly outgoingProvider: ProviderKind;
        readonly outgoingInstanceId: ProviderInstanceId;
        readonly targetProvider: ProviderKind;
        readonly targetInstanceId: ProviderInstanceId;
      }) {
        const { repository } = input;
        const outgoingCursor =
          activeSession?.resumeCursor ?? persistedBinding?.resumeCursor ?? undefined;
        const outgoingIdentity = nativeSessionIdentity(input.outgoingProvider, outgoingCursor);
        const outgoingModel =
          activeSession?.model ?? startConfigValueOrUndefined(persistedStartConfig.model) ?? null;
        const outgoingCwd =
          activeSession?.cwd ?? readPersistedCwd(persistedBinding?.runtimePayload) ?? null;
        const outgoingContextTokens =
          thread.session?.providerInstanceId === input.outgoingInstanceId
            ? (thread.session.estimatedContextTokens ?? null)
            : null;
        const lastHandoffable = handoffableMessages(thread.messages, input.messageId).at(-1);
        const threadMessageIds = new Set<string>(thread.messages.map((message) => message.id));
        const targetWindowTokens = resolveModelContextWindowTokens({
          provider: input.targetProvider,
          model: desiredModel,
        });

        let parkedForStart: ParkedNativeSession | undefined;
        let discardedByPrewrite: Array<{
          readonly provider: ProviderKind;
          readonly providerInstanceId: ProviderInstanceId;
          readonly resumeCursor: unknown;
        }> = [];
        const pendingId = crypto.randomUUID();
        const prewrite = Effect.gen(function* () {
          const state = yield* repository.get(threadId);
          const parked: Record<string, ParkedNativeSession> = { ...state?.parked };
          const previous = state?.pending ?? null;
          const outgoingSession = {
            provider: input.outgoingProvider,
            providerInstanceId: input.outgoingInstanceId,
            resumeCursor: outgoingCursor,
          };
          const previouslyParked = parked[input.outgoingInstanceId];
          discardedByPrewrite = [];
          if (previous?.mode === "full" && previous.targetInstanceId === input.outgoingInstanceId) {
            // The outgoing session never received the history it was switched in for.
            delete parked[input.outgoingInstanceId];
            discardedByPrewrite = [
              outgoingSession,
              ...(previouslyParked ? [previouslyParked] : []),
            ];
          } else {
            const lastSeen =
              previous?.mode === "delta" && previous.targetInstanceId === input.outgoingInstanceId
                ? previous.sinceMessageId
                : (lastHandoffable?.id ?? null);
            const parkable =
              outgoingCursor !== undefined &&
              outgoingCursor !== null &&
              outgoingIdentity !== undefined &&
              lastSeen !== null;
            // Parking replaces an older session of the same instance, or leaves the
            // outgoing one unreachable when it cannot be parked.
            if (previouslyParked && previouslyParked.nativeIdentity !== outgoingIdentity)
              discardedByPrewrite.push(previouslyParked);
            if (!parkable) discardedByPrewrite.push(outgoingSession);
            if (parkable)
              parked[input.outgoingInstanceId] = {
                provider: input.outgoingProvider,
                providerInstanceId: input.outgoingInstanceId,
                resumeCursor: outgoingCursor,
                nativeIdentity: outgoingIdentity,
                cwd: outgoingCwd,
                model: outgoingModel,
                lastSeenMessageId: lastSeen,
                estimatedContextTokens: outgoingContextTokens,
                parkedAt: createdAt,
              };
          }
          const candidate = parked[input.targetInstanceId];
          parkedForStart =
            candidate !== undefined &&
            candidate.provider === input.targetProvider &&
            canResumeParkedSession({
              parked: candidate,
              desiredCwd: instructionContext.cwd ?? null,
              threadMessageIds,
              deltaChars: handoffMessageChars(
                selectHandoffSource({
                  thread,
                  mode: "delta",
                  sinceMessageId: candidate.lastSeenMessageId,
                  excludeMessageId: input.messageId,
                }).messages,
              ),
              userTextChars: input.userText.length,
              targetWindowTokens,
            })
              ? candidate
              : undefined;
          const pending: PendingProviderHandoff = {
            id: pendingId,
            mode: "full",
            targetInstanceId: input.targetInstanceId,
            fromProvider: input.outgoingProvider,
            fromInstanceId: input.outgoingInstanceId,
            fromModel: outgoingModel,
            sinceMessageId: parkedForStart?.lastSeenMessageId ?? null,
            expectedNativeIdentity: null,
            createdAt,
          };
          return yield* repository.compareAndSet({
            threadId,
            expectedRevision: state?.revision ?? null,
            pending,
            parked,
          });
        });
        const written = (yield* prewrite) ?? (yield* prewrite);
        if (!written)
          return yield* providerSwitchRefused(
            "Another change to this thread raced the provider switch. Try again.",
          );
        yield* retireNativeSessions(threadId, discardedByPrewrite);

        const dropParked = (instanceId: ProviderInstanceId) =>
          Effect.gen(function* () {
            const state = yield* repository.get(threadId);
            const dropped = state?.parked[instanceId];
            if (!state || !dropped) return;
            const parked = { ...state.parked };
            delete parked[instanceId];
            if (
              yield* repository.compareAndSet({
                threadId,
                expectedRevision: state.revision,
                pending: state.pending,
                parked,
              })
            )
              yield* retireNativeSessions(threadId, [dropped]);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider switch could not drop an unresumable parked session", {
                threadId,
                instanceId,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        const startTarget = (resumeCursor?: unknown) =>
          startProviderSession({
            provider: input.targetProvider,
            carriesHandoff: true,
            ...(resumeCursor !== undefined ? { resumeCursor } : {}),
          });
        const resumeFrom = parkedForStart;
        let fellBack = false;
        const started = resumeFrom
          ? yield* startTarget(resumeFrom.resumeCursor).pipe(
              Effect.catch((error) => {
                // Only a confirmed-unrecoverable resume starts fresh; auth, permission
                // and transient failures keep the parked session for a later attempt.
                if (!isProviderResumeFailureText(errorText(error))) return Effect.fail(error);
                fellBack = true;
                return dropParked(input.targetInstanceId).pipe(Effect.andThen(startTarget()));
              }),
            )
          : yield* startTarget();
        yield* bindSessionToThread(started);
        yield* recordEffectiveStartConfig();

        const startedInstanceId = started.providerInstanceId ?? input.targetInstanceId;
        const resumed =
          resumeFrom !== undefined &&
          !fellBack &&
          isSameNativeSession(started.provider, resumeFrom.resumeCursor, started.resumeCursor);
        const finalize = Effect.gen(function* () {
          const state = yield* repository.get(threadId);
          if (!state?.pending || state.pending.id !== pendingId) return true;
          const parked = { ...state.parked };
          // The started session replaces this slot; unless it resumed it, the
          // parked session is unreachable from now on.
          const replaced = resumed ? undefined : parked[startedInstanceId];
          delete parked[startedInstanceId];
          const finalized = yield* repository.compareAndSet({
            threadId,
            expectedRevision: state.revision,
            pending: {
              ...state.pending,
              mode: resumed ? "delta" : "full",
              sinceMessageId: resumed && resumeFrom ? resumeFrom.lastSeenMessageId : null,
              expectedNativeIdentity:
                nativeSessionIdentity(started.provider, started.resumeCursor) ?? null,
            },
            parked,
          });
          if (finalized !== null && replaced) yield* retireNativeSessions(threadId, [replaced]);
          return finalized !== null;
        });
        // The pre-written full marker already delivers the history if this fails.
        yield* finalize.pipe(
          Effect.flatMap((done) => (done ? Effect.void : Effect.asVoid(finalize))),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider switch could not finalize its handoff marker", {
              threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        );
        yield* Effect.annotateCurrentSpan({
          "provider.session_decision": "switch-with-handoff",
          "provider.handoff_requested_mode": resumeFrom ? "delta" : "full",
          "provider.handoff_resumed": resumed,
        });
        yield* Effect.logInfo("provider command reactor switched provider with a context handoff", {
          threadId,
          fromProvider: input.outgoingProvider,
          fromInstanceId: input.outgoingInstanceId,
          toProvider: started.provider,
          toInstanceId: startedInstanceId,
          resumedParkedSession: resumed,
          resumeFellBack: fellBack,
        });
        return started;
      });

      const outgoingProvider =
        activeSession?.provider ?? persistedBinding?.provider ?? currentProvider;
      const outgoingInstanceId =
        activeSession?.providerInstanceId ??
        (persistedBinding ? resolveBindingInstanceId(persistedBinding) : undefined) ??
        currentInstanceId;
      const targetInstanceId =
        preferredInstanceId ??
        (preferredProvider ? defaultInstanceForProvider(preferredProvider) : undefined);
      // A start for the instance a pending handoff targets (such as the retry after a
      // resume fallback) carries that handoff, whichever path it takes.
      const startCarriesHandoff =
        targetInstanceId !== undefined && Option.isSome(handoffStates)
          ? yield* handoffStates.value.get(threadId).pipe(
              Effect.map((state) => state?.pending?.targetInstanceId === targetInstanceId),
              Effect.catch(() => Effect.succeed(false)),
            )
          : false;
      const handoffRequest = options?.handoff;
      if (
        handoffRequest !== undefined &&
        Option.isSome(handoffStates) &&
        outgoingProvider !== undefined &&
        outgoingInstanceId !== undefined &&
        preferredProvider !== undefined &&
        targetInstanceId !== undefined &&
        outgoingInstanceId !== targetInstanceId &&
        hasHandoffableConversation(thread.messages, handoffRequest.messageId)
      ) {
        yield* assertProviderSwitchAllowed({
          thread,
          targetInstanceId,
          userText: handoffRequest.userText,
        });
        const switched = yield* runProviderSwitch({
          repository: handoffStates.value,
          messageId: handoffRequest.messageId,
          userText: handoffRequest.userText,
          outgoingProvider,
          outgoingInstanceId,
          targetProvider: preferredProvider,
          targetInstanceId,
        });
        return switched.threadId;
      }

      const existingSessionThreadId =
        thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
      if (existingSessionThreadId) {
        const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
        const activeProvider =
          activeSession?.provider ?? persistedBinding?.provider ?? currentProvider;
        const activeInstanceId =
          activeSession?.providerInstanceId ??
          persistedBinding?.providerInstanceId ??
          currentInstanceId;
        const providerChanged =
          preferredProvider !== undefined &&
          activeProvider !== undefined &&
          preferredProvider !== activeProvider;
        const instanceChanged =
          !providerChanged &&
          preferredProvider === activeProvider &&
          preferredInstanceId !== undefined &&
          activeInstanceId !== undefined &&
          preferredInstanceId !== activeInstanceId;
        const sessionModelSwitch =
          activeProvider === undefined
            ? "in-session"
            : (yield* providerService.getCapabilities(activeProvider, activeInstanceId))
                .sessionModelSwitch;
        const requestedModel = commandModel;
        const modelChanged =
          requestedModel !== undefined && requestedModel !== activeSession?.model;
        const shouldRestartForModelChange =
          modelChanged &&
          (sessionModelSwitch === "restart-session" || currentProvider === "claudeAgent");
        const shouldRestartForModelOptionsChange =
          currentProvider === "claudeAgent" &&
          effectiveStartConfig.modelOptionsSource === "command" &&
          !areProviderModelOptionsEqual(
            baselineStartConfig.modelOptions,
            effectiveStartConfig.modelOptions,
          );
        const ignorePersistedMcpServers = baselineStartConfig.providerOptionsSource === "persisted";
        const previousProviderOptions =
          currentProvider !== undefined
            ? getProviderSessionRestartOptions(
                currentProvider,
                baselineStartConfig.providerOptions,
                { ignoreMcpServers: ignorePersistedMcpServers },
              )
            : undefined;
        const requestedProviderOptions =
          currentProvider !== undefined && effectiveStartConfig.providerOptionsSource === "command"
            ? getProviderSessionRestartOptions(
                currentProvider,
                effectiveStartConfig.providerOptions,
                { ignoreMcpServers: ignorePersistedMcpServers },
              )
            : undefined;
        const shouldRestartForProviderOptionsChange =
          currentProvider !== undefined &&
          effectiveStartConfig.providerOptionsSource === "command" &&
          !areProviderStartOptionsEqual(previousProviderOptions, requestedProviderOptions);
        const currentProjectMcpVersion =
          currentProjectMcpSnapshot?.effectiveVersion ??
          persistedBinding?.mcpEffectiveConfigVersion ??
          null;
        const shouldRestartForProjectMcpChange =
          currentProvider !== undefined &&
          (persistedBinding?.mcpEffectiveConfigVersion ?? null) !== currentProjectMcpVersion;
        const currentSessionCwd = activeSession?.cwd ?? null;
        const desiredSessionCwd = instructionContext.cwd ?? null;
        const shouldRestartForCwdChange =
          activeSession !== undefined &&
          currentSessionCwd !== null &&
          desiredSessionCwd !== null &&
          currentSessionCwd !== desiredSessionCwd;
        const shouldRestartForWorkflowExecutionProfileChange =
          activeWorkflowExecutionProfile !== desiredWorkflowExecutionProfile;

        if (
          !runtimeModeChanged &&
          !providerChanged &&
          !instanceChanged &&
          !shouldRestartForModelChange &&
          !shouldRestartForModelOptionsChange &&
          !shouldRestartForProviderOptionsChange &&
          !shouldRestartForProjectMcpChange &&
          !shouldRestartForComputerUseChange &&
          !shouldRestartForChromeLaunchChange &&
          !shouldRestartForCwdChange &&
          !shouldRestartForWorkflowExecutionProfileChange
        ) {
          if (activeSession) {
            yield* bindSessionToThread(activeSession);
          }
          yield* recordEffectiveStartConfig();
          yield* Effect.annotateCurrentSpan({
            "provider.session_decision": "reuse",
          });
          return existingSessionThreadId;
        }

        const resumeCursorDropReason = providerChanged
          ? "provider-changed"
          : instanceChanged
            ? "instance-changed"
            : shouldRestartForCwdChange && currentProvider !== "opencode"
              ? "cwd-changed"
              : undefined;
        const resumeCursor =
          resumeCursorDropReason !== undefined
            ? undefined
            : (activeSession?.resumeCursor ?? persistedBinding?.resumeCursor ?? undefined);
        const restartReasons = [
          ...(runtimeModeChanged ? ["runtime-mode-changed"] : []),
          ...(providerChanged ? ["provider-changed"] : []),
          ...(instanceChanged ? ["instance-changed"] : []),
          ...(shouldRestartForModelChange ? ["model-changed"] : []),
          ...(shouldRestartForModelOptionsChange ? ["model-options-changed"] : []),
          ...(shouldRestartForProviderOptionsChange ? ["provider-options-changed"] : []),
          ...(shouldRestartForProjectMcpChange ? ["project-mcp-changed"] : []),
          ...(shouldRestartForComputerUseChange ? ["computer-use-changed"] : []),
          ...(shouldRestartForChromeLaunchChange ? ["chrome-launch-changed"] : []),
          ...(shouldRestartForCwdChange ? ["cwd-changed"] : []),
          ...(shouldRestartForWorkflowExecutionProfileChange
            ? ["workflow-execution-profile-changed"]
            : []),
        ];
        yield* Effect.annotateCurrentSpan({
          "provider.session_decision": "restart",
          "provider.has_resume_cursor": resumeCursor !== undefined,
          ...(resumeCursorDropReason
            ? { "provider.resume_cursor_drop_reason": resumeCursorDropReason }
            : {}),
        });
        yield* Effect.logInfo("provider command reactor restarting provider session", {
          threadId,
          existingSessionThreadId,
          currentProvider,
          desiredProvider: preferredProvider,
          currentRuntimeMode: thread.session?.runtimeMode,
          desiredRuntimeMode: thread.runtimeMode,
          runtimeModeChanged,
          providerChanged,
          instanceChanged,
          modelChanged,
          shouldRestartForModelChange,
          shouldRestartForModelOptionsChange,
          shouldRestartForProviderOptionsChange,
          shouldRestartForProjectMcpChange,
          shouldRestartForComputerUseChange,
          shouldRestartForCwdChange,
          shouldRestartForWorkflowExecutionProfileChange,
          activeWorkflowExecutionProfile: activeWorkflowExecutionProfile ?? null,
          desiredWorkflowExecutionProfile: desiredWorkflowExecutionProfile ?? null,
          currentSessionCwd,
          desiredSessionCwd,
          persistedMcpEffectiveConfigVersion: persistedBinding?.mcpEffectiveConfigVersion ?? null,
          currentProjectMcpVersion,
          resumeCursorDropReason: resumeCursorDropReason ?? null,
          hasResumeCursor: resumeCursor !== undefined,
        });
        const restartedSession = yield* startProviderSession({
          ...(resumeCursor !== undefined ? { resumeCursor } : {}),
          ...(requestedProvider !== undefined ? { provider: requestedProvider } : {}),
          ...(startCarriesHandoff ? { carriesHandoff: true } : {}),
        });
        yield* Effect.logInfo("provider command reactor restarted provider session", {
          threadId,
          previousSessionId: existingSessionThreadId,
          restartedSessionThreadId: restartedSession.threadId,
          provider: restartedSession.provider,
          runtimeMode: restartedSession.runtimeMode,
        });
        yield* bindSessionToThread(restartedSession);
        yield* recordEffectiveStartConfig();
        const contextResetReason =
          resumeCursorDropReason ??
          (resumeCursor === undefined ? "missing-resume-cursor" : undefined);
        if (
          contextResetReason !== undefined &&
          !startCarriesHandoff &&
          hasPriorConversationContext(thread)
        ) {
          yield* appendProviderContextResetActivity({
            threadId,
            provider: restartedSession.provider,
            reason: contextResetReason,
            restartReasons,
            createdAt,
          });
        }
        return restartedSession.threadId;
      }

      const persistedBindingInstanceId = persistedBinding
        ? (persistedBinding.providerInstanceId ??
          defaultInstanceForProvider(persistedBinding.provider))
        : undefined;
      const persistedProviderMatches =
        persistedBinding !== undefined &&
        (preferredProvider === undefined || persistedBinding.provider === preferredProvider);
      const persistedInstanceMatches =
        persistedBinding !== undefined &&
        (preferredInstanceId === undefined || persistedBindingInstanceId === preferredInstanceId);
      const persistedCwd = readPersistedCwd(persistedBinding?.runtimePayload);
      const persistedCwdMatches =
        persistedBinding !== undefined && persistedCwd === instructionContext.cwd;
      const resumeCursorForStoppedSession =
        persistedProviderMatches &&
        persistedInstanceMatches &&
        (persistedCwdMatches || persistedBinding?.provider === "opencode") &&
        persistedBinding?.resumeCursor !== undefined &&
        persistedBinding.resumeCursor !== null
          ? persistedBinding.resumeCursor
          : undefined;
      yield* Effect.annotateCurrentSpan({
        "provider.session_decision":
          resumeCursorForStoppedSession !== undefined ? "resume-stopped" : "start",
        "provider.has_resume_cursor": resumeCursorForStoppedSession !== undefined,
      });
      const startedSession = yield* startProviderSession({
        ...(options?.provider !== undefined
          ? { provider: options.provider }
          : resumeCursorForStoppedSession !== undefined && persistedBinding?.provider
            ? { provider: persistedBinding.provider }
            : {}),
        ...(resumeCursorForStoppedSession !== undefined
          ? { resumeCursor: resumeCursorForStoppedSession }
          : {}),
        ...(startCarriesHandoff ? { carriesHandoff: true } : {}),
      });
      yield* bindSessionToThread(startedSession);
      yield* recordEffectiveStartConfig();
      if (
        resumeCursorForStoppedSession === undefined &&
        !startCarriesHandoff &&
        persistedBinding !== undefined &&
        hasPriorConversationContext(thread)
      ) {
        yield* appendProviderContextResetActivity({
          threadId,
          provider: startedSession.provider,
          reason: !persistedProviderMatches
            ? "provider-changed"
            : !persistedInstanceMatches
              ? "instance-changed"
              : !persistedCwdMatches
                ? "cwd-changed"
                : "missing-resume-cursor",
          restartReasons: ["recover-session"],
          createdAt,
        });
      }
      return startedSession.threadId;
    }).pipe(Effect.withSpan("provider.ensure-session"));
  });

  interface SendTurnForThreadInput {
    readonly threadId: ThreadId;
    /** The user message being delivered; required for a context handoff. */
    readonly messageId?: string;
    readonly deliveryId?: CommandId;
    readonly continuationRequestId?: string;
    readonly messageText: string;
    /** The text the provider receives: the stored text plus any referenced-thread block. */
    readonly providerInput: string;
    readonly submissionSource?: "human" | "automation";
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly provider?: ProviderKind;
    readonly model?: string;
    readonly modelSelection?: ModelSelection;
    readonly modelOptions?: ProviderModelOptions;
    readonly providerOptions?: ProviderStartOptions;
    readonly interactionMode?: "default" | "plan";
    readonly workflowExecutionProfile?: WorkflowTurnExecutionProfile;
    readonly createdAt: string;
  }

  const sendTurnForThread = Effect.fnUntraced(function* (input: SendTurnForThreadInput) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    if (input.continuationRequestId) {
      yield* resolveThreadWorkspaceContext(input.threadId, "continuation");
      yield* requireDeliverableThread(input.threadId);
      const live = (yield* providerService.listSessions()).find(
        (session) => session.threadId === input.threadId && session.status !== "closed",
      );
      if (
        !live ||
        live.runtimeMode !== thread.runtimeMode ||
        (live.model !== undefined &&
          live.model !== (thread.modelSelection?.model ?? thread.model)) ||
        (thread.modelSelection && thread.modelSelection.instanceId !== live.providerInstanceId)
      )
        return yield* new ProviderTurnDeliveryError({
          certainty: "not_sent",
          retryable: false,
          detail: "The native continuation's session or settings changed; it was not restarted.",
        });
      return yield* providerService.sendTurn({
        threadId: input.threadId,
        continuationRequestId: input.continuationRequestId,
        input: input.providerInput,
        ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
        submissionSource: "automation",
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
        ...(input.workflowExecutionProfile
          ? { workflowExecutionProfile: input.workflowExecutionProfile }
          : {}),
      });
    }
    // Nothing reaches the provider before sendTurn, so an earlier failure,
    // such as a session that cannot resume, is certainly not sent.
    const { request, handoff, consumedWithReceipt } = yield* prepareTurnForThread(
      input,
      thread,
    ).pipe(Effect.mapError(toPreSendDeliveryError));
    const result = yield* providerService
      .sendTurn(request)
      .pipe(
        Effect.catch((error) =>
          handoff?.effectiveMode === "delta" && isNotSentResumeFailure(error)
            ? fallBackToFullHandoff({ threadId: input.threadId, handoff, error })
            : Effect.fail(error),
        ),
      );
    if (handoff?.disposition === "consumed")
      yield* recordHandoffDelivered({
        threadId: input.threadId,
        deliveryId: input.deliveryId,
        handoff,
        consumedWithReceipt,
        createdAt: new Date().toISOString(),
      });
    return result;
  });

  /**
   * Prepares the pending context handoff for this turn, or reuses the payload an
   * earlier attempt of the same delivery stored so a retry sends identical bytes.
   * Returns undefined when nothing is pending for the active session.
   */
  const prepareHandoffForTurn = Effect.fnUntraced(function* (input: {
    readonly thread: OrchestrationThread;
    readonly messageId: string;
    readonly deliveryId: CommandId | undefined;
    readonly userText: string;
    readonly mcpAppContext: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
    readonly activeSession: ProviderSession;
  }) {
    if (Option.isNone(handoffStates)) return undefined;
    const repository = handoffStates.value;
    const { thread, activeSession } = input;
    const threadId = thread.id;
    const state = yield* repository.get(threadId);
    const pending = state?.pending;
    if (!state || !pending) return undefined;
    const activeInstanceId =
      activeSession.providerInstanceId ?? defaultInstanceForProvider(activeSession.provider);
    if (pending.targetInstanceId !== activeInstanceId) {
      yield* Effect.logWarning("provider command reactor cleared a stale context handoff marker", {
        threadId,
        targetInstanceId: pending.targetInstanceId,
        activeInstanceId,
      });
      yield* repository.compareAndSet({
        threadId,
        expectedRevision: state.revision,
        pending: null,
        parked: state.parked,
      });
      return undefined;
    }

    const attempt = yield* DeliveryAttemptContext;
    const durable =
      attempt !== null && input.deliveryId !== undefined && Option.isSome(deliveryRepository)
        ? { repository: deliveryRepository.value, deliveryId: input.deliveryId, attempt }
        : undefined;
    const compose = (handoff: DeliveryHandoff) =>
      handoff.disposition === "consumed" && handoff.block !== null
        ? composeHandoffInput({
            block: handoff.block,
            userText: input.userText,
            targetProvider: activeSession.provider,
          })
        : input.userText;
    // A delta survives only if the session is still the one it was prepared for;
    // any restart, recovery or refresh that lost the cursor promotes it to full.
    const currentIdentity =
      nativeSessionIdentity(activeSession.provider, activeSession.resumeCursor) ?? null;
    const deltaStillValid =
      pending.mode === "delta" &&
      currentIdentity !== null &&
      currentIdentity === pending.expectedNativeIdentity;
    let replaceStored = false;
    if (durable) {
      const stored = (yield* durable.repository.getByCommandId(durable.deliveryId))?.handoff;
      if (stored) {
        // A retry resends identical bytes only while they are still right: the same
        // marker, and a delta only for the session it was prepared for. Otherwise the
        // earlier attempt was not sent, so its payload is rebuilt for the session now.
        // Retention keeps only the manifest of older bodies; a trimmed one is rebuilt.
        const bodyTrimmed =
          stored.disposition === "consumed" &&
          stored.block === null &&
          (stored.includedCount > 0 || stored.summaryIncluded);
        if (
          stored.id === pending.id &&
          !bodyTrimmed &&
          (stored.effectiveMode === "full" || deltaStillValid)
        )
          return { handoff: stored, input: compose(stored), durable };
        replaceStored = true;
      }
    }
    const requestedMode = deltaStillValid ? "delta" : "full";
    if (
      requestedMode === "full" &&
      (pending.mode !== "full" || pending.expectedNativeIdentity === null)
    )
      yield* repository
        .compareAndSet({
          threadId,
          expectedRevision: state.revision,
          pending: {
            ...pending,
            mode: "full",
            sinceMessageId: null,
            expectedNativeIdentity: currentIdentity,
          },
          parked: state.parked,
        })
        .pipe(Effect.asVoid);

    const classification = providerService.classifyTurnInput
      ? yield* providerService.classifyTurnInput({
          threadId,
          instanceId: activeInstanceId,
          text: input.userText,
          cwd:
            resolveThreadWorkspaceCwd({
              thread,
              projects: (yield* orchestrationEngine.getReadModel()).projects,
            }) ?? undefined,
        })
      : "prompt";
    const base = {
      id: pending.id,
      rendererVersion: HANDOFF_RENDERER_VERSION,
      fromProvider: pending.fromProvider,
      fromInstanceId: pending.fromInstanceId,
      fromModel: pending.fromModel,
      toProvider: activeSession.provider,
      toInstanceId: activeInstanceId,
      toModel: activeSession.model ?? null,
      requestedMode: pending.mode,
    } as const;
    let handoff: DeliveryHandoff;
    if (classification === "native-command") {
      // Native commands run verbatim; the history waits for the next ordinary prompt.
      handoff = {
        ...base,
        disposition: "deferred",
        effectiveMode: requestedMode,
        messageIds: [],
        includedCount: 0,
        omittedCount: 0,
        summaryIncluded: false,
        block: null,
      };
    } else {
      const evictedFirstUserMessage =
        requestedMode === "full" &&
        thread.messages.length >= MAX_THREAD_MESSAGES &&
        Option.isSome(sqlOption)
          ? yield* readFirstUserMessage(threadId)
          : null;
      const source = selectHandoffSource({
        thread,
        mode: requestedMode,
        sinceMessageId: pending.sinceMessageId,
        excludeMessageId: input.messageId,
        evictedFirstUserMessage,
      });
      const images = input.attachments.filter((attachment) => attachment.type === "image").length;
      const rendered = renderProviderHandoff({
        source,
        userText: input.userText,
        allowanceChars: computeHandoffAllowanceChars({
          windowTokens: resolveModelContextWindowTokens({
            provider: activeSession.provider,
            model: activeSession.model,
          }),
          requestChars:
            input.userText.length + input.mcpAppContext.length + HANDOFF_RUNTIME_CONTEXT_CHARS,
          imageCount: images,
          otherAttachmentCount: input.attachments.length - images,
        }),
        participants: { fromLabel: handoffEndpointLabel(pending.fromProvider, pending.fromModel) },
        targetProvider: activeSession.provider,
      });
      const nothingToHandOff = source.messages.length === 0 && source.summary === null;
      // Sending the request alone would silently drop the conversation, and a later
      // turn would hand the target its own replies as another agent's.
      if (!rendered.delivered && !nothingToHandOff)
        return yield* new ProviderTurnDeliveryError({
          certainty: "not_sent",
          retryable: false,
          detail: `The conversation could not be handed off to ${handoffEndpointLabel(activeSession.provider, activeSession.model ?? null)} with this message: the message and its attachments leave no room for it. Shorten the message or remove attachments and send it again.`,
        });
      handoff = {
        ...base,
        // With nothing to hand off, the marker is settled by this turn all the same.
        disposition: "consumed",
        effectiveMode: source.effectiveMode,
        messageIds: rendered.messageIds,
        includedCount: rendered.includedCount,
        omittedCount: rendered.omittedCount,
        summaryIncluded: rendered.summaryIncluded,
        block: rendered.block,
      };
    }
    if (durable) {
      const stored = yield* durable.repository.recordHandoff({
        deliveryId: durable.deliveryId,
        attemptId: durable.attempt.attemptId,
        handoff,
        ...(replaceStored ? { replace: true } : {}),
      });
      if (!stored)
        return yield* new ProviderTurnDeliveryError({
          certainty: "not_sent",
          retryable: false,
          detail: "This delivery attempt no longer owns dispatch.",
        });
      handoff = stored;
    }
    yield* Effect.annotateCurrentSpan({
      "provider.handoff_requested_mode": handoff.requestedMode,
      "provider.handoff_effective_mode": handoff.effectiveMode,
      "provider.handoff_disposition": handoff.disposition,
    });
    return { handoff, input: compose(handoff), durable };
  });

  /** The thread's first user message, for a read model that evicted it. */
  const readFirstUserMessage = (threadId: ThreadId) =>
    Option.isNone(sqlOption)
      ? Effect.succeed(null)
      : sqlOption.value<{
          id: string;
          role: string;
          text: string;
          streaming: number;
          createdAt: string;
        }>`SELECT message_id AS "id", role, text, is_streaming AS "streaming", created_at AS "createdAt"
          FROM projection_thread_messages WHERE thread_id = ${threadId} AND role = 'user'
          ORDER BY created_at, message_id LIMIT 1`.pipe(
          Effect.map((rows) => {
            const row = rows[0];
            return row
              ? {
                  id: MessageId.makeUnsafe(row.id),
                  role: "user" as const,
                  text: row.text,
                  streaming: Boolean(row.streaming),
                  createdAt: row.createdAt,
                }
              : null;
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider handoff could not read the first user message", {
              threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(null)),
          ),
        );

  const prepareTurnForThread = Effect.fnUntraced(function* (
    input: SendTurnForThreadInput,
    thread: OrchestrationThread,
  ) {
    const resolvedContext = yield* resolveThreadInstructionContext(
      thread.id,
      input.workflowExecutionProfile,
    );
    const { effectiveCwd: workspace, instructionContext } = resolvedContext;
    if (thread.worktreePath && thread.branch) {
      const model = yield* orchestrationEngine.getReadModel();
      const project = model.projects.find((entry) => entry.id === thread.projectId);
      if (project) {
        yield* git.ensureWorktree({
          owner: `thread:${thread.id}`,
          submodules: (yield* settingsForThread(thread)).worktreeSubmodules,
          cwd: project.workspaceRoot,
          path: thread.worktreePath,
          branch: thread.branch,
        });
        if (Option.isSome(preparation))
          yield* preparation.value.prepare({
            threadId: thread.id,
            projectId: project.id,
            worktreePath: thread.worktreePath,
            branch: thread.branch,
          });
      }
    }
    if (workspace) yield* ensureWorkspaceDirectory(workspace);
    yield* requireDeliverableThread(input.threadId);
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      resolvedContext,
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.modelOptions !== undefined ? { modelOptions: input.modelOptions } : {}),
      ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
      ...(input.workflowExecutionProfile !== undefined
        ? { workflowExecutionProfile: input.workflowExecutionProfile }
        : {}),
      ...(input.submissionSource === "automation" ? { unattended: true } : {}),
      ...(input.messageId !== undefined
        ? { handoff: { messageId: input.messageId, userText: input.messageText.trim() } }
        : {}),
    });
    const normalizedInput = toNonEmptyProviderInput(input.providerInput);
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const persistedBinding = yield* providerSessionDirectory
      .getBinding(input.threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : (yield* providerService.getCapabilities(
            activeSession.provider,
            activeSession.providerInstanceId,
          )).sessionModelSwitch;
    const modelForTurn =
      sessionModelSwitch === "unsupported"
        ? activeSession?.model
        : (input.model ?? input.modelSelection?.model);
    const recoveryProvider =
      activeSession?.provider ??
      providerFromSessionName(thread.session?.providerName) ??
      input.provider ??
      inferProviderForModel(thread.model, "codex");

    const mcpAppContext = yield* appContextForTurn(
      input.threadId,
      input.submissionSource !== "automation" ? recoveryProvider : undefined,
    );
    yield* providerSessionDirectory.upsert({
      threadId: input.threadId,
      provider: recoveryProvider,
      providerInstanceId:
        activeSession?.providerInstanceId ??
        input.modelSelection?.instanceId ??
        (persistedBinding?.provider === recoveryProvider
          ? persistedBinding.providerInstanceId
          : undefined) ??
        defaultInstanceForProvider(recoveryProvider),
      runtimeMode: thread.runtimeMode,
      runtimePayload: {
        instructionContext,
      },
    });

    yield* requireDeliverableThread(input.threadId);
    if (Option.isSome(sqlOption))
      yield* assertScheduledDeliveryAllowed(input.deliveryId, {
        instanceId:
          activeSession?.providerInstanceId ??
          input.modelSelection?.instanceId ??
          persistedBinding?.providerInstanceId ??
          defaultInstanceForProvider(recoveryProvider),
        model: modelForTurn ?? activeSession?.model ?? input.modelSelection?.model ?? thread.model,
        modelSelection: input.modelSelection,
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sqlOption.value),
        Effect.provideService(ServerSettingsService, serverSettings),
      );
    // Re-read under the turn gate: the session start may have rewound or
    // reconciled the thread, and the handoff must describe what it is now.
    // An attachment-only turn carries a pending handoff too: otherwise the target
    // gets no history, and a later turn hands it its own reply as another agent's.
    const handoffEligible =
      input.messageId !== undefined &&
      activeSession !== undefined &&
      (normalizedInput !== undefined || normalizedAttachments.length > 0);
    const handoffThread = handoffEligible ? yield* resolveThread(input.threadId) : undefined;
    const prepared =
      handoffThread && input.messageId !== undefined && activeSession
        ? yield* prepareHandoffForTurn({
            thread: handoffThread,
            messageId: input.messageId,
            deliveryId: input.deliveryId,
            userText: normalizedInput ?? "",
            mcpAppContext,
            attachments: normalizedAttachments,
            activeSession,
          })
        : undefined;
    const providerInput = prepared?.input ?? normalizedInput;
    const request = {
      ...(input.continuationRequestId
        ? { continuationRequestId: input.continuationRequestId }
        : {}),
      threadId: input.threadId,
      ...(mcpAppContext ? { mcpAppContext } : {}),
      ...(input.submissionSource ? { submissionSource: input.submissionSource } : {}),
      ...(input.deliveryId !== undefined ? { deliveryId: input.deliveryId } : {}),
      ...(providerInput ? { input: providerInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { model: modelForTurn } : {}),
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.modelOptions !== undefined ? { modelOptions: input.modelOptions } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      ...(input.workflowExecutionProfile !== undefined
        ? { workflowExecutionProfile: input.workflowExecutionProfile }
        : {}),
    };
    return {
      request,
      handoff: prepared?.handoff,
      consumedWithReceipt: prepared?.durable !== undefined,
    };
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageId: string;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }

    if (thread.activities.some((activity) => activity.id === `worktree-setup:${input.threadId}`))
      return;
    const userMessages = thread.messages.filter((message) => message.role === "user");
    if (userMessages.length !== 1 || userMessages[0]?.id !== input.messageId) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    const settings = yield* settingsForThread(thread);
    const writingPreferences = settings.sourceControlWriting;
    yield* textGeneration
      .generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection: settings.textGenerationModelSelection,
        writingPreferences,
      })
      .pipe(
        Effect.timeout("3 seconds"),
        Effect.catch((error) =>
          Effect.logWarning(
            "provider command reactor failed to generate worktree branch name; skipping rename",
            { threadId: input.threadId, cwd, oldBranch, reason: error.message },
          ),
        ),
        Effect.flatMap((generated) => {
          if (!generated) return Effect.void;

          const targetBranch = buildGeneratedWorktreeBranchName(
            generated.branch,
            writingPreferences.branchNamePrefix,
          );
          if (targetBranch === oldBranch) return Effect.void;

          return Effect.gen(function* () {
            const common = yield* git.resolveCommonDir(cwd);
            return yield* withWorktreeLifecycleLock(
              cwd,
              withRepositoryLifecycleLock(
                workspaceConfig.baseDir,
                common,
                Effect.gen(function* () {
                  const current = yield* resolveThread(input.threadId);
                  if (current?.worktreePath !== cwd || current.branch !== oldBranch) return;
                  if (
                    Option.isSome(sqlOption) &&
                    (yield* sqlOption.value`SELECT 1 FROM workspace_transitions WHERE thread_id = ${input.threadId} AND phase IN ('reserved','stopping','applying','applied','needs_recovery') LIMIT 1`)
                      .length
                  )
                    return;
                  const renamed = yield* git.renameBranch({
                    cwd,
                    oldBranch,
                    newBranch: targetBranch,
                  });
                  yield* dispatchVerifiedWorkspace(
                    orchestrationEngine,
                    git,
                    {
                      type: "thread.meta.update",
                      commandId: serverCommandId("worktree-branch-rename"),
                      threadId: input.threadId,
                      branch: renamed.branch,
                      worktreePath: cwd,
                    },
                    { observation: true },
                  );
                }),
              ),
            );
          });
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "provider command reactor failed to generate or rename worktree branch",
            { threadId: input.threadId, cwd, oldBranch, cause: Cause.pretty(cause) },
          ),
        ),
      );
  });

  const maybeRequestThreadTitleForFirstTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: string;
    readonly titleSourceText: string;
    readonly titleGenerationModel?: string;
    readonly titleGenerationModelSelection?: ModelSelection;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const currentThread = readModel.threads.find(
      (entry) => entry.id === input.threadId && entry.deletedAt === null,
    );
    if (!currentThread || !hasEligibleFirstUserMessage(currentThread, input.messageId)) {
      return;
    }

    const createdAt = new Date().toISOString();
    yield* orchestrationEngine.dispatch({
      type: "thread.title.generation.start",
      commandId: serverCommandId("thread-title-generate"),
      threadId: input.threadId,
      expectedTitleRevision: currentThread.titleRevision ?? 0,
      titleSourceText: input.titleSourceText,
      ...(input.titleGenerationModel !== undefined
        ? { titleGenerationModel: input.titleGenerationModel }
        : {}),
      ...(input.titleGenerationModelSelection !== undefined
        ? { titleGenerationModelSelection: input.titleGenerationModelSelection }
        : {}),
      createdAt,
    });
  });

  const dispatchTitleRegenerationFailure = (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly expectedTitleRevision: number;
    readonly reason: string;
  }) => {
    const createdAt = new Date().toISOString();
    return orchestrationEngine.dispatch({
      type: "thread.title.regeneration.fail",
      commandId: serverCommandId("thread-title-regeneration-fail"),
      threadId: input.threadId,
      requestId: input.requestId,
      expectedTitleRevision: input.expectedTitleRevision,
      reason: input.reason.slice(0, 2_000),
      createdAt,
    });
  };

  const processTitleRegenerationStarted = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.title-regeneration-started" }>,
  ) {
    const requestId = event.payload.titleRegeneration.requestId;
    const thread = yield* resolveThread(event.payload.threadId);
    if (
      !thread ||
      thread.titleRegeneration?.requestId !== requestId ||
      (thread.titleRevision ?? 0) !== event.payload.expectedTitleRevision
    ) {
      return;
    }

    const readModel = yield* orchestrationEngine.getReadModel();
    const cwd = resolveThreadWorkspaceCwd({ thread, projects: readModel.projects });
    const explicitContext = formatThreadTitleRegenerationContext(thread.messages);
    const firstUserMessage = thread.messages.find((message) => message.role === "user");
    const titleSourceText = threadReferencesToLabels(
      event.payload.origin !== "first-turn"
        ? explicitContext.text
        : (event.payload.titleSourceText ?? userMessageTitleText(firstUserMessage?.text ?? "")),
    ).trim();
    const attachments =
      event.payload.origin !== "first-turn"
        ? explicitContext.attachments
        : (firstUserMessage?.attachments ?? []);
    if (titleSourceText.length === 0) {
      yield* dispatchTitleRegenerationFailure({
        threadId: thread.id,
        requestId,
        expectedTitleRevision: event.payload.expectedTitleRevision,
        reason: "There are no user messages available to generate a title.",
      });
      return;
    }

    const settings = yield* settingsForThread(thread);
    const requestedSelection =
      event.payload.titleGenerationModelSelection ??
      (event.payload.titleGenerationModel !== undefined
        ? {
            ...settings.textGenerationModelSelection,
            model: event.payload.titleGenerationModel,
          }
        : settings.textGenerationModelSelection);
    const linkedContext = Option.isSome(sqlOption)
      ? yield* readThreadPullRequestLinks(thread.id, 5).pipe(
          Effect.provideService(SqlClient.SqlClient, sqlOption.value),
          Effect.map(threadTitlePullRequestContext),
          Effect.timeoutOption("250 millis"),
          Effect.map(Option.getOrUndefined),
          Effect.catch(() =>
            Effect.logWarning("Thread title linked PR context is unavailable", {
              threadId: thread.id,
            }).pipe(Effect.as(undefined)),
          ),
        )
      : undefined;
    const generated = yield* resolveBestEffortGeneratedTitleResult({
      cwd,
      titleSourceText,
      attachments,
      ...(linkedContext !== undefined ? { linkedContext } : {}),
      instructions: settings.threadTitleInstructions,
      titleGenerationModel: requestedSelection.model,
      titleGenerationModelSelection: requestedSelection,
      ...(event.payload.origin === "explicit" ? { previousTitle: thread.title } : {}),
      defaultTitle: event.payload.origin === "explicit" ? thread.title : DEFAULT_NEW_THREAD_TITLE,
      textGeneration,
      logPrefix: "provider command reactor",
      logContext: { threadId: thread.id, requestId, origin: event.payload.origin },
    });

    const title = generated.title;
    if (
      (title === thread.title && event.payload.origin !== "auto-refine") ||
      title === DEFAULT_NEW_THREAD_TITLE
    ) {
      yield* dispatchTitleRegenerationFailure({
        threadId: thread.id,
        requestId,
        expectedTitleRevision: event.payload.expectedTitleRevision,
        reason: "No distinct title could be generated from the current conversation.",
      });
      return;
    }

    const latestThread = yield* resolveThread(thread.id);
    const automaticRequestIsStillEligible =
      event.payload.origin !== "first-turn" ||
      (latestThread !== undefined &&
        latestThread.deletedAt === null &&
        latestThread.titleSource === "default" &&
        latestThread.messages.filter((message) => message.role === "user").length === 1);
    if (
      !latestThread ||
      latestThread.titleRegeneration?.requestId !== requestId ||
      (latestThread.titleRevision ?? 0) !== event.payload.expectedTitleRevision ||
      !automaticRequestIsStillEligible
    ) {
      yield* dispatchTitleRegenerationFailure({
        threadId: thread.id,
        requestId,
        expectedTitleRevision: event.payload.expectedTitleRevision,
        reason: "A newer thread change superseded this generated result.",
      });
      return;
    }

    const createdAt = new Date().toISOString();
    yield* orchestrationEngine.dispatch({
      type: "thread.title.regeneration.complete",
      commandId: serverCommandId("thread-title-regeneration-complete"),
      threadId: thread.id,
      requestId,
      expectedTitleRevision: event.payload.expectedTitleRevision,
      title,
      needsRefinement: event.payload.origin === "explicit" ? false : generated.needsRefinement,
      ...(event.payload.origin === "auto-refine"
        ? { refinementTurn: event.payload.refinementTurn ?? 0 }
        : {}),
      createdAt,
    });
  });

  const processTitleRegenerationStartedSafely = (
    event: Extract<ProviderIntentEvent, { type: "thread.title-regeneration-started" }>,
  ) =>
    processTitleRegenerationStarted(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return dispatchTitleRegenerationFailure({
          threadId: event.payload.threadId,
          requestId: event.payload.titleRegeneration.requestId,
          expectedTitleRevision: event.payload.expectedTitleRevision,
          reason: `Title generation failed: ${Cause.pretty(cause)}`,
        }).pipe(
          Effect.catchCause((dispatchCause) =>
            Effect.logWarning("provider command reactor failed to clear title generation", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(dispatchCause),
            }),
          ),
        );
      }),
    );

  const titleRegenerationWorker = yield* makeBackgroundWorker(
    processTitleRegenerationStartedSafely,
    {
      name: "ProviderCommandReactor.titleRegeneration",
      maxEntries: 64,
      key: (event) =>
        event.payload.origin === "explicit"
          ? event.payload.titleRegeneration.requestId
          : event.payload.threadId,
      revision: (event) => event.payload.expectedTitleRevision,
    },
  );

  const processTurnStartRequested = Effect.fnUntraced(function* (
    event: Extract<
      ProviderIntentEvent,
      { type: "thread.turn-start-requested" | "thread.turn-steer-requested" }
    >,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread || thread.deletedAt !== null || thread.archivedAt !== null) {
      yield* Effect.logWarning(
        "provider turn start rejected: thread is missing, deleted, or archived",
        {
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
        },
      );
      return yield* new ProviderTurnDeliveryError({
        certainty: "not_sent",
        retryable: false,
        detail: "The queued turn's thread is missing, deleted, or archived.",
      });
    }

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      const detail = `User message '${event.payload.messageId}' was not found for turn start request.`;
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return yield* new ProviderTurnDeliveryError({
        certainty: "not_sent",
        retryable: false,
        detail,
      });
    }

    const submissionSource =
      event.commandId && Option.isSome(sqlOption)
        ? yield* readSubmissionSource(event.commandId, thread.id).pipe(
            Effect.provideService(SqlClient.SqlClient, sqlOption.value),
          )
        : undefined;
    // A native continuation's fixed prompt carries no references, so it skips reference work.
    const projectedInput =
      event.type === "thread.turn-start-requested" && event.payload.continuationRequestId
        ? message.text
        : projectProviderInput({
            text: message.text,
            submissionSource,
            readModel: yield* orchestrationEngine.getReadModel(),
            threadId: thread.id,
          });
    // A person's message was admitted with room for the block. An automation prompt was not, so
    // when the workflow's references would push it past the limit it goes without them.
    const providerInput =
      submissionSource !== "human" &&
      projectedInput !== message.text &&
      getProviderTurnInputLengthIssue(projectedInput) &&
      !getProviderTurnInputLengthIssue(message.text)
        ? message.text
        : projectedInput;
    if (event.type === "thread.turn-steer-requested") {
      const steerInputLengthIssue = getProviderTurnInputLengthIssue(providerInput);
      if (steerInputLengthIssue)
        return yield* new ProviderTurnDeliveryError({
          certainty: "not_sent",
          retryable: false,
          detail: steerInputLengthIssue.message,
        });
      const { project } = yield* resolveThreadWorkspaceContext(thread.id, "steer");
      if (!project)
        return yield* new ProviderTurnDeliveryError({
          certainty: "not_sent",
          retryable: false,
          detail: "Unknown project",
        });
      // A thread without a project has no checkout to be ready. sendTurn rejects the
      // steer unless `expectedTurnId` is still the live turn, which keeps running in
      // its checkout even if that switched branches.
      if (!isScratchProject(project))
        yield* assertWorktreeReady(
          git,
          {
            projectCwd: project.workspaceRoot,
            worktreePath: thread.worktreePath,
            branch: thread.branch,
          },
          false,
          { allowBranchDrift: true },
        ).pipe(Effect.mapError(toProviderTurnDeliveryError));
      const mcpAppContext = yield* appContextForTurn(
        thread.id,
        submissionSource !== "automation"
          ? providerFromSessionName(thread.session?.providerName)
          : undefined,
      );
      yield* requireDeliverableThread(thread.id);
      return yield* providerService.sendTurn({
        threadId: thread.id,
        ...(mcpAppContext ? { mcpAppContext } : {}),
        ...(event.commandId ? { deliveryId: event.commandId } : {}),
        ...(submissionSource ? { submissionSource } : {}),
        expectedTurnId: event.payload.expectedTurnId,
        ...(event.payload.expectedSessionGeneration !== undefined
          ? { expectedSessionGeneration: event.payload.expectedSessionGeneration }
          : {}),
        input: providerInput,
        attachments: message.attachments ?? [],
        interactionMode: event.payload.interactionMode,
      });
    }

    // The reference reserve is enforced where people send; here only the final input counts.
    const inputLengthIssue = getProviderTurnInputLengthIssue(providerInput);
    if (inputLengthIssue) {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: inputLengthIssue.message,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return yield* new ProviderTurnDeliveryError({
        certainty: "not_sent",
        retryable: false,
        detail: inputLengthIssue.message,
      });
    }

    yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
      threadId: event.payload.threadId,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      messageId: message.id,
      messageText: threadReferencesToLabels(message.text),
      ...(submissionSource ? { submissionSource } : {}),
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
    });

    yield* maybeRequestThreadTitleForFirstTurn({
      threadId: event.payload.threadId,
      messageId: message.id,
      titleSourceText: threadReferencesToLabels(
        event.payload.titleSourceText !== undefined
          ? event.payload.titleSourceText
          : userMessageTitleText(message.text),
      ),
      ...(event.payload.titleGenerationModel !== undefined
        ? { titleGenerationModel: event.payload.titleGenerationModel }
        : {}),
      ...(event.payload.titleGenerationModelSelection !== undefined
        ? { titleGenerationModelSelection: event.payload.titleGenerationModelSelection }
        : {}),
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logError("provider command reactor hit an unexpected thread title error", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }),
      ),
      Effect.forkScoped,
    );

    return yield* sendTurnForThread({
      ...(event.payload.continuationRequestId
        ? { continuationRequestId: event.payload.continuationRequestId }
        : {}),
      threadId: event.payload.threadId,
      messageId: message.id,
      ...(event.commandId !== null ? { deliveryId: event.commandId } : {}),
      messageText: message.text,
      providerInput,
      ...(submissionSource ? { submissionSource } : {}),
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.provider !== undefined ? { provider: event.payload.provider } : {}),
      ...(event.payload.model !== undefined ? { model: event.payload.model } : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      ...(event.payload.modelOptions !== undefined
        ? { modelOptions: event.payload.modelOptions }
        : {}),
      ...(event.payload.providerOptions !== undefined
        ? { providerOptions: event.payload.providerOptions }
        : {}),
      interactionMode: event.payload.interactionMode,
      ...(event.payload.workflowExecutionProfile !== undefined
        ? { workflowExecutionProfile: event.payload.workflowExecutionProfile }
        : {}),
      createdAt: event.payload.createdAt,
    });
  });

  const recordTurnStartFailure: ProviderCommandReactorShape["recordTurnStartFailure"] = (
    event,
    detail,
  ) =>
    Effect.gen(function* () {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) return;
      yield* setThreadSession({
        threadId: event.payload.threadId,
        session: {
          threadId: event.payload.threadId,
          status: "error",
          providerName: thread.session?.providerName ?? null,
          providerInstanceId: thread.session?.providerInstanceId ?? null,
          runtimeMode: event.payload.runtimeMode,
          activeTurnId: null,
          lastError: detail,
          lastErrorId: event.eventId,
          lastErrorOccurredAt: event.payload.createdAt,
          ...(thread.session?.estimatedContextTokens != null
            ? { estimatedContextTokens: thread.session.estimatedContextTokens }
            : {}),
          ...(thread.session?.modelContextWindowTokens != null
            ? { modelContextWindowTokens: thread.session.modelContextWindowTokens }
            : {}),
          ...(thread.session?.tokenUsageSource != null
            ? { tokenUsageSource: thread.session.tokenUsageSource }
            : {}),
          updatedAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
      });
    }).pipe(
      Effect.mapError((error) =>
        error instanceof Error ? error : new Error("Failed to record provider delivery failure."),
      ),
    );

  const processTurnInterruptRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    // Once a provider turn has started, the projected active turn id is the
    // provider's native id. Preserve it across recovery: a replacement provider
    // session has no in-memory active turn, so a session-only interrupt would be
    // a silent no-op.
    const activeTurnId = event.payload.turnId ?? thread.session?.activeTurnId ?? undefined;
    yield* providerService
      .interruptTurn({
        threadId: event.payload.threadId,
        ...(activeTurnId !== undefined ? { turnId: activeTurnId } : {}),
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause);
            const latest = yield* resolveThread(event.payload.threadId);
            const session = latest?.session;
            if (
              !session ||
              session.status === "stopped" ||
              session.status === "ready" ||
              (activeTurnId !== undefined &&
                session.activeTurnId !== null &&
                session.activeTurnId !== activeTurnId)
            )
              return;
            const detail = Cause.pretty(cause);
            yield* appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.turn.interrupt.failed",
              summary: "Provider turn interrupt failed",
              detail,
              turnId: activeTurnId ?? null,
              createdAt: event.payload.createdAt,
            });
            // Closing the session is the fallback for a failed native interrupt. Do
            // not claim it stopped if cleanup fails or a newer turn has taken over.
            const stopped = yield* providerService
              .stopSession({ threadId: event.payload.threadId })
              .pipe(Effect.result);
            if (stopped._tag === "Failure") {
              yield* Effect.logWarning("provider session cleanup failed after interrupt", {
                threadId: event.payload.threadId,
                cause: stopped.failure,
              });
              return;
            }
            const after = (yield* resolveThread(event.payload.threadId))?.session;
            if (
              !after ||
              after.status === "stopped" ||
              after.status === "ready" ||
              (activeTurnId !== undefined &&
                after.activeTurnId !== null &&
                after.activeTurnId !== activeTurnId)
            )
              return;
            yield* setThreadSession({
              threadId: event.payload.threadId,
              session: {
                ...after,
                status: "stopped",
                activeTurnId: null,
                lastError: detail,
                updatedAt: event.payload.createdAt,
              },
              createdAt: event.payload.createdAt,
            });
          }),
        ),
      );
  });

  const processApprovalResponseRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.approval.respond.failed",
              summary: "Provider approval response failed",
              detail: Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            });

            if (!isUnknownPendingApprovalRequestError(cause)) return;
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
  ) {
    const releaseAttachments = Option.isSome(sqlOption)
      ? sqlOption.value`DELETE FROM attachment_owners WHERE owner_kind = 'user_input' AND owner_id = ${event.payload.requestId} AND attachment_id IN (SELECT attachment_id FROM attachments WHERE thread_id = ${event.payload.threadId})`.pipe(
          Effect.asVoid,
        )
      : Effect.void;
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      yield* releaseAttachments;
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      yield* releaseAttachments;
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.user-input.respond.failed",
        summary: "Provider user input response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToUserInput({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        answers: event.payload.answers,
        attachments: event.payload.attachments ?? [],
      })
      .pipe(
        Effect.onInterrupt(() => releaseAttachments.pipe(Effect.ignore)),
        Effect.catchCause((cause) =>
          releaseAttachments.pipe(
            Effect.andThen(
              appendProviderFailureActivity({
                threadId: event.payload.threadId,
                kind: "provider.user-input.respond.failed",
                summary: "Provider user input response failed",
                detail: Cause.pretty(cause),
                turnId: null,
                createdAt: event.payload.createdAt,
                requestId: event.payload.requestId,
              }),
            ),
          ),
        ),
      );
  });

  const stopThreadSession = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }

    const now = input.createdAt;
    if (thread.session && thread.session.status !== "stopped") {
      yield* providerService.stopSession({ threadId: thread.id });
    }
    threadProviderOptions.delete(thread.id);
    threadModelOptions.delete(thread.id);

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        providerInstanceId: thread.session?.providerInstanceId ?? null,
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        lastErrorId: thread.session?.lastErrorId ?? null,
        lastErrorOccurredAt: thread.session?.lastErrorOccurredAt ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  const processSessionStopRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    yield* stopThreadSession({
      threadId: event.payload.threadId,
      createdAt: event.payload.createdAt,
    });
  });

  const processThreadArchived = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.archived" }>,
  ) {
    yield* withThreadTurnGate(
      event.payload.threadId,
      stopThreadSession({
        threadId: event.payload.threadId,
        createdAt: event.payload.archivedAt,
      }),
    );
  });

  const restartClaudeSessionForMcpApply = Effect.fnUntraced(function* (
    binding: ProviderRuntimeBinding,
    createdAt: string,
  ) {
    if (binding.projectId === undefined || binding.projectId === null) {
      return false;
    }

    const activeThread = yield* resolveActiveThread(binding.threadId);
    if (!activeThread) {
      return false;
    }

    const sessionContext = yield* resolveThreadSessionStartContext(
      binding.threadId,
      undefined,
      false,
    );
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === binding.threadId)),
      );
    const persistedCwd = readPersistedCwd(binding.runtimePayload);
    const cwdChanged = persistedCwd !== sessionContext.instructionContext.cwd;
    const resumeCursor = cwdChanged
      ? undefined
      : (activeSession?.resumeCursor ?? binding.resumeCursor ?? undefined);
    const effectiveStartConfig = resolveEffectiveStartConfig({
      memory: {
        ...(threadProviderOptions.has(binding.threadId)
          ? { providerOptions: threadProviderOptions.get(binding.threadId) }
          : {}),
        ...(threadModelOptions.has(binding.threadId)
          ? { modelOptions: threadModelOptions.get(binding.threadId) }
          : {}),
        ...(sessionContext.desiredModel ? { model: sessionContext.desiredModel } : {}),
      },
      persisted: readPersistedStartConfig(binding.runtimePayload),
    });

    const restartedSession = yield* providerService.replaceSession(
      binding.threadId,
      {
        threadId: binding.threadId,
        projectId: activeThread.projectId,
        provider: "claudeAgent",
        providerInstanceId: binding.providerInstanceId ?? defaultInstanceForProvider("claudeAgent"),
        ...sessionContext.instructionContext,
        ...(effectiveStartConfig.model ? { model: effectiveStartConfig.model } : {}),
        ...(effectiveStartConfig.modelOptions !== undefined
          ? { modelOptions: effectiveStartConfig.modelOptions }
          : {}),
        ...(effectiveStartConfig.providerOptions !== undefined
          ? { providerOptions: effectiveStartConfig.providerOptions }
          : {}),
        ...(resumeCursor !== undefined && resumeCursor !== null ? { resumeCursor } : {}),
        runtimeMode: sessionContext.desiredRuntimeMode,
      },
      {
        instanceId: resolveBindingInstanceId(binding),
        generation: readPersistedSessionGeneration(binding.runtimePayload),
      },
    );
    if (!restartedSession) return false;

    yield* bindSessionToThreadWithContext({
      thread: sessionContext.thread,
      session: restartedSession,
      createdAt,
      desiredRuntimeMode: sessionContext.desiredRuntimeMode,
      ...(effectiveStartConfig.model ? { desiredModel: effectiveStartConfig.model } : {}),
      instructionContext: sessionContext.instructionContext,
    });

    const resetReason = cwdChanged
      ? "cwd-changed"
      : resumeCursor === undefined || resumeCursor === null
        ? "missing-resume-cursor"
        : undefined;
    if (resetReason !== undefined && hasPriorConversationContext(sessionContext.thread)) {
      yield* appendProviderContextResetActivity({
        threadId: binding.threadId,
        provider: restartedSession.provider,
        reason: resetReason,
        restartReasons: ["project-mcp-changed"],
        createdAt,
      });
    }

    return true;
  });

  const applyMcpConfigToLiveSessions: ProviderCommandReactorShape["applyMcpConfigToLiveSessions"] =
    (input) =>
      Effect.gen(function* () {
        const projectScopeProjectId = input.scope === "project" ? (input.projectId ?? null) : null;
        if (input.scope === "project" && projectScopeProjectId === null) {
          return yield* new ProjectMcpConfigServiceError({
            code: "validation",
            message: "projectId is required when applying project-scoped MCP config.",
          });
        }

        const selectedInstance = input.instanceId
          ? deriveProviderInstanceConfigMap(yield* serverSettings.getSettings)[input.instanceId]
          : undefined;
        if (
          input.instanceId &&
          (!selectedInstance ||
            selectedInstance.enabled === false ||
            (selectedInstance.driver !== "codex" && selectedInstance.driver !== "claudeAgent") ||
            (typeof selectedInstance.config === "object" &&
              selectedInstance.config !== null &&
              "enabled" in selectedInstance.config &&
              selectedInstance.config.enabled === false))
        ) {
          return yield* new ProjectMcpConfigServiceError({
            code: "validation",
            message: "Select an enabled Codex or Claude instance for MCP Apply.",
          });
        }
        const codexProviderOptions = toCodexProviderStartOptions({
          binaryPath: input.binaryPath,
          homePath: input.homePath,
        });
        const bindings =
          projectScopeProjectId !== null
            ? yield* providerSessionDirectory.listBindingsByProject(projectScopeProjectId)
            : yield* providerSessionDirectory.listBindings();
        if (
          selectedInstance &&
          bindings.some(
            (binding) =>
              binding.status !== "stopped" &&
              resolveBindingInstanceId(binding) === input.instanceId &&
              (!input.threadIds || input.threadIds.includes(binding.threadId)) &&
              binding.provider !== selectedInstance.driver,
          )
        ) {
          return yield* new ProjectMcpConfigServiceError({
            code: "validation",
            message:
              "A selected MCP session belongs to a different provider driver. Restart it before applying.",
          });
        }
        if (input.retryUnchanged !== undefined && input.threadIds === undefined) {
          return yield* new ProjectMcpConfigServiceError({
            code: "validation",
            message: "retryUnchanged requires threadIds.",
          });
        }
        // Validate the complete request before invoking any provider, including mixed valid/invalid sets.
        for (const threadId of input.threadIds ?? []) {
          const thread = yield* resolveThread(threadId);
          const binding = bindings.find((entry) => entry.threadId === threadId);
          if (
            !thread ||
            (projectScopeProjectId !== null && thread.projectId !== projectScopeProjectId) ||
            (input.instanceId &&
              (!binding ||
                resolveBindingInstanceId(binding) !== input.instanceId ||
                binding.provider !== selectedInstance?.driver))
          ) {
            return yield* new ProjectMcpConfigServiceError({
              code: "validation",
              message: `Conversation '${threadId}' is outside the requested MCP scope or instance.`,
            });
          }
        }
        const createdAt = new Date().toISOString();
        const effectiveConfigCache = new Map<ProjectId, StoredEffectiveMcpConfig>();
        const codexGroups = new Map<
          string,
          {
            readonly projectId: ProjectId;
            readonly providerOptions?: ProviderStartOptions;
            readonly threadIds: ThreadId[];
          }
        >();
        const claudeThreadsByProject = new Map<ProjectId, ThreadId[]>();
        const claudeBindings = new Map<ThreadId, ProviderRuntimeBinding>();
        const failures: Array<McpLiveSessionReloadFailure> = [];
        const sessionOutcomes: McpSessionReloadOutcome[] = [];
        let codexReloaded = 0;
        let claudeRestarted = 0;
        let claudeReconciled = 0;
        let deferred = 0;
        let skipped = 0;
        const recordFailure = (
          threadId: ThreadId,
          provider: ProviderKind,
          result: McpReloadResult,
          binding?: ProviderRuntimeBinding,
          version = "",
        ) => {
          if (binding)
            sessionOutcomes.push({
              threadId,
              instanceId: resolveBindingInstanceId(binding),
              generation: readPersistedSessionGeneration(binding.runtimePayload),
              requestedVersion: version,
              attemptedVersion: version,
              disposition: "failed",
              result,
            });
          failures.push({
            threadId,
            provider,
            restartRequired: result.restartRequired,
            errors: result.errors,
          });
        };

        const readEffectiveConfigForProject = (projectId: ProjectId) => {
          const cached = effectiveConfigCache.get(projectId);
          if (cached) {
            return Effect.succeed(cached);
          }
          return projectMcpConfigService.readEffectiveRuntimeConfig(projectId).pipe(
            Effect.tap((resolved) =>
              Effect.sync(() => {
                effectiveConfigCache.set(projectId, resolved);
              }),
            ),
          );
        };

        for (const binding of bindings) {
          if (
            (input.instanceId && resolveBindingInstanceId(binding) !== input.instanceId) ||
            (input.threadIds && !input.threadIds.includes(binding.threadId))
          )
            continue;
          if (
            binding.status === "stopped" ||
            binding.projectId === undefined ||
            binding.projectId === null
          ) {
            skipped += 1;
            continue;
          }

          const snapshot = yield* readEffectiveConfigForProject(binding.projectId).pipe(
            Effect.result,
          );
          if (snapshot._tag === "Failure") {
            recordFailure(
              binding.threadId,
              binding.provider,
              {
                converged: false,
                restartRequired: false,
                servers: [],
                errors: [{ message: mcpConfigErrorMessage(snapshot.failure) }],
              },
              binding,
            );
            continue;
          }
          const effectiveConfig = snapshot.success;
          if (binding.provider === "codex") {
            const compatibility = yield* Effect.try({
              try: () => readCodexMcpOAuthCallbackConfig(effectiveConfig.servers),
              catch: mcpConfigErrorMessage,
            }).pipe(Effect.result);
            if (compatibility._tag === "Failure") {
              recordFailure(
                binding.threadId,
                "codex",
                {
                  converged: false,
                  restartRequired: false,
                  servers: [],
                  errors: [{ message: compatibility.failure }],
                },
                binding,
                effectiveConfig.effectiveVersion,
              );
              continue;
            }
          }
          // A session whose last reload of this version did not converge is
          // retried: the user may have fixed the server since.
          if (
            !input.retryUnchanged &&
            binding.mcpEffectiveConfigVersion === effectiveConfig.effectiveVersion &&
            readPersistedUnconvergedMcpConfigVersion(binding.runtimePayload) !==
              effectiveConfig.effectiveVersion
          ) {
            skipped += 1;
            continue;
          }

          if (binding.provider === "codex") {
            const persistedProviderOptions = readPersistedProviderOptions(binding.runtimePayload);
            if (
              codexProviderOptions &&
              getProviderEnvironmentKey("codex", persistedProviderOptions) !==
                getProviderEnvironmentKey("codex", codexProviderOptions)
            ) {
              skipped += 1;
              continue;
            }

            const providerOptions = codexProviderOptions ?? persistedProviderOptions;
            const groupKey = `${binding.projectId}\u0000${resolveBindingInstanceId(binding)}\u0000${getProviderEnvironmentKey("codex", providerOptions)}`;
            const existingGroup = codexGroups.get(groupKey);
            if (existingGroup) {
              existingGroup.threadIds.push(binding.threadId);
            } else {
              codexGroups.set(groupKey, {
                projectId: binding.projectId,
                ...(providerOptions !== undefined ? { providerOptions } : {}),
                threadIds: [binding.threadId],
              });
            }
            continue;
          }

          if (binding.provider === "claudeAgent") {
            const threads = claudeThreadsByProject.get(binding.projectId) ?? [];
            threads.push(binding.threadId);
            claudeThreadsByProject.set(binding.projectId, threads);
            claudeBindings.set(binding.threadId, binding);
            continue;
          }

          skipped += 1;
        }

        const reloadGroup = (
          request: Parameters<typeof providerService.reloadMcpConfigForProject>[0] & {
            threadIds: readonly ThreadId[];
          },
        ) =>
          Effect.forEach(
            request.threadIds,
            (threadId) =>
              providerService
                .reloadMcpConfigForProject({
                  ...request,
                  threadIds: [threadId],
                  ...(input.instanceId ? { instanceId: input.instanceId } : {}),
                  requestedVersion:
                    effectiveConfigCache.get(request.projectId)?.effectiveVersion ?? "",
                })
                .pipe(
                  Effect.catch((error) => {
                    const binding = bindings.find((entry) => entry.threadId === threadId)!;
                    return Effect.succeed({
                      sessions: [
                        {
                          threadId,
                          instanceId: resolveBindingInstanceId(binding),
                          generation: readPersistedSessionGeneration(binding.runtimePayload),
                          requestedVersion:
                            effectiveConfigCache.get(request.projectId)?.effectiveVersion ?? "",
                          attemptedVersion:
                            effectiveConfigCache.get(request.projectId)?.effectiveVersion ?? "",
                          disposition: "failed" as const,
                          result: {
                            converged: false,
                            restartRequired: false,
                            servers: [],
                            errors: [{ message: mcpConfigErrorMessage(error) }],
                          },
                        },
                      ],
                    });
                  }),
                ),
            { concurrency: 4 },
          ).pipe(
            Effect.map((outcomes) => ({ sessions: outcomes.flatMap((entry) => entry.sessions) })),
          );
        for (const group of codexGroups.values()) {
          const outcome = yield* reloadGroup({
            provider: "codex",
            projectId: group.projectId,
            ...(group.providerOptions !== undefined
              ? { providerOptions: group.providerOptions }
              : {}),
            // Only the out-of-date sessions, so counts match what was skipped.
            threadIds: group.threadIds,
          });
          // Codex pins MCP servers at launch; a changed set restarts at the next turn.
          for (const session of outcome.sessions) {
            sessionOutcomes.push(session);
            if (session.disposition === "superseded") {
              skipped += 1;
              continue;
            }
            if (session.result.converged) {
              codexReloaded += 1;
              continue;
            }
            if (session.result.restartRequired) {
              deferred += 1;
              sessionOutcomes[sessionOutcomes.length - 1] = { ...session, disposition: "deferred" };
            }
            recordFailure(session.threadId, "codex", session.result);
          }
          skipped += Math.max(0, group.threadIds.length - outcome.sessions.length);
        }

        // Claude reconciles F5-owned servers in place. Only a session that
        // cannot do so restarts, and only while idle; a busy one keeps its
        // stale config version so the next turn start restarts it. The idle
        // check and the restart share the turn gate, so a turn delivered while
        // the reload was retrying is seen here and never stopped.
        const restartIfStillIdle = (binding: ProviderRuntimeBinding) =>
          withThreadTurnGate(
            binding.threadId,
            Effect.gen(function* () {
              const current = Option.getOrUndefined(
                yield* providerSessionDirectory.getBinding(binding.threadId),
              );
              if (
                !current ||
                resolveBindingInstanceId(current) !== resolveBindingInstanceId(binding) ||
                readPersistedSessionGeneration(current.runtimePayload) !==
                  readPersistedSessionGeneration(binding.runtimePayload)
              )
                return false;
              const live = (yield* providerService.listSessions()).find(
                (entry) => entry.threadId === binding.threadId,
              );
              if (
                activeSubmissions.has(binding.threadId) ||
                !live ||
                live.activeTurnId ||
                live.status === "running"
              )
                return false;
              return yield* restartClaudeSessionForMcpApply(binding, createdAt);
            }),
          );
        for (const [projectId, threadIds] of claudeThreadsByProject) {
          const outcome = yield* reloadGroup({
            provider: "claudeAgent",
            projectId,
            threadIds,
          });
          const reached = new Set(outcome.sessions.map((session) => session.threadId));
          skipped += threadIds.filter((threadId) => !reached.has(threadId)).length;
          for (const session of outcome.sessions) {
            sessionOutcomes.push(session);
            if (session.disposition === "superseded") {
              skipped += 1;
              continue;
            }
            if (session.result.converged) {
              claudeReconciled += 1;
              continue;
            }
            const binding = claudeBindings.get(session.threadId);
            if (session.result.restartRequired && binding) {
              const restart = yield* restartIfStillIdle(binding).pipe(Effect.result);
              if (restart._tag === "Failure") {
                const result = {
                  converged: false,
                  restartRequired: true,
                  servers: [],
                  errors: [{ message: mcpConfigErrorMessage(restart.failure) }],
                };
                sessionOutcomes[sessionOutcomes.length - 1] = {
                  ...session,
                  disposition: "failed",
                  result,
                };
                recordFailure(session.threadId, "claudeAgent", result);
                continue;
              }
              if (restart.success) {
                claudeRestarted += 1;
                const started = Option.getOrUndefined(
                  yield* providerSessionDirectory.getBinding(session.threadId),
                );
                if (started)
                  sessionOutcomes[sessionOutcomes.length - 1] = {
                    ...session,
                    instanceId: resolveBindingInstanceId(started),
                    generation: readPersistedSessionGeneration(started.runtimePayload),
                    attemptedVersion: started.mcpEffectiveConfigVersion ?? session.attemptedVersion,
                    disposition: "applied",
                    result: { converged: true, restartRequired: false, servers: [], errors: [] },
                  };
                continue;
              }
            }
            const current = Option.getOrUndefined(
              yield* providerSessionDirectory.getBinding(session.threadId),
            );
            if (
              !current ||
              resolveBindingInstanceId(current) !== session.instanceId ||
              readPersistedSessionGeneration(current.runtimePayload) !== session.generation
            ) {
              sessionOutcomes[sessionOutcomes.length - 1] = {
                ...session,
                disposition: "superseded",
              };
              skipped += 1;
              continue;
            }
            if (session.result.restartRequired) {
              deferred += 1;
              sessionOutcomes[sessionOutcomes.length - 1] = { ...session, disposition: "deferred" };
            }
            recordFailure(session.threadId, "claudeAgent", session.result);
          }
        }

        const responseProjectId = projectScopeProjectId ?? input.projectId;
        const responseConfig =
          responseProjectId !== undefined
            ? yield* projectMcpConfigService
                .readEffectiveRuntimeConfig(responseProjectId)
                .pipe(Effect.catch(() => Effect.succeed(undefined)))
            : undefined;

        return {
          scope: input.scope,
          ...(responseProjectId !== undefined ? { projectId: responseProjectId } : {}),
          sessions: sessionOutcomes,
          codexReloaded,
          claudeRestarted,
          claudeReconciled,
          deferred,
          skipped,
          ...(failures.length > 0 ? { failures } : {}),
          ...(responseConfig ? { configVersion: responseConfig.effectiveVersion } : {}),
        } satisfies McpApplyToLiveSessionsResult;
      });

  // Title synchronization has its own bounded worker so a slow provider cannot stall turns.
  const providerTitleWorker = yield* makeBackgroundWorker(
    (input: { threadId: ThreadId; title: string; revision: number }) =>
      Effect.gen(function* () {
        const current = yield* resolveThread(input.threadId);
        if (
          !current ||
          current.deletedAt !== null ||
          (current.titleRevision ?? 0) !== input.revision ||
          current.title !== input.title
        )
          return;
        if (providerService.renameThread)
          yield* providerService.renameThread(input.threadId, input.title).pipe(
            Effect.timeout("5 seconds"),
            Effect.catchCause((cause) =>
              Effect.logWarning("Provider title sync failed", { threadId: input.threadId, cause }),
            ),
          );
      }),
    {
      name: "ProviderCommandReactor.providerTitle",
      key: (item) => item.threadId,
      revision: (item) => item.revision,
    },
  );

  /** Refresh the current live generation without reviving a stopped or replaced session. */
  const refreshSessionForThread = (thread: OrchestrationThread, createdAt: string) =>
    Effect.gen(function* () {
      const threadId = thread.id;
      const generation = thread.session?.capabilities?.generation;
      const binding = yield* providerSessionDirectory.getBinding(threadId);
      const persistedGeneration = readPersistedSessionGeneration(
        Option.getOrUndefined(binding)?.runtimePayload,
      );
      return yield* withThreadTurnGate(
        threadId,
        Effect.gen(function* () {
          const current = yield* resolveThread(threadId);
          const currentBinding = yield* providerSessionDirectory.getBinding(threadId);
          if (
            !current ||
            current.deletedAt !== null ||
            current.archivedAt !== null ||
            !current.session ||
            current.session.status === "stopped" ||
            current.session.capabilities?.generation !== generation ||
            readPersistedSessionGeneration(
              Option.getOrUndefined(currentBinding)?.runtimePayload,
            ) !== persistedGeneration ||
            current.session.providerName !== thread.session?.providerName ||
            current.session.providerInstanceId !== thread.session?.providerInstanceId
          )
            return;
          yield* ensureSessionForThread(threadId, createdAt, {
            keepWorkflowExecutionProfile: true,
            reportWorkspaceFailure: false,
          });
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("provider command reactor failed to refresh session", {
                threadId,
                cause: Cause.pretty(cause),
              }),
        ),
        Effect.forkIn(reactorScope),
      );
    });

  const processDomainEvent = (event: ProviderIntentEvent) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({
        "orchestration.event_type": event.type,
      });
      switch (event.type) {
        case "thread.title-regenerated":
        case "thread.turn-processing-quiesced": {
          const thread = yield* resolveThread(event.payload.threadId);
          if (event.type === "thread.title-regenerated" && thread)
            yield* providerTitleWorker.enqueue({
              threadId: thread.id,
              title: thread.title,
              revision: thread.titleRevision ?? 0,
            });
          const completedAt =
            event.type === "thread.turn-processing-quiesced"
              ? event.payload.processingQuiescedAt
              : thread?.latestTurn?.processingQuiescedAt;
          const turn = completedAt
            ? (thread?.messages.filter(
                (message) =>
                  message.role === "user" &&
                  message.turnId === null &&
                  message.createdAt <= completedAt,
              ).length ?? 0)
            : 0;
          if (
            (event.type !== "thread.title-regenerated" ||
              thread?.latestTurn?.processingQuiescedAt) &&
            thread?.titleSource === "generated" &&
            thread.titleState?.needsRefinement &&
            thread.titleState.refinementCount < 2 &&
            [1, 3].includes(turn) &&
            thread.titleState.lastRefinedTurn < turn &&
            !thread.titleRegeneration
          ) {
            yield* orchestrationEngine.dispatch({
              type: "thread.title.generation.start",
              commandId: serverCommandId("thread-title-refine"),
              threadId: thread.id,
              expectedTitleRevision: thread.titleRevision ?? 0,
              trigger: "auto-refine",
              refinementTurn: turn,
              createdAt: event.occurredAt,
            });
          }
          break;
        }
        case "thread.title-regeneration-started":
          if (event.payload.origin !== "explicit") {
            yield* titleRegenerationWorker.enqueue(event);
            break;
          }
          if (
            !(yield* titleRegenerationWorker
              .offer(event)
              .pipe(Effect.catchTag("WorkerAdmissionError", () => Effect.succeed(false))))
          ) {
            yield* dispatchTitleRegenerationFailure({
              threadId: event.payload.threadId,
              requestId: event.payload.titleRegeneration.requestId,
              expectedTitleRevision: event.payload.expectedTitleRevision,
              reason: "Title generation is busy or unavailable. Try again.",
            });
          }
          break;
        case "thread.runtime-mode-set": {
          const thread = yield* resolveThread(event.payload.threadId);
          if (!thread?.session || thread.session.status === "stopped") {
            return;
          }
          yield* refreshSessionForThread(thread, event.occurredAt);
          break;
        }
        case "thread.meta-updated": {
          const thread = yield* resolveThread(event.payload.threadId);
          if (thread && event.payload.title && event.payload.titleOrigin !== "provider")
            yield* providerTitleWorker.enqueue({
              threadId: event.payload.threadId,
              title: event.payload.title,
              revision: thread.titleRevision ?? 0,
            });
          // Titles and observed checkout branches do not change the provider
          // launch context. Re-reading its stale session would erase turn errors.
          if (
            event.payload.model === undefined &&
            event.payload.modelSelection === undefined &&
            event.payload.worktreePath === undefined
          )
            return;
          if (!thread?.session || thread.session.status === "stopped") {
            return;
          }
          yield* refreshSessionForThread(thread, event.occurredAt);
          break;
        }
        case "thread.deleted":
          deletedSessionStops.set(event.payload.threadId, { attempts: 0, retryAt: 0 });
          yield* stopDeletedSession(event.payload.threadId);
          break;
        case "thread.turn-start-requested":
          yield* processTurnStartRequested(event);
          break;
        case "thread.turn-interrupt-requested":
          yield* processTurnInterruptRequested(event);
          break;
        case "thread.approval-response-requested":
          yield* processApprovalResponseRequested(event);
          break;
        case "thread.user-input-response-requested":
          yield* processUserInputResponseRequested(event);
          break;
        case "thread.session-stop-requested":
          yield* processSessionStopRequested(event);
          break;
        case "thread.archived":
          yield* processThreadArchived(event);
          break;
      }
      yield* increment(orchestrationEventsProcessedTotal, {
        eventType: event.type,
      });
    }).pipe(Effect.withSpan(`provider.reactor.${event.type}`));

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    Effect.suspend(() => {
      let ownsControl = !orchestrationEngine.claimControl;
      return Effect.gen(function* () {
        if (
          isControlEvent(event) &&
          orchestrationEngine.claimControl &&
          (!event.commandId || !(yield* orchestrationEngine.claimControl(event.commandId)))
        )
          return;
        ownsControl = true;
        const origin = event.commandId
          ? orchestrationEngine.controlOrigin?.(event.commandId)
          : undefined;
        if (isControlEvent(event) && origin) {
          const current = Option.getOrUndefined(
            yield* providerSessionDirectory.getBinding(event.payload.threadId),
          );
          const thread = yield* resolveThread(event.payload.threadId);
          if (
            (current?.provider ?? null) !== origin.provider ||
            (current?.providerInstanceId ?? current?.provider ?? null) !== origin.instanceId ||
            (current ? readPersistedSessionGeneration(current.runtimePayload) : null) !==
              origin.generation ||
            (origin.activeTurnId !== null &&
              (thread?.session?.activeTurnId ?? null) !== origin.activeTurnId)
          ) {
            yield* appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind:
                event.type === "thread.session-stop-requested"
                  ? "provider.session.stop.failed"
                  : event.type === "thread.turn-interrupt-requested"
                    ? "provider.turn.interrupt.failed"
                    : event.type === "thread.approval-response-requested"
                      ? "provider.approval.respond.failed"
                      : "provider.user-input.respond.failed",
              summary: "The provider session changed before this action ran",
              detail: "The action was not sent to the replacement session or turn.",
              turnId: null,
              createdAt: event.occurredAt,
            });
            return;
          }
        }
        yield* processDomainEvent(event).pipe(Effect.provideService(ProviderControlTarget, origin));
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("provider command reactor failed to process event", {
            eventType: event.type,
            cause: Cause.pretty(cause),
          });
        }),
        Effect.ensuring(
          Effect.suspend(() =>
            ownsControl &&
            event.commandId &&
            isControlEvent(event) &&
            orchestrationEngine.completeControl
              ? orchestrationEngine.completeControl(event.commandId)
              : Effect.void,
          ),
        ),
      );
    });

  const worker = yield* makeBackgroundWorker(processDomainEventSafely, {
    name: "ProviderCommandReactor",
    controlEntries: 64,
    isControl: isControlEvent,
  });

  const start: ProviderCommandReactorShape["start"] = Effect.gen(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.runtime-mode-set" &&
          event.type !== "thread.meta-updated" &&
          event.type !== "thread.title-regeneration-started" &&
          event.type !== "thread.turn-processing-quiesced" &&
          event.type !== "thread.title-regenerated" &&
          event.type !== "thread.deleted" &&
          event.type !== "thread.turn-interrupt-requested" &&
          event.type !== "thread.approval-response-requested" &&
          event.type !== "thread.user-input-response-requested" &&
          event.type !== "thread.session-stop-requested" &&
          event.type !== "thread.archived"
        ) {
          return Effect.void;
        }

        if (isControlEvent(event)) return Effect.void;
        return worker.enqueue(event);
      }),
      { startImmediately: true },
    );

    // Separate subscriptions keep a blocked lossless bulk admission from hiding
    // controls later in the PubSub. Both feed the same serial priority worker.
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (!isControlEvent(event)) return Effect.void;
        return worker.enqueue(event as ProviderIntentEvent);
      }),
      { startImmediately: true },
    );

    const readModel = yield* orchestrationEngine.getReadModel();
    const deletedIds = new Set(
      readModel.threads.filter((thread) => thread.deletedAt !== null).map((thread) => thread.id),
    );
    let needsDeletedSessionDiscovery = deletedIds.size > 0;
    const discoverDeletedSessions = Effect.gen(function* () {
      if (!needsDeletedSessionDiscovery) return;
      const bindings = yield* providerSessionDirectory.listBindings({ excludeStopped: true });
      for (const binding of bindings)
        if (deletedIds.has(binding.threadId) && binding.status !== "stopped")
          deletedSessionStops.set(binding.threadId, { attempts: 0, retryAt: 0 });
      needsDeletedSessionDiscovery = false;
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logError("Failed to discover deleted-thread runtimes; discovery will retry", {
              cause: Cause.pretty(cause),
            }),
      ),
    );
    yield* discoverDeletedSessions;
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep("1 second").pipe(
          Effect.andThen(
            Effect.suspend(() =>
              discoverDeletedSessions.pipe(
                Effect.andThen(
                  Effect.suspend(() =>
                    Effect.forEach(
                      [...deletedSessionStops].filter(
                        ([, pending]) => pending.retryAt <= Date.now(),
                      ),
                      ([threadId]) => stopDeletedSession(threadId),
                      { discard: true, concurrency: 4 },
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    yield* Effect.forEach(
      readModel.threads,
      (thread) => {
        const pending = thread.titleRegeneration;
        if (pending == null) return Effect.void;
        return dispatchTitleRegenerationFailure({
          threadId: thread.id,
          requestId: pending.requestId,
          expectedTitleRevision: thread.titleRevision ?? 0,
          reason: "The server restarted before title generation completed.",
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("provider command reactor failed to clear orphaned title request", {
              threadId: thread.id,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      },
      { discard: true },
    );
  });

  const deliverTurnStart: ProviderCommandReactorShape["deliverTurnStart"] = (event) =>
    withThreadTurnGate(
      event.payload.threadId,
      Effect.acquireUseRelease(
        Effect.sync(() =>
          activeSubmissions.set(
            event.payload.threadId,
            (activeSubmissions.get(event.payload.threadId) ?? 0) + 1,
          ),
        ),
        () => processTurnStartRequested(event),
        () =>
          Effect.sync(() => {
            const remaining = (activeSubmissions.get(event.payload.threadId) ?? 1) - 1;
            if (remaining > 0) activeSubmissions.set(event.payload.threadId, remaining);
            else activeSubmissions.delete(event.payload.threadId);
          }),
      ),
    ).pipe(
      Effect.tap(() =>
        increment(orchestrationEventsProcessedTotal, {
          eventType: event.type,
        }),
      ),
      Effect.mapError(toProviderTurnDeliveryError),
    );

  const drain = Effect.all(
    [worker.drain, titleRegenerationWorker.drain, providerTitleWorker.drain],
    {
      discard: true,
      concurrency: 2,
    },
  );
  yield* registerShutdown("provider-command-work", "drain", () => drain, ["provider-ingestion"]);
  return {
    start,
    drain,
    deliverTurnStart,
    recordTurnStartFailure,
    applyMcpConfigToLiveSessions,
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
