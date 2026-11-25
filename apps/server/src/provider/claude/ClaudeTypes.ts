import {
  resolveClaudeBypassAvailability,
  type ClaudeBypassResolution,
} from "../claudeBypassAvailability.ts";
import { type ClaudeSubagentLaunch } from "../claudeSubagentSelection.ts";
import type { ThreadMcpBroker } from "../../mcp/threadMcpTools.ts";
import { type AssistantTextBlockState } from "../claudeAssistantText.ts";
import type { ProviderAdapterSessionStartInput } from "../Services/ProviderAdapter.ts";
import type { ComputerAutomationBrokerRuntime } from "../../computer/ComputerAutomationBroker";
import type { ChromeSessionRuntime } from "../chromeSessionRuntime";
import { ClaudeChromeActivity } from "../claudeChromeActivity";
import { type ClaudeToolResultCorrelation } from "../claudeToolResultCorrelations.ts";
import { ElicitationRegistry } from "../elicitationRegistry.ts";
import type { ProviderSessionStartInput } from "@t3tools/contracts";
import { claudeLimitState } from "../usageLimitMessages.ts";
import { type ClaudeMcpAppCatalog } from "../claudeMcpApps.ts";

import {
  type RewindFilesResult,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type McpServerConfig,
  type McpServerStatus,
  type McpSetServersResult,
  type PermissionUpdate,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ClaudeCodeEffort,
  type ModelCapabilities,
  type ProviderStartOptions,
  type ProviderApprovalDecision,
  type ProviderApprovalPresentation,
  ProviderInstanceId,
  type ProviderRequestKind,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type RuntimeContentStreamKind,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { type McpToolFilters } from "@t3tools/shared/mcpTranslation";
import { Deferred, Effect, Fiber, Queue } from "effect";

import { ProviderAdapterRequestError } from "../Errors.ts";
import { type ClaudeTurnLifecycle } from "../Layers/claudeTurnLifecycle.ts";
import { type EventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import type { PreviewAutomationBrokerShape } from "../../mcp/PreviewAutomationBroker.ts";
import { type ClaudeAgentBrowserState } from "../Layers/claudeAgentBrowser.ts";
import { readClaudeRecoveryMetadata } from "../claudeResumeState.ts";

import { type ClaudeNativeGoal } from "../claudeGoal.ts";

export const PROVIDER = "claudeAgent" as const;
/** Upper bound for one MCP App tool call, below the client's 60 s request deadline. */
export const CLAUDE_MCP_APP_CALL_TIMEOUT_MS = 55_000;
export type ClaudeTextStreamKind = Extract<
  RuntimeContentStreamKind,
  "assistant_text" | "reasoning_text"
>;
export type ClaudeToolResultStreamKind = Extract<
  RuntimeContentStreamKind,
  "command_output" | "file_change_output"
>;
export type ClaudeSdkEffort = Exclude<ClaudeCodeEffort, "ultrathink">;
export type ClaudeRuntimeFlagSettings = {
  readonly ultracode?: boolean | null;
  readonly effortLevel?: ClaudeSdkEffort | null;
  readonly fastMode?: boolean | null;
  readonly alwaysThinkingEnabled?: boolean | null;
};
export type ClaudeContextWindow = "200k" | "1m";

export type PromptQueueItem =
  | {
      readonly type: "message";
      readonly message: SDKUserMessage;
    }
  | {
      readonly type: "terminate";
    };

export interface ClaudeThinkingTokenAccount {
  /** Latest per-block estimate; it restarts from zero for each thinking block. */
  readonly lastEstimate: number;
  /** Tokens estimated since the last report. */
  readonly pending: number;
}

/**
 * Folds a live per-block estimate into the account. The SDK's per-frame
 * delta is used when present; otherwise the running total is diffed, with a
 * drop treated as a new block.
 */

export interface ClaudeTurnState {
  goalChecked?: boolean;
  userMessageUuids?: Set<string>;
  readonly synthetic?: boolean;
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly items: Array<unknown>;
  readonly assistantTextBlocks: Map<number, AssistantTextBlockState>;
  readonly assistantTextBlockOrder: Array<AssistantTextBlockState>;
  readonly capturedProposedPlanKeys: Set<string>;
  nextSyntheticAssistantBlockIndex: number;
  /**
   * Thinking blocks seen this turn. Ids come from this counter because block
   * indexes restart with every assistant message.
   */
  thinkingBlockCount: number;
  /** Open thinking blocks by stream block index, closed on stop or turn end. */
  readonly openThinkingBlocks: Map<number, string>;
  /** Live `thinking_tokens` accounting, reported when a thinking block closes. */
  thinkingTokens?: ClaudeThinkingTokenAccount;
  authenticationFailureMessage?: string;
  rateLimitFailure?: true;
  /**
   * The limit repeated on the latest blocked root assistant response. The CLI
   * suppresses an unchanged rate_limit_event, so this can be the only reset time.
   */
  assistantUsageLimit?: ReturnType<typeof claudeLimitState>;
  rejectedUsageLimits?: Map<string, ReturnType<typeof claudeLimitState>>;
  announcedUsageLimits?: Set<string>;
  interruptRequested: boolean;
  /**
   * Deferred signalled from `completeTurn` to cancel the interrupt watchdog
   * when the SDK drives completion before the 3s timeout elapses. Prevents
   * unbounded fiber accumulation under rapid stop/resend cycles.
   */
  watchdogCancel?: Deferred.Deferred<void>;
}

export interface PendingApproval {
  readonly agentId?: string;
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly suggestions?: ReadonlyArray<PermissionUpdate>;
  readonly presentation?: ProviderApprovalPresentation;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  /**
   * Set by `resolvePendingInteractions` when it has already emitted the
   * terminal `request.resolved` event for this approval. Suppresses a second
   * emission from the awaiting canUseTool handler once its deferred resumes.
   */
  resolvedExternally: boolean;
}

export interface PendingUserInput {
  readonly agentId?: string;
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
  readonly cancel: () => void;
  /**
   * Mirror of `PendingApproval.resolvedExternally` for AskUserQuestion. Avoids
   * duplicate `user-input.resolved` events when the interrupt path cancelled
   * the interaction and the awaiting handler later resumes.
   */
  resolvedExternally: boolean;
}

export interface ToolInFlight {
  readonly turnId?: TurnId;
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail?: string;
  readonly requestKind?: ProviderRequestKind;
  readonly input: Record<string, unknown>;
  readonly partialInputJson: string;
  readonly lastEmittedInputFingerprint?: string;
}

export interface SubagentTaskToolInFlight {
  readonly tool: ToolInFlight;
  /** The Agent tool call that launched the subagent. */
  readonly parentToolUseId: string;
  /** The turn that launched the subagent, so a revert of it drops the task. */
  readonly turnId?: TurnId;
}

export type ClaudeTaskTerminalStatus = "completed" | "failed" | "stopped";
export type ClaudeBackgroundStatus = "running" | ClaudeTaskTerminalStatus;

export interface ClaudeTaskState {
  readonly model?: string;
  readonly effort?: string;
  readonly taskId: string;
  readonly toolUseId?: string;
  readonly turnId?: TurnId;
  readonly description?: string;
  readonly taskType?: string;
  readonly tool?: ToolInFlight;
  readonly launchResult?: Record<string, unknown>;
  readonly backgrounded?: boolean;
}

export interface ClaudeTaskUpdatedPatch {
  readonly isBackgrounded?: true;
  readonly terminalStatus?: ClaudeTaskTerminalStatus;
  readonly backgroundEndedAt?: string;
}

export interface ClaudeTaskUpdatedMessage {
  readonly taskId?: string;
  readonly patch?: ClaudeTaskUpdatedPatch;
  readonly malformed: boolean;
}

export interface ClaudeRuntimeWarningOptions {
  readonly category?: "provider" | "verification" | "guardian" | "protocol";
  readonly actionable?: boolean;
  readonly detail?: unknown;
}

export interface ClaudeSessionContext {
  nativeGoal: ClaudeNativeGoal | null;
  chromeRuntime?: ChromeSessionRuntime | undefined;
  chromeGeneration?: string | undefined;
  /** Set once health checks run; coalesces the 5 s live check. */
  chromeHealthFiber?: Fiber.Fiber<void, never> | undefined;
  /** The Chrome-enabled CLI, registered with desktop main before stdio flowed. */
  chromeProcess?: { kill: (signal: NodeJS.Signals) => boolean } | undefined;
  /** Turns and Chrome calls: an idle session stops to free Chrome. */
  chromeActivity?: ClaudeChromeActivity | undefined;
  /** The session scheduled a wake-up or cron job, which would die with its CLI. */
  chromeScheduledWork?: boolean | undefined;
  /** Unregisters the broker's release hook for this session's Chrome lease. */
  chromeReleaserOff?: (() => void) | undefined;
  replyOwned?: boolean | undefined;
  hostContractVersion?: string | undefined;
  hostContractMigrationMessageUuid?: string | undefined;
  hostContractInstructionText?: string | undefined;
  workflowExecutionProfile?: ProviderSessionStartInput["workflowExecutionProfile"];
  rejectedUsageLimits?: Map<string, ReturnType<typeof claudeLimitState>>;
  nativeCompactionEnabled: boolean;
  readonly nativeReceipts: Map<string, { state: "completed" | "failed"; result?: unknown }>;
  readonly nativeTaskIds: Set<string>;
  readonly nativeTaskRuns: Map<string, string>;
  readonly supersededTaskRuns: Map<string, Set<string>>;
  readonly nativeTaskStops: Map<
    string,
    { operationId: string; settlement?: Deferred.Deferred<unknown, ProviderAdapterRequestError> }
  >;
  readonly startInput: ProviderAdapterSessionStartInput;
  readonly turnBoundaries: Array<import("../claudeResumeState.ts").ClaudeTurnBoundary>;
  latestUsage?: Record<string, unknown> | undefined;
  streamUsageInvalidated?: boolean;
  /** Selected base model whose CLI rejected auto; independent of raw init model spelling. */
  autoRejectedForModel?: string | undefined;
  /** Last `credential_expires_at` value already warned about in this session. */
  credentialExpiryWarned?: string;
  requestedRuntime?: Record<string, unknown>;
  lastProviderTitle?: string;
  nativeControl?:
    | {
        operationId: string;
        compacted: boolean;
        settlement: Deferred.Deferred<unknown, ProviderAdapterRequestError>;
      }
    | undefined;
  session: ProviderSession;
  readonly providerInstanceId: ProviderInstanceId;
  promptQueue: Queue.Queue<PromptQueueItem>;
  query: ClaudeQueryRuntime;
  readonly queryOptions: ClaudeQueryOptions;
  readonly mandatoryDisallowedTools: ReadonlyArray<string>;
  /** SDK deny list installed on the live query; recovery options can be newer. */
  activeDisallowedTools: ReadonlyArray<string>;
  readonly pendingPrompts: SDKUserMessage[];
  recovering: boolean;
  recoveryMetadata: ReturnType<typeof readClaudeRecoveryMetadata>;
  lastTotalCostUsd: number | undefined;
  readonly processEnvironment: NodeJS.ProcessEnv;
  streamFiber: Fiber.Fiber<void, Error> | undefined;
  readonly startedAt: string;
  /** Mode restored after plan turns; `auto` only while the model and CLI support it. */
  basePermissionMode: PermissionMode | undefined;
  bypassPolicyCache?: { cwd: string | undefined; resolution: ClaudeBypassResolution };
  bypassCliRestricted?: boolean;
  bypassWarning?: string;
  /** The session's runtime mode asked for Claude `auto` review. */
  readonly autoRequested: boolean;
  resumeSessionId: string | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  /** MCP form/URL requests answered through the private elicitation RPC. */
  readonly elicitations: ElicitationRegistry;
  /** Dynamic MCP servers F5 set on this query; the only ones reconcile may replace or remove. */
  ownedMcpServerNames: ReadonlySet<string>;
  mcpToolFilters: McpToolFilters;
  mcpStatusFiber?: Fiber.Fiber<void>;
  mcpStatusEmitted?: Map<string, string>;
  mcpObservationEpoch?: number;
  /** MCP App tools by server, from the latest `mcpServerStatus()` read. */
  mcpAppCatalog?: ClaudeMcpAppCatalog;
  /** App session identity; a new MCP observation epoch invalidates approvals. */
  mcpAppIdentity?: { readonly epoch: number; readonly id: string };
  readonly internalMcpServers: NonNullable<ClaudeQueryOptions["mcpServers"]>;
  readonly turns: Array<{
    id: TurnId;
    items: Array<unknown>;
    approximateChars: number;
  }>;
  readonly inFlightTools: Map<number, ToolInFlight>;
  /** Background calls outlive content-block indexes and sometimes their task notification. */
  readonly pendingBackgroundToolResults: Map<string, ClaudeToolResultCorrelation>;
  readonly completedTaskNotifications: Map<string, string | undefined>;
  readonly taskStates: Map<string, ClaudeTaskState>;
  readonly taskModelsByTool: Map<string, string>;
  readonly taskLaunchesByTool: Map<string, ClaudeSubagentLaunch>;
  /** Subagent TaskCreate/TaskUpdate calls awaiting their result, by tool_use id. */
  readonly subagentTaskTools: Map<string, SubagentTaskToolInFlight>;
  readonly lifecycle: ClaudeTurnLifecycle;
  settlementWatchdog: { resultId: string; cancel: Deferred.Deferred<void> } | undefined;
  turnState: ClaudeTurnState | undefined;
  lastAssistantUuid: string | undefined;
  resumeLatest: boolean;
  /** Claude lost transcript writes for the bound session; resumes add F5's summary. */
  transcriptIncomplete: boolean;
  /** `system/init.capabilities` of the running CLI, for feature detection. */
  initCapabilities: ReadonlySet<string>;
  /** `claude_code_version` the running CLI reported in `system/init`. */
  observedCliVersion?: string | undefined;
  /** Whole-tree cache-write split from the latest result's `modelUsage` (display only). */
  latestCacheWrites?: { ephemeral5mInputTokens: number; ephemeral1hInputTokens: number };
  lastThreadStartedId: string | undefined;
  configuredBase: Record<string, unknown>;
  /** A failed live update can leave the CLI running a different model. */
  modelSelectionUnknown?: boolean;
  /**
   * Turn IDs whose turnState was cleared while interrupt was in-flight. Late
   * SDK output for these turns (result/assistant messages arriving after the
   * watchdog or SDK-driven interrupt completed the turn) must be suppressed,
   * otherwise we would emit duplicate `turn.completed` events or leak
   * post-interrupt content into the thread.
   */
  readonly interruptedTurnIds: Set<TurnId>;
  availableSlashCommands: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly argumentHint?: string;
  }>;
  slashCommandsLoaded: boolean;
  supportedCommandsFingerprint: string;
  baseContextChars: number;
  approximateConversationChars: number;
  compactionRecommendationEmitted: boolean;
  resumeCompactionDialogShown: boolean;
  resumeAttemptSessionId: string | undefined;
  resumeRejected?: boolean;
  /** A background transcript fork check, interrupted when the session stops. */
  forkCheckFiber?: Fiber.Fiber<void>;
  forkCheckRunning?: boolean;
  /** Task notifications seen since the last fork check; only they fork the transcript. */
  taskNotificationsSinceForkCheck?: number;
  resumeConfirmed: boolean;
  /**
   * Settles once the CLI confirms the resumed conversation, or the session
   * ends before it does. The first turn after a resume waits on this so a
   * prompt the CLI never loaded is not reported as delivered.
   */
  readonly resumeSettlement: Deferred.Deferred<ClaudeResumeSettlement> | undefined;
  /** Bounded CLI stderr tail, written to the provider log when the session ends. */
  readonly processDiagnostics: { stderrTail: string };
  resumeInvalidatedTurnId: TurnId | undefined;
  modelContextWindowTokens: number;
  readonly resultContextWindows: Map<string, number>;
  autoCompactWindow?: number | undefined;
  /** Resolved by completeTurn while Stop waits for Claude to abort the turn. */
  interruptedTurnSettled: Deferred.Deferred<void> | undefined;
  stopped: boolean;
  retiring: boolean;
  /** Agent browser/computer capabilities installed for this session generation. */
  agentBrowser: ClaudeAgentBrowserState | undefined;
  computerDispose?: () => void;
  computerEndTurn?: (turnId: string) => void;
}

// Streaming-input results carry a running total. Resumes may restore transcript
// totals; /clear resets them. An unknown resume baseline omits the first cost,
// rather than charging historical spend. Zeroed crash results never reset it.
// Suppressed late interrupt results are included in the next accounted delta;
// their individual turn cost cannot be recovered from cumulative totals alone.

export interface ClaudeMcpAuthenticateResponse {
  readonly authUrl?: string;
  readonly requiresUserAction?: boolean;
  readonly callbackExpected?: boolean;
}

export interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  /** Shipped native control helper; it uses the running child's isolated environment. */
  readonly renameSession?: (title: string, sessionId?: string) => Promise<void>;
  // SDK 0.3.292 ships this bounded native reader; keep it optional because
  // its Query declaration does not yet expose the control-channel helper.
  readonly getTaskOutput?: (
    taskId: string,
  ) => Promise<{ output: string; total_bytes: number; truncated: boolean }>;

  readonly stopTask?: (taskId: string) => Promise<void>;
  readonly rewindFiles?: (
    userMessageId: string,
    options?: { dryRun?: boolean },
  ) => Promise<RewindFilesResult>;
  readonly interrupt: () => Promise<unknown>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly applyFlagSettings: (settings: ClaudeRuntimeFlagSettings) => Promise<void>;
  readonly initializationResult?: () => Promise<unknown>;
  readonly mcpServerStatus?: () => Promise<ReadonlyArray<McpServerStatus>>;
  readonly toggleMcpServer?: (serverName: string, enabled: boolean) => Promise<void>;
  readonly supportedModels?: () => Promise<ReadonlyArray<unknown>>;
  readonly supportedCommands?: () => Promise<
    ReadonlyArray<{
      readonly name: string;
      readonly description: string;
      readonly argumentHint?: string;
    }>
  >;
  readonly setMcpServers?: (
    servers: Record<string, McpServerConfig>,
  ) => Promise<McpSetServersResult>;
  readonly reconnectMcpServer?: (serverName: string) => Promise<void>;
  /** Undocumented SDK control request (`mcp_authenticate`); feature-detected at runtime. */
  readonly mcpAuthenticate?: (
    serverName: string,
    redirectUri?: string,
  ) => Promise<ClaudeMcpAuthenticateResponse | undefined>;
  readonly close: () => void;
}

export interface ClaudeAdapterLiveOptions {
  readonly resolveBypassAvailability?: typeof resolveClaudeBypassAvailability;
  readonly oneOffProviderOptions?: ProviderStartOptions["claudeAgent"];
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly readResumeTranscript?: (
    input: ClaudeSessionProbeInput,
  ) => Promise<ReadonlyMap<string, Record<string, unknown>>>;
  readonly probeResumableClaudeSession?: (
    input: ClaudeSessionProbeInput,
  ) => Effect.Effect<"present" | "absent" | "unknown">;
  /**
   * How long the first turn after a resume waits for the CLI to confirm the
   * saved conversation. Zero skips the wait.
   */
  readonly resumeConfirmationTimeoutMs?: number;
  /**
   * How long Stop waits for Claude to abort a running turn before closing the
   * query. Zero closes immediately.
   */
  readonly interruptGraceMs?: number;
  /**
   * Hosts F5's in-process preview tools in interactive desktop sessions and
   * supplies live agent browser policy. Absent outside desktop mode.
   */
  readonly previewAutomationBroker?: PreviewAutomationBrokerShape;
  readonly threadMcpBroker?: ThreadMcpBroker["Service"];
  readonly computerAutomationBroker?: ComputerAutomationBrokerRuntime;
  readonly chromeRuntime?: ChromeSessionRuntime;
  /** Executable-reported model capabilities for this instance (SDK initialization). */
  readonly reportedModelCapabilities?: ClaudeReportedModelCapabilitiesLookup;
}

export interface ClaudeSessionProbeInput {
  readonly sessionId: string;
  /**
   * The Claude config dir the CLI child process writes transcripts to. This
   * must come from the provider process environment, not from the f5 server's
   * own `process.env`, because isolated profiles and custom `homePath`
   * settings point the CLI at a different directory.
   */
  readonly claudeConfigDir: string;
}

export interface ClaudeSessionStoreFs {
  readonly readdir: (path: string) => Promise<ReadonlyArray<string>>;
  readonly stat: (path: string) => Promise<{ readonly size: number; isFile(): boolean }>;
  /** Yields the file's lines in order and stops reading when `signal` aborts. */
  readonly readLines: (path: string, signal: AbortSignal) => AsyncIterable<string>;
}

export type ClaudeResumeSettlement =
  | { readonly outcome: "confirmed" }
  // A user Interrupt or Stop ended the session; the turn is interrupted as usual.
  | { readonly outcome: "cancelled" }
  | { readonly outcome: "failed"; readonly resumeRejected: boolean };

// Bounds how long the first turn after a resume waits for the CLI to confirm
// the saved conversation. On timeout the send is reported as before.
export const DEFAULT_CLAUDE_RESUME_CONFIRMATION_TIMEOUT_MS = 20_000;
export const DEFAULT_CLAUDE_INTERRUPT_GRACE_MS = 3_000;
/** One status read per second for up to 30 s after init. */
export const AGENT_BROWSER_STATUS_POLL_ATTEMPTS = 30;

export type ClaudeReportedModelCapabilitiesLookup = (
  model: string,
) => Effect.Effect<ModelCapabilities | undefined>;

/** A control request failed because the CLI ended before the prompt was queued. */
export class ClaudeQueryEndedBeforePrompt {
  constructor(
    readonly context: ClaudeSessionContext,
    readonly cause: unknown,
  ) {}
}
