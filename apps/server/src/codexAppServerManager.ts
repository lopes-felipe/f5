import { timeOrderedUuid } from "@t3tools/shared/ids";
import { CODEX_ONE_OFF_PROMPT_TIMEOUT_MS } from "./provider/oneOffPromptTimeouts.ts";
import { stringifyWithinBytes } from "@t3tools/shared/boundedJson";
import { findMcpAppToolPolicy } from "@t3tools/shared/mcpApp";
import { raceWithAbort } from "@t3tools/shared/abortSignal";
import {
  codexMessagePresentation,
  presentCodexMessageItem,
} from "@t3tools/shared/codexMessagePresentation";
import { buildCodexResourceReadParams } from "./codex/codexConfigurationRequests";
import { CODEX_NATIVE_ASIDE_COMMAND } from "@t3tools/shared/slashCommands";
import { Utf8Lines } from "@t3tools/shared/utf8Lines";
import { CODEX_MAX_INCOMING_MESSAGE_BYTES, ProviderLineReader } from "./codex/lineReader.ts";
import {
  validBrowserResumeArguments,
  codexBrowserResumeCursor,
} from "./provider/codexBrowserResume";
import { waitForControl } from "./computer/CodexControlHandoff";
import { readBoundedPages } from "./codex/readBoundedPages.ts";
import {
  mergeCodexMcpStartupStatuses,
  decodeCodexMcpServerStatus,
} from "./codex/codexMcpServerStatus.ts";
import type { CodexControlMcpServerStatus } from "./codex/CodexControlClient.ts";
import {
  supportsCodexNativeOperations,
  supportsCodexRelease5,
  supportsCodexRelease6,
} from "@t3tools/shared/providerRuntimeCapabilities";
import { normalizeProviderRuntimeInfo } from "@t3tools/shared/runtimeInfo";
import type {
  NativeOperationInput,
  NativeOperationInspectInput,
  NativeOperationRecord,
  ReadOnlyEnforcement,
} from "@t3tools/contracts";
import { READ_ONLY_WORKFLOW_ENVIRONMENT } from "./provider/readOnlyWorkflowShell.ts";
import { makeReadOnlyGitGuard } from "./provider/readOnlyGitConfig.ts";
import { codexApprovalShellCommand } from "./provider/codex/CodexProtocolHelpers.ts";
import { appendGitConfigPairs } from "./git/gitConfigEnvironment.ts";
import { readCodexCommandApprovalOffer } from "./codex/commandApprovalOffer.ts";
import { describeMcpElicitation, mcpElicitationResponse } from "./codex/mcpElicitation.ts";
import { codexMcpConsentToolName } from "./mcp/hub/providerHubServers.ts";
import { buildElicitationDescriptor } from "@t3tools/shared/elicitationForm";
import {
  ElicitationDeliveryUncertainError,
  ElicitationRegistry,
  type ElicitationTerminalReceipt,
} from "./provider/elicitationRegistry.ts";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { appendStderrTail, stderrExcerpt } from "./codex/stderrDiagnostics.ts";
import * as OS from "node:os";

export { CODEX_MAX_INCOMING_MESSAGE_BYTES };

import {
  ApprovalRequestId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_RUNTIME_MODE,
  type ElicitationAction,
  EventId,
  ProviderItemId,
  ProviderRequestKind,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  RuntimeMode,
  SubagentActivityKind,
} from "@t3tools/contracts";
import { codexServerRequestDisposition } from "@t3tools/shared/codexProtocolManifest";
import { configureCodexCyberAccess } from "@t3tools/shared/model";
import { readCodexModelPages } from "./codex/readCodexModelPages.ts";
import { readCodexReportedModelCapabilities } from "./provider/codexModelCatalog.ts";
import { normalizeCodexThreadItemType } from "./provider/codexItemPresentation.ts";
import { Effect, Schema, ServiceMap } from "effect";

import { formatCodexUnsupportedModelError } from "./provider/codexErrors.ts";
import {
  buildInstructionProfile,
  CODEX_RESUMED_CONTEXT_KEY,
  INSTRUCTION_PROFILE_CONFIG_KEY,
} from "./provider/sharedAssistantContract";
import {
  lookupModelContextWindowTokens,
  readCodexModelContextWindowCatalog,
} from "./provider/modelContextWindowMetadata.ts";
import { buildCodexAppServerCommand } from "./provider/codexLaunchArgs.ts";
import { buildProviderChildProcessEnv } from "./providerProcessEnv";
import { withBrowserOpenThreadToken } from "./browser/BrowserOpenThreadToken";
import { resolveCodexCommand } from "./provider/codexExecutable.ts";
import {
  fingerprintSupportedSlashCommands,
  normalizeSupportedSlashCommands,
} from "./provider/supportedSlashCommands";
import {
  createJsonRpcStdinWriter,
  JsonRpcDeliveryError,
  jsonRpcWriteLane,
  type JsonRpcWriteOptions,
} from "./codex/JsonRpcStdinWriter.ts";
import { resolveCodexHome } from "./os-jank.ts";
import {
  codexProjectLayerFolders,
  codexProjectRulesConflictMessage,
  codexReadOnlyStageConfigArgs,
  codexReadOnlySourceHome,
  findCodexRulesInFolders,
  materializeCodexReadOnlyHome,
} from "./codex/CodexReadOnlyHome.ts";
import { resolveInvocation } from "./spawn/resolveCommand.ts";

import {
  buildCodexSampleParams,
  buildCodexReadMarkParams,
  buildCodexMemoryReadParams,
  buildCodexUsageReadParams,
  buildCodexGoalPauseParams,
  buildCodexGoalClearParams,
  CodexJsonRpcError,
  isUnknownMethodError,
  CODEX_JSON_RPC_TIMEOUT_MS,
  CODEX_EXIT_STATUS_GRACE_MS,
  CODEX_STDOUT_ENDED_MESSAGE,
  CODEX_THREAD_OPEN_TIMEOUT_MS,
  CODEX_ELICITATION_OPENED_METHOD,
  CODEX_ELICITATION_SETTLED_METHOD,
  codexRequestTimeoutMs,
  CODEX_ONE_OFF_THREAD_PREFIX,
  CODEX_ONE_OFF_WORKER_IDLE_MS,
  CODEX_ONE_OFF_WORKER_MAX_PROMPTS,
  CODEX_SKILLS_REFRESH_TIMEOUT_MS,
  CODEX_INITIAL_SKILLS_RETRY_DELAY_MS,
  CODEX_NATIVE_REQUEST_CORRELATION_CAPACITY,
  EMPTY_SUPPORTED_COMMANDS_FINGERPRINT,
  asObject,
  asString,
  readNotificationProviderThreadId,
  readCodexPermissionProfile,
  codexSessionAllowedResponse,
  codexApprovalResponse,
  legacyCodexApprovalDecision,
  readEnabledSkillsFromSkillsListResponse,
  describeDroppedSkill,
  readCodexAccountSnapshot,
  mapCodexRuntimeMode,
  CODEX_READ_ONLY_TURN_SANDBOX_POLICY,
  type CodexReadOnlyMode,
  type CodexReadOnlyRequirements,
  codexReadOnlyStagePolicy,
  codexReadOnlyModeEnforcement,
  codexReadOnlyThreadPolicyViolation,
  readCodexRequirements,
  codexReadOnlyModeUnderRequirements,
  CODEX_READ_ONLY_REFUSED_METHOD,
  codexReadOnlyPolicyDecision,
  CODEX_THREAD_CONFIG,
  buildCodexThreadOpenRequestParams,
  isCodexLegacyHistoryRevertError,
  selectCodexRewindStrategy,
  buildCodexThreadRevertParams,
  buildCodexThreadForkParams,
  resolveCodexModelForAccount,
  killChildTree,
  normalizeCodexModelSlug,
  resolveCodexServiceTier,
  buildCodexTurnStartParams,
  buildCodexTurnSteerParams,
  buildCodexInitializeParams,
  buildCodexInstructionContext,
  isSyntheticOneOffThreadId,
  codexOneOffPoolKey,
  toCodexUserInputAnswers,
  classifyCodexStderrLine,
  isRecoverableThreadResumeError,
  isArchivedThreadResumeError,
  normalizeProviderThreadId,
  readCodexProviderOptions,
  assertSupportedCodexCliVersion,
  readResumeCursorThreadId,
  readResumeThreadId,
  toTurnId,
  toProviderItemId,
  type PendingRequest,
  type PendingApprovalRequest,
  type NativeRequestCorrelation,
  type CodexSessionContext,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcNotification,
  type CodexAppServerSendTurnInput,
  type CodexAppServerStartSessionInput,
  type CodexThreadTurnSnapshot,
  type CodexThreadSnapshot,
  type CodexOneOffWorker,
} from "./provider/codex/CodexProtocolHelpers.ts";

export {
  buildCodexSampleParams,
  buildCodexReadMarkParams,
  buildCodexMemoryReadParams,
  buildCodexUsageReadParams,
  buildCodexGoalPauseParams,
  buildCodexGoalClearParams,
  CodexJsonRpcError,
  isUnknownMethodError,
  type CodexAppServerSendTurnInput,
  type CodexAppServerStartSessionInput,
  type CodexThreadTurnSnapshot,
  type CodexThreadSnapshot,
  CODEX_EXIT_STATUS_GRACE_MS,
  CODEX_STDOUT_ENDED_MESSAGE,
  CODEX_THREAD_OPEN_TIMEOUT_MS,
  CODEX_ELICITATION_OPENED_METHOD,
  CODEX_ELICITATION_SETTLED_METHOD,
  codexRequestTimeoutMs,
  CODEX_ONE_OFF_WORKER_IDLE_MS,
  codexSessionAllowedResponse,
  legacyCodexApprovalDecision,
  readEnabledSkillsFromSkillsListResponse,
  readCodexAccountSnapshot,
  mapCodexRuntimeMode,
  CODEX_READ_ONLY_TURN_SANDBOX_POLICY,
  type CodexReadOnlyMode,
  type CodexReadOnlyRequirements,
  codexReadOnlyStagePolicy,
  codexReadOnlyModeEnforcement,
  codexReadOnlyThreadPolicyViolation,
  readCodexRequirements,
  codexReadOnlyModeUnderRequirements,
  CODEX_READ_ONLY_REFUSED_METHOD,
  codexReadOnlyPolicyDecision,
  CODEX_THREAD_CONFIG,
  buildCodexThreadOpenRequestParams,
  isCodexLegacyHistoryRevertError,
  selectCodexRewindStrategy,
  buildCodexThreadRevertParams,
  buildCodexThreadForkParams,
  resolveCodexModelForAccount,
  killChildTree,
  normalizeCodexModelSlug,
  resolveCodexServiceTier,
  buildCodexTurnStartParams,
  buildCodexTurnSteerParams,
  buildCodexInitializeParams,
  isSyntheticOneOffThreadId,
  codexOneOffPoolKey,
  classifyCodexStderrLine,
  isRecoverableThreadResumeError,
  isArchivedThreadResumeError,
  assertSupportedCodexCliVersion,
  readResumeCursorThreadId,
};

export interface CodexAppServerManagerEvents {
  event: [event: ProviderEvent];
}

export class CodexAppServerManager extends EventEmitter<CodexAppServerManagerEvents> {
  private readonly sessions = new Map<ThreadId, CodexSessionContext>();
  private shutdownDeadline: number | undefined;
  private readonly sourceDrains = new Map<Promise<void>, () => void>();
  private readonly sessionStartLocks = new Map<ThreadId, Promise<void>>();
  private readonly oneOffWorkers = new Map<ThreadId, CodexOneOffWorker>();

  private runPromise: (effect: Effect.Effect<unknown, never>) => Promise<unknown>;
  /**
   * Set by the adapter: true when F5's MCP hub will ask before this tool call, so
   * Codex's own consent prompt for it is accepted without showing.
   */
  mcpHubAsksBeforeCall?: (threadId: ThreadId, serverName: string, toolName: string) => boolean;
  constructor(services?: ServiceMap.ServiceMap<never>) {
    super();
    this.runPromise = services ? Effect.runPromiseWith(services) : Effect.runPromise;
  }

  async startSession(
    input: CodexAppServerStartSessionInput,
    signal?: AbortSignal,
  ): Promise<ProviderSession> {
    const previous = this.sessionStartLocks.get(input.threadId) ?? Promise.resolve();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.catch(() => undefined).then(() => barrier);
    this.sessionStartLocks.set(input.threadId, current);
    try {
      await raceWithAbort(
        previous.catch(() => undefined),
        signal,
      );
      signal?.throwIfAborted();
      if (this.sessions.has(input.threadId)) {
        this.stopSession(input.threadId);
      }
      return await this.startSessionUnlocked(input, signal);
    } finally {
      release();
      void current.finally(() => {
        if (this.sessionStartLocks.get(input.threadId) === current)
          this.sessionStartLocks.delete(input.threadId);
      });
    }
  }

  private async startSessionUnlocked(
    input: CodexAppServerStartSessionInput,
    signal?: AbortSignal,
  ): Promise<ProviderSession> {
    const threadId = input.threadId;
    const now = new Date().toISOString();
    let removeStartupAbort: (() => void) | undefined;
    let context: CodexSessionContext | undefined;
    const resumeThreadId = readResumeThreadId(input);
    const requestedModel = normalizeCodexModelSlug(input.model);
    const fallbackModel =
      requestedModel ?? (resumeThreadId ? undefined : DEFAULT_MODEL_BY_PROVIDER.codex);

    try {
      const resolvedCwd = input.cwd ?? process.cwd();

      const session: ProviderSession = {
        provider: "codex",
        status: "connecting",
        runtimeMode: input.runtimeMode,
        ...(fallbackModel ? { model: fallbackModel } : {}),
        cwd: resolvedCwd,
        threadId,
        createdAt: now,
        updatedAt: now,
      };

      const codexOptions = readCodexProviderOptions(input);
      const codexBinaryPath = resolveCodexCommand(codexOptions.binaryPath);
      const instanceHomePath = resolveCodexHome({ homePath: codexOptions.homePath });
      // A read-only stage runs in a home without the instance's `rules`: Codex runs commands an
      // allow rule matches outside its sandbox, without asking F5.
      const readOnlyHomePath =
        input.workflowExecutionProfile && input.readOnlyHomePath
          ? input.readOnlyHomePath
          : undefined;
      const readOnlySourceHome = readOnlyHomePath
        ? codexReadOnlySourceHome(instanceHomePath, input.processEnvironment ?? process.env)
        : undefined;
      if (readOnlyHomePath && readOnlySourceHome)
        await materializeCodexReadOnlyHome({
          sourceHome: readOnlySourceHome,
          readOnlyHome: readOnlyHomePath,
        });
      const codexHomePath = readOnlyHomePath ?? instanceHomePath;
      const processCwd = input.processCwd ?? resolvedCwd;
      const cliVersion = await this.assertSupportedCodexCliVersion({
        processEnvironment: input.processEnvironment ?? process.env,
        binaryPath: codexBinaryPath,
        cwd: processCwd,
        ...(signal ? { signal } : {}),
        ...(codexHomePath ? { homePath: codexHomePath } : {}),
      });
      // Commands F5 approves run unsandboxed in a policy-enforced stage.
      const unsandboxedReadOnly =
        input.workflowExecutionProfile !== undefined && input.readOnlyEnforcement === "policy";
      const baseChildEnvironment = buildProviderChildProcessEnv(
        input.processEnvironment ?? process.env,
        {
          ...input.mcpEnvironment,
          ...(codexHomePath ? { CODEX_HOME: codexHomePath } : {}),
          // Unsandboxed, `git status` would refresh the index and hold its lock.
          ...(unsandboxedReadOnly ? READ_ONLY_WORKFLOW_ENVIRONMENT : {}),
        },
      );
      // A repository's own Git helpers must not run for those commands (readOnlyGitConfig.ts).
      // Requirements can still send the stage to the sandbox, where nothing is approved.
      const readOnlyGitGuard = unsandboxedReadOnly
        ? await makeReadOnlyGitGuard(resolvedCwd, baseChildEnvironment)
        : undefined;
      const childEnvironment = withBrowserOpenThreadToken(
        readOnlyGitGuard
          ? appendGitConfigPairs({ ...baseChildEnvironment }, readOnlyGitGuard.pairs)
          : baseChildEnvironment,
        threadId,
      );
      const appServerCommand = buildCodexAppServerCommand({
        ...(codexOptions.modelProvider ? { modelProvider: codexOptions.modelProvider } : {}),
        ...(codexOptions.launchArgs ? { providerLaunchArgs: codexOptions.launchArgs } : {}),
        environment: childEnvironment,
        mcpServers: input.mcpServers ?? {},
        ...(input.mcpOAuthCallbackPort ? { mcpOAuthCallbackPort: input.mcpOAuthCallbackPort } : {}),
        ...(input.mcpOAuthCallbackUrl ? { mcpOAuthCallbackUrl: input.mcpOAuthCallbackUrl } : {}),
        ...(input.disablePlugins ? { disablePlugins: true } : {}),
        // File credentials and pinned project markers keep the home's sign-in and the project
        // rules guard exact (CodexReadOnlyHome.ts).
        ...(readOnlySourceHome
          ? {
              extraConfigArgs: await codexReadOnlyStageConfigArgs(
                readOnlySourceHome,
                childEnvironment,
              ),
            }
          : {}),
      });
      if (appServerCommand.dropped.length > 0) {
        await this.runPromise(
          Effect.logWarning("ignored reserved Codex launch arguments", {
            threadId,
            dropped: appServerCommand.dropped,
          }),
        );
      }
      const invocation = await resolveInvocation(
        codexBinaryPath,
        appServerCommand.argv,
        childEnvironment,
        {
          cwd: processCwd,
        },
      );
      signal?.throwIfAborted();
      const child = spawn(invocation.file, [...invocation.args], {
        cwd: processCwd,
        env: childEnvironment,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const output = new ProviderLineReader(child.stdout, CODEX_MAX_INCOMING_MESSAGE_BYTES);
      const writer = createJsonRpcStdinWriter({
        stdin: child.stdin,
        closedMessage: "Cannot write to codex app-server stdin.",
        onFailure: (cause) => {
          if (!context || context.phase === "closed" || context.phase === "draining") return;
          const error = cause instanceof Error ? cause : new Error(String(cause));
          context.beginDrain?.(error, "session/exited", error.message);
          if (!child.killed) killChildTree(child);
        },
      });

      context = {
        ...(input.browserResume ? { browserResume: input.browserResume } : {}),
        browserResumeRegistered: false,
        session,
        ...(input.mcpEventIdentity ? { mcpEventIdentity: input.mcpEventIdentity } : {}),
        account: {
          type: "unknown",
          planType: null,
          sparkEnabled: false,
        },
        child,
        output,
        writer,
        pending: new Map(),
        pendingApprovals: new Map(),
        pendingUserInputs: new Map(),
        elicitations: new ElicitationRegistry(),
        nativeRequestCorrelations: new Map(),
        instructionContext: buildCodexInstructionContext(input, resolvedCwd),
        modelContextWindowCatalog: new Map(),
        availableSkills: [],
        supportedCommandsFingerprint: EMPTY_SUPPORTED_COMMANDS_FINGERPRINT,
        skillsLoaded: false,
        skillRefreshInFlight: false,
        skillRefreshPending: false,
        initialSkillsRetryTimeout: undefined,
        initialSkillsRetryAttempted: false,
        resumedContextSent: false,
        cliVersion,
        protocolDecodeFailureCount: 0,
        nextRequestId: 1,
        stopping: false,
      };

      this.sessions.set(threadId, context);
      this.attachProcessListeners(context);
      if (signal) {
        const startedContext = context;
        const abort = () => {
          if (this.sessions.get(threadId) === startedContext) this.stopSession(threadId);
        };
        signal.addEventListener("abort", abort, { once: true });
        removeStartupAbort = () => signal.removeEventListener("abort", abort);
        if (signal.aborted) {
          abort();
          signal.throwIfAborted();
        }
      }

      this.emitLifecycleEvent(context, "session/connecting", "Starting codex app-server");

      await this.sendRequest(context, "initialize", buildCodexInitializeParams(cliVersion));

      await this.writeMessage(context, { method: "initialized" });
      const savedModelProvider = supportsCodexRelease6(cliVersion)
        ? asString(asObject(input.resumeCursor)?.f5ModelProvider)
        : undefined;
      try {
        const pages = await readCodexModelPages(
          (params) => this.sendRequest(context!, "model/list", params),
          savedModelProvider ? { modelProvider: savedModelProvider } : {},
        );
        const modelListResponse = { data: pages.entries };
        context.modelContextWindowCatalog = readCodexModelContextWindowCatalog(modelListResponse);
        context.reportedModelCapabilities = new Map([
          ...[...(input.effectiveModelCapabilities ?? [])].filter(
            ([, caps]) => caps.source === "reported",
          ),
          ...readCodexReportedModelCapabilities(modelListResponse),
        ]);
      } catch (error) {
        context.reportedModelCapabilities = new Map(
          [...(input.effectiveModelCapabilities ?? [])].filter(
            ([, caps]) => caps.source === "reported",
          ),
        );
        await Effect.logWarning("codex model/list did not expose context window metadata", {
          threadId,
          cause: error instanceof Error ? error.message : String(error),
        }).pipe(this.runPromise);
      }
      try {
        const accountReadResponse = await this.sendRequest(context, "account/read", {});
        context.account = readCodexAccountSnapshot(accountReadResponse);
      } catch (error) {
        await Effect.logWarning("codex account/read failed", {
          threadId,
          cause: error instanceof Error ? error.message : String(error),
        }).pipe(this.runPromise);
      }

      const normalizedModel = resolveCodexModelForAccount(fallbackModel, context.account);
      const launchServiceTier = supportsCodexRelease6(cliVersion)
        ? undefined
        : resolveCodexServiceTier(
            input.serviceTier,
            context.reportedModelCapabilities?.get(
              normalizedModel ?? DEFAULT_MODEL_BY_PROVIDER.codex,
            ),
          );
      context.workflowExecutionProfile = input.workflowExecutionProfile;
      if (input.workflowExecutionProfile)
        context.readOnlyMode = await this.readOnlyModeForRequirements(
          context,
          input.readOnlyEnforcement ?? "sandbox",
        );
      else delete context.readOnlyMode;
      if (readOnlyGitGuard) context.readOnlyGitGuard = readOnlyGitGuard;
      else delete context.readOnlyGitGuard;
      if (readOnlyHomePath) await this.assertNoCodexProjectRules(context, input.cwd ?? processCwd);
      const threadOpenParams = buildCodexThreadOpenRequestParams({
        cliVersion,
        browserResume: !!input.browserResume,
        ...(normalizedModel ? { model: normalizedModel } : {}),
        ...(typeof launchServiceTier === "string" ? { serviceTier: launchServiceTier } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(resumeThreadId ? { resumeThreadId } : {}),
        runtimeMode: input.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        ...(input.workflowExecutionProfile
          ? { workflowExecutionProfile: input.workflowExecutionProfile }
          : {}),
        ...(context.readOnlyMode ? { readOnlyMode: context.readOnlyMode } : {}),
      });
      this.emitLifecycleEvent(
        context,
        "session/threadOpenRequested",
        resumeThreadId
          ? `Attempting to resume thread ${resumeThreadId}.`
          : "Starting a new Codex thread.",
      );
      await Effect.logInfo("codex app-server opening thread", {
        threadId,
        requestedRuntimeMode: input.runtimeMode,
        requestedModel: normalizedModel ?? null,
        requestedCwd: resolvedCwd,
        resumeThreadId: resumeThreadId ?? null,
      }).pipe(this.runPromise);

      let threadOpenMethod: "thread/start" | "thread/resume" = "thread/start";
      let threadOpenResponse: unknown;
      if (resumeThreadId) {
        try {
          threadOpenMethod = "thread/resume";
          try {
            threadOpenResponse = await this.sendRequest(
              context,
              "thread/resume",
              threadOpenParams.resume!,
            );
          } catch (error) {
            if (!isArchivedThreadResumeError(error)) throw error;
            // An archived session keeps its history; unarchive it and resume again.
            await this.sendRequest(context, "thread/unarchive", { threadId: resumeThreadId });
            threadOpenResponse = await this.sendRequest(
              context,
              "thread/resume",
              threadOpenParams.resume!,
            );
          }
        } catch (error) {
          if (!isRecoverableThreadResumeError(error)) {
            this.emitErrorEvent(
              context,
              "session/threadResumeFailed",
              error instanceof Error ? error.message : "Codex thread resume failed.",
            );
            await Effect.logWarning("codex app-server thread resume failed", {
              threadId,
              requestedRuntimeMode: input.runtimeMode,
              resumeThreadId,
              recoverable: false,
              providerMessage: error instanceof CodexJsonRpcError ? error.rawMessage : undefined,
              cause: error instanceof Error ? error.message : String(error),
            }).pipe(this.runPromise);
            throw error;
          }

          threadOpenMethod = "thread/start";
          this.emitLifecycleEvent(
            context,
            "session/threadResumeFallback",
            `Could not resume thread ${resumeThreadId}; started a new thread instead.`,
          );
          await Effect.logWarning("codex app-server thread resume fell back to fresh start", {
            threadId,
            requestedRuntimeMode: input.runtimeMode,
            resumeThreadId,
            recoverable: true,
            cause: error instanceof Error ? error.message : String(error),
          }).pipe(this.runPromise);
          threadOpenResponse = await this.sendRequest(
            context,
            "thread/start",
            threadOpenParams.start,
          );
        }
      } else {
        threadOpenMethod = "thread/start";
        threadOpenResponse = await this.sendRequest(
          context,
          "thread/start",
          threadOpenParams.start,
        );
      }

      const providerThreadId = this.readThreadOpenProviderThreadId(
        threadOpenMethod,
        threadOpenResponse,
      );
      if (input.workflowExecutionProfile) {
        const violation = codexReadOnlyThreadPolicyViolation(
          threadOpenResponse,
          context.readOnlyMode,
        );
        if (violation) {
          await Effect.logError("codex read-only workflow session opened without its sandbox", {
            threadId,
            method: threadOpenMethod,
            violation,
          }).pipe(this.runPromise);
          throw new Error(`Codex did not apply the read-only sandbox (${violation}).`);
        }
      }
      context.browserResumeRegistered =
        threadOpenMethod === "thread/start"
          ? !!threadOpenParams.start.dynamicTools
          : asObject(input.resumeCursor)?.f5BrowserResume === true;
      const nativeModelProvider = supportsCodexRelease6(cliVersion)
        ? (asString(asObject(threadOpenResponse)?.modelProvider) ??
          asString(asObject(asObject(threadOpenResponse)?.thread)?.modelProvider))
        : undefined;
      if (nativeModelProvider && nativeModelProvider !== savedModelProvider) {
        // Older F5 cursors predate native-provider bindings. Refresh from the
        // resumed thread's provider, never from a newly selected default.
        context.modelContextWindowCatalog = new Map();
        context.reportedModelCapabilities = new Map(
          [...(input.effectiveModelCapabilities ?? [])].filter(
            ([, caps]) => caps.source === "reported",
          ),
        );
        try {
          const pages = await readCodexModelPages(
            (params) => this.sendRequest(context!, "model/list", params),
            { modelProvider: nativeModelProvider },
          );
          const response = { data: pages.entries };
          context.modelContextWindowCatalog = readCodexModelContextWindowCatalog(response);
          context.reportedModelCapabilities = readCodexReportedModelCapabilities(response);
        } catch (error) {
          await Effect.logWarning("Codex native-provider model catalog unavailable", {
            threadId,
            cause: error instanceof Error ? error.message : String(error),
          }).pipe(this.runPromise);
        }
      }

      this.updateSession(context, {
        status: "ready",
        resumeCursor: codexBrowserResumeCursor(
          {
            ...asObject(input.resumeCursor),
            ...(nativeModelProvider ? { f5ModelProvider: nativeModelProvider } : {}),
            ...(threadOpenMethod === "thread/start" && input.priorWorkSummary
              ? { f5ResumedContextPending: true }
              : {}),
          },
          providerThreadId,
          context.browserResumeRegistered,
        ),
      });
      if (supportsCodexRelease5(context.cliVersion) && context.readState === undefined) {
        void this.sendRequest(
          context,
          "thread/read",
          {
            threadId: providerThreadId,
            includeTurns: false,
          },
          2000,
        ).catch(() => undefined);
      }
      // Only skip replaying restored context when Codex actually reopened the
      // original provider thread. Fallback thread/start still needs that
      // context on the first follow-up turn.
      context.resumedContextSent =
        threadOpenMethod === "thread/resume" &&
        asObject(input.resumeCursor)?.f5ResumedContextPending !== true;
      const modelContextWindowTokens =
        normalizedModel !== null && normalizedModel !== undefined
          ? lookupModelContextWindowTokens({
              provider: "codex",
              model: normalizedModel,
              catalog: context.modelContextWindowCatalog,
            })
          : undefined;
      const rememberedChildren = asObject(input.resumeCursor)?.childThreadIds;
      context.childThreadIds = new Set(
        Array.isArray(rememberedChildren)
          ? rememberedChildren.filter((id): id is string => typeof id === "string").slice(-512)
          : [],
      );
      context.requestedRuntime = { model: input.model, serviceTier: input.serviceTier };
      context.deferredServiceTier = supportsCodexRelease6(cliVersion)
        ? input.serviceTier
        : undefined;
      context.serviceTierApplied = typeof launchServiceTier === "string";
      const nativeTier = asObject(threadOpenResponse)?.serviceTier;
      const openedServiceTier =
        supportsCodexRelease6(cliVersion) && (nativeTier === null || typeof nativeTier === "string")
          ? nativeTier
          : launchServiceTier;
      this.emitSessionConfigured(context, {
        ...(normalizedModel ? { model: normalizedModel } : {}),
        ...(modelContextWindowTokens !== undefined ? { modelContextWindowTokens } : {}),
        ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
        ...(openedServiceTier !== undefined ? { serviceTier: openedServiceTier } : {}),
        [INSTRUCTION_PROFILE_CONFIG_KEY]: buildInstructionProfile({ provider: "codex" }),
      });
      this.emitLifecycleEvent(
        context,
        "session/threadOpenResolved",
        `Codex ${threadOpenMethod} resolved.`,
      );
      await Effect.logInfo("codex app-server thread open resolved", {
        threadId,
        threadOpenMethod,
        requestedResumeThreadId: resumeThreadId ?? null,
        resolvedThreadId: providerThreadId,
        requestedRuntimeMode: input.runtimeMode,
      }).pipe(this.runPromise);
      this.emitLifecycleEvent(context, "session/ready", `Connected to thread ${providerThreadId}`);
      this.scheduleSkillsRefresh(context, { forceReload: false });
      return {
        ...context.session,
        // What the stage actually runs under, which ProviderService records and shows: Codex's
        // requirements can leave a requested `policy` stage only the sandbox.
        ...(context.readOnlyMode
          ? { readOnlyEnforcement: codexReadOnlyModeEnforcement(context.readOnlyMode) }
          : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start Codex session.";
      if (context && this.sessions.get(threadId) === context) {
        this.updateSession(context, {
          status: "error",
          lastError: message,
        });
        this.emitErrorEvent(context, "session/startFailed", message);
        this.stopSession(threadId);
      } else if (!context) {
        this.emitEvent({
          id: EventId.makeUnsafe(timeOrderedUuid()),
          kind: "error",
          provider: "codex",
          threadId,
          createdAt: new Date().toISOString(),
          method: "session/startFailed",
          message,
        });
      }
      throw new Error(message, { cause: error });
    } finally {
      removeStartupAbort?.();
    }
  }

  async sendTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);
    if (input.serviceTier === undefined && context.deferredServiceTier !== undefined)
      input = { ...input, serviceTier: context.deferredServiceTier };
    const providerThreadId = readResumeCursorThreadId(context.session.resumeCursor);
    if (!providerThreadId) throw new Error("Session is missing provider resume thread id.");
    const { serviceTier: _requestedTier, ...inputWithoutTier } = input;
    const turnInput =
      input.serviceTier === null && !context.serviceTierApplied ? inputWithoutTier : input;
    const cyberModel =
      resolveCodexModelForAccount(
        normalizeCodexModelSlug(input.model ?? context.session.model),
        context.account,
      ) ?? DEFAULT_MODEL_BY_PROVIDER.codex;
    const cyberCapabilities = cyberModel
      ? context.reportedModelCapabilities?.get(cyberModel)
      : undefined;
    let turnCapabilities = context.reportedModelCapabilities;
    if (
      cyberModel &&
      cyberCapabilities?.optionDescriptors?.some((option) => option.id === "cyberAccessProgram")
    ) {
      const config = asObject(
        await this.sendRequest(context, "config/read", { includeLayers: false }).catch(
          () => undefined,
        ),
      )?.config;
      const configuredCapabilities = new Map(context.reportedModelCapabilities);
      configuredCapabilities.set(
        cyberModel,
        configureCodexCyberAccess(cyberCapabilities, config, context.account.type),
      );
      turnCapabilities = configuredCapabilities;
    }
    const turnStartParams = buildCodexTurnStartParams(turnInput, {
      providerThreadId,
      model: context.session.model,
      account: context.account,
      instructionContext: context.instructionContext,
      resumedContextSent: context.resumedContextSent,
      reportedModelCapabilities: turnCapabilities,
      workflowExecutionProfile: context.workflowExecutionProfile,
      readOnlyMode: context.readOnlyMode,
    });
    if (input.audioFiles?.length && supportsCodexRelease6(context.cliVersion)) {
      const model = normalizeCodexModelSlug(turnStartParams.model);
      if (
        model &&
        context.reportedModelCapabilities?.get(model)?.inputModalities?.includes("audio")
      ) {
        const config = asObject(
          asObject(
            await this.sendRequest(context, "config/read", { includeLayers: false }).catch(
              () => undefined,
            ),
          )?.config,
        );
        if (asObject(config?.desktop)?.f5_audio_attachments === true) {
          for (const path of new Set(input.audioFiles))
            turnStartParams.input.push({ type: "localAudio", path });
        }
      }
    }
    if (input.attachments?.some((attachment) => attachment.type === "localAudio")) {
      const model = normalizeCodexModelSlug(turnStartParams.model ?? context.session.model);
      const capabilities = model ? context.reportedModelCapabilities?.get(model) : undefined;
      try {
        if (
          !supportsCodexRelease6(context.cliVersion) ||
          !capabilities?.inputModalities?.includes("audio")
        )
          throw new Error(
            "Enable experimental audio attachments and select a Codex model that reports audio input support.",
          );
        const config = asObject(
          asObject(await this.sendRequest(context, "config/read", { includeLayers: false }))
            ?.config,
        );
        if (asObject(config?.desktop)?.f5_audio_attachments !== true)
          throw new Error("Enable experimental audio attachments in Codex provider settings.");
      } catch (cause) {
        throw Object.assign(
          new Error(
            cause instanceof Error ? cause.message : "Audio attachment validation failed.",
            { cause },
          ),
          { deliveryCertainty: "not_sent", deliveryRetryable: false },
        );
      }
    }

    if (input.expectedTurnId !== undefined) {
      if (context.session.activeTurnId !== input.expectedTurnId) {
        throw new CodexJsonRpcError(
          "turn/steer",
          -32602,
          "The active turn changed before steering.",
        );
      }
      const response = this.readObject(
        await this.sendRequest(
          context,
          "turn/steer",
          buildCodexTurnSteerParams(providerThreadId, turnStartParams.input, input.expectedTurnId),
        ),
      );
      const id = this.readString(response, "turnId");
      if (id !== input.expectedTurnId)
        throw new Error("turn/steer returned an unexpected turn id.");
      return { threadId: input.threadId, turnId: input.expectedTurnId };
    }
    const response = await this.sendRequest(context, "turn/start", turnStartParams);
    context.deferredServiceTier = undefined;
    context.lastAdditionalContext = turnStartParams.additionalContext;

    const turn = this.readObject(this.readObject(response), "turn");
    const turnIdRaw = this.readString(turn, "id");
    if (!turnIdRaw) {
      throw new Error("turn/start response did not include a turn id.");
    }
    const turnId = TurnId.makeUnsafe(turnIdRaw);

    const serviceTier = this.readString(turn, "serviceTier");
    if (serviceTier) {
      const tiers = (context.usageServiceTiers ??= new Map());
      tiers.set(turnId, serviceTier);
      if (tiers.size > 256) tiers.delete(tiers.keys().next().value!);
    }

    const nextConfiguredModel = turnStartParams.model ?? context.session.model;

    this.updateSession(context, {
      status: "running",
      ...(nextConfiguredModel !== undefined ? { model: nextConfiguredModel } : {}),
      // A queued follow-up has its own id, but interrupt requires the running turn.
      activeTurnId:
        context.session.status === "running" ? (context.session.activeTurnId ?? turnId) : turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    });
    context.requestedRuntime = {
      model: input.model ?? context.requestedRuntime?.model,
      effort: input.effort,
      serviceTier: input.serviceTier,
    };
    if (turnStartParams.serviceTier !== undefined) {
      context.serviceTierApplied = typeof turnStartParams.serviceTier === "string";
    }
    if (nextConfiguredModel !== undefined) {
      const modelContextWindowTokens = lookupModelContextWindowTokens({
        provider: "codex",
        model: nextConfiguredModel,
        catalog: context.modelContextWindowCatalog,
      });
      const {
        modelContextWindowTokens: _previousLimit,
        serviceTier: _previousTier,
        effort: _previousEffort,
        ...configuredBase
      } = context.configuredBase ?? {};
      this.emitSessionConfigured(context, {
        ...configuredBase,
        model: nextConfiguredModel,
        ...(turnStartParams.effort ? { effort: turnStartParams.effort } : {}),
        ...(turnStartParams.serviceTier ? { serviceTier: turnStartParams.serviceTier } : {}),
        ...(modelContextWindowTokens !== undefined ? { modelContextWindowTokens } : {}),
      });
    }
    context.resumedContextSent = true;
    if (asObject(context.session.resumeCursor)?.f5ResumedContextPending === true) {
      const { f5ResumedContextPending: _pending, ...cursor } = asObject(
        context.session.resumeCursor,
      )!;
      this.updateSession(context, { resumeCursor: cursor });
    }

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  }

  async runOneOffPrompt(input: {
    readonly prompt: string;
    readonly cwd?: string;
    readonly model?: string;
    readonly effort?: string | undefined;
    readonly serviceTier?: "fast" | "default" | null;
    readonly runtimeMode?: RuntimeMode;
    readonly providerOptions?: ProviderSessionStartInput["providerOptions"];
    readonly timeoutMs?: number;
  }): Promise<string> {
    // One-off prompts reuse a warm app-server for the same launch config
    // instead of spawning one per prompt; each prompt still gets a fresh
    // provider thread. Acquiring is synchronous, so two prompts can never
    // claim the same worker.
    const poolKey = codexOneOffPoolKey(input.providerOptions);
    // Resolved once and sent explicitly on both paths, so a prompt runs in the
    // same directory whether or not a warm worker exists.
    const cwd = input.cwd ?? process.cwd();
    let worker = this.acquireOneOffWorker(poolKey);
    const threadId =
      worker?.threadId ?? ThreadId.makeUnsafe(`${CODEX_ONE_OFF_THREAD_PREFIX}${randomUUID()}`);
    let succeeded = false;
    const timeoutMs = input.timeoutMs ?? CODEX_ONE_OFF_PROMPT_TIMEOUT_MS;
    // One-off output is the ordered contribution of every assistant item.
    const capturedItems = new Map<string, string>();
    const replacedItems = new Set<string>();
    const followUpPromises = new Set<Promise<unknown>>();

    let resolveCompletion: (() => void) | undefined;
    let rejectCompletion: ((error: Error) => void) | undefined;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const timer = setTimeout(() => {
      rejectCompletion?.(
        new Error(`Timed out waiting for Codex one-off prompt completion after ${timeoutMs}ms.`),
      );
    }, timeoutMs);

    const trackFollowUp = (promise: Promise<unknown>) => {
      followUpPromises.add(promise);
      promise.finally(() => {
        followUpPromises.delete(promise);
      });
    };

    // A reused worker may still deliver stragglers from its previous prompt
    // until the new provider thread is open; only this prompt's turn counts.
    let turnRequested = false;
    const listener = (event: ProviderEvent) => {
      if (event.threadId !== threadId || !turnRequested) {
        return;
      }

      if (event.method === "item/agentMessage/delta" && typeof event.textDelta === "string") {
        const itemId = event.itemId ?? asString(asObject(event.payload)?.itemId) ?? "anonymous";
        if (!replacedItems.has(itemId))
          capturedItems.set(itemId, (capturedItems.get(itemId) ?? "") + event.textDelta);
        return;
      }

      if (event.method === "item/completed") {
        const payload = asObject(event.payload);
        const item = asObject(payload?.item) ?? payload;
        const completedText = asString(item?.text);
        const itemId = event.itemId ?? asString(item?.id) ?? "anonymous";
        const presentation = codexMessagePresentation(item);
        if (presentation.replace) {
          capturedItems.set(itemId, presentation.text ?? "");
          replacedItems.add(itemId);
        } else if (completedText && !capturedItems.get(itemId)) {
          capturedItems.set(itemId, completedText);
        }
      }

      if (event.kind === "request" && event.requestId) {
        if (event.requestKind) {
          trackFollowUp(
            this.respondToRequest(threadId, event.requestId, "decline").catch(() => undefined),
          );
          return;
        }
        if (event.method === "item/tool/requestUserInput") {
          trackFollowUp(
            this.respondToUserInput(threadId, event.requestId, {}).catch(() => undefined),
          );
          return;
        }
      }

      if (event.method === "turn/completed") {
        const turn = this.readObject(event.payload, "turn");
        const status = this.readString(turn, "status");
        const errorMessage = this.readString(this.readObject(turn, "error"), "message");
        if (status !== "completed") {
          rejectCompletion?.(
            new Error(
              errorMessage ??
                (status === "failed"
                  ? "Codex one-off prompt failed."
                  : `Unexpected Codex one-off prompt status: ${status ?? "unknown"}.`),
            ),
          );
          return;
        }
        resolveCompletion?.();
      }
    };

    this.on("event", listener);

    try {
      if (worker) {
        await this.openOneOffThread(threadId, {
          cwd,
          ...(input.model !== undefined ? { model: input.model } : {}),
          runtimeMode: input.runtimeMode ?? "approval-required",
        });
      } else {
        worker = { key: poolKey, threadId, busy: true, prompts: 0, idleTimer: undefined };
        this.oneOffWorkers.set(threadId, worker);
        await this.startSession({
          threadId,
          provider: "codex",
          cwd,
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.providerOptions !== undefined
            ? { providerOptions: input.providerOptions }
            : {}),
          runtimeMode: input.runtimeMode ?? "approval-required",
          // The process outlives this prompt's cwd (which may be a temp dir)
          // and serves later prompts in other dirs, so it runs somewhere
          // neutral that carries no project or home-directory instructions.
          processCwd: OS.tmpdir(),
          // One-offs never use plugins; keep Codex from starting a marketplace
          // upgrade that a stopped app-server would leave behind on disk.
          disablePlugins: true,
        });
      }
      turnRequested = true;
      await this.sendTurn({
        threadId,
        input: input.prompt,
        // Background prompts keep a cheap effort unless the caller picks one.
        effort: input.effort ?? "medium",
        ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
      });
      await completion;
      const text = [...capturedItems.values()].join("").trim();
      if (text.length === 0) {
        throw new Error("Codex one-off prompt completed without returning any assistant text.");
      }
      succeeded = true;
      return text;
    } finally {
      clearTimeout(timer);
      this.off("event", listener);
      if (followUpPromises.size > 0) {
        await Promise.allSettled(followUpPromises);
      }
      this.releaseOneOffWorker(threadId, succeeded);
    }
  }

  /** An idle, live warm worker for this launch config, now marked busy. */
  private acquireOneOffWorker(key: string): CodexOneOffWorker | undefined {
    for (const worker of this.oneOffWorkers.values()) {
      if (worker.key !== key || worker.busy) continue;
      const context = this.sessions.get(worker.threadId);
      if (!context || context.stopping || context.session.status !== "ready") {
        // The process exited (or broke) while idle.
        this.stopSession(worker.threadId);
        continue;
      }
      clearTimeout(worker.idleTimer);
      worker.idleTimer = undefined;
      worker.busy = true;
      return worker;
    }
    return undefined;
  }

  /**
   * Keep a healthy worker warm for the next one-off, at most one idle worker
   * per launch config; stop everything else. A failed or timed-out prompt
   * may leave a turn running, so its process is never reused.
   */
  private releaseOneOffWorker(threadId: ThreadId, succeeded: boolean): void {
    const worker = this.oneOffWorkers.get(threadId);
    const context = this.sessions.get(threadId);
    if (!worker) {
      this.stopSession(threadId);
      return;
    }
    worker.busy = false;
    worker.prompts += 1;
    const reusable =
      succeeded &&
      context !== undefined &&
      !context.stopping &&
      context.session.status === "ready" &&
      context.session.activeTurnId === undefined &&
      worker.prompts < CODEX_ONE_OFF_WORKER_MAX_PROMPTS &&
      ![...this.oneOffWorkers.values()].some(
        (other) => other !== worker && other.key === worker.key && !other.busy,
      );
    if (!reusable) {
      this.stopSession(threadId);
      return;
    }
    worker.idleTimer = setTimeout(() => {
      this.stopSession(threadId);
    }, CODEX_ONE_OFF_WORKER_IDLE_MS);
    worker.idleTimer.unref?.();
  }

  /** Start a fresh provider thread on a warm one-off app-server. */
  private async openOneOffThread(
    threadId: ThreadId,
    input: { readonly cwd: string; readonly model?: string; readonly runtimeMode: RuntimeMode },
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const resolvedCwd = input.cwd;
    const model = resolveCodexModelForAccount(
      normalizeCodexModelSlug(input.model) ?? DEFAULT_MODEL_BY_PROVIDER.codex,
      context.account,
    );
    const params = buildCodexThreadOpenRequestParams({
      ...(model ? { model } : {}),
      cwd: resolvedCwd,
      runtimeMode: input.runtimeMode,
      ...(context.cliVersion !== undefined ? { cliVersion: context.cliVersion } : {}),
      browserResume: !!context.browserResume,
    });
    const response = await this.sendRequest(context, "thread/start", params.start);
    const providerThreadId = this.readThreadOpenProviderThreadId("thread/start", response);
    const previousThreadId = readResumeCursorThreadId(context.session.resumeCursor);
    if (previousThreadId) {
      context.retiredMcpThreads ??= new Set();
      context.retiredMcpThreads.add(previousThreadId);
    }
    context.mcpCalls?.clear();
    context.mcpCallOwners?.clear();
    context.browserResumeRegistered = !!params.start.dynamicTools;
    context.instructionContext = buildCodexInstructionContext(
      {
        threadId,
        runtimeMode: input.runtimeMode,
        // Integrations and the project's Branch prefix belong to the session, not the
        // provider thread.
        ...(context.instructionContext?.integrationInstructions
          ? { integrationInstructions: context.instructionContext.integrationInstructions }
          : {}),
        ...(context.instructionContext?.branchNamePrefix
          ? { branchNamePrefix: context.instructionContext.branchNamePrefix }
          : {}),
      },
      resolvedCwd,
    );
    context.resumedContextSent = false;
    // Notifications from the previous provider thread are dropped from here on.
    this.updateSession(context, {
      status: "ready",
      runtimeMode: input.runtimeMode,
      cwd: resolvedCwd,
      ...(model ? { model } : {}),
      activeTurnId: undefined,
      resumeCursor: { threadId: providerThreadId },
    });
  }

  private readThreadOpenProviderThreadId(method: string, response: unknown): string {
    const record = this.readObject(response);
    const providerThreadId =
      this.readString(this.readObject(record, "thread"), "id") ??
      this.readString(record, "threadId");
    if (!providerThreadId) {
      throw new Error(`${method} response did not include a thread id.`);
    }
    return providerThreadId;
  }

  private nativeThreadId(context: CodexSessionContext): string {
    const id = readResumeCursorThreadId(context.session.resumeCursor);
    if (!id) throw new Error("The provider thread identity is unavailable.");
    return id;
  }

  async renameThread(threadId: ThreadId, title: string): Promise<void> {
    const context = this.requireSession(threadId);
    if (context.lastProviderTitle === title) return;
    try {
      await this.sendRequest(context, "thread/name/set", {
        threadId: this.nativeThreadId(context),
        name: title,
      });
    } catch (error) {
      if (!isUnknownMethodError(error, "thread/name/set")) throw error;
    }
    context.lastProviderTitle = title;
  }

  async readChildThreadItems(
    threadId: ThreadId,
    childId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ data: unknown[]; nextCursor: string | null } | "unsupported-provider" | null> {
    const context = this.sessions.get(threadId);
    if (!context || context.session.status === "closed" || context.phase === "draining")
      return null;
    if (!context.childThreadIds?.has(childId)) return null;
    try {
      const response = asObject(
        await this.sendRequest(context, "thread/items/list", {
          threadId: childId,
          cursor,
          limit,
          sortDirection: "asc",
        }),
      );
      if (!Array.isArray(response?.data) || response.data.length > limit)
        throw new Error("Invalid child transcript page.");
      return {
        data: response.data,
        nextCursor: typeof response.nextCursor === "string" ? response.nextCursor : null,
      };
    } catch (error) {
      if (error instanceof CodexJsonRpcError && error.code === -32601)
        return "unsupported-provider";
      throw error;
    }
  }

  private cacheReadState(context: CodexSessionContext, value: unknown): void {
    if (value === null) {
      context.readState = null;
      return;
    }
    const state = asObject(value);
    if (typeof state?.revision === "string" && "firstUnread" in state)
      context.readState = { revision: state.revision, firstUnread: state.firstUnread };
  }

  async markNativeThreadRead(threadId: ThreadId): Promise<void> {
    const context = this.sessions.get(threadId);
    if (
      !context ||
      !this.isLiveContext(context) ||
      !supportsCodexRelease5(context.cliVersion) ||
      context.readMarkInFlight ||
      !context.readState ||
      context.readState.firstUnread === null
    )
      return;
    context.readMarkInFlight = true;
    try {
      await this.sendRequest(
        context,
        "thread/readState/update",
        buildCodexReadMarkParams(this.nativeThreadId(context), context.readState.revision),
      );
    } catch (error) {
      const data = error instanceof CodexJsonRpcError ? asObject(error.data) : undefined;
      if (data?.reason === "readStateConflict") this.cacheReadState(context, data.readState);
      else await Effect.logDebug("Codex read mark failed", { threadId }).pipe(this.runPromise);
    } finally {
      context.readMarkInFlight = false;
    }
  }

  async inspectNativeOperation(input: NativeOperationInspectInput): Promise<unknown> {
    const context = this.requireSession(input.threadId);
    const threadId = this.nativeThreadId(context);
    if (input.kind === "memory") {
      if (!supportsCodexRelease5(context.cliVersion))
        throw new Error("Memory requires Codex 0.166.0 or later.");
      return this.sendRequest(context, "thread/memory/read", buildCodexMemoryReadParams(threadId));
    }
    if (input.kind === "usage") {
      if (!supportsCodexNativeOperations(context.cliVersion))
        throw new Error("Usage requires Codex 0.162.0 or later.");
      return this.sendRequest(context, "account/usage/read", buildCodexUsageReadParams(threadId));
    }
    if (input.kind === "goal") return this.sendRequest(context, "thread/goal/get", { threadId });
    if (input.kind === "attachments") {
      const response = asObject(
        await this.sendRequest(context, "thread/attachment/list", { threadId }),
      );
      // Native payloads may contain file contents or private extension data. Only metadata crosses F5's wire.
      const data = response?.attachments ?? response?.data;
      return {
        attachments: Array.isArray(data)
          ? data.slice(0, 512).map((entry) => {
              const value = asObject(entry);
              return {
                id: value?.id,
                attachmentType: value?.attachmentType,
                identityKey: value?.identityKey,
                createdAt: value?.createdAt,
                source: "codex",
              };
            })
          : [],
      };
    }
    if (input.kind !== "task" || !input.nativeId || !context.childThreadIds?.has(input.nativeId))
      throw new Error("This child thread is not owned by this session.");
    // One native page, never readPaginatedThread's full-history accumulator.
    const response = asObject(
      await this.sendRequest(context, "thread/items/list", {
        threadId: input.nativeId,
        limit: input.limit ?? 20,
        cursor: input.cursor ?? null,
        sortDirection: "asc",
      }),
    );
    let bytes = 0;
    const data = Array.isArray(response?.data)
      ? response.data.slice(0, input.limit ?? 20).map((entry) => {
          const size = Buffer.byteLength(JSON.stringify(entry) ?? "", "utf8");
          if (size > 64 * 1024 || bytes + size > 256 * 1024)
            return { omitted: true, reason: "Native output exceeds the page limit." };
          bytes += size;
          const value = asObject(entry);
          return value?.item
            ? { ...value, item: presentCodexMessageItem(value.item) }
            : presentCodexMessageItem(entry);
        })
      : [];
    return {
      data,
      nextCursor: typeof response?.nextCursor === "string" ? response.nextCursor : null,
    };
  }

  async executeNativeOperation(
    input: NativeOperationInput,
    onReceipt?: (receipt: unknown) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let dispatched = false;
    try {
      return await this.executeNativeOperationImpl(input, onReceipt, signal, () => {
        dispatched = true;
      });
    } catch (cause) {
      if (!dispatched)
        throw Object.assign(
          new Error(cause instanceof Error ? cause.message : String(cause), { cause }),
          {
            deliveryCertainty: "not_sent" as const,
            ...(asObject(cause)?.nativeOperationCancelled === true
              ? { nativeOperationCancelled: true }
              : {}),
          },
        );
      throw cause;
    }
  }

  private async executeNativeOperationImpl(
    input: NativeOperationInput,
    onReceipt: ((receipt: unknown) => Promise<void>) | undefined,
    signal: AbortSignal | undefined,
    onDispatch: () => void,
  ): Promise<unknown> {
    const context = this.requireSession(input.threadId);
    const threadId = this.nativeThreadId(context);
    const command = input.command;
    const request = (method: string, params: Record<string, unknown>) => {
      if (!["thread/read", "thread/goal/get"].includes(method)) onDispatch();
      return this.sendRequest(context, method, params);
    };
    if (command.kind === "aside") {
      if (!supportsCodexRelease5(context.cliVersion) || context.session.activeTurnId)
        throw new Error("Ask aside requires an idle Codex 0.166.0 session.");
      context.samplePreparing = true;
      context.sampleCancelled = false;
      let history: Record<string, unknown> | undefined;
      const assertNotCancelled = () => {
        if (signal?.aborted || context.sampleCancelled)
          throw Object.assign(new Error("Aside cancelled."), { nativeOperationCancelled: true });
      };
      try {
        await onReceipt?.({ nativeThreadId: threadId });
        assertNotCancelled();
        history = asObject(
          await this.sendRequest(context, "thread/turns/list", {
            threadId,
            limit: 1,
            sortDirection: "desc",
          }),
        );
        assertNotCancelled();
      } finally {
        context.samplePreparing = false;
      }
      const latest = Array.isArray(history?.data) ? asObject(history.data[0]) : undefined;
      if (
        !latest ||
        typeof latest.id !== "string" ||
        typeof latest.status !== "string" ||
        !["completed", "failed", "interrupted"].includes(latest.status)
      )
        throw new Error("Ask aside requires a settled native turn.");
      const requestId = context.nextRequestId;
      const sampleModel = context.session.model ?? null;
      context.sampleRequestId = requestId;
      const cancel = () => {
        void this.cancelSample(context).catch(() => undefined);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        context.sampleCompletion = request(
          "thread/sample",
          buildCodexSampleParams(
            threadId,
            latest.id,
            command.question,
            typeof context.requestedRuntime?.effort === "string"
              ? context.requestedRuntime.effort
              : undefined,
          ),
        );
        const result = asObject(await context.sampleCompletion);
        if (context.sampleCancelled) throw new Error("Aside cancelled.");
        const aside = {
          question: command.question,
          text:
            typeof result?.text === "string"
              ? Buffer.byteLength(result.text, "utf8") > 32000
                ? new TextDecoder().decode(Buffer.from(result.text, "utf8").subarray(0, 32000), {
                    stream: true,
                  }) + "\n[Answer truncated]"
                : result.text
              : null,
          inputTokens: result?.inputTokens,
          cachedInputTokens: result?.cachedInputTokens,
          outputTokens: result?.outputTokens,
          model: sampleModel,
        };
        this.emitEvent({
          ...context.mcpEventIdentity,
          id: EventId.makeUnsafe(timeOrderedUuid()),
          kind: "notification",
          provider: "codex",
          threadId: input.threadId,
          createdAt: new Date().toISOString(),
          method: "f5/aside/completed",
          payload: aside,
        });
        return aside;
      } catch (cause) {
        if (context.sampleCancelled)
          throw Object.assign(new Error("Aside cancelled.", { cause }), {
            nativeOperationCancelled: true,
          });
        throw cause;
      } finally {
        delete context.sampleRequestId;
        delete context.sampleCompletion;
        delete context.sampleCancellation;
        signal?.removeEventListener("abort", cancel);
      }
    }
    await onReceipt?.({ nativeThreadId: threadId });
    if (command.kind === "goalPause")
      return request("thread/goal/set", buildCodexGoalPauseParams(threadId, "user"));
    if (command.kind === "goalClear")
      return request("thread/goal/clear", buildCodexGoalClearParams(threadId));
    if (command.kind === "goalSet") {
      let running = false;
      let terminal: unknown;
      let resolve!: (value: unknown) => void;
      let reject!: (error: Error) => void;
      const completion = new Promise<unknown>((accept, refuse) => {
        resolve = accept;
        reject = refuse;
      });
      void completion.catch(() => undefined);
      const listener = (event: ProviderEvent) => {
        if (event.threadId !== input.threadId) return;
        if (event.method === "turn/started") running = true;
        if (event.method === "turn/completed") {
          running = false;
          if (terminal) resolve(terminal);
        }
        if (event.method === "thread/goal/updated") {
          const goal = asObject(asObject(event.payload)?.goal);
          if (goal && goal.status !== "active") {
            terminal = { goal };
            if (!running) resolve(terminal);
          }
        }
        if (event.method === "thread/goal/cleared") {
          terminal = { goal: null };
          if (!running) resolve(terminal);
        }
        if (event.method === "session/exited" || event.method === "session/closed")
          reject(new Error("Provider exited during goal execution."));
      };
      this.on("event", listener);
      const aborted = () =>
        reject(new Error("Goal waiter was cancelled; reconciliation is required."));
      signal?.addEventListener("abort", aborted, { once: true });
      context.nativeGoalActive = true;
      context.nativeGoalBudget = command.tokenBudget;
      let goalSettled = false;
      try {
        await request("thread/goal/set", {
          threadId,
          objective: command.objective,
          tokenBudget: command.tokenBudget,
          status: "active",
          origin: "user",
        });
        // The operation reservation owns every continuation until the goal settles.
        const result = await completion;
        goalSettled = true;
        return result;
      } finally {
        if (!goalSettled) context.nativeGoalActive = false;
        this.off("event", listener);
        signal?.removeEventListener("abort", aborted);
      }
    }
    if (command.kind === "fork") {
      const history = await this.readThread(input.threadId);
      const boundary =
        command.beforeTurnId === undefined
          ? history.turns.length
          : history.turns.findIndex((turn) => turn.id === command.beforeTurnId);
      if (boundary < 0) throw new Error("The selected fork boundary no longer exists.");
      const forkParams = buildCodexThreadForkParams(
        {
          cwd: command.cwd,
          ...(context.session.model ? { model: context.session.model } : {}),
          runtimeMode: context.session.runtimeMode,
        },
        threadId,
        command.beforeTurnId,
      );
      await onReceipt?.({
        sourceNativeThreadId: threadId,
        expectedRemainingTurnIds: history.turns.slice(0, boundary).map((turn) => turn.id),
      });
      const response = asObject(
        await this.forkWithArchivedRecovery(
          context,
          { ...forkParams, deferGoalContinuation: true },
          request,
        ),
      );
      const forkId = asObject(response?.thread)?.id;
      if (typeof forkId !== "string" || forkId === threadId)
        throw new Error("Invalid native fork identity.");
      await onReceipt?.({
        nativeThreadId: forkId,
        sourceNativeThreadId: threadId,
        targetThreadId: command.targetThreadId,
      });
      const fork = await this.readPaginatedThread(context, forkId);
      if (
        JSON.stringify(fork.turns.map((turn) => turn.id)) !==
        JSON.stringify(history.turns.slice(0, boundary).map((turn) => turn.id))
      )
        throw new Error(
          "Fork history differs from the selected boundary; source thread was not modified.",
        );
      return {
        resumeCursor: { threadId: forkId },
        targetThreadId: command.targetThreadId,
        cwd: command.cwd,
      };
    }
    if (command.kind !== "compact" && command.kind !== "review")
      throw new Error("This native operation is unsupported by Codex.");
    // Subscribe before dispatch because native events may precede the RPC response.
    let nativeTurnId: string | undefined;
    let reviewAnchorResolved = false;
    const completedCandidates: ProviderEvent[] = [];
    let nativeItemId: string | undefined;
    let settled: ProviderEvent | undefined;
    let resolve!: (event: ProviderEvent) => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<ProviderEvent>((accept, refuse) => {
      resolve = accept;
      reject = refuse;
    });
    // The promise can reject before dispatch returns. Install a handler immediately.
    void completion.catch(() => undefined);
    let receiptWrites: Promise<unknown> = Promise.resolve();
    const listener = (event: ProviderEvent) => {
      if (event.threadId !== input.threadId) return;
      if (event.method === "session/exited" || event.method === "session/closed")
        reject(new Error("Provider exited during native operation."));
      if (event.method === "turn/started" && (command.kind !== "review" || !reviewAnchorResolved)) {
        nativeTurnId = String(asObject(asObject(event.payload)?.turn)?.id ?? event.turnId ?? "");
        receiptWrites = receiptWrites
          .then(() => onReceipt?.({ nativeThreadId: threadId, nativeTurnId }))
          .catch((cause) => {
            reject(cause instanceof Error ? cause : new Error("Receipt persistence failed."));
          });
      }
      if (
        event.method === "item/completed" &&
        asObject(asObject(event.payload)?.item)?.type === "contextCompaction"
      ) {
        nativeItemId = String(asObject(asObject(event.payload)?.item)?.id ?? event.itemId ?? "");
        receiptWrites = receiptWrites
          .then(() => onReceipt?.({ nativeThreadId: threadId, nativeTurnId, nativeItemId }))
          .catch((cause) =>
            reject(cause instanceof Error ? cause : new Error("Receipt persistence failed.")),
          );
      }
      if (event.method === "turn/completed" && completedCandidates.length < 32)
        completedCandidates.push(event);
      if (
        event.method === "turn/completed" &&
        (command.kind !== "review" || reviewAnchorResolved) &&
        (!nativeTurnId || String(event.turnId) === nativeTurnId)
      ) {
        settled = event;
        resolve(event);
      }
    };
    this.on("event", listener);
    const aborted = () =>
      reject(new Error("Native operation waiter was cancelled; reconcile the provider outcome."));
    signal?.addEventListener("abort", aborted, { once: true });
    // Browser admission has already returned. Keep the correlated waiter until
    // settlement, process exit or explicit cancellation, including slow healthy turns.
    try {
      if (command.kind === "review") {
        context.reviewOperationActive = true;
        context.forkNotifications = [];
        context.forkNotificationOverflow = false;
        const response = asObject(
          await request("review/start", {
            threadId,
            delivery: "inline",
            target:
              command.target.type === "commit"
                ? { ...command.target, title: null }
                : command.target,
          }),
        );
        nativeTurnId = String(asObject(response?.turn)?.id ?? "");
        if (!nativeTurnId) throw new Error("Review did not return a native turn identity.");
        reviewAnchorResolved = true;
        context.nativeReviewTurnId = nativeTurnId;
        settled = completedCandidates.find((event) => String(event.turnId) === nativeTurnId);
        await onReceipt?.({
          nativeThreadId: threadId,
          nativeTurnId,
          reviewThreadId: response?.reviewThreadId,
        });
        const reviewId = response?.reviewThreadId;
        const buffered = context.forkNotifications;
        context.forkNotifications = undefined;
        if (typeof reviewId === "string" && reviewId !== threadId) {
          (context.reviewThreadIds ??= new Set()).add(reviewId);
          for (const notification of buffered ?? [])
            if (readNotificationProviderThreadId(notification.params) === reviewId)
              this.handleServerNotification(context, notification);
        }
      } else await request("thread/compact/start", { threadId });
      const event = settled ?? (await completion);
      const turn = asObject(asObject(event.payload)?.turn);
      if (turn?.status !== "completed")
        throw new Error(`Native operation ended as ${String(turn?.status ?? "unknown")}.`);
      if (command.kind === "compact" && !nativeItemId)
        throw new Error("Compaction turn ended without a correlated contextCompaction item.");
      return {
        native: true,
        nativeTurnId,
        ...(nativeItemId ? { nativeItemId } : {}),
        status: "completed",
      };
    } finally {
      this.off("event", listener);
      context.reviewOperationActive = false;
      if (settled && String(settled.turnId) === nativeTurnId) delete context.nativeReviewTurnId;
      context.forkNotifications = undefined;
      signal?.removeEventListener("abort", aborted);
      await receiptWrites;
    }
  }

  async reconcileNativeOperation(
    record: NativeOperationRecord,
  ): Promise<{ state: "completed" | "failed" | "indeterminate"; result?: unknown }> {
    const context = this.requireSession(record.threadId);
    const receipt = asObject(record.receipt);
    const result = asObject(record.result);
    const nativeTurnId = result?.nativeTurnId ?? receipt?.nativeTurnId;
    const threadId =
      typeof receipt?.nativeThreadId === "string"
        ? receipt.nativeThreadId
        : this.nativeThreadId(context);
    if (record.command.kind === "fork") {
      const forkId = receipt?.nativeThreadId;
      const sourceId = receipt?.sourceNativeThreadId;
      // A lost response may have created an orphan. Absence of an identity is not proof of failure.
      if (typeof forkId !== "string" || typeof sourceId !== "string" || forkId === sourceId)
        return { state: "indeterminate" };
      const fork = await this.readPaginatedThread(context, forkId);
      const expected = receipt?.expectedRemainingTurnIds;
      if (!Array.isArray(expected)) return { state: "indeterminate" };
      if (JSON.stringify(fork.turns.map((turn) => turn.id)) !== JSON.stringify(expected))
        return {
          state: "failed",
          result: { reason: "Fork history does not match the retained boundary." },
        };
      return {
        state: "completed",
        result: {
          resumeCursor: { threadId: forkId },
          targetThreadId: record.command.targetThreadId,
          cwd: record.command.cwd,
        },
      };
    }
    if (record.command.kind === "goalPause" || record.command.kind === "goalClear") {
      const response = asObject(await this.sendRequest(context, "thread/goal/get", { threadId }));
      const goal = asObject(response?.goal);
      const matches =
        record.command.kind === "goalClear" ? !goal : !goal || goal.status === "paused";
      if (!matches) return { state: "indeterminate" };
      const read = asObject(
        await this.sendRequest(context, "thread/read", { threadId, includeTurns: false }),
      );
      if (asObject(asObject(read?.thread)?.status)?.type === "active")
        return { state: "indeterminate" };
      return { state: "completed", result: { goal } };
    }
    if (record.command.kind === "goalSet") {
      const response = asObject(await this.sendRequest(context, "thread/goal/get", { threadId }));
      const goal = asObject(response?.goal);
      if (goal?.status === "active" && !context.nativeGoalActive) {
        await this.sendRequest(context, "thread/goal/set", {
          threadId,
          status: "paused",
          origin: "automatic",
        });
        const read = asObject(
          await this.sendRequest(context, "thread/read", { threadId, includeTurns: false }),
        );
        if (asObject(asObject(read?.thread)?.status)?.type === "active")
          return { state: "indeterminate" };
        return { state: "completed", result: { goal: { ...goal, status: "paused" } } };
      }
      if (!goal || goal.status !== "active") {
        const read = asObject(
          await this.sendRequest(context, "thread/read", { threadId, includeTurns: false }),
        );
        if (asObject(asObject(read?.thread)?.status)?.type === "active")
          return { state: "indeterminate" };
        return { state: "completed", result: { goal } };
      }
      return { state: "indeterminate" };
    }
    if (typeof nativeTurnId !== "string") return { state: "indeterminate" };
    const response = asObject(
      await this.sendRequest(context, "thread/read", { threadId, includeTurns: true }),
    );
    const turns = asObject(response?.thread)?.turns;
    const turn = Array.isArray(turns)
      ? turns.map(asObject).find((turn) => turn?.id === nativeTurnId)
      : undefined;
    if (turn?.status === "completed")
      return { state: "completed", result: { nativeTurnId, native: true } };
    if (turn?.status === "failed" || turn?.status === "interrupted")
      return { state: "failed", result: { nativeTurnId, status: turn.status } };
    return { state: "indeterminate" };
  }

  private cancelSample(context: CodexSessionContext): Promise<void> {
    if (context.sampleCancellation) return context.sampleCancellation;
    if (context.sampleRequestId === undefined) return Promise.resolve();
    const requestId = context.sampleRequestId;
    context.sampleCancelled = true;
    const completion = context.sampleCompletion;
    context.sampleCancellation = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await this.sendRequest(context, "thread/sample/cancel", { requestId });
        if (completion)
          await Promise.race([
            completion.catch(() => undefined),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Codex did not settle the cancelled sample.")),
                5000,
              );
            }),
          ]);
      } catch (cause) {
        // A cancellation acknowledgement alone is insufficient: end the process
        // if work cannot be confirmed settled before releasing its reservation.
        this.stopSession(context.session.threadId);
        if (completion) await completion.catch(() => undefined);
        throw cause;
      } finally {
        clearTimeout(timer);
      }
    })();
    return context.sampleCancellation;
  }

  async interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void> {
    const context = this.requireSession(threadId);
    if (context.samplePreparing) {
      context.sampleCancelled = true;
      return;
    }
    if (context.sampleRequestId !== undefined) {
      await this.cancelSample(context);
      return;
    }
    if (context.nativeGoalActive) {
      try {
        await this.sendRequest(context, "thread/goal/set", {
          threadId: this.nativeThreadId(context),
          status: "paused",
          origin: "automatic",
        });
      } catch (cause) {
        this.stopSession(threadId);
        throw new Error("The native goal could not be paused. Its provider session was stopped.", {
          cause,
        });
      }
      context.nativeGoalActive = false;
    }
    const effectiveTurnId = turnId ?? context.session.activeTurnId;

    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!effectiveTurnId || !providerThreadId) {
      return;
    }

    await this.sendRequest(context, "turn/interrupt", {
      threadId: providerThreadId,
      turnId: effectiveTurnId,
    });
    this.retireMcpCalls(context, providerThreadId, effectiveTurnId);
  }

  async readThread(threadId: ThreadId): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(threadId);
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }

    if (!context.turnPaginationUnsupported) {
      try {
        return await this.readPaginatedThread(context, providerThreadId);
      } catch (error) {
        if (!isUnknownMethodError(error, "thread/turns/list")) {
          throw error;
        }
        context.turnPaginationUnsupported = true;
      }
    }

    const response = await this.sendRequest(context, "thread/read", {
      threadId: providerThreadId,
      includeTurns: true,
    });
    return this.parseThreadSnapshot("thread/read", response);
  }

  private async readPaginatedThread(
    context: CodexSessionContext,
    providerThreadId: string,
  ): Promise<CodexThreadSnapshot> {
    const turns: CodexThreadTurnSnapshot[] = [];
    const cursors = new Set<string>();
    const turnIds = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await this.sendRequest(context, "thread/turns/list", {
        threadId: providerThreadId,
        limit: 50,
        sortDirection: "asc",
        itemsView: "full",
        ...(cursor !== undefined ? { cursor } : {}),
      }).catch((error: unknown) => {
        // Once pagination has succeeded, any subsequent failure invalidates this snapshot.
        if (cursor !== undefined) {
          throw new Error("thread/turns/list failed while paging thread history.", {
            cause: error,
          });
        }
        throw error;
      });
      const page = this.readObject(response);
      if (
        !Array.isArray(page?.data) ||
        !(
          page.nextCursor === null ||
          (typeof page.nextCursor === "string" && page.nextCursor.length > 0)
        )
      ) {
        throw new Error("thread/turns/list returned an invalid page.");
      }
      for (const value of page.data) {
        const turn = this.readObject(value);
        if (
          typeof turn?.id !== "string" ||
          turn.id.trim().length === 0 ||
          turnIds.has(turn.id) ||
          !Array.isArray(turn.items) ||
          turn.itemsView !== "full"
        ) {
          throw new Error("thread/turns/list returned an invalid or incomplete turn.");
        }
        turnIds.add(turn.id);
        turns.push({
          id: TurnId.makeUnsafe(turn.id),
          items: turn.items.map(presentCodexMessageItem),
        });
      }
      if (page.nextCursor === null) break;
      if (cursors.has(page.nextCursor)) {
        throw new Error("thread/turns/list returned a repeated cursor.");
      }
      cursor = page.nextCursor;
      cursors.add(cursor);
    } while (cursor !== undefined);
    return { threadId: providerThreadId, turns, historyCoverage: "complete" };
  }

  /**
   * Rewind to an absolute turn boundary. Rollback was deprecated in 0.147 and
   * removed in 0.156. Revert requires paginated history (default from 0.158);
   * legacy threads on newer CLIs therefore need a validated fork.
   */
  async rollbackThread(
    threadId: ThreadId,
    numTurns: number,
    beforeTurnId?: string,
    onAdoptSession?: (session: ProviderSession) => Promise<void>,
  ): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(threadId);
    const providerThreadId = readResumeCursorThreadId(context.session.resumeCursor);
    if (!providerThreadId) throw new Error("Session is missing a provider resume thread id.");
    if (!Number.isInteger(numTurns) || numTurns < 1)
      throw new Error("numTurns must be an integer >= 1.");
    if (context.unsettledFork)
      throw new Error(
        "An earlier thread/fork never answered and may have created an orphan. Restart the Codex session before retrying.",
      );
    if (context.unsettledCountRollback)
      throw new Error(
        "An earlier thread/rollback for this session never answered and may still apply. Restart the Codex session before retrying.",
      );

    let boundaryTurnId = beforeTurnId;
    let expectedRemainingTurnIds: string[] | undefined;
    const resolveBoundary = async () => {
      const snapshot = await this.readThread(threadId);
      if (numTurns > snapshot.turns.length) {
        throw new Error(
          `Cannot drop ${numTurns} turns from a thread with ${snapshot.turns.length} turns; refusing a count-based rollback.`,
        );
      }
      const boundary = snapshot.turns[snapshot.turns.length - numTurns]!.id;
      if (boundaryTurnId !== undefined && boundary !== boundaryTurnId) {
        throw new Error(
          "Thread history no longer ends with the turns to drop; refusing a count-based rollback.",
        );
      }
      boundaryTurnId = boundary;
      expectedRemainingTurnIds = snapshot.turns.slice(0, -numTurns).map((turn) => turn.id);
    };
    if (boundaryTurnId === undefined) await resolveBoundary();

    if (selectCodexRewindStrategy(context, providerThreadId) === "revert") {
      let response: unknown;
      let succeeded = false;
      try {
        response = await this.sendRequest(
          context,
          "thread/revert",
          buildCodexThreadRevertParams(providerThreadId, boundaryTurnId!),
        );
        succeeded = true;
      } catch (error) {
        if (isUnknownMethodError(error, "thread/revert")) context.revertUnsupported = true;
        else if (isCodexLegacyHistoryRevertError(error)) {
          (context.legacyHistoryThreadIds ??= new Set()).add(providerThreadId);
        } else throw error;
      }
      if (succeeded) {
        const revertedId = normalizeProviderThreadId(
          this.readString(this.readObject(response)?.thread, "id"),
        );
        const { rewindSourceThreadId: _previousSource, ...currentCursor } =
          this.readObject(context.session.resumeCursor) ?? {};
        if (revertedId && revertedId !== providerThreadId) {
          if (expectedRemainingTurnIds === undefined) await resolveBoundary();
          const snapshot = await this.readPaginatedThread(context, revertedId);
          if (
            snapshot.turns.length !== expectedRemainingTurnIds!.length ||
            snapshot.turns.some((turn, index) => turn.id !== expectedRemainingTurnIds![index])
          )
            throw new Error(
              "thread/revert retained history does not match the rewind boundary; refusing adoption.",
            );
          const resumeCursor = {
            ...currentCursor,
            threadId: revertedId,
            rewindSourceThreadId: providerThreadId,
          };
          const { activeTurnId: _activeTurnId, ...idleSession } = context.session;
          await onAdoptSession?.({ ...idleSession, status: "ready", resumeCursor });
          this.updateSession(context, { status: "ready", activeTurnId: undefined, resumeCursor });
          return snapshot;
        }
        const { activeTurnId: _activeTurnId, ...idleSession } = context.session;
        await onAdoptSession?.({ ...idleSession, status: "ready", resumeCursor: currentCursor });
        this.updateSession(context, {
          status: "ready",
          activeTurnId: undefined,
          ...(_previousSource ? { resumeCursor: currentCursor } : {}),
        });
        return this.readThread(threadId);
      }
    }

    // Resolve this even when unsupported-method flags were cached by a prior rewind.
    if (expectedRemainingTurnIds === undefined) await resolveBoundary();
    if (selectCodexRewindStrategy(context, providerThreadId) === "rollback") {
      let response: unknown;
      let succeeded = false;
      try {
        response = await this.sendRequest(context, "thread/rollback", {
          threadId: providerThreadId,
          numTurns,
        });
        succeeded = true;
      } catch (error) {
        if (isUnknownMethodError(error, "thread/rollback")) context.rollbackUnsupported = true;
        else {
          if (!(error instanceof CodexJsonRpcError)) context.unsettledCountRollback = true;
          throw error;
        }
      }
      if (succeeded) {
        this.updateSession(context, { status: "ready", activeTurnId: undefined });
        await onAdoptSession?.(context.session);
        return this.parseThreadSnapshot("thread/rollback", response);
      }
    }

    const config = context.configuredBase;
    const forkParams = buildCodexThreadForkParams(
      {
        ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
        ...(context.session.model ? { model: context.session.model } : {}),
        ...(typeof config?.serviceTier === "string" ? { serviceTier: config.serviceTier } : {}),
        runtimeMode: context.session.runtimeMode,
        ...(context.workflowExecutionProfile
          ? { workflowExecutionProfile: context.workflowExecutionProfile }
          : {}),
        ...(context.readOnlyMode ? { readOnlyMode: context.readOnlyMode } : {}),
      },
      providerThreadId,
      boundaryTurnId!,
    );
    // The server chooses the fork id. Buffer foreign events until the response
    // reveals it; registration by guessed id could route unrelated child events.
    context.forkNotifications = [];
    context.forkNotificationOverflow = false;
    let forkedId: string | undefined;
    try {
      let response: unknown;
      try {
        response = await this.forkWithArchivedRecovery(
          context,
          forkParams,
          async (method, params) => {
            try {
              return await this.sendRequest(context, method, params);
            } catch (error) {
              if (method === "thread/fork" && !(error instanceof CodexJsonRpcError)) {
                context.unsettledFork = true;
              }
              throw error;
            }
          },
        );
      } catch (error) {
        if (context.unsettledFork) {
          await this.runPromise(
            Effect.logWarning("Codex rewind fork response lost; possible orphan", {
              threadId,
              providerThreadId,
            }),
          );
        }
        throw error;
      }
      forkedId = normalizeProviderThreadId(
        this.readString(this.readObject(response)?.thread, "id"),
      );
      if (!forkedId || forkedId === providerThreadId)
        throw new Error("thread/fork returned an invalid fork id; refusing adoption.");
      const snapshot = await this.readPaginatedThread(context, forkedId);
      if (context.forkNotificationOverflow) {
        await this.runPromise(
          Effect.logWarning("Codex rewind fork event buffer overflow; possible orphan", {
            threadId,
            forkedId,
          }),
        );
        throw new Error(
          `thread/fork event buffer overflow; refusing adoption of possible orphan ${forkedId}.`,
        );
      }
      if (
        snapshot.turns.length !== expectedRemainingTurnIds!.length ||
        snapshot.turns.some((turn, index) => turn.id !== expectedRemainingTurnIds![index])
      ) {
        throw new Error(
          "thread/fork retained history does not match the rewind boundary; refusing adoption.",
        );
      }
      const resumeCursor = {
        ...this.readObject(context.session.resumeCursor),
        threadId: forkedId,
        rewindSourceThreadId: providerThreadId,
      };
      // Save before exposing the new identity locally. If persistence fails,
      // recovery must not complete against an adopted but undurable cursor.
      const { activeTurnId: _activeTurnId, ...idleSession } = context.session;
      await onAdoptSession?.({ ...idleSession, status: "ready", resumeCursor });
      this.updateSession(context, { status: "ready", activeTurnId: undefined, resumeCursor });
      const notifications = context.forkNotifications;
      context.forkNotifications = undefined;
      for (const notification of notifications) {
        if (readNotificationProviderThreadId(notification.params) === forkedId) {
          this.handleServerNotification(context, notification);
        }
      }
      const auxiliaryCount = notifications.filter(
        (notification) => readNotificationProviderThreadId(notification.params) !== forkedId,
      ).length;
      if (auxiliaryCount)
        await this.runPromise(
          Effect.logDebug("Ignoring buffered Codex auxiliary-thread notifications", {
            threadId,
            count: auxiliaryCount,
          }),
        );
      context.legacyHistoryThreadIds?.delete(providerThreadId);
      try {
        await this.sendRequest(context, "thread/unsubscribe", { threadId: providerThreadId });
      } catch (error) {
        await this.runPromise(
          Effect.logDebug("Codex old thread unsubscribe failed", {
            threadId,
            detail: String(error),
          }),
        );
      }
      return this.readThread(threadId);
    } finally {
      context.forkNotifications = undefined;
      context.forkNotificationOverflow = false;
    }
  }

  async respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pendingRequest = context.pendingApprovals.get(requestId);
    if (!pendingRequest) {
      throw new Error(`Unknown pending approval request: ${requestId}`);
    }

    let correlation = (
      context.nativeRequestCorrelations as Map<string, NativeRequestCorrelation> | undefined
    )?.get(String(pendingRequest.jsonRpcId));
    if (!correlation) {
      correlation = {
        nativeRequestId: String(pendingRequest.jsonRpcId),
        requestId: pendingRequest.requestId,
        method: pendingRequest.method,
        requestKind: pendingRequest.requestKind,
        responseChannel: "approval",
        ...(pendingRequest.turnId ? { turnId: pendingRequest.turnId } : {}),
        ...(pendingRequest.itemId ? { itemId: pendingRequest.itemId } : {}),
        resolvedLocally: false,
      };
      this.rememberNativeRequestCorrelation(context, correlation);
    }
    await this.writeMessage(context, {
      id: pendingRequest.jsonRpcId,
      result: codexApprovalResponse(pendingRequest, decision),
    });
    // A provider-side cancellation can race the write while it is in flight.
    // In that case the server resolution owns the row and has already cleared
    // the pending request.
    if (!context.pendingApprovals.has(requestId)) {
      return;
    }
    this.markNativeRequestResolvedLocally(context, correlation);
    context.pendingApprovals.delete(requestId);
    // Only an explicit session answer allows the kind. An "always" answer is an execpolicy rule
    // for one command prefix and must not widen into every command.
    if (decision === "acceptForSession")
      pendingRequest.sessionAllowance?.add(pendingRequest.requestKind);

    this.emitEvent({
      ...context.mcpEventIdentity,
      id: EventId.makeUnsafe(timeOrderedUuid()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "item/requestApproval/decision",
      turnId: pendingRequest.turnId,
      itemId: pendingRequest.itemId,
      requestId: pendingRequest.requestId,
      requestKind: pendingRequest.requestKind,
      payload: {
        requestId: pendingRequest.requestId,
        requestKind: pendingRequest.requestKind,
        requestMethod: pendingRequest.method,
        ...(pendingRequest.requestedPermissions
          ? { requestedPermissions: pendingRequest.requestedPermissions }
          : {}),
        decision,
      },
    });
  }

  async respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pendingRequest = context.pendingUserInputs.get(requestId);
    if (!pendingRequest) {
      throw new Error(`Unknown pending user input request: ${requestId}`);
    }

    let correlation = (
      context.nativeRequestCorrelations as Map<string, NativeRequestCorrelation> | undefined
    )?.get(String(pendingRequest.jsonRpcId));
    if (!correlation) {
      correlation = {
        nativeRequestId: String(pendingRequest.jsonRpcId),
        requestId: pendingRequest.requestId,
        method: "item/tool/requestUserInput",
        responseChannel: "user-input",
        ...(pendingRequest.turnId ? { turnId: pendingRequest.turnId } : {}),
        ...(pendingRequest.itemId ? { itemId: pendingRequest.itemId } : {}),
        resolvedLocally: false,
      };
      this.rememberNativeRequestCorrelation(context, correlation);
    }
    const codexAnswers = toCodexUserInputAnswers(answers);
    await this.writeMessage(context, {
      id: pendingRequest.jsonRpcId,
      result: {
        answers: codexAnswers,
      },
    });
    if (!context.pendingUserInputs.has(requestId)) {
      return;
    }
    this.markNativeRequestResolvedLocally(context, correlation);
    context.pendingUserInputs.delete(requestId);

    this.emitEvent({
      ...context.mcpEventIdentity,
      id: EventId.makeUnsafe(timeOrderedUuid()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "item/tool/requestUserInput/answered",
      turnId: pendingRequest.turnId,
      itemId: pendingRequest.itemId,
      requestId: pendingRequest.requestId,
      payload: {
        requestId: pendingRequest.requestId,
        answers: codexAnswers,
      },
    });
  }

  /**
   * Delivers a private MCP form/URL answer. Values go straight to the native
   * JSON-RPC response; no event, log or correlation keeps them.
   */
  async respondToElicitation(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    response: { readonly action: ElicitationAction; readonly content?: unknown },
  ): Promise<"submitted"> {
    const context = this.requireSession(threadId);
    const registry = context.elicitations;
    if (!registry?.has(requestId))
      throw new Error(`Unknown pending elicitation request: ${requestId}`);
    try {
      return await registry.submit(requestId, response);
    } catch (error) {
      if (error instanceof ElicitationDeliveryUncertainError)
        this.settleElicitation(context, requestId, "aborted");
      throw error;
    }
  }

  private openElicitation(context: CodexSessionContext, request: JsonRpcRequest): void {
    const params = asObject(request.params);
    const mode = asString(params?.mode);
    const descriptor = buildElicitationDescriptor({
      mode: mode === "openaiForm" ? "openai/form" : mode,
      message: params?.message ?? params?.description,
      serverName: params?.serverName,
      title: params?.title,
      nativeId: params?.elicitationId,
      requestedSchema: params?.requestedSchema,
      url: params?.url,
    });
    const registry = context.elicitations;
    if (!descriptor.ok || !registry) {
      this.writeServerRequestResponse(context, {
        id: request.id,
        result: { action: "cancel", content: null, _meta: null },
      });
      this.emitUnsupportedServerRequestWarning(
        context,
        request,
        `An MCP server asked for input F5 cannot show completely (${
          descriptor.ok ? "no form support" : descriptor.reason
        }); it was cancelled without submitting data.`,
      );
      return;
    }
    const route = this.readRouteFields(request.params);
    const requestId = ApprovalRequestId.makeUnsafe(randomUUID());
    registry.open({
      requestId,
      descriptor: descriptor.value,
      turnId: route.turnId,
      deliver: async (answer) => {
        try {
          await this.writeMessage(context, {
            id: request.id,
            result: { action: answer.action, content: answer.content ?? null, _meta: null },
          });
        } catch {
          throw new ElicitationDeliveryUncertainError();
        }
      },
    });
    this.rememberNativeRequestCorrelation(context, {
      nativeRequestId: String(request.id),
      requestId,
      method: request.method,
      requestKind: "mcp-elicitation",
      responseChannel: "elicitation",
      ...(route.turnId ? { turnId: route.turnId } : {}),
      ...(route.itemId ? { itemId: route.itemId } : {}),
      resolvedLocally: false,
    });
    this.emitEvent({
      ...context.mcpEventIdentity,
      id: EventId.makeUnsafe(timeOrderedUuid()),
      kind: "request",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: CODEX_ELICITATION_OPENED_METHOD,
      turnId: route.turnId,
      itemId: route.itemId,
      requestId,
      requestKind: "mcp-elicitation",
      payload: { elicitation: descriptor.value },
    });
  }

  private settleElicitation(
    context: CodexSessionContext,
    requestId: ApprovalRequestId,
    outcome: "completed" | "aborted",
  ): void {
    const receipt = context.elicitations?.settle(requestId, outcome);
    if (receipt) this.emitElicitationReceipt(context, requestId, receipt);
  }

  private emitElicitationReceipt(
    context: CodexSessionContext,
    requestId: ApprovalRequestId,
    receipt: ElicitationTerminalReceipt,
  ): void {
    this.emitEvent({
      ...context.mcpEventIdentity,
      id: EventId.makeUnsafe(timeOrderedUuid()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: CODEX_ELICITATION_SETTLED_METHOD,
      requestId,
      requestKind: "mcp-elicitation",
      payload: { receipt },
    });
  }

  private abortElicitations(context: CodexSessionContext): void {
    for (const { requestId, receipt } of context.elicitations?.abortAll() ?? [])
      this.emitElicitationReceipt(context, requestId, receipt);
  }

  /**
   * Reloads MCP config and returns the status the session observes
   * afterwards, or undefined when this Codex build cannot list it.
   */
  async reloadMcpConfig(
    threadId: ThreadId,
  ): Promise<ReadonlyArray<Record<string, unknown>> | undefined> {
    const context = this.requireSession(threadId);
    context.mcpStartupStatuses?.clear();
    context.mcpObservationContext = {};
    await this.sendRequest<Record<string, never>>(context, "config/mcpServer/reload", undefined);
    try {
      const listing = await this.getMcpServerStatuses(threadId);
      return listing.complete ? listing.entries.map((entry) => ({ ...entry })) : undefined;
    } catch {
      return undefined;
    }
  }

  browserResumeAvailable(threadId: ThreadId): boolean {
    return this.sessions.get(threadId)?.browserResumeRegistered === true;
  }

  async waitForMcpIdle(
    threadId: ThreadId,
    deadline: number,
    check: () => Promise<void>,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    await waitForControl(
      () => !context.mcpCalls?.size,
      deadline,
      async () => {
        if (!this.isLiveContext(context)) throw new Error("The Codex session ended.");
        await check();
      },
      () => "An MCP call is still running; retry browser_resume once it finishes.",
    );
  }

  private readonly mcpAppIdentities = new WeakMap<object, string>();
  getMcpAppSessionIdentity(threadId: ThreadId): string {
    const context = this.requireSession(threadId);
    if (!this.isLiveContext(context) || !["ready", "running"].includes(context.session.status))
      throw new Error("Send a message to reconnect.");
    const observation = this.getMcpObservationContext(threadId);
    let identity = this.mcpAppIdentities.get(observation);
    if (!identity) {
      identity = randomUUID();
      this.mcpAppIdentities.set(observation, identity);
    }
    return identity;
  }

  /** App calls use the already-running session and never start or recover one. */
  async callMcpAppTool(
    threadId: ThreadId,
    server: string,
    tool: string,
    args: Record<string, unknown>,
    expectedIdentity: string,
    approved: boolean,
  ): Promise<unknown> {
    const context = this.requireSession(threadId);
    if (!this.isLiveContext(context) || !["ready", "running"].includes(context.session.status))
      throw new Error("Send a message to reconnect.");
    if (
      !server.trim() ||
      server.length > 256 ||
      !tool.trim() ||
      tool.length > 256 ||
      stringifyWithinBytes(args, 65536) === undefined
    )
      throw new Error("Invalid MCP app tool request.");
    const generation = this.getMcpObservationContext(threadId);
    if (this.getMcpAppSessionIdentity(threadId) !== expectedIdentity)
      throw new Error("The MCP app session changed before approval was used.");
    const listing = await this.getMcpServerStatuses(threadId, { deadline: Date.now() + 10000 });
    const policy = findMcpAppToolPolicy(
      Object.values(listing.entries.find((entry) => entry.name === server)?.tools ?? {}),
      tool,
    );
    if (!listing.complete || !policy || (!approved && !policy.readOnlyHint))
      throw new Error("The MCP app tool needs approval or is unavailable.");
    if (
      !this.isLiveContext(context) ||
      generation !== this.getMcpObservationContext(threadId) ||
      this.getMcpAppSessionIdentity(threadId) !== expectedIdentity
    )
      throw new Error("The MCP app session changed before dispatch.");
    const result = await this.sendRequest(
      context,
      "mcpServer/tool/call",
      { threadId: this.nativeThreadId(context), server, tool, arguments: args },
      30000,
    );
    if (!this.isLiveContext(context) || generation !== this.getMcpObservationContext(threadId))
      throw new Error(
        "The MCP app session changed; the tool outcome is unknown. Do not retry automatically.",
      );
    return result;
  }

  /** The live session's `codex app-server` process id, the parent of its stdio MCP servers. */
  codexProcessId(threadId: ThreadId): number | undefined {
    const context = this.sessions.get(threadId);
    return context && this.isLiveContext(context) ? context.child.pid : undefined;
  }

  /** Codex's own thread id for the session (its turn metadata's `session_id`). */
  providerThreadId(threadId: ThreadId): string | undefined {
    const context = this.sessions.get(threadId);
    return context ? readResumeCursorThreadId(context.session.resumeCursor) : undefined;
  }

  /**
   * F5's own call to one of the session's MCP tools, outside the model's turn. Codex only
   * allows tools in the server's `enabled_tools`; `meta` becomes the call's `_meta`.
   */
  async callMcpServerTool(
    threadId: ThreadId,
    server: string,
    tool: string,
    args: Record<string, unknown>,
    meta: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<unknown> {
    const context = this.requireSession(threadId);
    if (!this.isLiveContext(context)) throw new Error("The session isn't running.");
    return this.sendRequest(
      context,
      "mcpServer/tool/call",
      {
        threadId: this.nativeThreadId(context),
        server,
        tool,
        arguments: args,
        ...(Object.keys(meta).length ? { _meta: meta } : {}),
      },
      timeoutMs,
    );
  }

  async readMcpAppResource(
    threadId: ThreadId,
    server: string,
    uri: string,
    expectedIdentity?: string,
    routing?: import("@t3tools/contracts").McpResourceRouting,
  ): Promise<unknown> {
    const context = this.requireSession(threadId);
    if (routing?.target && !supportsCodexRelease6(context.cliVersion))
      throw new Error("Account-targeted MCP resources require Codex 0.170.0 or later.");
    if (!this.isLiveContext(context) || !["ready", "running"].includes(context.session.status))
      throw new Error("Send a message to reconnect.");
    if (!server.trim() || server.length > 256 || !uri.trim() || uri.length > 4096)
      throw new Error("Invalid MCP app resource request.");
    const generation = this.getMcpObservationContext(threadId);
    if (
      expectedIdentity !== undefined &&
      this.getMcpAppSessionIdentity(threadId) !== expectedIdentity
    )
      throw new Error("The MCP app session changed before capture.");
    const result = await this.sendRequest(
      context,
      "mcpServer/resource/read",
      buildCodexResourceReadParams(
        this.nativeThreadId(context),
        server,
        uri,
        supportsCodexRelease6(context.cliVersion) ? routing : undefined,
      ),
      10000,
    );
    if (!this.isLiveContext(context) || generation !== this.getMcpObservationContext(threadId))
      throw new Error("The MCP app session changed.");
    return result;
  }

  getMcpObservationContext(threadId: ThreadId): object {
    const context = this.requireSession(threadId);
    return (context.mcpObservationContext ??= {});
  }

  async getMcpServerStatuses(
    threadId: ThreadId,
    options: { signal?: AbortSignal; deadline?: number } = {},
  ) {
    const context = this.requireSession(threadId);
    const observationContext = this.getMcpObservationContext(threadId);
    const result = await readBoundedPages<CodexControlMcpServerStatus>({
      label: "mcpServerStatus/list",
      allowMissingCursor: true,
      maxItems: 1000,
      maxPageItems: 100,
      initialFailureIsPartial: true,
      ...options,
      request: (cursor, remaining) =>
        this.sendRequest(
          context,
          "mcpServerStatus/list",
          { limit: 100, ...(cursor ? { cursor } : {}) },
          Math.min(10_000, remaining),
        ),
      decode: decodeCodexMcpServerStatus,
    });
    if (
      !this.isLiveContext(context) ||
      observationContext !== this.getMcpObservationContext(threadId)
    )
      throw new Error("The MCP observation was superseded.");
    return {
      ...result,
      entries: mergeCodexMcpStartupStatuses(result.entries, [
        ...(context.mcpStartupStatuses?.values() ?? []),
      ]),
    };
  }

  stopSession(threadId: ThreadId): void {
    const worker = this.oneOffWorkers.get(threadId);
    if (worker) {
      clearTimeout(worker.idleTimer);
      this.oneOffWorkers.delete(threadId);
    }
    const context = this.sessions.get(threadId);
    if (!context) {
      return;
    }

    context.stopping = true;

    const error = new Error("Session stopped before request completed.");
    this.failPendingRequests(context, error);
    this.abortElicitations(context);
    context.writer.close(error);
    context.beginDrain?.(error, "session/closed", "Session stopped");

    if (!context.child.killed) {
      killChildTree(context.child);
    }

    if (!context.beginDrain) {
      context.output.close();
      if (this.sessions.get(threadId) === context) this.sessions.delete(threadId);
    }
  }

  /** Thread sessions only; one-off app-servers are internal and never bound to a thread. */
  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values())
      .filter(
        ({ session, phase }) =>
          phase !== "draining" && !isSyntheticOneOffThreadId(session.threadId),
      )
      .map(({ session }) => ({ ...session }));
  }

  hasSession(threadId: ThreadId): boolean {
    const context = this.sessions.get(threadId);
    return context !== undefined && context.phase !== "draining";
  }

  /** The working directory of a read-only workflow stage's session, or undefined for any other. */
  readOnlyStageCwd(threadId: ThreadId): string | undefined {
    const context = this.sessions.get(threadId);
    return context?.workflowExecutionProfile ? context.session.cwd : undefined;
  }

  /** Native discovery state: the skills catalog is Codex's session command catalog. */
  getSessionDiscovery(
    threadId: ThreadId,
  ):
    | { readonly outcome: "pending" | "discovered" | "failed"; readonly nativeCommands?: boolean }
    | undefined {
    const context = this.sessions.get(threadId);
    if (!context || context.stopping) return undefined;
    if (context.skillsLoaded) return { outcome: "discovered", nativeCommands: true };
    // After the one retry a missing catalog is final for this session.
    return context.initialSkillsRetryAttempted && !context.skillRefreshInFlight
      ? { outcome: "failed", nativeCommands: false }
      : { outcome: "pending" };
  }

  stopAll(): void {
    for (const threadId of this.sessions.keys()) {
      this.stopSession(threadId);
    }
  }

  async shutdown(deadline = Date.now() + 1_800): Promise<void> {
    this.shutdownDeadline = deadline;
    this.stopAll();
    const timer = setTimeout(
      () => {
        for (const finish of this.sourceDrains.values()) finish();
      },
      Math.max(0, deadline - Date.now()),
    );
    try {
      await Promise.all([...this.sourceDrains.keys()]);
    } finally {
      clearTimeout(timer);
    }
  }

  private requireSession(threadId: ThreadId): CodexSessionContext {
    const context = this.sessions.get(threadId);
    if (!context) {
      throw new Error(`Unknown session for thread: ${threadId}`);
    }

    if (context.session.status === "closed" || context.phase === "draining") {
      throw new Error(`Session is closed for thread: ${threadId}`);
    }

    return context;
  }

  private failPendingRequests(context: CodexSessionContext, error: Error): void {
    for (const pending of context.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(
        new JsonRpcDeliveryError(
          error.message,
          pending.wasWritten === false ? "not_sent" : "unknown",
        ),
      );
      pending.cancelWrite?.();
    }
    context.pending.clear();
    context.pendingApprovals.clear();
    context.pendingUserInputs.clear();
    context.nativeRequestCorrelations.clear();
    this.clearInitialSkillsRetry(context);
  }

  private attachProcessListeners(context: CodexSessionContext): void {
    const drained = Promise.withResolvers<void>();
    const stderr = new Utf8Lines(1024 * 1024, "truncate");
    const stderrDecoder = new StringDecoder("utf8");
    let stderrTail = "";
    let exitMessage: string | undefined;
    let processExitTerminal = false;
    const withStderr = (message: string) => {
      const excerpt = stderrExcerpt(stderrTail);
      return excerpt ? `${message} ${excerpt}` : message;
    };
    let stdoutClosed = false;
    let stderrClosed = false;
    let finishing = false;
    let terminal: { method: string; message: string } | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let exitStatusGrace: ReturnType<typeof setTimeout> | undefined;
    let endedByStdoutClose = false;
    const isCurrent = () => this.sessions.get(context.session.threadId) === context;
    const acceptsOutput = () => context.phase !== "closed";
    const emitStderr = (line: string) => {
      if (!acceptsOutput()) return;
      const classified = classifyCodexStderrLine(line);
      if (classified) this.emitErrorEvent(context, "process/stderr", classified.message);
    };
    const onStderr = (chunk: Buffer) => {
      stderrTail = appendStderrTail(stderrTail, stderrDecoder.write(chunk));
      for (const line of stderr.push(chunk)) emitStderr(line);
    };
    const onLine = (line: string) => {
      if (acceptsOutput()) this.handleStdoutLine(context, line);
    };
    const finish = () => {
      if (!terminal || context.phase === "closed" || finishing) return;
      finishing = true;
      if (deadline) clearTimeout(deadline);
      if (exitStatusGrace) clearTimeout(exitStatusGrace);
      // A descendant can hold stdout open after the provider exits. Finish
      // bytes already received while the context still accepts notifications.
      context.output.finish();
      for (const line of stderr.finish()) emitStderr(line);
      stderrTail = appendStderrTail(stderrTail, stderrDecoder.end());
      if (exitMessage && processExitTerminal) {
        const previousMessage = terminal.message;
        terminal.message = withStderr(exitMessage);
        if (context.session.lastError === previousMessage && isCurrent())
          this.updateSession(context, { lastError: terminal.message });
      }
      context.phase = "closed";
      this.sourceDrains.delete(drained.promise);
      drained.resolve();
      context.output.off("line", onLine);
      context.output.off("overflow", onOutputOverflow);
      context.output.off("close", onStdoutClose);
      context.child.stderr.off("data", onStderr);
      context.child.stderr.off("end", onStderrClose);
      context.child.stderr.off("close", onStderrClose);
      context.child.off("exit", onExit);
      context.child.off("close", onClose);
      context.child.off("error", onError);
      const retiredTurnId = context.session.activeTurnId;
      this.updateSession(context, { status: "closed", activeTurnId: undefined });
      this.emitLifecycleEvent(context, terminal.method, terminal.message, retiredTurnId);
      if (isCurrent()) this.sessions.delete(context.session.threadId);
      context.output.close();
      // Descendants can inherit pipes after the provider exits. At EOF/the
      // deadline, release those handles instead of keeping shutdown alive.
      context.child.stdout?.destroy?.();
      context.child.stderr.destroy?.();
      context.child.stdin?.destroy?.();
    };
    this.sourceDrains.set(drained.promise, finish);
    const maybeFinish = () => {
      if (stdoutClosed && stderrClosed) finish();
    };
    const onStdoutClose = () => {
      stdoutClosed = true;
      if (!terminal && context.phase !== "closed" && !exitStatusGrace) {
        // Node ends stdout before it reports the exit of a crashed process, so
        // wait briefly for the exit status. stdout can also close while the
        // process keeps running; no response can arrive then, so end the session.
        exitStatusGrace = setTimeout(() => {
          if (terminal || context.phase === "closed") return;
          endedByStdoutClose = true;
          beginDrain(
            new Error(CODEX_STDOUT_ENDED_MESSAGE),
            "session/exited",
            CODEX_STDOUT_ENDED_MESSAGE,
          );
          if (!context.child.killed) killChildTree(context.child);
        }, CODEX_EXIT_STATUS_GRACE_MS);
        exitStatusGrace.unref?.();
      }
      maybeFinish();
    };
    const onStderrClose = () => {
      stderrClosed = true;
      maybeFinish();
    };
    const beginDrain = (error: Error, method: string, message: string) => {
      // Written RPCs reject immediately on exit, even if a response remains in
      // the pipe. Notifications keep draining until EOF or the shared budget.
      if (exitStatusGrace) clearTimeout(exitStatusGrace);
      this.failPendingRequests(context, error);
      this.abortElicitations(context);
      context.writer.close(error);
      if (terminal || context.phase === "closed") return;
      terminal = { method, message };
      context.phase = "draining";
      deadline = setTimeout(
        finish,
        Math.max(0, (this.shutdownDeadline ?? Date.now() + 1_800) - Date.now()),
      );
      deadline.unref?.();
      maybeFinish();
    };
    const onError = (error: Error) => {
      if (!terminal && isCurrent()) {
        this.updateSession(context, { status: "error", lastError: error.message });
        this.emitErrorEvent(context, "process/error", error.message);
      }
      beginDrain(error, "session/exited", error.message);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      exitMessage = `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
      const message = withStderr(exitMessage);
      if (!terminal || (endedByStdoutClose && !finishing && signal === null))
        processExitTerminal = true;
      // An exit code that arrives after the stdout grace period still describes
      // how the process ended. A signal is usually the kill that followed.
      if (endedByStdoutClose && !finishing && signal === null) {
        endedByStdoutClose = false;
        terminal = { method: "session/exited", message };
        if (code !== 0 && isCurrent()) this.updateSession(context, { lastError: message });
      }
      if (!terminal && code !== 0 && isCurrent())
        this.updateSession(context, { lastError: message });
      beginDrain(new Error(message), "session/exited", message);
    };
    const onClose = () => {
      stdoutClosed = stderrClosed = true;
      finish();
      context.child.off("error", onError);
    };
    // The reader stops at the cap; the session cannot resynchronize mid-message, so it ends.
    const onOutputOverflow = () => {
      const message = `codex app-server sent a message larger than ${CODEX_MAX_INCOMING_MESSAGE_BYTES} bytes; the session was ended.`;
      onError(new Error(message));
      if (!context.child.killed) killChildTree(context.child);
    };
    context.beginDrain = beginDrain;
    context.output.on("overflow", onOutputOverflow);
    context.output.on("line", onLine);
    context.output.on("close", onStdoutClose);
    context.child.stderr.on("data", onStderr);
    context.child.stderr.on("end", onStderrClose);
    context.child.stderr.on("close", onStderrClose);
    context.child.on("error", onError);
    context.child.on("exit", onExit);
    context.child.on("close", onClose);
  }

  private handleStdoutLine(context: CodexSessionContext, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      const diagnostics = this.protocolDecodeFailureDiagnostics(context, line);
      this.emitErrorEvent(
        context,
        "protocol/parseError",
        "Received invalid JSON from codex app-server.",
        diagnostics,
      );
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      const diagnostics = this.protocolDecodeFailureDiagnostics(context, line);
      this.emitErrorEvent(
        context,
        "protocol/invalidMessage",
        "Received non-object protocol message.",
        diagnostics,
      );
      return;
    }

    if (this.isServerRequest(parsed)) {
      this.handleServerRequest(context, parsed);
      return;
    }

    if (this.isServerNotification(parsed)) {
      this.handleServerNotification(context, parsed);
      return;
    }

    if (this.isResponse(parsed)) {
      this.handleResponse(context, parsed);
      return;
    }

    this.emitErrorEvent(
      context,
      "protocol/unrecognizedMessage",
      "Received protocol message in an unknown shape.",
      this.protocolDecodeFailureDiagnostics(context, line),
    );
  }

  /**
   * Compaction rebuilds history from user messages and Codex's own context,
   * which drops F5's `additionalContext` messages. Codex resends an entry only
   * when its value changes, so without this the F5 contract would stay lost
   * for the rest of the session. The one-time resumed context is not restored.
   */
  private restoreAdditionalContext(context: CodexSessionContext, providerThreadId: string): void {
    const entries = Object.entries(context.lastAdditionalContext ?? {}).filter(
      ([key]) => !key.startsWith(CODEX_RESUMED_CONTEXT_KEY),
    );
    if (entries.length === 0 || !this.isLiveContext(context)) return;
    void this.sendRequest(context, "thread/inject_items", {
      threadId: providerThreadId,
      items: entries.map(([key, entry]) => ({
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: `<${key}>${entry.value}</${key}>` }],
      })),
    }).catch((cause: unknown) =>
      Effect.logWarning("failed to restore Codex additional context after compaction", {
        threadId: context.session.threadId,
        cause: cause instanceof Error ? cause.message : String(cause),
      }).pipe(this.runPromise),
    );
  }

  private retireMcpCalls(context: CodexSessionContext, threadId: string, turnId: string): void {
    const key = JSON.stringify([threadId, turnId]);
    context.retiredMcpTurns ??= new Set();
    context.retiredMcpTurns.add(key);
    if (context.retiredMcpTurns.size > 256)
      context.retiredMcpTurns.delete(context.retiredMcpTurns.values().next().value!);
    for (const [id, owner] of context.mcpCallOwners ?? []) {
      if (owner.threadId === threadId && owner.turnId === turnId) {
        context.mcpCalls?.delete(id);
        context.mcpCallOwners?.delete(id);
      }
    }
  }

  private handleServerNotification(
    context: CodexSessionContext,
    notification: JsonRpcNotification,
  ): void {
    if (notification.method === "item/started" || notification.method === "item/completed") {
      const params = asObject(notification.params);
      const item = asObject(params?.item);
      if (item?.type === "mcpToolCall" && typeof item.id === "string") {
        const threadId =
          readNotificationProviderThreadId(notification.params) ??
          readResumeCursorThreadId(context.session.resumeCursor);
        const turnId =
          this.readRouteFields(notification.params).turnId ?? context.session.activeTurnId;
        context.mcpCalls ??= new Set();
        context.mcpCallOwners ??= new Map();
        if (
          notification.method === "item/started" &&
          threadId &&
          turnId &&
          !context.retiredMcpThreads?.has(threadId) &&
          !context.retiredMcpTurns?.has(JSON.stringify([threadId, turnId]))
        ) {
          context.mcpCalls.add(item.id);
          context.mcpCallOwners.set(item.id, { threadId, turnId });
        } else if (notification.method === "item/completed") {
          context.mcpCalls.delete(item.id);
          context.mcpCallOwners.delete(item.id);
        }
      }
    }
    if (notification.method === "turn/completed") {
      const threadId =
        readNotificationProviderThreadId(notification.params) ??
        readResumeCursorThreadId(context.session.resumeCursor);
      const turnId =
        this.readRouteFields(notification.params).turnId ?? context.session.activeTurnId;
      if (threadId && turnId) this.retireMcpCalls(context, threadId, turnId);
    }
    if (notification.method === "mcpServer/startupStatus/updated") {
      const params = asObject(notification.params);
      const name = asString(params?.name) ?? asString(params?.server);
      const status = asString(params?.status);
      if (
        name &&
        (status === "starting" ||
          status === "ready" ||
          status === "failed" ||
          status === "cancelled" ||
          status === "needs-auth")
      ) {
        context.mcpStartupStatuses ??= new Map();
        context.mcpStartupStatuses.set(name, {
          name,
          startupStatus: status,
          ...(asString(params?.error) ? { error: asString(params?.error)! } : {}),
        });
      }
    }
    if (notification.method === "serverRequest/resolved") {
      const params = asObject(notification.params);
      const nativeRequestIdValue = params?.requestId;
      const nativeRequestId =
        typeof nativeRequestIdValue === "string" || typeof nativeRequestIdValue === "number"
          ? String(nativeRequestIdValue)
          : undefined;
      const correlations = context.nativeRequestCorrelations as
        | Map<string, NativeRequestCorrelation>
        | undefined;
      const correlation = nativeRequestId
        ? (correlations?.get(nativeRequestId) ??
          this.findPendingNativeRequestCorrelation(context, nativeRequestId))
        : undefined;
      if (correlation) {
        correlations?.delete(correlation.nativeRequestId);
        if (correlation.responseChannel === "elicitation") {
          // The native completion correlated with this request: a submitted
          // answer is resolved, an unanswered one was cancelled by Codex.
          this.settleElicitation(context, correlation.requestId, "completed");
          return;
        }
        const requestedPermissions = context.pendingApprovals.get(
          correlation.requestId,
        )?.requestedPermissions;
        if (correlation.responseChannel === "approval") {
          context.pendingApprovals.delete(correlation.requestId);
        } else {
          context.pendingUserInputs.delete(correlation.requestId);
        }

        // We already emitted the canonical local resolution after writing the
        // response. Codex may acknowledge it with serverRequest/resolved; do
        // not append a second row for the same decision.
        if (correlation.resolvedLocally) {
          return;
        }

        this.emitEvent({
          ...context.mcpEventIdentity,
          id: EventId.makeUnsafe(timeOrderedUuid()),
          kind: "notification",
          provider: "codex",
          threadId: context.session.threadId,
          createdAt: new Date().toISOString(),
          method: notification.method,
          ...(correlation.turnId ? { turnId: correlation.turnId } : {}),
          ...(correlation.itemId ? { itemId: correlation.itemId } : {}),
          requestId: correlation.requestId,
          ...(correlation.requestKind ? { requestKind: correlation.requestKind } : {}),
          payload: {
            ...params,
            request: {
              method: correlation.method,
              ...(correlation.requestKind ? { kind: correlation.requestKind } : {}),
            },
            resolutionSource: "server",
            ...(requestedPermissions ? { requestedPermissions } : {}),
          },
        });
        return;
      }

      // A local response correlation may already have aged out of the bounded
      // acknowledgement cache. With no pending prompt left to clear, treating
      // this as a standalone resolution would only create a duplicate row.
      void Effect.logDebug("ignoring uncorrelated Codex server request resolution", {
        threadId: context.session.threadId,
        nativeRequestId,
      }).pipe(this.runPromise);
      return;
    }

    const notificationThread = asObject(asObject(notification.params)?.thread);
    const source = asObject(notificationThread?.source);
    const notificationThreadId = readNotificationProviderThreadId(notification.params);
    if (
      notification.method === "thread/started" &&
      notificationThreadId &&
      (notificationThread?.threadSource === "memory_consolidation" ||
        source?.subAgent === "memory_consolidation")
    ) {
      const memoryThreadIds = (context.memoryThreadIds ??= new Set());
      memoryThreadIds.add(notificationThreadId);
      if (memoryThreadIds.size > 256)
        memoryThreadIds.delete(memoryThreadIds.values().next().value!);
      return;
    }
    if (notificationThreadId && context.memoryThreadIds?.has(notificationThreadId)) {
      if (notification.method === "thread/closed")
        context.memoryThreadIds.delete(notificationThreadId);
      return;
    }

    const primaryProviderThreadId = readResumeCursorThreadId(context.session.resumeCursor);
    const notificationProviderThreadId = readNotificationProviderThreadId(notification.params);
    if (
      primaryProviderThreadId !== undefined &&
      notificationProviderThreadId !== undefined &&
      notificationProviderThreadId !== primaryProviderThreadId &&
      !context.reviewThreadIds?.has(notificationProviderThreadId)
    ) {
      if (context.forkNotifications) {
        if (context.forkNotifications.length < 512) context.forkNotifications.push(notification);
        else context.forkNotificationOverflow = true;
        return;
      }
      // Codex collaboration agents share the parent app-server process, so
      // their notifications arrive on the same stdout stream. They are not
      // turns in the parent F5 thread and must not mutate its lifecycle or
      // conversation projections.
      void Effect.logDebug("ignoring Codex notification for auxiliary provider thread", {
        threadId: context.session.threadId,
        primaryProviderThreadId,
        notificationProviderThreadId,
        method: notification.method,
      }).pipe(this.runPromise);
      return;
    }

    if (notification.method === "thread/readState/changed")
      this.cacheReadState(context, asObject(notification.params)?.readState);
    if (notification.method === "thread/goal/updated") {
      const goal = asObject(asObject(notification.params)?.goal);
      if (goal && goal.status !== "active") context.nativeGoalActive = false;
      if (
        this.isLiveContext(context) &&
        goal?.status === "active" &&
        (!context.nativeGoalActive ||
          (context.nativeGoalBudget !== undefined &&
            typeof goal.tokensUsed === "number" &&
            goal.tokensUsed >= context.nativeGoalBudget)) &&
        !context.nativeGoalPauseInFlight
      ) {
        context.nativeGoalPauseInFlight = true;
        void this.sendRequest(context, "thread/goal/set", {
          threadId: this.nativeThreadId(context),
          status: "paused",
          origin: "automatic",
        })
          .catch(() => {
            if (!this.isLiveContext(context)) return;
            this.emitLifecycleEvent(
              context,
              "session/goalPauseFailed",
              "Native goal could not be paused; its provider session was stopped.",
            );
            this.stopSession(context.session.threadId);
          })
          .finally(() => {
            context.nativeGoalPauseInFlight = false;
          });
      }
    }
    if (notification.method === "thread/goal/cleared") context.nativeGoalActive = false;
    if (notification.method === "thread/name/updated") {
      const title = asObject(notification.params)?.threadName;
      if (typeof title === "string") context.lastProviderTitle = title;
    }
    const item = asObject(asObject(notification.params)?.item);
    if (
      notification.method === "item/completed" &&
      item?.type === "contextCompaction" &&
      notificationProviderThreadId !== undefined &&
      notificationProviderThreadId === primaryProviderThreadId
    ) {
      this.restoreAdditionalContext(context, notificationProviderThreadId);
    }
    if (context.reviewOperationActive && item?.type === "enteredReviewMode") {
      const reviewTurnId = asObject(notification.params)?.turnId;
      if (typeof reviewTurnId === "string") context.nativeReviewTurnId = reviewTurnId;
    }
    const itemType = normalizeCodexThreadItemType(item?.type ?? item?.kind);
    const nativeThreadId = notificationProviderThreadId ?? primaryProviderThreadId;
    const closesThread =
      notification.method === "thread/closed" || notification.method === "thread/deleted";
    if (closesThread && nativeThreadId) {
      const closed = (context.closedNativeThreadIds ??= new Set());
      closed.add(nativeThreadId);
      if (closed.size > 128) closed.delete(closed.values().next().value!);
    }
    if (
      (nativeThreadId
        ? context.closedNativeThreadIds?.has(nativeThreadId)
        : context.session.status === "closed") &&
      (itemType === "command_execution" || notification.method.startsWith("item/commandExecution/"))
    ) {
      return;
    }
    // The adapter may display unscoped activity, but it cannot grant access:
    // only an explicit primary-thread envelope establishes child ownership.
    const activityChildId =
      itemType === "subagent_activity" &&
      primaryProviderThreadId !== undefined &&
      notificationProviderThreadId === primaryProviderThreadId &&
      Schema.is(SubagentActivityKind)(item?.kind) &&
      asString(item?.agentPath ?? item?.agent_path)?.trim()
        ? asString(item?.agentThreadId ?? item?.agent_thread_id)?.trim()
        : undefined;
    const isCollabCall =
      item?.type === "collabAgentToolCall" || item?.type === "collab_agent_tool_call";
    if (item && (isCollabCall || activityChildId)) {
      let childrenChanged = false;
      // Newer Codex runtimes publish subAgentActivity without a collab call.
      // Register only children explicitly reported by this parent, keeping
      // transcript reads fenced by the same persisted session allowlist.
      const children = activityChildId ? [activityChildId] : item.receiverThreadIds;
      if (Array.isArray(children))
        for (const child of children)
          if (typeof child === "string") {
            const ids = (context.childThreadIds ??= new Set());
            if (!ids.has(child)) {
              ids.add(child);
              if (ids.size > 512) ids.delete(ids.values().next().value!);
              childrenChanged = true;
            }
          }
      if (context.childThreadIds && childrenChanged)
        this.updateSession(context, {
          resumeCursor: {
            ...asObject(context.session.resumeCursor),
            childThreadIds: [...context.childThreadIds],
          },
        });
    }
    const route = this.readRouteFields(notification.params);
    // review/start returns the review identity. Certified Codex also emits a
    // transport control turn with another id; keep F5's lifecycle on the review.
    if (notification.method === "turn/started" && context.nativeReviewTurnId)
      route.turnId = TurnId.makeUnsafe(context.nativeReviewTurnId);
    const textDelta =
      notification.method === "item/agentMessage/delta"
        ? this.readString(notification.params, "delta")
        : undefined;
    const completedTier =
      notification.method === "turn/completed" && route.turnId
        ? context.usageServiceTiers?.get(route.turnId)
        : undefined;
    if (notification.method === "turn/started" && route.turnId) {
      const serviceTier = this.readString(
        this.readObject(notification.params, "turn"),
        "serviceTier",
      );
      if (serviceTier) {
        const tiers = (context.usageServiceTiers ??= new Map());
        tiers.set(route.turnId, serviceTier);
        if (tiers.size > 256) tiers.delete(tiers.keys().next().value!);
      }
    }
    if (
      route.turnId &&
      (notification.method === "turn/completed" || notification.method === "turn/aborted")
    )
      context.usageServiceTiers?.delete(route.turnId);

    this.emitEvent({
      ...context.mcpEventIdentity,
      id: EventId.makeUnsafe(timeOrderedUuid()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: notification.method,
      turnId: route.turnId,
      itemId: route.itemId,
      textDelta,
      payload: completedTier
        ? { serviceTier: completedTier, ...asObject(notification.params) }
        : notification.method === "turn/started" && context.nativeReviewTurnId
          ? {
              ...asObject(notification.params),
              turn: {
                ...asObject(asObject(notification.params)?.turn),
                id: context.nativeReviewTurnId,
              },
            }
          : notification.method === "mcpServer/startupStatus/updated"
            ? { ...asObject(notification.params), ...context.mcpEventIdentity }
            : notification.method === "item/completed" || notification.method === "item/started"
              ? {
                  ...asObject(notification.params),
                  item: presentCodexMessageItem(asObject(notification.params)?.item),
                }
              : notification.params,
    });

    if (notification.method === "thread/started") {
      const providerThreadId = normalizeProviderThreadId(
        this.readString(this.readObject(notification.params)?.thread, "id"),
      );
      if (providerThreadId && !context.reviewThreadIds?.has(providerThreadId)) {
        context.closedNativeThreadIds?.delete(providerThreadId);
        this.updateSession(context, {
          resumeCursor: {
            ...this.readObject(context.session.resumeCursor),
            threadId: providerThreadId,
          },
        });
      }
      return;
    }

    if (closesThread) {
      if (
        notificationProviderThreadId &&
        context.reviewThreadIds?.delete(notificationProviderThreadId)
      )
        return;
      this.updateSession(context, {
        status: "closed",
        activeTurnId: undefined,
      });
      return;
    }

    if (notification.method === "account/login/completed") {
      if (!this.isLiveContext(context)) return;
      const login = asObject(notification.params);
      if (login?.success !== true) {
        context.account = {
          type: "unknown",
          planType: null,
          sparkEnabled: false,
        };
        return;
      }

      void this.sendRequest(context, "account/read", {})
        .then((response) => {
          if (this.isLiveContext(context)) {
            context.account = readCodexAccountSnapshot(response);
          }
        })
        .catch((error) => {
          void Effect.logWarning("codex account refresh after login failed", {
            threadId: context.session.threadId,
            cause: error instanceof Error ? error.message : String(error),
          }).pipe(this.runPromise);
        });
      return;
    }

    if (notification.method === "skills/changed") {
      if (context.skillRefreshInFlight) {
        context.skillRefreshPending = true;
        return;
      }

      this.scheduleSkillsRefresh(context, { forceReload: true });
      return;
    }

    if (notification.method === "turn/started") {
      const turnId = toTurnId(
        context.nativeReviewTurnId ??
          this.readString(this.readObject(notification.params)?.turn, "id"),
      );
      this.updateSession(context, {
        status: "running",
        activeTurnId: turnId,
      });
      return;
    }

    if (notification.method === "turn/completed") {
      const turn = this.readObject(notification.params, "turn");
      const status = this.readString(turn, "status");
      const errorMessage = this.readString(this.readObject(turn, "error"), "message");
      // A finished turn has consumed or abandoned its elicitations; older
      // servers may not acknowledge them with serverRequest/resolved.
      const completedTurnId = toTurnId(this.readString(turn, "id"));
      if (completedTurnId === context.nativeReviewTurnId) delete context.nativeReviewTurnId;
      if (completedTurnId)
        for (const requestId of context.elicitations?.forTurn(completedTurnId) ?? [])
          this.settleElicitation(context, requestId, "completed");
      this.updateSession(context, {
        status: status === "failed" ? "error" : "ready",
        activeTurnId: undefined,
        lastError: errorMessage ?? context.session.lastError,
      });
      return;
    }

    if (notification.method === "error") {
      const message = this.readString(this.readObject(notification.params)?.error, "message");
      const willRetry = this.readBoolean(notification.params, "willRetry");

      this.updateSession(context, {
        status: willRetry ? "running" : "error",
        ...(!willRetry ? { activeTurnId: undefined } : {}),
        lastError: message ?? context.session.lastError,
      });
    }
  }

  /**
   * Answers an approval request of a policy-enforced read-only stage with F5's classifier
   * (`codexReadOnlyPolicyDecision`), or returns false to leave it to the normal flow. An accepted
   * request runs without a trace here, like Codex's own safe commands; a refused one is reported
   * as auto-declined, so the stage counts it and fails only when the model keeps trying.
   */
  private answerReadOnlyPolicyRequest(
    context: CodexSessionContext,
    request: JsonRpcRequest,
    approvalRequest: NonNullable<ReturnType<CodexAppServerManager["approvalRequestForMethod"]>>,
    route: { readonly turnId?: TurnId | undefined; readonly itemId?: ProviderItemId | undefined },
  ): boolean {
    const verdict = codexReadOnlyPolicyDecision(request.method, request.params);
    if (!verdict) return false;
    const command =
      verdict.decision === "accept" && context.readOnlyGitGuard
        ? codexApprovalShellCommand(request.method, request.params)
        : undefined;
    if (!command || !context.readOnlyGitGuard) {
      this.respondToReadOnlyPolicyRequest(context, request, approvalRequest, route, verdict);
      return true;
    }
    // The classifier accepted the text. Git also runs programs a repository's config names, so
    // the repositories the command reaches are read before it is approved.
    void context.readOnlyGitGuard
      .refusal(command.script, command.cwd)
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
      .then((reason) =>
        this.respondToReadOnlyPolicyRequest(
          context,
          request,
          approvalRequest,
          route,
          reason === undefined ? verdict : { decision: "decline", reason },
        ),
      );
    return true;
  }

  private respondToReadOnlyPolicyRequest(
    context: CodexSessionContext,
    request: JsonRpcRequest,
    approvalRequest: NonNullable<ReturnType<CodexAppServerManager["approvalRequestForMethod"]>>,
    route: { readonly turnId?: TurnId | undefined; readonly itemId?: ProviderItemId | undefined },
    verdict: NonNullable<ReturnType<typeof codexReadOnlyPolicyDecision>>,
  ): void {
    // The repository check is asynchronous: the session can have ended meanwhile.
    if (!this.isLiveContext(context)) return;
    const commandOffer =
      approvalRequest.method === "item/commandExecution/requestApproval"
        ? readCodexCommandApprovalOffer(request.params)
        : undefined;
    const offered = (decision: ProviderApprovalDecision) =>
      !commandOffer?.decisions || commandOffer.decisions.has(decision);
    const decision = verdict.decision === "accept" && offered("accept") ? "accept" : "decline";
    // Escalation requests offer `accept`, an execpolicy amendment and `cancel`, but no `decline`.
    // Codex still takes a plain `decline` (gate G3c), while `cancel` would end the turn.
    const result =
      decision === "decline" && approvalRequest.responseKind === "decision"
        ? { decision: "decline" }
        : codexApprovalResponse(
            {
              responseKind: approvalRequest.responseKind,
              ...(commandOffer ? { commandOffer } : {}),
            },
            decision,
          );
    this.writeServerRequestResponse(context, { id: request.id, result });
    if (decision === "accept") return;
    this.emitEvent({
      ...context.mcpEventIdentity,
      id: EventId.makeUnsafe(timeOrderedUuid()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: CODEX_READ_ONLY_REFUSED_METHOD,
      turnId: route.turnId,
      itemId: route.itemId,
      requestId: ApprovalRequestId.makeUnsafe(randomUUID()),
      requestKind: approvalRequest.requestKind,
      payload: {
        requestMethod: request.method,
        ...(verdict.reason ? { reason: verdict.reason } : {}),
        params: request.params,
      },
    });
  }

  private handleServerRequest(context: CodexSessionContext, request: JsonRpcRequest): void {
    if (!this.isLiveContext(context)) return;
    if (
      request.method === "item/tool/call" &&
      asObject(request.params)?.tool === "browser_resume"
    ) {
      const params = asObject(request.params)!;
      const turnId = context.session.activeTurnId;
      const valid =
        validBrowserResumeArguments(params.arguments) &&
        params.namespace == null &&
        params.threadId === readResumeCursorThreadId(context.session.resumeCursor) &&
        typeof params.callId === "string" &&
        !!turnId &&
        params.turnId === turnId;
      void (async () => {
        let success = false;
        let value: unknown;
        try {
          if (context.session.runtimeMode !== "full-access")
            throw new Error("browser_resume requires Full access.");
          if (!context.browserResumeRegistered || !context.browserResume)
            throw new Error(
              "browser_resume is not registered on this provider thread. Chrome can restart with the next message.",
            );
          if (!valid)
            throw new Error(
              "Invalid or stale browser_resume request; supply a nonempty reason during the active turn.",
            );
          value = await context.browserResume!();
          if (!this.isLiveContext(context) || context.session.activeTurnId !== turnId)
            throw new Error("The turn ended before Chrome resumed.");
          success = true;
        } catch (error) {
          value = { error: error instanceof Error ? error.message : String(error) };
        }
        if (this.isLiveContext(context))
          this.writeServerRequestResponse(context, {
            id: request.id,
            result: { success, contentItems: [{ type: "inputText", text: JSON.stringify(value) }] },
          });
      })();
      return;
    }
    const route = this.readRouteFields(request.params);
    if (
      request.method === "mcpServer/elicitation/request" &&
      !describeMcpElicitation(request.params).approvalOptions.some((option) =>
        option.decision.startsWith("accept"),
      )
    ) {
      this.openElicitation(context, request);
      return;
    }
    // F5's hub asks before this tool call itself (Ask policy or a changed tool), so
    // Codex's own consent prompt is accepted unseen and the user answers once.
    if (request.method === "mcpServer/elicitation/request") {
      const serverName = asString(asObject(request.params)?.serverName);
      const toolName = codexMcpConsentToolName(request.params);
      if (
        serverName &&
        toolName &&
        this.mcpHubAsksBeforeCall?.(context.session.threadId, serverName, toolName)
      ) {
        this.writeServerRequestResponse(context, {
          id: request.id,
          result: mcpElicitationResponse(request.params, "accept"),
        });
        return;
      }
    }
    const approvalRequest = this.approvalRequestForMethod(request.method);
    const requestKind = approvalRequest?.requestKind;
    if (
      approvalRequest &&
      context.workflowExecutionProfile &&
      context.readOnlyMode !== undefined &&
      context.readOnlyMode !== "sandbox" &&
      this.answerReadOnlyPolicyRequest(context, request, approvalRequest, route)
    )
      return;
    const sessionAllowance =
      (requestKind === "command" || requestKind === "file-change") &&
      asObject(request.params)?.kind !== "humanCommand"
        ? this.sessionAllowance(context)
        : undefined;
    if (approvalRequest && requestKind && sessionAllowance?.has(requestKind)) {
      const allowed = codexSessionAllowedResponse(
        approvalRequest.responseKind,
        approvalRequest.method === "item/commandExecution/requestApproval"
          ? readCodexCommandApprovalOffer(request.params)
          : undefined,
      );
      if (allowed) {
        this.writeServerRequestResponse(context, { id: request.id, result: allowed });
        return;
      }
    }
    let requestId: ApprovalRequestId | undefined;
    let responseChannel: NativeRequestCorrelation["responseChannel"] | undefined;
    if (approvalRequest) {
      requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      responseChannel = "approval";
      const params = asObject(request.params);
      const requestedPermissions =
        approvalRequest.responseKind === "permissions"
          ? readCodexPermissionProfile(params?.permissions)
          : undefined;
      const pendingRequest: PendingApprovalRequest = {
        requestId,
        jsonRpcId: request.id,
        method: approvalRequest.method,
        requestKind: approvalRequest.requestKind,
        responseKind: approvalRequest.responseKind,
        ...(approvalRequest.responseKind === "mcp-elicitation"
          ? { elicitation: request.params }
          : {}),
        ...(approvalRequest.method === "item/commandExecution/requestApproval"
          ? { commandOffer: readCodexCommandApprovalOffer(request.params) }
          : {}),
        ...(requestedPermissions !== undefined ? { requestedPermissions } : {}),
        ...(sessionAllowance ? { sessionAllowance } : {}),
        threadId: context.session.threadId,
        ...(route.turnId ? { turnId: route.turnId } : {}),
        ...(route.itemId ? { itemId: route.itemId } : {}),
      };
      context.pendingApprovals.set(requestId, pendingRequest);
    }

    if (request.method === "item/tool/requestUserInput") {
      requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      responseChannel = "user-input";
      context.pendingUserInputs.set(requestId, {
        requestId,
        jsonRpcId: request.id,
        threadId: context.session.threadId,
        ...(route.turnId ? { turnId: route.turnId } : {}),
        ...(route.itemId ? { itemId: route.itemId } : {}),
      });
    }

    if (requestId && responseChannel) {
      this.rememberNativeRequestCorrelation(context, {
        nativeRequestId: String(request.id),
        requestId,
        method: request.method,
        ...(requestKind ? { requestKind } : {}),
        responseChannel,
        ...(route.turnId ? { turnId: route.turnId } : {}),
        ...(route.itemId ? { itemId: route.itemId } : {}),
        resolvedLocally: false,
      });

      this.emitEvent({
        ...context.mcpEventIdentity,
        id: EventId.makeUnsafe(timeOrderedUuid()),
        kind: "request",
        provider: "codex",
        threadId: context.session.threadId,
        createdAt: new Date().toISOString(),
        method: request.method,
        turnId: route.turnId,
        itemId: route.itemId,
        requestId,
        requestKind,
        payload: request.params,
      });
      return;
    }

    if (request.method === "currentTime/read") {
      this.writeServerRequestResponse(context, {
        id: request.id,
        result: {
          // Codex defines currentTimeAt as whole Unix seconds.
          currentTimeAt: Math.floor(Date.now() / 1_000),
        },
      });
      return;
    }

    const disposition = codexServerRequestDisposition(request.method);
    const message =
      request.method === "item/tool/call"
        ? "Unexpected dynamic tool request; no matching F5 tool was registered."
        : request.method === "account/chatgptAuthTokens/refresh"
          ? "Unexpected ChatGPT auth-token refresh request; F5 does not provide external auth tokens."
          : request.method === "attestation/generate"
            ? "Unexpected attestation request; attestation capability is disabled."
            : `Unsupported server request: ${request.method}`;
    this.writeServerRequestResponse(context, {
      id: request.id,
      error: {
        code: disposition === undefined ? -32601 : -32000,
        message,
      },
    });
    this.emitUnsupportedServerRequestWarning(context, request, message);
  }

  private rememberNativeRequestCorrelation(
    context: CodexSessionContext,
    correlation: NativeRequestCorrelation,
  ): void {
    let correlations = context.nativeRequestCorrelations as
      | Map<string, NativeRequestCorrelation>
      | undefined;
    if (!correlations) {
      correlations = new Map();
      (
        context as CodexSessionContext & {
          nativeRequestCorrelations: Map<string, NativeRequestCorrelation>;
        }
      ).nativeRequestCorrelations = correlations;
    }
    correlations.delete(correlation.nativeRequestId);
    correlations.set(correlation.nativeRequestId, correlation);
    while (correlations.size > CODEX_NATIVE_REQUEST_CORRELATION_CAPACITY) {
      const oldestKey = correlations.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        break;
      }
      correlations.delete(oldestKey);
    }
  }

  private markNativeRequestResolvedLocally(
    context: CodexSessionContext,
    correlation: NativeRequestCorrelation,
  ): void {
    correlation.resolvedLocally = true;
    // Reinsert the acknowledgement tombstone in case the pending correlation
    // was evicted while the JSON-RPC write was in flight.
    this.rememberNativeRequestCorrelation(context, correlation);
  }

  private findPendingNativeRequestCorrelation(
    context: CodexSessionContext,
    nativeRequestId: string,
  ): NativeRequestCorrelation | undefined {
    for (const pending of context.pendingApprovals.values()) {
      if (String(pending.jsonRpcId) !== nativeRequestId) {
        continue;
      }
      return {
        nativeRequestId,
        requestId: pending.requestId,
        method: pending.method,
        requestKind: pending.requestKind,
        responseChannel: "approval",
        ...(pending.turnId ? { turnId: pending.turnId } : {}),
        ...(pending.itemId ? { itemId: pending.itemId } : {}),
        resolvedLocally: false,
      };
    }
    for (const pending of context.pendingUserInputs.values()) {
      if (String(pending.jsonRpcId) !== nativeRequestId) {
        continue;
      }
      return {
        nativeRequestId,
        requestId: pending.requestId,
        method: "item/tool/requestUserInput",
        responseChannel: "user-input",
        ...(pending.turnId ? { turnId: pending.turnId } : {}),
        ...(pending.itemId ? { itemId: pending.itemId } : {}),
        resolvedLocally: false,
      };
    }
    return undefined;
  }

  private writeServerRequestResponse(context: CodexSessionContext, response: unknown): void {
    void this.writeMessage(context, response).catch((error) => {
      this.emitErrorEvent(
        context,
        "protocol/writeFailed",
        error instanceof Error ? error.message : "Failed to write protocol response.",
      );
    });
  }

  private emitUnsupportedServerRequestWarning(
    context: CodexSessionContext,
    request: JsonRpcRequest,
    message: string,
  ): void {
    this.emitEvent({
      ...context.mcpEventIdentity,
      id: EventId.makeUnsafe(timeOrderedUuid()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "protocol/unsupportedServerRequest",
      message,
      payload: {
        requestMethod: request.method,
      },
    });
  }

  private handleResponse(context: CodexSessionContext, response: JsonRpcResponse): void {
    const key = String(response.id);
    const pending = context.pending.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    context.pending.delete(key);

    if (response.error) {
      const providerMessage = formatCodexUnsupportedModelError(
        response.error.code === -32600 &&
          response.error.message?.includes("already has an active writer")
          ? "This conversation is open in another Codex client. Codex lets one client write to a conversation at a time. Quit the other Codex app, CLI, or IDE extension, then send your message again."
          : (response.error.message ?? "Unknown JSON-RPC error"),
        asObject(response.error.data)?.codexErrorInfo,
      );
      if (
        response.error.code === -32600 &&
        asObject(response.error.data)?.reason === "serverShuttingDown"
      ) {
        context.beginDrain?.(
          new Error("Codex is shutting down; reconnect on the next turn."),
          "session/exited",
          "Codex is shutting down.",
        );
      }
      pending.reject(
        new CodexJsonRpcError(
          pending.method,
          response.error.code,
          providerMessage,
          response.error.data,
          response.error.message ?? "Unknown JSON-RPC error",
        ),
      );
      return;
    }

    if (["thread/read", "thread/readState/update"].includes(pending.method)) {
      this.cacheReadState(context, asObject(response.result)?.readState);
    }
    pending.resolve(response.result);
  }

  private async forkWithArchivedRecovery(
    context: CodexSessionContext,
    params: Record<string, unknown>,
    request = (method: string, input: Record<string, unknown>): Promise<unknown> =>
      this.sendRequest(context, method, input),
  ): Promise<unknown> {
    try {
      return await request("thread/fork", params);
    } catch (error) {
      if (!isArchivedThreadResumeError(error)) throw error;
      await request("thread/unarchive", { threadId: params.threadId });
      return request("thread/fork", params);
    }
  }

  private async sendRequest<TResponse>(
    context: CodexSessionContext,
    method: string,
    params: unknown,
    timeoutMs = codexRequestTimeoutMs(method),
  ): Promise<TResponse> {
    const id = context.nextRequestId;
    context.nextRequestId += 1;

    const result = await new Promise<unknown>((resolve, reject) => {
      const controller = new AbortController();
      const pending: PendingRequest = {
        method,
        resolve,
        reject,
        wasWritten: false,
        cancelWrite: () => controller.abort(),
        timeout:
          timeoutMs === 0
            ? undefined
            : setTimeout(() => {
                context.pending.delete(String(id));
                controller.abort();
                reject(
                  new JsonRpcDeliveryError(
                    `Timed out waiting for ${method}.`,
                    pending.wasWritten ? "unknown" : "not_sent",
                  ),
                );
              }, timeoutMs),
      };
      context.pending.set(String(id), pending);
      void this.writeMessage(
        context,
        { method, id, params },
        {
          signal: controller.signal,
          deadline: Date.now() + (timeoutMs || CODEX_JSON_RPC_TIMEOUT_MS),
          lane: jsonRpcWriteLane({ method }),
          onWrite: () => {
            pending.wasWritten = true;
          },
        },
      ).catch((error) => {
        clearTimeout(pending.timeout);
        context.pending.delete(String(id));
        reject(error);
      });
    });

    return result as TResponse;
  }

  private async writeMessage(
    context: CodexSessionContext,
    message: unknown,
    options?: JsonRpcWriteOptions,
  ): Promise<void> {
    await context.writer.write(message, { lane: jsonRpcWriteLane(message), ...options });
  }

  private emitSessionConfigured(
    context: CodexSessionContext,
    config: Record<string, unknown>,
  ): void {
    context.configuredBase = config;
    const configuredPayload = context.skillsLoaded
      ? {
          ...config,
          slashCommands: [
            ...context.availableSkills,
            ...(supportsCodexRelease5(context.cliVersion) &&
            !context.availableSkills.some((skill) => skill.name === "aside")
              ? [CODEX_NATIVE_ASIDE_COMMAND]
              : []),
          ],
        }
      : config;

    this.emitEvent({
      ...context.mcpEventIdentity,
      id: EventId.makeUnsafe(timeOrderedUuid()),
      kind: "session",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "session/configured",
      payload: {
        config: {
          ...configuredPayload,
          runtimeInfo: normalizeProviderRuntimeInfo(context.requestedRuntime ?? {}, config),
        },
      },
    });
  }

  /**
   * Refuses a read-only stage when a project layer Codex itself loads for `cwd` holds rules. The
   * adapter's guard walks the folders Codex would use with the pinned project-root markers;
   * managed config can still change the markers, so this asks Codex which `.codex` folders it
   * reads. A Codex that can't say fails closed.
   */
  private async assertNoCodexProjectRules(
    context: CodexSessionContext,
    cwd: string,
  ): Promise<void> {
    let folders: ReadonlyArray<string> | undefined;
    try {
      folders = codexProjectLayerFolders(
        await this.sendRequest(context, "config/read", { cwd, includeLayers: true }),
      );
    } catch (error) {
      throw new Error(
        `Codex couldn't list the project config it loads for this read-only stage (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
    if (!folders)
      throw new Error("Codex didn't list the project config it loads for this read-only stage.");
    const conflict = await findCodexRulesInFolders(folders);
    if (conflict) throw new Error(codexProjectRulesConflictMessage(conflict));
  }

  /**
   * `codexReadOnlyModeUnderRequirements` for this session's Codex. A policy-enforced stage reads
   * the requirements first; a CLI without `configRequirements/read` keeps the request. When the
   * stage ends up sandboxed instead, the thread gets a configuration warning saying why, and the
   * started session reports `readOnlyEnforcement: "sandbox"` for ProviderService to record.
   */
  private async readOnlyModeForRequirements(
    context: CodexSessionContext,
    requested: ReadOnlyEnforcement,
  ): Promise<CodexReadOnlyMode> {
    if (requested !== "policy") return "sandbox";
    let requirements: CodexReadOnlyRequirements | undefined;
    try {
      requirements = readCodexRequirements(
        await this.sendRequest(context, "configRequirements/read", undefined),
      );
    } catch (error) {
      await Effect.logWarning("codex configRequirements/read failed", {
        threadId: context.session.threadId,
        cause: error instanceof Error ? error.message : String(error),
      }).pipe(this.runPromise);
    }
    const mode = codexReadOnlyModeUnderRequirements(requested, requirements);
    if (codexReadOnlyModeEnforcement(mode) === requested) return mode;
    this.emitEvent({
      ...context.mcpEventIdentity,
      id: EventId.makeUnsafe(timeOrderedUuid()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "configWarning",
      payload: {
        summary:
          "Read-only stage runs in Codex's read-only sandbox: your organisation's Codex requirements don't allow Codex to ask before running commands.",
        details: `Allowed approval policies: ${[...(requirements?.allowedApprovalPolicies ?? [])].join(", ")}. Where Codex's sandbox can't start (F5's macOS desktop app), shell commands fail and the stage reads through F5's forge tools.`,
      },
    });
    return mode;
  }

  private emitLifecycleEvent(
    context: CodexSessionContext,
    method: string,
    message: string,
    turnId?: TurnId,
  ): void {
    this.emitEvent({
      ...context.mcpEventIdentity,
      id: EventId.makeUnsafe(timeOrderedUuid()),
      kind: "session",
      provider: "codex",
      threadId: context.session.threadId,
      ...(turnId ? { turnId } : {}),
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private protocolDecodeFailureDiagnostics(
    context: CodexSessionContext,
    line: string,
  ): Record<string, unknown> {
    context.protocolDecodeFailureCount += 1;
    return {
      recordByteLength: Buffer.byteLength(line, "utf8"),
      recordSha256: createHash("sha256").update(line).digest("hex"),
      occurrence: context.protocolDecodeFailureCount,
    };
  }

  private emitErrorEvent(
    context: CodexSessionContext,
    method: string,
    message: string,
    payload?: unknown,
  ): void {
    this.emitEvent({
      ...context.mcpEventIdentity,
      id: EventId.makeUnsafe(timeOrderedUuid()),
      kind: "error",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
      ...(payload !== undefined ? { payload } : {}),
    });
  }

  private emitEvent(event: ProviderEvent): void {
    this.emit("event", event);
  }

  private clearInitialSkillsRetry(context: CodexSessionContext): void {
    if (context.initialSkillsRetryTimeout) {
      clearTimeout(context.initialSkillsRetryTimeout);
      context.initialSkillsRetryTimeout = undefined;
    }
  }

  private scheduleInitialSkillsRetry(context: CodexSessionContext): void {
    if (
      !this.isLiveContext(context) ||
      context.skillsLoaded ||
      context.initialSkillsRetryAttempted ||
      context.initialSkillsRetryTimeout
    ) {
      return;
    }

    context.initialSkillsRetryTimeout = setTimeout(() => {
      context.initialSkillsRetryTimeout = undefined;
      if (!this.isLiveContext(context) || context.skillsLoaded) {
        return;
      }

      context.initialSkillsRetryAttempted = true;
      this.scheduleSkillsRefresh(context, { forceReload: true });
    }, CODEX_INITIAL_SKILLS_RETRY_DELAY_MS);
  }

  private scheduleSkillsRefresh(
    context: CodexSessionContext,
    options: { readonly forceReload: boolean },
  ): void {
    if (!this.isLiveContext(context)) {
      return;
    }

    if (context.skillRefreshInFlight) {
      if (options.forceReload) {
        context.skillRefreshPending = true;
      }
      return;
    }

    context.skillRefreshInFlight = true;
    void this.runSkillsRefresh(context, options).catch((error) => {
      if (!this.isLiveContext(context)) {
        return;
      }

      if (!options.forceReload && !context.skillsLoaded) {
        this.scheduleInitialSkillsRetry(context);
      }

      void Effect.logWarning("codex skills/list failed", {
        threadId: context.session.threadId,
        forceReload: options.forceReload,
        cause: error instanceof Error ? error.message : String(error),
      }).pipe(this.runPromise);
    });
  }

  private async runSkillsRefresh(
    context: CodexSessionContext,
    options: { readonly forceReload: boolean },
  ): Promise<void> {
    try {
      if (!this.isLiveContext(context)) {
        return;
      }

      const cwd = context.session.cwd ?? context.instructionContext?.cwd ?? process.cwd();
      const response = await this.sendRequest(
        context,
        "skills/list",
        {
          cwds: [cwd],
          forceReload: options.forceReload,
        },
        CODEX_SKILLS_REFRESH_TIMEOUT_MS,
      );

      if (!this.isLiveContext(context)) {
        return;
      }

      const droppedSkills: string[] = [];
      const normalizedCommands = normalizeSupportedSlashCommands(
        readEnabledSkillsFromSkillsListResponse(response, {
          onDroppedSkill: ({ reason, skill }) => {
            droppedSkills.push(`${reason}: ${describeDroppedSkill(skill)}`);
          },
        }),
      );
      if (droppedSkills.length > 0) {
        await Effect.logDebug("codex skills/list dropped malformed skills", {
          threadId: context.session.threadId,
          droppedSkills,
        }).pipe(this.runPromise);
      }

      this.clearInitialSkillsRetry(context);
      const fingerprint = fingerprintSupportedSlashCommands(normalizedCommands);
      if (context.skillsLoaded && fingerprint === context.supportedCommandsFingerprint) {
        return;
      }

      context.skillsLoaded = true;
      context.availableSkills = normalizedCommands;
      context.supportedCommandsFingerprint = fingerprint;
      if (context.configuredBase) {
        this.emitSessionConfigured(context, context.configuredBase);
      }
    } finally {
      context.skillRefreshInFlight = false;
      const shouldRerun = context.skillRefreshPending;
      context.skillRefreshPending = false;
      if (shouldRerun && this.isLiveContext(context)) {
        this.scheduleSkillsRefresh(context, { forceReload: true });
      }
    }
  }

  private isLiveContext(context: CodexSessionContext): boolean {
    return (
      !context.stopping &&
      context.phase !== "draining" &&
      context.phase !== "closed" &&
      this.sessions.get(context.session.threadId) === context
    );
  }

  private assertSupportedCodexCliVersion(input: {
    readonly processEnvironment: NodeJS.ProcessEnv;
    readonly binaryPath: string;
    readonly cwd: string;
    readonly homePath?: string;
    readonly signal?: AbortSignal;
  }): Promise<string | null> {
    return assertSupportedCodexCliVersion(input);
  }

  private updateSession(context: CodexSessionContext, updates: Partial<ProviderSession>): void {
    if (updates.resumeCursor)
      updates = {
        ...updates,
        resumeCursor: codexBrowserResumeCursor(
          asObject(updates.resumeCursor),
          readResumeCursorThreadId(updates.resumeCursor),
          context.browserResumeRegistered === true,
        ),
      };
    context.session = {
      ...context.session,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
  }

  /** The kinds allowed for the session in its current runtime mode. */
  private sessionAllowance(context: CodexSessionContext): Set<ProviderRequestKind> {
    const runtimeMode = context.session.runtimeMode;
    if (context.sessionApprovals?.runtimeMode !== runtimeMode)
      context.sessionApprovals = { runtimeMode, kinds: new Set() };
    return context.sessionApprovals.kinds;
  }

  private approvalRequestForMethod(method: string):
    | {
        readonly method: PendingApprovalRequest["method"];
        readonly requestKind: ProviderRequestKind;
        readonly responseKind: PendingApprovalRequest["responseKind"];
      }
    | undefined {
    if (method === "mcpServer/elicitation/request")
      return { method, requestKind: "mcp-elicitation", responseKind: "mcp-elicitation" };

    if (method === "item/commandExecution/requestApproval") {
      return { method, requestKind: "command", responseKind: "decision" };
    }

    if (method === "item/fileRead/requestApproval") {
      return { method, requestKind: "file-read", responseKind: "decision" };
    }

    if (method === "item/fileChange/requestApproval") {
      return { method, requestKind: "file-change", responseKind: "decision" };
    }

    if (method === "item/permissions/requestApproval") {
      return { method, requestKind: "permission", responseKind: "permissions" };
    }

    if (method === "execCommandApproval") {
      return { method, requestKind: "command", responseKind: "legacy-decision" };
    }

    if (method === "applyPatchApproval") {
      return { method, requestKind: "file-change", responseKind: "legacy-decision" };
    }

    return undefined;
  }

  private parseThreadSnapshot(method: string, response: unknown): CodexThreadSnapshot {
    const responseRecord = this.readObject(response);
    const thread = this.readObject(responseRecord, "thread");
    const threadIdRaw =
      this.readString(thread, "id") ?? this.readString(responseRecord, "threadId");
    if (!threadIdRaw) {
      throw new Error(`${method} response did not include a thread id.`);
    }
    const turnsRaw =
      this.readArray(thread, "turns") ?? this.readArray(responseRecord, "turns") ?? [];
    const turns = turnsRaw.map((turnValue, index) => {
      const turn = this.readObject(turnValue);
      const turnIdRaw = this.readString(turn, "id") ?? `${threadIdRaw}:turn:${index + 1}`;
      const turnId = TurnId.makeUnsafe(turnIdRaw);
      const items = this.readArray(turn, "items") ?? [];
      return {
        id: turnId,
        items: items.map(presentCodexMessageItem),
      };
    });

    return {
      threadId: threadIdRaw,
      turns,
    };
  }

  private isServerRequest(value: unknown): value is JsonRpcRequest {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.method === "string" &&
      (typeof candidate.id === "string" || typeof candidate.id === "number")
    );
  }

  private isServerNotification(value: unknown): value is JsonRpcNotification {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return typeof candidate.method === "string" && !("id" in candidate);
  }

  private isResponse(value: unknown): value is JsonRpcResponse {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    const hasId = typeof candidate.id === "string" || typeof candidate.id === "number";
    const hasMethod = typeof candidate.method === "string";
    return hasId && !hasMethod;
  }

  private readRouteFields(params: unknown): {
    turnId?: TurnId;
    itemId?: ProviderItemId;
  } {
    const route: {
      turnId?: TurnId;
      itemId?: ProviderItemId;
    } = {};

    const turnId = toTurnId(
      this.readString(params, "turnId") ?? this.readString(this.readObject(params, "turn"), "id"),
    );
    const itemId = toProviderItemId(
      this.readString(params, "itemId") ??
        this.readString(this.readObject(params, "item"), "id") ??
        this.readString(params, "callId"),
    );

    if (turnId) {
      route.turnId = turnId;
    }

    if (itemId) {
      route.itemId = itemId;
    }

    return route;
  }

  private readObject(value: unknown, key?: string): Record<string, unknown> | undefined {
    const target =
      key === undefined
        ? value
        : value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined;

    if (!target || typeof target !== "object") {
      return undefined;
    }

    return target as Record<string, unknown>;
  }

  private readArray(value: unknown, key?: string): unknown[] | undefined {
    const target =
      key === undefined
        ? value
        : value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined;
    return Array.isArray(target) ? target : undefined;
  }

  private readString(value: unknown, key: string): string | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "string" ? candidate : undefined;
  }

  private readBoolean(value: unknown, key: string): boolean | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "boolean" ? candidate : undefined;
  }
}
