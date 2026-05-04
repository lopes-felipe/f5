import {
  type ChatAttachment,
  CommandId,
  DEFAULT_NEW_THREAD_TITLE,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  EventId,
  type McpApplyToLiveSessionsResult,
  type OrchestrationEvent,
  ProjectId,
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
} from "@t3tools/contracts";
import { Cache, Cause, Duration, Effect, Layer, Option, Schema, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { estimateMessageContextCharacters, inferProviderForModel } from "@t3tools/shared/model";
import {
  areProviderModelOptionsEqual,
  areProviderStartOptionsEqual,
  getProviderEnvironmentKey,
  getProviderSessionRestartOptions,
  normalizeProviderStartOptions,
} from "@t3tools/shared/providerOptions";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import { ProviderAdapterRequestError, ProviderServiceError } from "../../provider/Errors.ts";
import { resolveBestEffortGeneratedTitle } from "../../threadTitle.ts";
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

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.meta-updated"
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPersistedProviderOptions(runtimePayload: unknown): ProviderStartOptions | undefined {
  if (!isRecord(runtimePayload)) {
    return undefined;
  }

  const raw = "providerOptions" in runtimePayload ? runtimePayload.providerOptions : undefined;
  return isRecord(raw) ? (raw as ProviderStartOptions) : undefined;
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

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
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

function buildThreadInstructionContext(input: {
  readonly thread: OrchestrationThread;
  readonly projectTitle?: string;
  readonly projectMemories: ReadonlyArray<ProjectMemory>;
  readonly cwd?: string;
  readonly turnCount: number;
}): Partial<SharedInstructionInput> {
  return {
    ...(input.projectTitle ? { projectTitle: input.projectTitle } : {}),
    ...(input.projectMemories.length > 0 ? { projectMemories: input.projectMemories } : {}),
    threadTitle: input.thread.title,
    turnCount: input.turnCount,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    runtimeMode: input.thread.runtimeMode,
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

function buildGeneratedWorktreeBranchName(raw: string): string {
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
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const projectMcpConfigService = yield* ProjectMcpConfigService;
  const git = yield* GitCore;
  const textGeneration = yield* TextGeneration;
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadProviderOptions = new Map<string, ProviderStartOptions>();
  const threadModelOptions = new Map<string, ProviderModelOptions>();

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
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
        setThreadSession({
          threadId: input.thread.id,
          session: {
            threadId: input.thread.id,
            status: mapProviderSessionStatusToOrchestrationStatus(input.session.status),
            providerName: input.session.provider,
            runtimeMode: input.desiredRuntimeMode,
            activeTurnId: null,
            lastError: input.session.lastError ?? null,
            estimatedContextTokens:
              instructionTokens + threadMessageContextCharacters(input.thread),
            modelContextWindowTokens: resolveModelContextWindowTokens({
              provider: input.session.provider,
              model: input.session.model ?? input.desiredModel ?? input.thread.model,
            }),
            tokenUsageSource: "estimated",
            updatedAt: input.session.updatedAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const ensureSessionForThread = Effect.fnUntraced(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly provider?: ProviderKind;
      readonly model?: string;
      readonly modelOptions?: ProviderModelOptions;
      readonly providerOptions?: ProviderStartOptions;
    },
  ) {
    return yield* Effect.gen(function* () {
      const sessionContext = yield* resolveThreadSessionStartContext(threadId);
      const { thread, instructionContext, persistedBinding, desiredRuntimeMode } = sessionContext;
      const currentProvider: ProviderKind | undefined =
        thread.session?.providerName === "codex" || thread.session?.providerName === "claudeAgent"
          ? thread.session.providerName
          : undefined;
      const preferredProvider: ProviderKind | undefined = options?.provider ?? currentProvider;
      const desiredModel = options?.model ?? sessionContext.desiredModel;
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
            ...instructionContext,
            ...(desiredModel ? { model: desiredModel } : {}),
            ...(options?.modelOptions !== undefined ? { modelOptions: options.modelOptions } : {}),
            ...(options?.providerOptions !== undefined
              ? { providerOptions: options.providerOptions }
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
          desiredModel,
          instructionContext,
        });

      const activeSession = yield* resolveActiveSession(threadId);
      const existingSessionThreadId =
        thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
      if (existingSessionThreadId) {
        const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
        const providerChanged =
          options?.provider !== undefined && options.provider !== currentProvider;
        const sessionModelSwitch =
          currentProvider === undefined
            ? "in-session"
            : (yield* providerService.getCapabilities(currentProvider)).sessionModelSwitch;
        const modelChanged = options?.model !== undefined && options.model !== activeSession?.model;
        const shouldRestartForModelChange =
          modelChanged &&
          (sessionModelSwitch === "restart-session" || currentProvider === "claudeAgent");
        const previousModelOptions = threadModelOptions.get(threadId);
        const shouldRestartForModelOptionsChange =
          currentProvider === "claudeAgent" &&
          options?.modelOptions !== undefined &&
          !areProviderModelOptionsEqual(previousModelOptions, options.modelOptions);
        const previousProviderOptions =
          currentProvider !== undefined
            ? getProviderSessionRestartOptions(currentProvider, threadProviderOptions.get(threadId))
            : undefined;
        const shouldRestartForProviderOptionsChange =
          currentProvider !== undefined &&
          options?.providerOptions !== undefined &&
          !areProviderStartOptionsEqual(
            previousProviderOptions,
            getProviderSessionRestartOptions(currentProvider, options.providerOptions),
          );
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

        if (
          !runtimeModeChanged &&
          !providerChanged &&
          !shouldRestartForModelChange &&
          !shouldRestartForModelOptionsChange &&
          !shouldRestartForProviderOptionsChange &&
          !shouldRestartForProjectMcpChange &&
          !shouldRestartForCwdChange
        ) {
          if (activeSession) {
            yield* bindSessionToThread(activeSession);
          }
          yield* Effect.annotateCurrentSpan({
            "provider.session_decision": "reuse",
          });
          return existingSessionThreadId;
        }

        const resumeCursor =
          providerChanged ||
          shouldRestartForModelChange ||
          shouldRestartForModelOptionsChange ||
          shouldRestartForProviderOptionsChange ||
          shouldRestartForProjectMcpChange ||
          shouldRestartForCwdChange
            ? undefined
            : (activeSession?.resumeCursor ?? undefined);
        yield* Effect.annotateCurrentSpan({
          "provider.session_decision": "restart",
          "provider.has_resume_cursor": resumeCursor !== undefined,
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
          modelChanged,
          shouldRestartForModelChange,
          shouldRestartForModelOptionsChange,
          shouldRestartForProviderOptionsChange,
          shouldRestartForProjectMcpChange,
          shouldRestartForCwdChange,
          currentSessionCwd,
          desiredSessionCwd,
          persistedMcpEffectiveConfigVersion: persistedBinding?.mcpEffectiveConfigVersion ?? null,
          currentProjectMcpVersion,
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
        return restartedSession.threadId;
      }

      const resumeCursorForStoppedSession =
        thread.session?.status === "stopped" &&
        persistedBinding?.resumeCursor !== undefined &&
        persistedBinding.resumeCursor !== null &&
        (options?.provider === undefined || options.provider === persistedBinding.provider)
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
      return startedSession.threadId;
    }).pipe(Effect.withSpan("provider.ensure-session"));
  });

  const sendTurnForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly provider?: ProviderKind;
    readonly model?: string;
    readonly modelOptions?: ProviderModelOptions;
    readonly providerOptions?: ProviderStartOptions;
    readonly interactionMode?: "default" | "plan";
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.modelOptions !== undefined ? { modelOptions: input.modelOptions } : {}),
      ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
    });
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    if (input.providerOptions !== undefined) {
      const normalizedProviderOptions = activeSession?.provider
        ? normalizeProviderStartOptions(activeSession.provider, input.providerOptions)
        : input.providerOptions;
      if (normalizedProviderOptions) {
        threadProviderOptions.set(input.threadId, normalizedProviderOptions);
      } else {
        threadProviderOptions.delete(input.threadId);
      }
    }
    if (input.modelOptions !== undefined) {
      threadModelOptions.set(input.threadId, input.modelOptions);
    }
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
    });
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : (yield* providerService.getCapabilities(activeSession.provider)).sessionModelSwitch;
    const modelForTurn = sessionModelSwitch === "unsupported" ? activeSession?.model : input.model;
    const recoveryProvider =
      activeSession?.provider ??
      (thread.session?.providerName === "codex" || thread.session?.providerName === "claudeAgent"
        ? thread.session.providerName
        : undefined) ??
      input.provider ??
      inferProviderForModel(thread.model, "codex");

    yield* providerSessionDirectory.upsert({
      threadId: input.threadId,
      provider: recoveryProvider,
      runtimeMode: thread.runtimeMode,
      runtimePayload: {
        instructionContext,
      },
    });

    yield* providerService.sendTurn({
      threadId: input.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { model: modelForTurn } : {}),
      ...(input.modelOptions !== undefined ? { modelOptions: input.modelOptions } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
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
    yield* textGeneration
      .generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
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

          const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
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

  const maybeGenerateThreadTitleForFirstTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: string;
    readonly titleSourceText: string;
    readonly titleGenerationModel?: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const currentThread = readModel.threads.find(
      (entry) => entry.id === input.threadId && entry.deletedAt === null,
    );
    if (!currentThread || !hasEligibleFirstUserMessage(currentThread, input.messageId)) {
      return;
    }

    const cwd = resolveThreadWorkspaceCwd({
      thread: currentThread,
      projects: readModel.projects,
    });
    const attachments = input.attachments ?? [];
    const applyTitleIfEligible = (title: string) =>
      Effect.gen(function* () {
        const nextThread = yield* resolveActiveThread(input.threadId);
        if (!nextThread || !hasEligibleFirstUserMessage(nextThread, input.messageId)) {
          return;
        }

        if (title === DEFAULT_NEW_THREAD_TITLE) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: serverCommandId("thread-title-generate"),
          threadId: input.threadId,
          title,
        });
      });

    const title = yield* resolveBestEffortGeneratedTitle({
      cwd,
      titleSourceText: input.titleSourceText,
      attachments,
      titleGenerationModel: input.titleGenerationModel,
      defaultTitle: DEFAULT_NEW_THREAD_TITLE,
      textGeneration,
      logPrefix: "provider command reactor",
      logContext: {
        threadId: input.threadId,
      },
    });
    yield* applyTitleIfEligible(title);
  });

  const processTurnStartRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
      threadId: event.payload.threadId,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      messageId: message.id,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
    }).pipe(Effect.forkScoped);

    yield* maybeGenerateThreadTitleForFirstTurn({
      threadId: event.payload.threadId,
      messageId: message.id,
      titleSourceText:
        event.payload.titleSourceText !== undefined ? event.payload.titleSourceText : message.text,
      ...(event.payload.titleGenerationModel !== undefined
        ? { titleGenerationModel: event.payload.titleGenerationModel }
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

    yield* sendTurnForThread({
      threadId: event.payload.threadId,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.provider !== undefined ? { provider: event.payload.provider } : {}),
      ...(event.payload.model !== undefined ? { model: event.payload.model } : {}),
      ...(event.payload.modelOptions !== undefined
        ? { modelOptions: event.payload.modelOptions }
        : {}),
      ...(event.payload.providerOptions !== undefined
        ? { providerOptions: event.payload.providerOptions }
        : {}),
      interactionMode: event.payload.interactionMode,
      createdAt: event.payload.createdAt,
    });
  });

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

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* providerService.interruptTurn({ threadId: event.payload.threadId });
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

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
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
    const providerOptions =
      threadProviderOptions.get(binding.threadId) ??
      readPersistedProviderOptions(binding.runtimePayload);
    const modelOptions = threadModelOptions.get(binding.threadId);

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
      ...sessionContext.instructionContext,
      ...(sessionContext.desiredModel ? { model: sessionContext.desiredModel } : {}),
      ...(modelOptions !== undefined ? { modelOptions } : {}),
      ...(providerOptions !== undefined ? { providerOptions } : {}),
      runtimeMode: sessionContext.desiredRuntimeMode,
    });

    yield* bindSessionToThreadWithContext({
      thread: sessionContext.thread,
      session: restartedSession,
      createdAt,
      desiredRuntimeMode: sessionContext.desiredRuntimeMode,
      desiredModel: sessionContext.desiredModel,
      instructionContext: sessionContext.instructionContext,
    });

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
        case "thread.runtime-mode-set": {
          const thread = yield* resolveThread(event.payload.threadId);
          if (!thread?.session || thread.session.status === "stopped") {
            return;
          }
          const cachedProviderOptions = threadProviderOptions.get(event.payload.threadId);
          const cachedModelOptions = threadModelOptions.get(event.payload.threadId);
          yield* ensureSessionForThread(event.payload.threadId, event.occurredAt, {
            ...(cachedProviderOptions !== undefined
              ? { providerOptions: cachedProviderOptions }
              : {}),
            ...(cachedModelOptions !== undefined ? { modelOptions: cachedModelOptions } : {}),
          });
          break;
        }
        case "thread.meta-updated": {
          const thread = yield* resolveThread(event.payload.threadId);
          if (!thread?.session || thread.session.status === "stopped") {
            return;
          }
          const cachedProviderOptions = threadProviderOptions.get(event.payload.threadId);
          const cachedModelOptions = threadModelOptions.get(event.payload.threadId);
          yield* ensureSessionForThread(event.payload.threadId, event.occurredAt, {
            ...(cachedProviderOptions !== undefined
              ? { providerOptions: cachedProviderOptions }
              : {}),
            ...(cachedModelOptions !== undefined ? { modelOptions: cachedModelOptions } : {}),
          });
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

  const start: ProviderCommandReactorShape["start"] = Effect.forkScoped(
    Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
      if (
        event.type !== "thread.runtime-mode-set" &&
        event.type !== "thread.meta-updated" &&
        event.type !== "thread.deleted" &&
        event.type !== "thread.turn-start-requested" &&
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
  ).pipe(Effect.asVoid);

  return {
    start,
    drain: worker.drain,
    applyMcpConfigToLiveSessions,
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
