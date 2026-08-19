import {
  type ChatAttachment,
  CommandId,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_NEW_THREAD_TITLE,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_SERVER_SETTINGS,
  defaultInstanceIdForDriver,
  EventId,
  type ModelSelection,
  type McpApplyToLiveSessionsResult,
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
import { Cause, Effect, Layer, Option, Schema, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { estimateMessageContextCharacters, inferProviderForModel } from "@t3tools/shared/model";
import { getProviderTurnInputLengthIssue } from "@t3tools/shared/providerInput";
import {
  areProviderModelOptionsEqual,
  areProviderStartOptionsEqual,
  getProviderEnvironmentKey,
  getProviderSessionRestartOptions,
  normalizeProviderStartOptions,
} from "@t3tools/shared/providerOptions";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import {
  increment,
  orchestrationEventsProcessedTotal,
  providerSessionContextResetsTotal,
} from "../../observability/Metrics.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  ProviderServiceError,
  ProviderTurnDeliveryError,
  ProviderUnsupportedError,
  ProviderValidationError,
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
import { buildThreadResumeContext } from "../compactionService.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { toCodexProviderStartOptions } from "../../provider/codexProviderOptions.ts";
import { resolveEffectiveStartConfig } from "../../provider/effectiveStartConfig.ts";
import {
  readPersistedCwd,
  readPersistedInstructionContext,
  readPersistedProviderOptions,
  readPersistedStartConfig,
} from "../../provider/runtimePayload.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  formatThreadTitleRegenerationContext,
  resolveBestEffortGeneratedTitle,
} from "../../threadTitle.ts";

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.meta-updated"
      | "thread.title-regeneration-started"
      | "thread.deleted"
      | "thread.turn-start-requested"
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
  switch (provider) {
    case "claudeAgent":
      return "Claude";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "opencode":
      return "OpenCode";
    case "grok":
      return "Grok";
  }
}

function providerFromSessionName(value: string | null | undefined): ProviderKind | undefined {
  switch (value) {
    case "codex":
    case "claudeAgent":
    case "cursor":
    case "opencode":
    case "grok":
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
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const WORKTREE_BRANCH_PREFIX = "t3code";
const TEMP_WORKTREE_BRANCH_PATTERN = new RegExp(`^${WORKTREE_BRANCH_PREFIX}\\/[0-9a-f]{8}$`);

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
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function isTemporaryWorktreeBranch(branch: string): boolean {
  return TEMP_WORKTREE_BRANCH_PATTERN.test(branch.trim().toLowerCase());
}

function buildGeneratedWorktreeBranchName(raw: string, configuredPrefix: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  const prefix =
    configuredPrefix
      .trim()
      .toLowerCase()
      .replace(/^refs\/heads\//, "")
      .replace(/[^a-z0-9/_-]+/g, "-")
      .replace(/^\/+|\/+$/g, "") || "f5";
  return `${prefix}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const projectMcpConfigService = yield* ProjectMcpConfigService;
  const git = yield* GitCore;
  const textGeneration = yield* TextGeneration;
  const serverSettings = yield* ServerSettingsService;
  const threadProviderOptions = new Map<string, ProviderStartOptions>();
  const threadModelOptions = new Map<string, ProviderModelOptions>();

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly deliveryId?: CommandId;
    readonly kind:
      | "provider.turn.start.failed"
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
        id: EventId.makeUnsafe(crypto.randomUUID()),
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
          id: EventId.makeUnsafe(crypto.randomUUID()),
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

  const resolveThreadSessionStartContext = Effect.fnUntraced(function* (threadId: ThreadId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });
    const project = readModel.projects.find(
      (project) => project.id === thread.projectId && project.deletedAt === null,
    );
    yield* Effect.logInfo("provider command reactor resolved thread session start context", {
      threadId,
      threadWorktreePath: thread.worktreePath,
      projectWorkspaceRoot: project?.workspaceRoot ?? null,
      effectiveCwd: effectiveCwd ?? null,
    });
    const activeProjectMemories = (project?.memories ?? []).filter(
      (memory) => memory.deletedAt === null,
    );
    const instructionContext = buildThreadInstructionContext({
      thread,
      ...(project?.title ? { projectTitle: project.title } : {}),
      projectMemories: activeProjectMemories,
      ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
      turnCount: deriveThreadTurnCount(thread),
    });
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
    },
  ) {
    return yield* Effect.gen(function* () {
      const sessionContext = yield* resolveThreadSessionStartContext(threadId);
      const {
        thread,
        instructionContext: baseInstructionContext,
        persistedBinding,
        desiredRuntimeMode,
      } = sessionContext;
      const instructionContext: Partial<SharedInstructionInput> = {
        ...baseInstructionContext,
        ...(options?.workflowExecutionProfile
          ? { workflowExecutionProfile: options.workflowExecutionProfile }
          : {}),
      };
      const currentProvider = providerFromSessionName(thread.session?.providerName);
      const currentInstanceId =
        thread.session?.providerInstanceId ??
        persistedBinding?.providerInstanceId ??
        (currentProvider ? defaultInstanceForProvider(currentProvider) : undefined);
      const threadSelectionProvider = thread.modelSelection?.model
        ? inferProviderForModel(thread.modelSelection.model)
        : undefined;
      const sameProviderThreadSelectionInstanceId =
        threadSelectionProvider !== undefined && threadSelectionProvider === currentProvider
          ? thread.modelSelection?.instanceId
          : undefined;
      const preferredInstanceId =
        options?.preferredInstanceId ??
        options?.modelSelection?.instanceId ??
        sameProviderThreadSelectionInstanceId ??
        currentInstanceId;
      const preferredProvider: ProviderKind | undefined = options?.provider ?? currentProvider;
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
      const effectiveStartConfig = {
        ...unresolvedEffectiveStartConfig,
        providerOptions: preferredProvider
          ? normalizeProviderStartOptions(
              preferredProvider,
              unresolvedEffectiveStartConfig.providerOptions,
            )
          : unresolvedEffectiveStartConfig.providerOptions,
      };
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

      const resolveActiveSession = (threadId: ThreadId) =>
        providerService
          .listSessions()
          .pipe(
            Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)),
          );

      const startProviderSession = (input?: {
        readonly resumeCursor?: unknown;
        readonly provider?: ProviderKind;
      }) => {
        const providerForStart = input?.provider ?? preferredProvider;

        return Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({
            "provider.operation": "start-session",
            "provider.thread_id": threadId,
            ...(providerForStart ? { "provider.kind": providerForStart } : {}),
            ...(desiredModel ? { "provider.model": desiredModel } : {}),
            "provider.has_resume_cursor": input?.resumeCursor !== undefined,
          });
          return yield* providerService.startSession(threadId, {
            threadId,
            projectId: thread.projectId,
            ...(providerForStart ? { provider: providerForStart } : {}),
            ...(preferredInstanceId ? { providerInstanceId: preferredInstanceId } : {}),
            ...instructionContext,
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
            ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
            runtimeMode: desiredRuntimeMode,
          });
        }).pipe(Effect.withSpan("provider.start-session"));
      };

      const bindSessionToThread = (session: ProviderSession) =>
        bindSessionToThreadWithContext({
          thread,
          session,
          createdAt,
          desiredRuntimeMode,
          ...(desiredModel ? { desiredModel } : {}),
          instructionContext,
        });

      const activeSession = yield* resolveActiveSession(threadId);
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
          currentProvider === undefined
            ? "in-session"
            : (yield* providerService.getCapabilities(currentProvider)).sessionModelSwitch;
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
        const currentProjectMcpVersion = project
          ? yield* projectMcpConfigService.readEffectiveStoredConfig(project.id).pipe(
              Effect.map((config) => config.effectiveVersion),
              Effect.catch((error) =>
                Effect.logWarning("provider command reactor could not read project MCP config", {
                  threadId,
                  projectId: project.id,
                  detail: error.message,
                }).pipe(Effect.as(null)),
              ),
            )
          : null;
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
        const activeWorkflowExecutionProfile = readPersistedInstructionContext(
          persistedBinding?.runtimePayload,
        )?.workflowExecutionProfile;
        const shouldRestartForWorkflowExecutionProfileChange =
          activeWorkflowExecutionProfile !== options?.workflowExecutionProfile;

        if (
          !runtimeModeChanged &&
          !providerChanged &&
          !instanceChanged &&
          !shouldRestartForModelChange &&
          !shouldRestartForModelOptionsChange &&
          !shouldRestartForProviderOptionsChange &&
          !shouldRestartForProjectMcpChange &&
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
            : shouldRestartForCwdChange
              ? "cwd-changed"
              : shouldRestartForWorkflowExecutionProfileChange
                ? "workflow-execution-profile-changed"
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
          desiredProvider: options?.provider ?? currentProvider,
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
          shouldRestartForCwdChange,
          shouldRestartForWorkflowExecutionProfileChange,
          activeWorkflowExecutionProfile: activeWorkflowExecutionProfile ?? null,
          desiredWorkflowExecutionProfile: options?.workflowExecutionProfile ?? null,
          currentSessionCwd,
          desiredSessionCwd,
          persistedMcpEffectiveConfigVersion: persistedBinding?.mcpEffectiveConfigVersion ?? null,
          currentProjectMcpVersion,
          resumeCursorDropReason: resumeCursorDropReason ?? null,
          hasResumeCursor: resumeCursor !== undefined,
        });
        const restartedSession = yield* startProviderSession({
          ...(resumeCursor !== undefined ? { resumeCursor } : {}),
          ...(options?.provider !== undefined ? { provider: options.provider } : {}),
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
        if (contextResetReason !== undefined && hasPriorConversationContext(thread)) {
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
      const persistedWorkflowExecutionProfile = readPersistedInstructionContext(
        persistedBinding?.runtimePayload,
      )?.workflowExecutionProfile;
      const persistedWorkflowExecutionProfileMatches =
        persistedWorkflowExecutionProfile === options?.workflowExecutionProfile;
      const resumeCursorForStoppedSession =
        persistedProviderMatches &&
        persistedInstanceMatches &&
        persistedCwdMatches &&
        persistedWorkflowExecutionProfileMatches &&
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
      });
      yield* bindSessionToThread(startedSession);
      yield* recordEffectiveStartConfig();
      if (
        resumeCursorForStoppedSession === undefined &&
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
                : !persistedWorkflowExecutionProfileMatches
                  ? "workflow-execution-profile-changed"
                  : "missing-resume-cursor",
          restartReasons: ["recover-session"],
          createdAt,
        });
      }
      return startedSession.threadId;
    }).pipe(Effect.withSpan("provider.ensure-session"));
  });

  const sendTurnForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly deliveryId?: CommandId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly provider?: ProviderKind;
    readonly model?: string;
    readonly modelSelection?: ModelSelection;
    readonly modelOptions?: ProviderModelOptions;
    readonly providerOptions?: ProviderStartOptions;
    readonly interactionMode?: "default" | "plan";
    readonly workflowExecutionProfile?: WorkflowTurnExecutionProfile;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.modelOptions !== undefined ? { modelOptions: input.modelOptions } : {}),
      ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
      ...(input.workflowExecutionProfile !== undefined
        ? { workflowExecutionProfile: input.workflowExecutionProfile }
        : {}),
    });
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const persistedBinding = yield* providerSessionDirectory
      .getBinding(input.threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    const readModel = yield* orchestrationEngine.getReadModel();
    const project = readModel.projects.find(
      (project) => project.id === thread.projectId && project.deletedAt === null,
    );
    const activeProjectMemories = (project?.memories ?? []).filter(
      (memory) => memory.deletedAt === null,
    );
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });
    yield* Effect.logInfo("provider command reactor sendTurnForThread resolved cwd", {
      threadId: input.threadId,
      threadWorktreePath: thread.worktreePath,
      projectWorkspaceRoot: project?.workspaceRoot ?? null,
      effectiveCwd: effectiveCwd ?? null,
    });
    const instructionContext = buildThreadInstructionContext({
      thread,
      ...(project?.title ? { projectTitle: project.title } : {}),
      projectMemories: activeProjectMemories,
      ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
      turnCount: deriveThreadTurnCount(thread),
      ...(input.workflowExecutionProfile
        ? { workflowExecutionProfile: input.workflowExecutionProfile }
        : {}),
    });
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : (yield* providerService.getCapabilities(activeSession.provider)).sessionModelSwitch;
    const modelForTurn =
      sessionModelSwitch === "unsupported"
        ? activeSession?.model
        : (input.model ?? input.modelSelection?.model);
    const recoveryProvider =
      activeSession?.provider ??
      providerFromSessionName(thread.session?.providerName) ??
      input.provider ??
      inferProviderForModel(thread.model, "codex");

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

    return yield* providerService.sendTurn({
      threadId: input.threadId,
      ...(input.deliveryId !== undefined ? { deliveryId: input.deliveryId } : {}),
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { model: modelForTurn } : {}),
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.modelOptions !== undefined ? { modelOptions: input.modelOptions } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      ...(input.workflowExecutionProfile !== undefined
        ? { workflowExecutionProfile: input.workflowExecutionProfile }
        : {}),
    });
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

    const userMessages = thread.messages.filter((message) => message.role === "user");
    if (userMessages.length !== 1 || userMessages[0]?.id !== input.messageId) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    const writingPreferences = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.sourceControlWriting),
      Effect.catch((error) =>
        Effect.logWarning("failed to read branch writing settings; using defaults", {
          reason: error.message,
        }).pipe(Effect.as(DEFAULT_SERVER_SETTINGS.sourceControlWriting)),
      ),
    );
    yield* textGeneration
      .generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
        writingPreferences,
      })
      .pipe(
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

          return Effect.flatMap(
            git.renameBranch({ cwd, oldBranch, newBranch: targetBranch }),
            (renamed) =>
              orchestrationEngine.dispatch({
                type: "thread.meta.update",
                commandId: serverCommandId("worktree-branch-rename"),
                threadId: input.threadId,
                branch: renamed.branch,
                worktreePath: cwd,
              }),
          );
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
    const titleSourceText =
      event.payload.origin === "explicit"
        ? explicitContext.text
        : (event.payload.titleSourceText ?? firstUserMessage?.text ?? "").trim();
    const attachments =
      event.payload.origin === "explicit"
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

    const settings = yield* serverSettings.getSettings;
    const requestedSelection =
      event.payload.titleGenerationModelSelection ??
      (event.payload.titleGenerationModel !== undefined
        ? {
            ...settings.textGenerationModelSelection,
            model: event.payload.titleGenerationModel,
          }
        : settings.textGenerationModelSelection);
    const title = yield* resolveBestEffortGeneratedTitle({
      cwd,
      titleSourceText,
      attachments,
      titleGenerationModel: requestedSelection.model,
      titleGenerationModelSelection: requestedSelection,
      ...(event.payload.origin === "explicit" ? { previousTitle: thread.title } : {}),
      defaultTitle: event.payload.origin === "explicit" ? thread.title : DEFAULT_NEW_THREAD_TITLE,
      textGeneration,
      logPrefix: "provider command reactor",
      logContext: { threadId: thread.id, requestId, origin: event.payload.origin },
    });

    if (title === thread.title || title === DEFAULT_NEW_THREAD_TITLE) {
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

  const titleRegenerationWorker = yield* makeDrainableWorker(processTitleRegenerationStartedSafely);

  const processTurnStartRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      yield* Effect.logWarning("provider turn start ignored because the thread is missing", {
        threadId: event.payload.threadId,
        messageId: event.payload.messageId,
      });
      return yield* new ProviderTurnDeliveryError({
        certainty: "not_sent",
        retryable: false,
        detail: "The queued turn's thread no longer exists.",
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

    const inputLengthIssue = getProviderTurnInputLengthIssue(message.text);
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
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
    }).pipe(Effect.forkScoped);

    yield* maybeRequestThreadTitleForFirstTurn({
      threadId: event.payload.threadId,
      messageId: message.id,
      titleSourceText:
        event.payload.titleSourceText !== undefined ? event.payload.titleSourceText : message.text,
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
      threadId: event.payload.threadId,
      ...(event.commandId !== null ? { deliveryId: event.commandId } : {}),
      messageText: message.text,
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
    yield* providerService.interruptTurn({
      threadId: event.payload.threadId,
      ...(activeTurnId !== undefined ? { turnId: activeTurnId } : {}),
    });
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
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
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
      })
      .pipe(
        Effect.catchCause((cause) =>
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
    yield* stopThreadSession({
      threadId: event.payload.threadId,
      createdAt: event.payload.archivedAt,
    });
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

    const sessionContext = yield* resolveThreadSessionStartContext(binding.threadId);
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

    yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor could not stop Claude session for MCP apply", {
          threadId: binding.threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

    const restartedSession = yield* providerService.startSession(binding.threadId, {
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
    });

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

        const codexProviderOptions = toCodexProviderStartOptions({
          binaryPath: input.binaryPath,
          homePath: input.homePath,
        });
        const bindings =
          projectScopeProjectId !== null
            ? yield* providerSessionDirectory.listBindingsByProject(projectScopeProjectId)
            : yield* providerSessionDirectory.listBindings();
        const createdAt = new Date().toISOString();
        const effectiveConfigCache = new Map<ProjectId, StoredEffectiveMcpConfig>();
        const codexGroups = new Map<
          string,
          {
            readonly projectId: ProjectId;
            readonly providerOptions?: ProviderStartOptions;
            count: number;
          }
        >();
        let codexReloaded = 0;
        let claudeRestarted = 0;
        let skipped = 0;

        const readEffectiveConfigForProject = (projectId: ProjectId) => {
          const cached = effectiveConfigCache.get(projectId);
          if (cached) {
            return Effect.succeed(cached);
          }
          return projectMcpConfigService.readEffectiveStoredConfig(projectId).pipe(
            Effect.tap((resolved) =>
              Effect.sync(() => {
                effectiveConfigCache.set(projectId, resolved);
              }),
            ),
          );
        };

        for (const binding of bindings) {
          if (
            binding.status === "stopped" ||
            binding.projectId === undefined ||
            binding.projectId === null
          ) {
            skipped += 1;
            continue;
          }

          const effectiveConfig = yield* readEffectiveConfigForProject(binding.projectId);
          if (binding.mcpEffectiveConfigVersion === effectiveConfig.effectiveVersion) {
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
            const groupKey = `${binding.projectId}\u0000${getProviderEnvironmentKey("codex", providerOptions)}`;
            const existingGroup = codexGroups.get(groupKey);
            if (existingGroup) {
              existingGroup.count += 1;
            } else {
              codexGroups.set(groupKey, {
                projectId: binding.projectId,
                ...(providerOptions !== undefined ? { providerOptions } : {}),
                count: 1,
              });
            }
            continue;
          }

          if (binding.provider === "claudeAgent") {
            const restarted = yield* restartClaudeSessionForMcpApply(binding, createdAt);
            if (restarted) {
              claudeRestarted += 1;
            } else {
              skipped += 1;
            }
            continue;
          }

          skipped += 1;
        }

        for (const group of codexGroups.values()) {
          yield* providerService.reloadMcpConfigForProject({
            provider: "codex",
            projectId: group.projectId,
            ...(group.providerOptions !== undefined
              ? { providerOptions: group.providerOptions }
              : {}),
          });
          codexReloaded += group.count;
        }

        const responseProjectId = projectScopeProjectId ?? input.projectId;
        const responseConfig =
          responseProjectId !== undefined
            ? yield* projectMcpConfigService.readEffectiveStoredConfig(responseProjectId)
            : undefined;

        return {
          scope: input.scope,
          ...(responseProjectId !== undefined ? { projectId: responseProjectId } : {}),
          codexReloaded,
          claudeRestarted,
          skipped,
          ...(responseConfig ? { configVersion: responseConfig.effectiveVersion } : {}),
        } satisfies McpApplyToLiveSessionsResult;
      });

  const processDomainEvent = (event: ProviderIntentEvent) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({
        "orchestration.event_type": event.type,
      });
      switch (event.type) {
        case "thread.title-regeneration-started":
          yield* titleRegenerationWorker.enqueue(event);
          break;
        case "thread.runtime-mode-set": {
          const thread = yield* resolveThread(event.payload.threadId);
          if (!thread?.session || thread.session.status === "stopped") {
            return;
          }
          yield* ensureSessionForThread(event.payload.threadId, event.occurredAt);
          break;
        }
        case "thread.meta-updated": {
          const thread = yield* resolveThread(event.payload.threadId);
          if (!thread?.session || thread.session.status === "stopped") {
            return;
          }
          const currentProvider = providerFromSessionName(thread.session.providerName);
          const selectedProvider = event.payload.modelSelection?.model
            ? inferProviderForModel(event.payload.modelSelection.model)
            : undefined;
          const preferredInstanceId =
            selectedProvider !== undefined && selectedProvider === currentProvider
              ? event.payload.modelSelection?.instanceId
              : undefined;
          yield* ensureSessionForThread(
            event.payload.threadId,
            event.occurredAt,
            preferredInstanceId !== undefined ? { preferredInstanceId } : undefined,
          );
          break;
        }
        case "thread.deleted":
          threadProviderOptions.delete(event.payload.threadId);
          threadModelOptions.delete(event.payload.threadId);
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
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: ProviderCommandReactorShape["start"] = Effect.gen(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.runtime-mode-set" &&
          event.type !== "thread.meta-updated" &&
          event.type !== "thread.title-regeneration-started" &&
          event.type !== "thread.deleted" &&
          event.type !== "thread.turn-interrupt-requested" &&
          event.type !== "thread.approval-response-requested" &&
          event.type !== "thread.user-input-response-requested" &&
          event.type !== "thread.session-stop-requested" &&
          event.type !== "thread.archived"
        ) {
          return Effect.void;
        }

        return worker.enqueue(event);
      }),
    );

    const readModel = yield* orchestrationEngine.getReadModel();
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
    processTurnStartRequested(event).pipe(
      Effect.tap(() =>
        increment(orchestrationEventsProcessedTotal, {
          eventType: event.type,
        }),
      ),
      Effect.mapError((error) => {
        if (Schema.is(ProviderTurnDeliveryError)(error)) return error;
        const definitelyNotSent =
          Schema.is(ProviderValidationError)(error) ||
          Schema.is(ProviderUnsupportedError)(error) ||
          Schema.is(ProviderAdapterValidationError)(error);
        const detail = definitelyNotSent
          ? error instanceof Error
            ? error.message
            : "The provider rejected the turn before it was sent."
          : "The provider delivery outcome is unknown. Recheck provider history before retrying.";
        return new ProviderTurnDeliveryError({
          certainty: definitelyNotSent ? "not_sent" : "unknown",
          retryable: false,
          detail,
          cause: error,
        });
      }),
    );

  return {
    start,
    drain: Effect.all([worker.drain, titleRegenerationWorker.drain], {
      discard: true,
      concurrency: 2,
    }),
    deliverTurnStart,
    recordTurnStartFailure,
    applyMcpConfigToLiveSessions,
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
