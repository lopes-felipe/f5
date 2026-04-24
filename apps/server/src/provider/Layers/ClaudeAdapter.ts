/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import {
  type CanUseTool,
  query,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SDKMessage,
  type SDKResultMessage,
  type SettingSource,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  type ClaudeCodeEffort,
  type ProviderApprovalDecision,
  ProviderItemId,
  type ProviderRequestKind,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type RuntimeContentStreamKind,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  getEffectiveClaudeCodeEffort,
  getReasoningEffortOptions,
  resolveReasoningEffortForProvider,
  supportsClaudeFastMode,
  supportsClaudeThinkingToggle,
  supportsClaudeUltrathinkKeyword,
} from "@t3tools/shared/model";
import { filterReservedClaudeLaunchArgs } from "@t3tools/shared/cliArgs";
import { translateMcpForClaudeAgent } from "@t3tools/shared/mcpTranslation";
import {
  Cause,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Option,
  Queue,
  Random,
  Ref,
  Stream,
} from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { buildProviderChildProcessEnv } from "../../providerProcessEnv.ts";
import {
  fetchAnthropicModelContextWindowCatalog,
  lookupModelContextWindowTokens,
  readClaudeModelContextWindowCatalog,
} from "../modelContextWindowMetadata.ts";
import {
  estimateModelContextWindowTokens,
  roughTokenEstimateFromCharacters,
} from "../providerContext.ts";
import {
  buildClaudeAssistantInstructions,
  buildInstructionProfile,
  INSTRUCTION_PROFILE_CONFIG_KEY,
} from "../sharedAssistantContract.ts";
import {
  fingerprintSupportedSlashCommands,
  normalizeSupportedSlashCommands,
} from "../supportedSlashCommands.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { ClaudeAdapter, type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import type {
  ProviderConversationCompactionResult,
  ProviderOneOffPromptResult,
} from "../Services/ProviderAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "claudeAgent" as const;
const COMPACTION_QUERY_TIMEOUT = Duration.minutes(3);
type ClaudeTextStreamKind = Extract<RuntimeContentStreamKind, "assistant_text" | "reasoning_text">;
type ClaudeToolResultStreamKind = Extract<
  RuntimeContentStreamKind,
  "command_output" | "file_change_output"
>;
type ClaudeSdkEffort = Exclude<ClaudeCodeEffort, "ultrathink">;

type PromptQueueItem =
  | {
      readonly type: "message";
      readonly message: SDKUserMessage;
    }
  | {
      readonly type: "terminate";
    };

interface ClaudeResumeState {
  readonly threadId?: ThreadId;
  readonly resume?: string;
  readonly resumeSessionAt?: string;
  readonly turnCount?: number;
  readonly baseContextChars?: number;
  readonly approximateConversationChars?: number;
  readonly compactionRecommendationEmitted?: boolean;
}

interface ClaudeTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly items: Array<unknown>;
  readonly assistantTextBlocks: Map<number, AssistantTextBlockState>;
  readonly assistantTextBlockOrder: Array<AssistantTextBlockState>;
  readonly capturedProposedPlanKeys: Set<string>;
  nextSyntheticAssistantBlockIndex: number;
  interruptRequested: boolean;
  /**
   * Deferred signalled from `completeTurn` to cancel the interrupt watchdog
   * when the SDK drives completion before the 3s timeout elapses. Prevents
   * unbounded fiber accumulation under rapid stop/resend cycles.
   */
  watchdogCancel?: Deferred.Deferred<void>;
}

interface AssistantTextBlockState {
  readonly itemId: string;
  readonly blockIndex: number;
  emittedTextDelta: boolean;
  fallbackText: string;
  streamClosed: boolean;
  completionEmitted: boolean;
}

interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly suggestions?: ReadonlyArray<PermissionUpdate>;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  /**
   * Set by `resolvePendingInteractions` when it has already emitted the
   * terminal `request.resolved` event for this approval. Suppresses a second
   * emission from the awaiting canUseTool handler once its deferred resumes.
   */
  resolvedExternally: boolean;
}

interface PendingUserInput {
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

interface ToolInFlight {
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

interface ClaudeSessionContext {
  session: ProviderSession;
  readonly promptQueue: Queue.Queue<PromptQueueItem>;
  readonly query: ClaudeQueryRuntime;
  streamFiber: Fiber.Fiber<void, Error> | undefined;
  readonly startedAt: string;
  readonly basePermissionMode: PermissionMode | undefined;
  resumeSessionId: string | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{
    id: TurnId;
    items: Array<unknown>;
    approximateChars: number;
  }>;
  readonly inFlightTools: Map<number, ToolInFlight>;
  turnState: ClaudeTurnState | undefined;
  lastAssistantUuid: string | undefined;
  lastThreadStartedId: string | undefined;
  configuredBase: Record<string, unknown>;
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
  modelContextWindowTokens: number;
  stopped: boolean;
}

interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  readonly interrupt: () => Promise<void>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
  readonly initializationResult?: () => Promise<unknown>;
  readonly supportedModels?: () => Promise<ReadonlyArray<unknown>>;
  readonly supportedCommands?: () => Promise<
    ReadonlyArray<{
      readonly name: string;
      readonly description: string;
      readonly argumentHint?: string;
    }>
  >;
  readonly close: () => void;
}

interface ClaudeAppendSystemPromptConfig {
  readonly type: "preset";
  readonly preset: "claude_code";
  readonly append: string;
}

type ClaudeQueryOptionsWithAppend = Omit<ClaudeQueryOptions, "effort"> & {
  readonly effort?: ClaudeSdkEffort;
  readonly appendSystemPrompt?: ClaudeAppendSystemPromptConfig;
};

export interface ClaudeAdapterLiveOptions {
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptionsWithAppend;
  }) => ClaudeQueryRuntime;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSyntheticClaudeThreadId(value: string): boolean {
  return value.startsWith("claude-thread-");
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(toMessage(cause, fallback));
}

function normalizeClaudeStreamMessages(cause: Cause.Cause<Error>): ReadonlyArray<string> {
  const errors = Cause.prettyErrors(cause)
    .map((error) => error.message.trim())
    .filter((message) => message.length > 0);
  if (errors.length > 0) {
    return errors;
  }

  const squashed = toMessage(Cause.squash(cause), "").trim();
  return squashed.length > 0 ? [squashed] : [];
}

function isClaudeInterruptedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("all fibers interrupted without error") ||
    normalized.includes("request was aborted") ||
    normalized.includes("interrupted by user")
  );
}

function isClaudeInterruptedCause(cause: Cause.Cause<Error>): boolean {
  return (
    Cause.hasInterruptsOnly(cause) ||
    normalizeClaudeStreamMessages(cause).some(isClaudeInterruptedMessage)
  );
}

function messageFromClaudeStreamCause(cause: Cause.Cause<Error>, fallback: string): string {
  return normalizeClaudeStreamMessages(cause)[0] ?? fallback;
}

function interruptionMessageFromClaudeCause(cause: Cause.Cause<Error>): string {
  const message = messageFromClaudeStreamCause(cause, "Claude runtime interrupted.");
  return isClaudeInterruptedMessage(message) ? "Claude runtime interrupted." : message;
}

function makeClaudePromptInput(
  promptQueue: Queue.Queue<PromptQueueItem>,
): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
      return {
        next: async (): Promise<IteratorResult<SDKUserMessage>> => {
          while (true) {
            const exit = await Effect.runPromise(Effect.exit(Queue.take(promptQueue)));
            if (Exit.isFailure(exit)) {
              return {
                done: true,
                value: undefined,
              };
            }

            if (exit.value.type === "terminate") {
              return {
                done: true,
                value: undefined,
              };
            }

            return {
              done: false,
              value: exit.value.message,
            };
          }
        },
        return: async () => ({
          done: true,
          value: undefined,
        }),
      };
    },
  };
}

function resultErrorsText(result: SDKResultMessage): string {
  return "errors" in result && Array.isArray(result.errors)
    ? result.errors.join(" ").toLowerCase()
    : "";
}

function isInterruptedResult(result: SDKResultMessage): boolean {
  const errors = resultErrorsText(result);
  if (errors.includes("interrupt")) {
    return true;
  }

  return (
    result.subtype === "error_during_execution" &&
    result.is_error === false &&
    (errors.includes("request was aborted") ||
      errors.includes("interrupted by user") ||
      errors.includes("aborted"))
  );
}

function asRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(value);
}

function asCanonicalTurnId(value: TurnId): TurnId {
  return value;
}

function asRuntimeRequestId(value: ApprovalRequestId): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(value);
}

function toPermissionMode(value: unknown): PermissionMode | undefined {
  switch (value) {
    case "default":
    case "acceptEdits":
    case "bypassPermissions":
    case "plan":
    case "dontAsk":
      return value;
    default:
      return undefined;
  }
}

function readClaudeResumeState(resumeCursor: unknown): ClaudeResumeState | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const cursor = resumeCursor as {
    threadId?: unknown;
    resume?: unknown;
    sessionId?: unknown;
    resumeSessionAt?: unknown;
    turnCount?: unknown;
    baseContextChars?: unknown;
    approximateConversationChars?: unknown;
    compactionRecommendationEmitted?: unknown;
  };

  const threadIdCandidate = typeof cursor.threadId === "string" ? cursor.threadId : undefined;
  const threadId =
    threadIdCandidate && !isSyntheticClaudeThreadId(threadIdCandidate)
      ? ThreadId.makeUnsafe(threadIdCandidate)
      : undefined;
  const resumeCandidate =
    typeof cursor.resume === "string"
      ? cursor.resume
      : typeof cursor.sessionId === "string"
        ? cursor.sessionId
        : undefined;
  const resume = resumeCandidate && isUuid(resumeCandidate) ? resumeCandidate : undefined;
  const resumeSessionAt =
    typeof cursor.resumeSessionAt === "string" ? cursor.resumeSessionAt : undefined;
  const turnCountValue = typeof cursor.turnCount === "number" ? cursor.turnCount : undefined;
  const baseContextCharsValue =
    typeof cursor.baseContextChars === "number" ? cursor.baseContextChars : undefined;
  const approximateConversationCharsValue =
    typeof cursor.approximateConversationChars === "number"
      ? cursor.approximateConversationChars
      : undefined;
  const compactionRecommendationEmitted =
    typeof cursor.compactionRecommendationEmitted === "boolean"
      ? cursor.compactionRecommendationEmitted
      : undefined;

  return {
    ...(threadId ? { threadId } : {}),
    ...(resume ? { resume } : {}),
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    ...(turnCountValue !== undefined && Number.isInteger(turnCountValue) && turnCountValue >= 0
      ? { turnCount: turnCountValue }
      : {}),
    ...(baseContextCharsValue !== undefined &&
    Number.isInteger(baseContextCharsValue) &&
    baseContextCharsValue >= 0
      ? { baseContextChars: baseContextCharsValue }
      : {}),
    ...(approximateConversationCharsValue !== undefined &&
    Number.isInteger(approximateConversationCharsValue) &&
    approximateConversationCharsValue >= 0
      ? { approximateConversationChars: approximateConversationCharsValue }
      : {}),
    ...(compactionRecommendationEmitted !== undefined ? { compactionRecommendationEmitted } : {}),
  };
}

function classifyToolItemType(
  toolName: string,
  options?: { readonly blockType?: string },
): CanonicalItemType {
  if (options?.blockType?.toLowerCase() === "mcp_tool_use") {
    return "mcp_tool_call";
  }

  const normalized = toolName.toLowerCase();
  if (normalized === "todowrite") {
    return "dynamic_tool_call";
  }
  if (normalized.includes("agent")) {
    return "collab_agent_tool_call";
  }
  if (
    normalized === "task" ||
    normalized === "agent" ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

function classifyToolRequestKind(
  toolName: string,
  options?: { readonly blockType?: string },
): ProviderRequestKind | undefined {
  if (options?.blockType?.toLowerCase() === "mcp_tool_use") return undefined;
  const n = toolName.toLowerCase();
  if (n === "read") return "file-read";
  if (n === "edit" || n === "write" || n === "multiedit" || n === "notebookedit") {
    return "file-change";
  }
  if (n === "bash") return "command";
  return undefined; // Glob/Grep/WebSearch/TodoWrite/Task/MCP keep existing behavior
}

function isReadOnlyToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "read" ||
    normalized.includes("read file") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}

function classifyRequestType(toolName: string): CanonicalRequestType {
  if (isReadOnlyToolName(toolName)) {
    return "file_read_approval";
  }
  const itemType = classifyToolItemType(toolName);
  return itemType === "command_execution"
    ? "command_execution_approval"
    : itemType === "file_change"
      ? "file_change_approval"
      : "dynamic_tool_call";
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function usageFromClaudeStreamEvent(
  message: SDKMessage,
): { readonly rawMethod: string; readonly usage: unknown } | undefined {
  if (message.type !== "stream_event") {
    return undefined;
  }

  const event = message.event;
  if (event.type === "message_start") {
    const usage = (event.message as { readonly usage?: unknown } | undefined)?.usage;
    return usage === undefined
      ? undefined
      : {
          rawMethod: "claude/stream_event/message_start",
          usage,
        };
  }

  if (event.type === "message_delta") {
    return event.usage === undefined
      ? undefined
      : {
          rawMethod: "claude/stream_event/message_delta",
          usage: event.usage,
        };
  }

  return undefined;
}

function getClaudeSessionModel(context: ClaudeSessionContext): string | undefined {
  return (
    normalizeOptionalString(context.session.model) ??
    normalizeOptionalString(context.configuredBase.model)
  );
}

async function lookupClaudeReportedModelContextWindowTokens(
  context: ClaudeSessionContext,
): Promise<number | undefined> {
  const model = getClaudeSessionModel(context);
  if (!model) {
    return undefined;
  }

  if (context.query.initializationResult) {
    const initializationCatalog = readClaudeModelContextWindowCatalog(
      await context.query.initializationResult(),
    );
    const initializationTokens = lookupModelContextWindowTokens({
      provider: "claudeAgent",
      model,
      catalog: initializationCatalog,
    });
    if (initializationTokens !== undefined) {
      return initializationTokens;
    }
  }

  if (context.query.supportedModels) {
    const supportedModelsCatalog = readClaudeModelContextWindowCatalog(
      await context.query.supportedModels(),
    );
    const supportedModelsTokens = lookupModelContextWindowTokens({
      provider: "claudeAgent",
      model,
      catalog: supportedModelsCatalog,
    });
    if (supportedModelsTokens !== undefined) {
      return supportedModelsTokens;
    }
  }

  const fetchedCatalog = await fetchAnthropicModelContextWindowCatalog({
    apiKey: process.env.ANTHROPIC_API_KEY,
    authToken: process.env.ANTHROPIC_AUTH_TOKEN,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
  });
  return lookupModelContextWindowTokens({
    provider: "claudeAgent",
    model,
    catalog: fetchedCatalog,
  });
}

function formatSubagentLabel(subagentType: string): string {
  return subagentType
    .split(/[-_\s]+/g)
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
    .join(" ");
}

function readSubagentMetadata(
  input: Record<string, unknown>,
  result?: Record<string, unknown>,
): {
  readonly subagentType?: string;
  readonly subagentDescription?: string;
  readonly subagentPrompt?: string;
  readonly subagentResult?: string;
  readonly subagentModel?: string;
} {
  const subagentType = normalizeOptionalString(input.subagent_type);
  const subagentDescription = normalizeOptionalString(input.description);
  const subagentPrompt = normalizeOptionalString(input.prompt);
  const subagentResult = normalizeOptionalString(
    result ? extractTextContent(result.content ?? result) : undefined,
  );
  const subagentModel = normalizeOptionalString(input.model);

  return {
    ...(subagentType ? { subagentType } : {}),
    ...(subagentDescription ? { subagentDescription } : {}),
    ...(subagentPrompt ? { subagentPrompt } : {}),
    ...(subagentResult ? { subagentResult } : {}),
    ...(subagentModel ? { subagentModel } : {}),
  };
}

function buildToolLifecycleData(input: {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
}): Record<string, unknown> {
  const itemType = classifyToolItemType(input.toolName);
  const subagentMetadata =
    itemType === "collab_agent_tool_call"
      ? readSubagentMetadata(input.toolInput, input.result)
      : undefined;

  return {
    toolName: input.toolName,
    input: input.toolInput,
    ...(input.result ? { result: input.result } : {}),
    ...subagentMetadata,
  };
}

function fileOrientedToolDetail(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  const n = toolName.toLowerCase();
  const isFileTool =
    n === "read" || n === "edit" || n === "write" || n === "multiedit" || n === "notebookedit";
  if (!isFileTool) return undefined;
  return (
    normalizeOptionalString(input.file_path) ??
    normalizeOptionalString(input.notebook_path) ??
    normalizeOptionalString(input.path)
  );
}

function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  if (classifyToolItemType(toolName) === "collab_agent_tool_call") {
    const description = normalizeOptionalString(input.description);
    if (description) {
      return `${toolName}: ${description.slice(0, 400)}`;
    }

    const prompt = normalizeOptionalString(input.prompt);
    if (prompt) {
      return `${toolName}: ${prompt.slice(0, 400)}`;
    }
  }

  if (toolName.toLowerCase() === "todowrite" && Array.isArray(input.todos)) {
    const total = input.todos.length;
    return `${toolName}: ${total} task${total === 1 ? "" : "s"}`;
  }

  const filePath = fileOrientedToolDetail(toolName, input);
  if (filePath) return filePath;

  const commandValue = input.command ?? input.cmd;
  const command = typeof commandValue === "string" ? commandValue : undefined;
  if (command && command.trim().length > 0) {
    return `${toolName}: ${command.trim().slice(0, 400)}`;
  }

  const serialized = JSON.stringify(input);
  if (serialized.length <= 400) {
    return `${toolName}: ${serialized}`;
  }
  return `${toolName}: ${serialized.slice(0, 397)}...`;
}

function titleForTool(itemType: CanonicalItemType, input?: Record<string, unknown>): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call": {
      const subagentType = input ? normalizeOptionalString(input.subagent_type) : undefined;
      return subagentType ? `${formatSubagentLabel(subagentType)} agent` : "Subagent task";
    }
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

const SUPPORTED_CLAUDE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const CLAUDE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

function buildClaudeQueryEnv(providerOptions?: {
  readonly subagentModel?: string | undefined;
}): NodeJS.ProcessEnv {
  const subagentModel = normalizeOptionalString(providerOptions?.subagentModel);
  if (!subagentModel) {
    return buildProviderChildProcessEnv();
  }

  if (subagentModel === "inherit") {
    return buildProviderChildProcessEnv(process.env, {
      CLAUDE_CODE_SUBAGENT_MODEL: undefined,
    });
  }

  return buildProviderChildProcessEnv(process.env, {
    CLAUDE_CODE_SUBAGENT_MODEL: subagentModel,
  });
}

function buildPromptText(input: ProviderSendTurnInput): string {
  const requestedEffort = resolveReasoningEffortForProvider(
    "claudeAgent",
    input.modelOptions?.claudeAgent?.effort ?? null,
  );
  const supportedEffortOptions = getReasoningEffortOptions("claudeAgent", input.model);
  const promptEffort =
    requestedEffort === "ultrathink" && supportsClaudeUltrathinkKeyword(input.model)
      ? "ultrathink"
      : requestedEffort && supportedEffortOptions.includes(requestedEffort)
        ? requestedEffort
        : null;
  return applyClaudePromptEffortPrefix(input.input?.trim() ?? "", promptEffort);
}

function buildUserMessage(input: {
  readonly sdkContent: Array<Record<string, unknown>>;
}): SDKUserMessage {
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: input.sdkContent,
    },
  } as SDKUserMessage;
}

function buildClaudeImageContentBlock(input: {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}): Record<string, unknown> {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: input.mimeType,
      data: Buffer.from(input.bytes).toString("base64"),
    },
  };
}

function buildUserMessageEffect(
  input: ProviderSendTurnInput,
  dependencies: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly attachmentsDir: string;
  },
): Effect.Effect<SDKUserMessage, ProviderAdapterRequestError> {
  return Effect.gen(function* () {
    const text = buildPromptText(input);
    const sdkContent: Array<Record<string, unknown>> = [];

    if (text.length > 0) {
      sdkContent.push({ type: "text", text });
    }

    for (const attachment of input.attachments ?? []) {
      if (attachment.type !== "image") {
        continue;
      }

      if (!SUPPORTED_CLAUDE_IMAGE_MIME_TYPES.has(attachment.mimeType)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: `Unsupported Claude image attachment type '${attachment.mimeType}'.`,
        });
      }

      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: dependencies.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: `Invalid attachment id '${attachment.id}'.`,
        });
      }

      const bytes = yield* dependencies.fileSystem.readFile(attachmentPath).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/start",
              detail: toMessage(cause, "Failed to read attachment file."),
              cause,
            }),
        ),
      );

      sdkContent.push(
        buildClaudeImageContentBlock({
          mimeType: attachment.mimeType,
          bytes,
        }),
      );
    }

    return buildUserMessage({ sdkContent });
  });
}

function turnStatusFromResult(result: SDKResultMessage): ProviderRuntimeTurnStatus {
  if (result.subtype === "success") {
    return "completed";
  }

  const errors = resultErrorsText(result);
  if (isInterruptedResult(result)) {
    return "interrupted";
  }
  if (errors.includes("cancel")) {
    return "cancelled";
  }
  return "failed";
}

function streamKindFromDeltaType(deltaType: string): ClaudeTextStreamKind {
  return deltaType.includes("thinking") ? "reasoning_text" : "assistant_text";
}

function nativeProviderRefs(
  _context: ClaudeSessionContext,
  options?: {
    readonly providerItemId?: string | undefined;
  },
): NonNullable<ProviderRuntimeEvent["providerRefs"]> {
  if (options?.providerItemId) {
    return {
      providerItemId: ProviderItemId.makeUnsafe(options.providerItemId),
    };
  }
  return {};
}

function extractAssistantTextBlocks(message: SDKMessage): Array<string> {
  if (message.type !== "assistant") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const fragments: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (
      candidate.type === "text" &&
      typeof candidate.text === "string" &&
      candidate.text.length > 0
    ) {
      fragments.push(candidate.text);
    }
  }

  return fragments;
}

function extractContentBlockText(block: unknown): string {
  if (!block || typeof block !== "object") {
    return "";
  }

  const candidate = block as { type?: unknown; text?: unknown };
  return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => extractTextContent(entry)).join("");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    text?: unknown;
    content?: unknown;
  };

  if (typeof record.text === "string") {
    return record.text;
  }

  return extractTextContent(record.content);
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function approximateContextCharsFromContentBlock(block: unknown): number {
  if (!block || typeof block !== "object") {
    return 0;
  }

  const record = block as {
    type?: unknown;
    text?: unknown;
    thinking?: unknown;
    name?: unknown;
    input?: unknown;
    content?: unknown;
  };

  switch (record.type) {
    case "text":
      return typeof record.text === "string" ? record.text.length : 0;
    case "thinking":
      return typeof record.thinking === "string" ? record.thinking.length : 0;
    case "tool_use":
    case "server_tool_use":
    case "mcp_tool_use":
      return (
        (typeof record.name === "string" ? record.name.length : 0) + safeJsonLength(record.input)
      );
    case "tool_result":
      return extractTextContent(record.content).length;
    case "image":
    case "document":
      return 16;
    default:
      return extractTextContent(block).length;
  }
}

function approximateContextCharsFromMessageContent(content: unknown): number {
  if (typeof content === "string") {
    return content.length;
  }
  if (Array.isArray(content)) {
    return content.reduce<number>(
      (total, block) => total + approximateContextCharsFromContentBlock(block),
      0,
    );
  }
  return extractTextContent(content).length;
}

function approximateContextCharsFromTurnItems(items: ReadonlyArray<unknown>): number {
  return items.reduce<number>((total, item) => {
    if (!item || typeof item !== "object") {
      return total;
    }
    const record = item as { content?: unknown };
    if ("content" in record) {
      return total + approximateContextCharsFromMessageContent(record.content);
    }
    return total + safeJsonLength(item);
  }, 0);
}

function extractExitPlanModePlan(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as {
    plan?: unknown;
  };
  return typeof record.plan === "string" && record.plan.trim().length > 0
    ? record.plan.trim()
    : undefined;
}

function exitPlanCaptureKey(input: {
  readonly toolUseId?: string | undefined;
  readonly planMarkdown: string;
}): string {
  return input.toolUseId && input.toolUseId.length > 0
    ? `tool:${input.toolUseId}`
    : `plan:${input.planMarkdown}`;
}

function tryParseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function toolInputFingerprint(input: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(input);
  } catch {
    return undefined;
  }
}

function toolResultStreamKind(itemType: CanonicalItemType): ClaudeToolResultStreamKind | undefined {
  switch (itemType) {
    case "command_execution":
      return "command_output";
    case "file_change":
      return "file_change_output";
    default:
      return undefined;
  }
}

function toolResultBlocksFromUserMessage(message: SDKMessage): Array<{
  readonly toolUseId: string;
  readonly block: Record<string, unknown>;
  readonly text: string;
  readonly isError: boolean;
}> {
  if (message.type !== "user") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: Array<{
    readonly toolUseId: string;
    readonly block: Record<string, unknown>;
    readonly text: string;
    readonly isError: boolean;
  }> = [];

  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const block = entry as Record<string, unknown>;
    if (block.type !== "tool_result") {
      continue;
    }

    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    if (!toolUseId) {
      continue;
    }

    blocks.push({
      toolUseId,
      block,
      text: extractTextContent(block.content),
      isError: block.is_error === true,
    });
  }

  return blocks;
}

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("not found")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function sdkMessageType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { type?: unknown };
  return typeof record.type === "string" ? record.type : undefined;
}

function sdkMessageSubtype(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { subtype?: unknown };
  return typeof record.subtype === "string" ? record.subtype : undefined;
}

function sdkNativeMethod(message: SDKMessage): string {
  const subtype = sdkMessageSubtype(message);
  if (subtype) {
    return `claude/${message.type}/${subtype}`;
  }

  if (message.type === "stream_event") {
    const streamType = sdkMessageType(message.event);
    if (streamType) {
      const deltaType =
        streamType === "content_block_delta"
          ? sdkMessageType((message.event as { delta?: unknown }).delta)
          : undefined;
      if (deltaType) {
        return `claude/${message.type}/${streamType}/${deltaType}`;
      }
      return `claude/${message.type}/${streamType}`;
    }
  }

  return `claude/${message.type}`;
}

function sdkNativeItemId(message: SDKMessage): string | undefined {
  if (message.type === "assistant") {
    const maybeId = (message.message as { id?: unknown }).id;
    if (typeof maybeId === "string") {
      return maybeId;
    }
    return undefined;
  }

  if (message.type === "user") {
    return toolResultBlocksFromUserMessage(message)[0]?.toolUseId;
  }

  if (message.type === "stream_event") {
    const event = message.event as {
      type?: unknown;
      content_block?: { id?: unknown };
    };
    if (event.type === "content_block_start" && typeof event.content_block?.id === "string") {
      return event.content_block.id;
    }
  }

  return undefined;
}

function makeClaudeAdapter(options?: ClaudeAdapterLiveOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);

    const createQuery =
      options?.createQuery ??
      ((input: {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptionsWithAppend;
      }) =>
        // Claude Code added `xhigh` for Opus 4.7 before the installed SDK
        // typings caught up, so we widen the local type here and cast only at
        // the SDK boundary.
        query({
          prompt: input.prompt,
          options: input.options as ClaudeQueryOptions,
        }) as ClaudeQueryRuntime);

    const sessions = new Map<ThreadId, ClaudeSessionContext>();
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

    const emitSessionConfigured = (
      context: ClaudeSessionContext,
      config: Record<string, unknown>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        context.configuredBase = config;

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.configured",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          payload: {
            config: {
              ...context.configuredBase,
              modelContextWindowTokens: context.modelContextWindowTokens,
              ...(context.slashCommandsLoaded
                ? { slashCommands: [...context.availableSlashCommands] }
                : {}),
            },
          },
          providerRefs: nativeProviderRefs(context),
        });
      });

    const refreshModelContextWindowTokens = (context: ClaudeSessionContext): Effect.Effect<void> =>
      Effect.gen(function* () {
        const requestedModel = getClaudeSessionModel(context);
        if (!requestedModel) {
          return;
        }

        const reportedTokens = yield* Effect.promise(() =>
          lookupClaudeReportedModelContextWindowTokens(context),
        ).pipe(Effect.orElseSucceed(() => undefined));
        if (
          reportedTokens === undefined ||
          requestedModel !== getClaudeSessionModel(context) ||
          reportedTokens === context.modelContextWindowTokens
        ) {
          return;
        }

        context.modelContextWindowTokens = reportedTokens;
        yield* emitSessionConfigured(context, context.configuredBase);
      });

    const refreshSupportedCommands = (context: ClaudeSessionContext): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!context.query.supportedCommands) {
          return;
        }

        const supportedCommandsResult = yield* Effect.exit(
          Effect.tryPromise({
            try: () => context.query.supportedCommands!(),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "supportedCommands",
                detail: toMessage(cause, "Failed to query Claude supported commands."),
                cause,
              }),
          }),
        );
        if (Exit.isFailure(supportedCommandsResult)) {
          const error = Cause.squash(supportedCommandsResult.cause);
          yield* Effect.logWarning("failed to query Claude supported commands", {
            threadId: context.session.threadId,
            detail:
              typeof error === "object" && error !== null && "detail" in error
                ? String(error.detail)
                : toMessage(error, "Failed to query Claude supported commands."),
          });
          return;
        }

        const normalizedCommands = normalizeSupportedSlashCommands(supportedCommandsResult.value);
        const fingerprint = fingerprintSupportedSlashCommands(normalizedCommands);
        if (context.slashCommandsLoaded && fingerprint === context.supportedCommandsFingerprint) {
          return;
        }

        context.slashCommandsLoaded = true;
        context.availableSlashCommands = normalizedCommands;
        context.supportedCommandsFingerprint = fingerprint;
        yield* emitSessionConfigured(context, context.configuredBase);
      });

    const logNativeSdkMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!nativeEventLogger) {
          return;
        }

        const observedAt = new Date().toISOString();
        const itemId = sdkNativeItemId(message);

        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id:
                "uuid" in message && typeof message.uuid === "string"
                  ? message.uuid
                  : crypto.randomUUID(),
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method: sdkNativeMethod(message),
              ...(typeof message.session_id === "string"
                ? { providerThreadId: message.session_id }
                : {}),
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              ...(itemId ? { itemId: ProviderItemId.makeUnsafe(itemId) } : {}),
              payload: message,
            },
          },
          context.session.threadId,
        );
      });

    const snapshotThread = (
      context: ClaudeSessionContext,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: ReadonlyArray<{
          id: TurnId;
          items: ReadonlyArray<unknown>;
        }>;
      },
      ProviderAdapterValidationError
    > =>
      Effect.gen(function* () {
        const threadId = context.session.threadId;
        if (!threadId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "readThread",
            issue: "Session thread id is not initialized yet.",
          });
        }
        return {
          threadId,
          turns: context.turns.map((turn) => ({
            id: turn.id,
            items: [...turn.items],
          })),
        };
      });

    const updateResumeCursor = (context: ClaudeSessionContext): Effect.Effect<void> =>
      Effect.gen(function* () {
        const threadId = context.session.threadId;
        if (!threadId) return;

        const resumeCursor = {
          threadId,
          ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
          ...(context.lastAssistantUuid ? { resumeSessionAt: context.lastAssistantUuid } : {}),
          turnCount: context.turns.length,
          baseContextChars: context.baseContextChars,
          approximateConversationChars: context.approximateConversationChars,
          compactionRecommendationEmitted: context.compactionRecommendationEmitted,
        };

        context.session = {
          ...context.session,
          resumeCursor,
          updatedAt: yield* nowIso,
        };
      });

    const ensureAssistantTextBlock = (
      context: ClaudeSessionContext,
      blockIndex: number,
      options?: {
        readonly fallbackText?: string;
        readonly streamClosed?: boolean;
      },
    ): Effect.Effect<
      | {
          readonly blockIndex: number;
          readonly block: AssistantTextBlockState;
        }
      | undefined
    > =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState) {
          return undefined;
        }

        const existing = turnState.assistantTextBlocks.get(blockIndex);
        if (existing && !existing.completionEmitted) {
          if (existing.fallbackText.length === 0 && options?.fallbackText) {
            existing.fallbackText = options.fallbackText;
          }
          if (options?.streamClosed) {
            existing.streamClosed = true;
          }
          return { blockIndex, block: existing };
        }

        const block: AssistantTextBlockState = {
          itemId: yield* Random.nextUUIDv4,
          blockIndex,
          emittedTextDelta: false,
          fallbackText: options?.fallbackText ?? "",
          streamClosed: options?.streamClosed ?? false,
          completionEmitted: false,
        };
        turnState.assistantTextBlocks.set(blockIndex, block);
        turnState.assistantTextBlockOrder.push(block);
        return { blockIndex, block };
      });

    const createSyntheticAssistantTextBlock = (
      context: ClaudeSessionContext,
      fallbackText: string,
    ): Effect.Effect<
      | {
          readonly blockIndex: number;
          readonly block: AssistantTextBlockState;
        }
      | undefined
    > =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState) {
          return undefined;
        }

        const blockIndex = turnState.nextSyntheticAssistantBlockIndex;
        turnState.nextSyntheticAssistantBlockIndex -= 1;
        return yield* ensureAssistantTextBlock(context, blockIndex, {
          fallbackText,
          streamClosed: true,
        });
      });

    const completeAssistantTextBlock = (
      context: ClaudeSessionContext,
      block: AssistantTextBlockState,
      options?: {
        readonly force?: boolean;
        readonly rawMethod?: string;
        readonly rawPayload?: unknown;
      },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState || block.completionEmitted) {
          return;
        }

        if (!options?.force && !block.streamClosed) {
          return;
        }

        if (!block.emittedTextDelta && block.fallbackText.length > 0) {
          const deltaStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "content.delta",
            eventId: deltaStamp.eventId,
            provider: PROVIDER,
            createdAt: deltaStamp.createdAt,
            threadId: context.session.threadId,
            turnId: turnState.turnId,
            itemId: asRuntimeItemId(block.itemId),
            payload: {
              streamKind: "assistant_text",
              delta: block.fallbackText,
            },
            providerRefs: nativeProviderRefs(context),
            ...(options?.rawMethod || options?.rawPayload
              ? {
                  raw: {
                    source: "claude.sdk.message" as const,
                    ...(options.rawMethod ? { method: options.rawMethod } : {}),
                    payload: options?.rawPayload,
                  },
                }
              : {}),
          });
        }

        block.completionEmitted = true;
        if (turnState.assistantTextBlocks.get(block.blockIndex) === block) {
          turnState.assistantTextBlocks.delete(block.blockIndex);
        }

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.completed",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          itemId: asRuntimeItemId(block.itemId),
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            ...(block.fallbackText.length > 0 ? { detail: block.fallbackText } : {}),
          },
          providerRefs: nativeProviderRefs(context),
          ...(options?.rawMethod || options?.rawPayload
            ? {
                raw: {
                  source: "claude.sdk.message" as const,
                  ...(options.rawMethod ? { method: options.rawMethod } : {}),
                  payload: options?.rawPayload,
                },
              }
            : {}),
        });
      });

    const backfillAssistantTextBlocksFromSnapshot = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState) {
          return;
        }

        const snapshotTextBlocks = extractAssistantTextBlocks(message);
        if (snapshotTextBlocks.length === 0) {
          return;
        }

        const orderedBlocks = turnState.assistantTextBlockOrder.map((block) => ({
          blockIndex: block.blockIndex,
          block,
        }));

        for (const [position, text] of snapshotTextBlocks.entries()) {
          const existingEntry = orderedBlocks[position];
          const entry =
            existingEntry ??
            (yield* createSyntheticAssistantTextBlock(context, text).pipe(
              Effect.map((created) => {
                if (!created) {
                  return undefined;
                }
                orderedBlocks.push(created);
                return created;
              }),
            ));
          if (!entry) {
            continue;
          }

          if (entry.block.fallbackText.length === 0) {
            entry.block.fallbackText = text;
          }

          if (entry.block.streamClosed && !entry.block.completionEmitted) {
            yield* completeAssistantTextBlock(context, entry.block, {
              rawMethod: "claude/assistant",
              rawPayload: message,
            });
          }
        }
      });

    const ensureThreadId = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (typeof message.session_id !== "string" || message.session_id.length === 0) {
          return;
        }
        const nextThreadId = message.session_id;
        context.resumeSessionId = message.session_id;
        yield* updateResumeCursor(context);

        if (context.lastThreadStartedId !== nextThreadId) {
          context.lastThreadStartedId = nextThreadId;
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "thread.started",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            payload: {
              providerThreadId: nextThreadId,
            },
            providerRefs: {},
            raw: {
              source: "claude.sdk.message",
              method: "claude/thread/started",
              payload: {
                session_id: message.session_id,
              },
            },
          });
        }
      });

    const emitRuntimeError = (
      context: ClaudeSessionContext,
      message: string,
      cause?: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (cause !== undefined) {
          void cause;
        }
        const turnState = context.turnState;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "runtime.error",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
          payload: {
            message,
            class: "provider_error",
            ...(cause !== undefined ? { detail: cause } : {}),
          },
          providerRefs: nativeProviderRefs(context),
        });
      });

    const emitRuntimeWarning = (
      context: ClaudeSessionContext,
      message: string,
      detail?: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "runtime.warning",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
          payload: {
            message,
            ...(detail !== undefined ? { detail } : {}),
          },
          providerRefs: nativeProviderRefs(context),
        });
      });

    const maybeRecommendCompaction = (
      context: ClaudeSessionContext,
      turnId: TurnId | undefined,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (context.compactionRecommendationEmitted) {
          return;
        }

        const estimatedTokens = roughTokenEstimateFromCharacters(
          context.baseContextChars + context.approximateConversationChars,
        );
        const thresholdTokens = Math.floor(context.modelContextWindowTokens * 0.8);
        if (estimatedTokens < thresholdTokens) {
          return;
        }

        context.compactionRecommendationEmitted = true;
        yield* updateResumeCursor(context);

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "compaction.recommended",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(turnId ? { turnId } : {}),
          payload: {
            estimatedTokens,
            thresholdTokens,
            modelContextWindowTokens: context.modelContextWindowTokens,
          },
          providerRefs: nativeProviderRefs(context),
        });
      });

    const emitProposedPlanCompleted = (
      context: ClaudeSessionContext,
      input: {
        readonly planMarkdown: string;
        readonly toolUseId?: string | undefined;
        readonly rawSource: "claude.sdk.message" | "claude.sdk.permission";
        readonly rawMethod: string;
        readonly rawPayload: unknown;
      },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        const planMarkdown = input.planMarkdown.trim();
        if (!turnState || planMarkdown.length === 0) {
          return;
        }

        const captureKey = exitPlanCaptureKey({
          toolUseId: input.toolUseId,
          planMarkdown,
        });
        if (turnState.capturedProposedPlanKeys.has(captureKey)) {
          return;
        }
        turnState.capturedProposedPlanKeys.add(captureKey);

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.proposed.completed",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          payload: {
            planMarkdown,
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: input.toolUseId,
          }),
          raw: {
            source: input.rawSource,
            method: input.rawMethod,
            payload: input.rawPayload,
          },
        });
      });

    const completeTurn = (
      context: ClaudeSessionContext,
      status: ProviderRuntimeTurnStatus,
      errorMessage?: string,
      result?: SDKResultMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState) {
          // Late result for an already-completed (e.g. watchdog-interrupted)
          // turn — drop it so we don't emit a duplicate `turn.completed`.
          // SDKResultMessage doesn't carry a turnId, but the only way we
          // reach this branch in practice is a delayed SDK result arriving
          // after we already force-completed the turn on interrupt.
          if (context.interruptedTurnIds.size > 0) {
            return;
          }
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "turn.completed",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(context.session.resumeCursor !== undefined
              ? { resumeCursor: context.session.resumeCursor }
              : {}),
            payload: {
              state: status,
              ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
              ...(result?.usage ? { usage: result.usage } : {}),
              ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
              ...(typeof result?.total_cost_usd === "number"
                ? { totalCostUsd: result.total_cost_usd }
                : {}),
              ...(errorMessage ? { errorMessage } : {}),
            },
            providerRefs: {},
          });
          return;
        }

        // Cancel any interrupt watchdog still waiting to force-complete this
        // turn. Safe to signal even if the watchdog already fired — the
        // deferred is resolve-once.
        if (turnState.watchdogCancel) {
          yield* Deferred.succeed(turnState.watchdogCancel, undefined).pipe(Effect.ignore);
        }
        if (status === "interrupted") {
          context.interruptedTurnIds.add(turnState.turnId);
        }

        for (const [index, tool] of context.inFlightTools.entries()) {
          const toolStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "item.completed",
            eventId: toolStamp.eventId,
            provider: PROVIDER,
            createdAt: toolStamp.createdAt,
            threadId: context.session.threadId,
            turnId: turnState.turnId,
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: status === "completed" ? "completed" : "failed",
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              data: {
                toolName: tool.toolName,
                input: tool.input,
              },
            },
            providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
            raw: {
              source: "claude.sdk.message",
              method: "claude/result",
              payload: result ?? { status },
            },
          });
          context.inFlightTools.delete(index);
        }
        // Clear any remaining stale entries (e.g. from interrupted content blocks)
        context.inFlightTools.clear();

        for (const block of turnState.assistantTextBlockOrder) {
          yield* completeAssistantTextBlock(context, block, {
            force: true,
            rawMethod: "claude/result",
            rawPayload: result ?? { status },
          });
        }

        const approximateTurnChars = approximateContextCharsFromTurnItems(turnState.items);
        context.turns.push({
          id: turnState.turnId,
          items: [...turnState.items],
          approximateChars: approximateTurnChars,
        });
        context.approximateConversationChars += approximateTurnChars;

        const updatedAt = yield* nowIso;
        context.session = {
          ...context.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt,
          ...(status === "failed" && errorMessage ? { lastError: errorMessage } : {}),
        };
        context.turnState = undefined;
        yield* updateResumeCursor(context);

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.completed",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          ...(context.session.resumeCursor !== undefined
            ? { resumeCursor: context.session.resumeCursor }
            : {}),
          payload: {
            state: status,
            ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
            ...(result?.usage ? { usage: result.usage } : {}),
            ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
            ...(typeof result?.total_cost_usd === "number"
              ? { totalCostUsd: result.total_cost_usd }
              : {}),
            ...(errorMessage ? { errorMessage } : {}),
          },
          providerRefs: nativeProviderRefs(context),
        });
        yield* maybeRecommendCompaction(context, turnState.turnId);
        yield* refreshSupportedCommands(context);
      });

    const handleStreamEvent = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "stream_event") {
          return;
        }

        // After an interrupt was requested, stop emitting stream-event deltas
        // (text/thinking/tool input) so the UI doesn't see further output.
        if (context.turnState?.interruptRequested) {
          return;
        }

        const { event } = message;
        const usageSnapshot = usageFromClaudeStreamEvent(message);

        if (usageSnapshot) {
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "thread.token-usage.updated",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            payload: {
              usage: usageSnapshot.usage,
            },
            providerRefs: nativeProviderRefs(context),
            raw: {
              source: "claude.sdk.message",
              method: usageSnapshot.rawMethod,
              payload: message,
            },
          });
        }

        if (event.type === "content_block_delta") {
          if (
            (event.delta.type === "text_delta" || event.delta.type === "thinking_delta") &&
            context.turnState
          ) {
            const deltaText =
              event.delta.type === "text_delta"
                ? event.delta.text
                : typeof event.delta.thinking === "string"
                  ? event.delta.thinking
                  : "";
            if (deltaText.length === 0) {
              return;
            }
            const streamKind = streamKindFromDeltaType(event.delta.type);
            const assistantBlockEntry =
              event.delta.type === "text_delta"
                ? yield* ensureAssistantTextBlock(context, event.index)
                : context.turnState.assistantTextBlocks.get(event.index)
                  ? {
                      blockIndex: event.index,
                      block: context.turnState.assistantTextBlocks.get(
                        event.index,
                      ) as AssistantTextBlockState,
                    }
                  : undefined;
            if (assistantBlockEntry?.block && event.delta.type === "text_delta") {
              assistantBlockEntry.block.emittedTextDelta = true;
            }
            const stamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "content.delta",
              eventId: stamp.eventId,
              provider: PROVIDER,
              createdAt: stamp.createdAt,
              threadId: context.session.threadId,
              turnId: context.turnState.turnId,
              ...(assistantBlockEntry?.block
                ? { itemId: asRuntimeItemId(assistantBlockEntry.block.itemId) }
                : {}),
              payload: {
                streamKind,
                delta: deltaText,
              },
              providerRefs: nativeProviderRefs(context),
              raw: {
                source: "claude.sdk.message",
                method: "claude/stream_event/content_block_delta",
                payload: message,
              },
            });
            return;
          }

          if (event.delta.type === "input_json_delta") {
            const tool = context.inFlightTools.get(event.index);
            if (!tool || typeof event.delta.partial_json !== "string") {
              return;
            }

            const partialInputJson = tool.partialInputJson + event.delta.partial_json;
            const parsedInput = tryParseJsonRecord(partialInputJson);
            const detail = parsedInput
              ? summarizeToolRequest(tool.toolName, parsedInput)
              : tool.detail;
            const title = parsedInput ? titleForTool(tool.itemType, parsedInput) : tool.title;
            let nextTool: ToolInFlight = {
              ...tool,
              partialInputJson,
              title,
              ...(parsedInput ? { input: parsedInput } : {}),
              ...(detail ? { detail } : {}),
            };

            const nextFingerprint =
              parsedInput && Object.keys(parsedInput).length > 0
                ? toolInputFingerprint(parsedInput)
                : undefined;
            context.inFlightTools.set(event.index, nextTool);

            if (
              !parsedInput ||
              !nextFingerprint ||
              tool.lastEmittedInputFingerprint === nextFingerprint
            ) {
              return;
            }

            nextTool = {
              ...nextTool,
              lastEmittedInputFingerprint: nextFingerprint,
            };
            context.inFlightTools.set(event.index, nextTool);

            const stamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "item.updated",
              eventId: stamp.eventId,
              provider: PROVIDER,
              createdAt: stamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              itemId: asRuntimeItemId(nextTool.itemId),
              payload: {
                itemType: nextTool.itemType,
                status: "inProgress",
                title: nextTool.title,
                ...(nextTool.detail ? { detail: nextTool.detail } : {}),
                ...(nextTool.requestKind ? { requestKind: nextTool.requestKind } : {}),
                data: buildToolLifecycleData({
                  toolName: nextTool.toolName,
                  toolInput: nextTool.input,
                }),
              },
              providerRefs: nativeProviderRefs(context, { providerItemId: nextTool.itemId }),
              raw: {
                source: "claude.sdk.message",
                method: "claude/stream_event/content_block_delta/input_json_delta",
                payload: message,
              },
            });
          }
          return;
        }

        if (event.type === "content_block_start") {
          const { index, content_block: block } = event;
          if (block.type === "text") {
            yield* ensureAssistantTextBlock(context, index, {
              fallbackText: extractContentBlockText(block),
            });
            return;
          }
          if (
            block.type !== "tool_use" &&
            block.type !== "server_tool_use" &&
            block.type !== "mcp_tool_use"
          ) {
            return;
          }

          const toolName = block.name;
          const itemType = classifyToolItemType(toolName, { blockType: block.type });
          const requestKind = classifyToolRequestKind(toolName, { blockType: block.type });
          const toolInput =
            typeof block.input === "object" && block.input !== null
              ? (block.input as Record<string, unknown>)
              : {};
          const itemId = block.id;
          const detail = summarizeToolRequest(toolName, toolInput);
          const inputFingerprint =
            Object.keys(toolInput).length > 0 ? toolInputFingerprint(toolInput) : undefined;

          const tool: ToolInFlight = {
            itemId,
            itemType,
            toolName,
            title: titleForTool(itemType, toolInput),
            detail,
            ...(requestKind ? { requestKind } : {}),
            input: toolInput,
            partialInputJson: "",
            ...(inputFingerprint ? { lastEmittedInputFingerprint: inputFingerprint } : {}),
          };
          context.inFlightTools.set(index, tool);

          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "item.started",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: "inProgress",
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              ...(tool.requestKind ? { requestKind: tool.requestKind } : {}),
              data: buildToolLifecycleData({
                toolName: tool.toolName,
                toolInput,
              }),
            },
            providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
            raw: {
              source: "claude.sdk.message",
              method: "claude/stream_event/content_block_start",
              payload: message,
            },
          });
          return;
        }

        if (event.type === "content_block_stop") {
          const { index } = event;
          const assistantBlock = context.turnState?.assistantTextBlocks.get(index);
          if (assistantBlock) {
            assistantBlock.streamClosed = true;
            yield* completeAssistantTextBlock(context, assistantBlock, {
              rawMethod: "claude/stream_event/content_block_stop",
              rawPayload: message,
            });
            return;
          }
          const tool = context.inFlightTools.get(index);
          if (!tool) {
            return;
          }
        }
      });

    const handleUserMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "user") {
          return;
        }

        if (context.turnState) {
          context.turnState.items.push(message.message);
        }

        for (const toolResult of toolResultBlocksFromUserMessage(message)) {
          const toolEntry = Array.from(context.inFlightTools.entries()).find(
            ([, tool]) => tool.itemId === toolResult.toolUseId,
          );
          if (!toolEntry) {
            continue;
          }

          const [index, tool] = toolEntry;
          const itemStatus = toolResult.isError ? "failed" : "completed";
          const toolData = buildToolLifecycleData({
            toolName: tool.toolName,
            toolInput: tool.input,
            result: toolResult.block,
          });

          const updatedStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "item.updated",
            eventId: updatedStamp.eventId,
            provider: PROVIDER,
            createdAt: updatedStamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: toolResult.isError ? "failed" : "inProgress",
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              ...(tool.requestKind ? { requestKind: tool.requestKind } : {}),
              data: toolData,
            },
            providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
            raw: {
              source: "claude.sdk.message",
              method: "claude/user",
              payload: message,
            },
          });

          const streamKind = toolResultStreamKind(tool.itemType);
          if (streamKind && toolResult.text.length > 0 && context.turnState) {
            const deltaStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "content.delta",
              eventId: deltaStamp.eventId,
              provider: PROVIDER,
              createdAt: deltaStamp.createdAt,
              threadId: context.session.threadId,
              turnId: context.turnState.turnId,
              itemId: asRuntimeItemId(tool.itemId),
              payload: {
                streamKind,
                delta: toolResult.text,
              },
              providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
              raw: {
                source: "claude.sdk.message",
                method: "claude/user",
                payload: message,
              },
            });
          }

          const completedStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "item.completed",
            eventId: completedStamp.eventId,
            provider: PROVIDER,
            createdAt: completedStamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: itemStatus,
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              ...(tool.requestKind ? { requestKind: tool.requestKind } : {}),
              data: toolData,
            },
            providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
            raw: {
              source: "claude.sdk.message",
              method: "claude/user",
              payload: message,
            },
          });

          if (tool.itemType === "file_change" && context.turnState) {
            const diffStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "turn.diff.updated",
              eventId: diffStamp.eventId,
              provider: PROVIDER,
              createdAt: diffStamp.createdAt,
              threadId: context.session.threadId,
              turnId: context.turnState.turnId,
              itemId: asRuntimeItemId(tool.itemId),
              payload: {
                unifiedDiff: "",
              },
              providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
              raw: {
                source: "claude.sdk.message",
                method: "claude/user",
                payload: message,
              },
            });
          }

          context.inFlightTools.delete(index);
        }
      });

    const handleAssistantMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "assistant") {
          return;
        }

        // Suppress any assistant output for an already-interrupted turn so
        // buffered deltas/tool_use blocks don't leak past the interrupt.
        // The `interruptedTurnIds` guard catches late messages arriving after
        // the watchdog (or SDK-driven interrupt) already cleared turnState.
        if (context.turnState?.interruptRequested) {
          return;
        }
        if (!context.turnState && context.interruptedTurnIds.size > 0) {
          return;
        }

        // Auto-start a synthetic turn for assistant messages that arrive without
        // an active turn (e.g., background agent/subagent responses between user prompts).
        if (!context.turnState) {
          const turnId = TurnId.makeUnsafe(yield* Random.nextUUIDv4);
          const startedAt = yield* nowIso;
          context.turnState = {
            turnId,
            startedAt,
            items: [],
            assistantTextBlocks: new Map(),
            assistantTextBlockOrder: [],
            capturedProposedPlanKeys: new Set(),
            nextSyntheticAssistantBlockIndex: -1,
            interruptRequested: false,
          };
          context.session = {
            ...context.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: startedAt,
          };
          const turnStartedStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "turn.started",
            eventId: turnStartedStamp.eventId,
            provider: PROVIDER,
            createdAt: turnStartedStamp.createdAt,
            threadId: context.session.threadId,
            turnId,
            payload: {},
            providerRefs: {
              ...nativeProviderRefs(context),
              providerTurnId: turnId,
            },
            raw: {
              source: "claude.sdk.message",
              method: "claude/synthetic-turn-start",
              payload: {},
            },
          });
        }

        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== "object") {
              continue;
            }
            const toolUse = block as {
              type?: unknown;
              id?: unknown;
              name?: unknown;
              input?: unknown;
            };
            if (toolUse.type !== "tool_use" || toolUse.name !== "ExitPlanMode") {
              continue;
            }
            const planMarkdown = extractExitPlanModePlan(toolUse.input);
            if (!planMarkdown) {
              continue;
            }
            yield* emitProposedPlanCompleted(context, {
              planMarkdown,
              toolUseId: typeof toolUse.id === "string" ? toolUse.id : undefined,
              rawSource: "claude.sdk.message",
              rawMethod: "claude/assistant",
              rawPayload: message,
            });
          }
        }

        if (context.turnState) {
          context.turnState.items.push(message.message);
          yield* backfillAssistantTextBlocksFromSnapshot(context, message);
        }

        context.lastAssistantUuid = message.uuid;
        yield* updateResumeCursor(context);
      });

    const handleResultMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "result") {
          return;
        }

        const status = turnStatusFromResult(message);
        const errorMessage = message.subtype === "success" ? undefined : message.errors[0];

        if (status === "failed") {
          yield* emitRuntimeError(context, errorMessage ?? "Claude turn failed.");
        }

        yield* completeTurn(context, status, errorMessage, message);
      });

    const handleSystemMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "system") {
          return;
        }

        const stamp = yield* makeEventStamp();
        const base = {
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          providerRefs: nativeProviderRefs(context),
          raw: {
            source: "claude.sdk.message" as const,
            method: sdkNativeMethod(message),
            messageType: `${message.type}:${message.subtype}`,
            payload: message,
          },
        };

        switch (message.subtype) {
          case "init":
            context.configuredBase = message as Record<string, unknown>;
            yield* emitSessionConfigured(context, context.configuredBase);
            return;
          case "status":
            yield* offerRuntimeEvent({
              ...base,
              type: "session.state.changed",
              payload: {
                state: message.status === "compacting" ? "waiting" : "running",
                reason: `status:${message.status ?? "active"}`,
                detail: message,
              },
            });
            return;
          case "compact_boundary":
            yield* offerRuntimeEvent({
              ...base,
              type: "thread.state.changed",
              payload: {
                state: "compacted",
                detail: message,
              },
            });
            return;
          case "hook_started":
            yield* offerRuntimeEvent({
              ...base,
              type: "hook.started",
              payload: {
                hookId: message.hook_id,
                hookName: message.hook_name,
                hookEvent: message.hook_event,
              },
            });
            return;
          case "hook_progress":
            yield* offerRuntimeEvent({
              ...base,
              type: "hook.progress",
              payload: {
                hookId: message.hook_id,
                output: message.output,
                stdout: message.stdout,
                stderr: message.stderr,
              },
            });
            return;
          case "hook_response":
            yield* offerRuntimeEvent({
              ...base,
              type: "hook.completed",
              payload: {
                hookId: message.hook_id,
                outcome: message.outcome,
                output: message.output,
                stdout: message.stdout,
                stderr: message.stderr,
                ...(typeof message.exit_code === "number" ? { exitCode: message.exit_code } : {}),
              },
            });
            return;
          case "task_started":
            yield* offerRuntimeEvent({
              ...base,
              type: "task.started",
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                description: message.description,
                ...(message.task_type ? { taskType: message.task_type } : {}),
              },
            });
            return;
          case "task_progress":
            yield* offerRuntimeEvent({
              ...base,
              type: "task.progress",
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                description: message.description,
                ...(message.summary ? { summary: message.summary } : {}),
                ...(message.usage ? { usage: message.usage } : {}),
                ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
              },
            });
            return;
          case "task_notification":
            yield* offerRuntimeEvent({
              ...base,
              type: "task.completed",
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                status: message.status,
                ...(message.summary ? { summary: message.summary } : {}),
                ...(message.usage ? { usage: message.usage } : {}),
              },
            });
            return;
          case "files_persisted":
            yield* offerRuntimeEvent({
              ...base,
              type: "files.persisted",
              payload: {
                files: Array.isArray(message.files)
                  ? message.files.map((file: { filename: string; file_id: string }) => ({
                      filename: file.filename,
                      fileId: file.file_id,
                    }))
                  : [],
                ...(Array.isArray(message.failed)
                  ? {
                      failed: message.failed.map((entry: { filename: string; error: string }) => ({
                        filename: entry.filename,
                        error: entry.error,
                      })),
                    }
                  : {}),
              },
            });
            return;
          default:
            yield* emitRuntimeWarning(
              context,
              `Unhandled Claude system message subtype '${message.subtype}'.`,
              message,
            );
            return;
        }
      });

    const handleSdkTelemetryMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const stamp = yield* makeEventStamp();
        const base = {
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          providerRefs: nativeProviderRefs(context),
          raw: {
            source: "claude.sdk.message" as const,
            method: sdkNativeMethod(message),
            messageType: message.type,
            payload: message,
          },
        };

        if (message.type === "tool_progress") {
          yield* offerRuntimeEvent({
            ...base,
            type: "tool.progress",
            payload: {
              toolUseId: message.tool_use_id,
              toolName: message.tool_name,
              elapsedSeconds: message.elapsed_time_seconds,
              ...(message.task_id ? { summary: `task:${message.task_id}` } : {}),
            },
          });
          return;
        }

        if (message.type === "tool_use_summary") {
          yield* offerRuntimeEvent({
            ...base,
            type: "tool.summary",
            payload: {
              summary: message.summary,
              ...(message.preceding_tool_use_ids.length > 0
                ? { precedingToolUseIds: message.preceding_tool_use_ids }
                : {}),
            },
          });
          return;
        }

        if (message.type === "auth_status") {
          yield* offerRuntimeEvent({
            ...base,
            type: "auth.status",
            payload: {
              isAuthenticating: message.isAuthenticating,
              output: message.output,
              ...(message.error ? { error: message.error } : {}),
            },
          });
          return;
        }

        if (message.type === "rate_limit_event") {
          yield* offerRuntimeEvent({
            ...base,
            type: "account.rate-limits.updated",
            payload: {
              rateLimits: message,
            },
          });
          return;
        }
      });

    const handleSdkMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* logNativeSdkMessage(context, message);
        yield* ensureThreadId(context, message);

        // If the current turn was interrupted, drop any buffered SDK output
        // except "result", which legitimately ends the turn via completeTurn.
        if (context.turnState?.interruptRequested && message.type !== "result") {
          return;
        }

        switch (message.type) {
          case "stream_event":
            yield* handleStreamEvent(context, message);
            return;
          case "user":
            yield* handleUserMessage(context, message);
            return;
          case "assistant":
            yield* handleAssistantMessage(context, message);
            return;
          case "result":
            yield* handleResultMessage(context, message);
            return;
          case "system":
            yield* handleSystemMessage(context, message);
            return;
          case "tool_progress":
          case "tool_use_summary":
          case "auth_status":
          case "rate_limit_event":
            yield* handleSdkTelemetryMessage(context, message);
            return;
          default:
            yield* emitRuntimeWarning(
              context,
              `Unhandled Claude SDK message type '${message.type}'.`,
              message,
            );
            return;
        }
      });

    const runSdkStream = (context: ClaudeSessionContext): Effect.Effect<void, Error> =>
      Stream.fromAsyncIterable(context.query, (cause) =>
        toError(cause, "Claude runtime stream failed."),
      ).pipe(
        Stream.takeWhile(() => !context.stopped),
        Stream.runForEach((message) => handleSdkMessage(context, message)),
      );

    const handleStreamExit = (
      context: ClaudeSessionContext,
      exit: Exit.Exit<void, Error>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (context.stopped) {
          return;
        }

        if (Exit.isFailure(exit)) {
          if (isClaudeInterruptedCause(exit.cause)) {
            if (context.turnState) {
              yield* completeTurn(
                context,
                "interrupted",
                interruptionMessageFromClaudeCause(exit.cause),
              );
            }
          } else {
            const message = messageFromClaudeStreamCause(
              exit.cause,
              "Claude runtime stream failed.",
            );
            yield* emitRuntimeError(context, message, Cause.pretty(exit.cause));
            yield* completeTurn(context, "failed", message);
          }
        } else if (context.turnState) {
          yield* completeTurn(context, "interrupted", "Claude runtime stream ended.");
        }

        yield* stopSessionInternal(context, {
          emitExitEvent: true,
        });
      });

    const resolvePendingInteractions = (context: ClaudeSessionContext): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const [requestId, pending] of context.pendingApprovals) {
          // Mark resolved BEFORE signalling the deferred so the awaiting
          // canUseTool handler (which may resume synchronously) sees the
          // flag and skips its own terminal emission. Otherwise callers see
          // two `request.resolved` events per cancelled approval.
          pending.resolvedExternally = true;
          yield* Deferred.succeed(pending.decision, "cancel");
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "request.resolved",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            requestId: asRuntimeRequestId(requestId),
            payload: {
              requestType: pending.requestType,
              decision: "cancel",
            },
            providerRefs: nativeProviderRefs(context),
          });
        }
        context.pendingApprovals.clear();

        for (const [requestId, pending] of context.pendingUserInputs) {
          const emptyAnswers = {} as ProviderUserInputAnswers;
          pending.resolvedExternally = true;
          pending.cancel();
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "user-input.resolved",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            requestId: asRuntimeRequestId(requestId),
            payload: { answers: emptyAnswers },
            providerRefs: nativeProviderRefs(context),
            raw: {
              source: "claude.sdk.permission",
              method: "canUseTool/AskUserQuestion/resolved",
              payload: { answers: emptyAnswers },
            },
          });
        }
        context.pendingUserInputs.clear();
      });

    const stopSessionInternal = (
      context: ClaudeSessionContext,
      options?: { readonly emitExitEvent?: boolean },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (context.stopped) return;

        context.stopped = true;

        yield* resolvePendingInteractions(context);

        yield* Queue.offer(context.promptQueue, {
          type: "terminate",
        }).pipe(Effect.ignore);

        if (context.turnState) {
          yield* completeTurn(context, "interrupted", "Session stopped.");
        }

        const streamFiber = context.streamFiber;
        context.streamFiber = undefined;

        // @effect-diagnostics-next-line tryCatchInEffectGen:off
        try {
          context.query.close();
        } catch (cause) {
          yield* emitRuntimeError(context, "Failed to close Claude runtime query.", cause);
        }

        if (streamFiber && streamFiber.pollUnsafe() === undefined) {
          yield* Fiber.interrupt(streamFiber);
        }

        const updatedAt = yield* nowIso;
        context.session = {
          ...context.session,
          status: "closed",
          activeTurnId: undefined,
          updatedAt,
        };

        if (options?.emitExitEvent !== false) {
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "session.exited",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(context.session.resumeCursor !== undefined
              ? { resumeCursor: context.session.resumeCursor }
              : {}),
            payload: {
              reason: "Session stopped",
              exitKind: "graceful",
            },
            providerRefs: {},
          });
        }

        sessions.delete(context.session.threadId);
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<ClaudeSessionContext, ProviderAdapterError> => {
      const context = sessions.get(threadId);
      if (!context) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      if (context.stopped || context.session.status === "closed") {
        return Effect.fail(
          new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      return Effect.succeed(context);
    };

    const runOneOffPrompt: ClaudeAdapterShape["runOneOffPrompt"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "runOneOffPrompt",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const promptMessage = buildUserMessage({
          sdkContent: [{ type: "text", text: input.prompt }],
        });
        const prompt = (async function* () {
          yield promptMessage;
        })();
        const providerOptions = input.providerOptions?.claudeAgent;
        const permissionMode = toPermissionMode(providerOptions?.permissionMode);
        // One-off prompts intentionally exclude MCP so the output stays
        // deterministic and tool-free. Even when the saved session config uses
        // bypass permissions, we keep the explicit tool-deny gate active here.

        const queryRuntime = yield* Effect.try({
          try: () =>
            createQuery({
              prompt,
              options: {
                ...(input.cwd ? { cwd: input.cwd } : {}),
                ...(input.model ? { model: input.model } : {}),
                pathToClaudeCodeExecutable: providerOptions?.binaryPath ?? "claude",
                settingSources: [...CLAUDE_SETTING_SOURCES],
                ...(permissionMode ? { permissionMode } : {}),
                ...(providerOptions?.maxThinkingTokens !== undefined
                  ? { maxThinkingTokens: providerOptions.maxThinkingTokens }
                  : {}),
                ...(() => {
                  const filtered = filterReservedClaudeLaunchArgs(providerOptions?.launchArgs);
                  return filtered ? { extraArgs: filtered } : {};
                })(),
                includePartialMessages: true,
                canUseTool: async () =>
                  ({
                    behavior: "deny",
                    message:
                      "This one-off prompt requires plain-text output only. Tool calls are not allowed.",
                  }) satisfies PermissionResult,
                env: buildClaudeQueryEnv(providerOptions),
              },
            }),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: toMessage(cause, "Failed to start Claude one-off prompt query."),
              cause,
            }),
        });

        const result = yield* Effect.tryPromise({
          try: async () => {
            let streamedText = "";
            let fallbackText = "";

            for await (const message of queryRuntime) {
              if (message.type === "stream_event" && message.event.type === "content_block_delta") {
                if (message.event.delta.type === "text_delta") {
                  streamedText += message.event.delta.text;
                }
                continue;
              }

              if (message.type === "assistant") {
                const snapshotText = extractAssistantTextBlocks(message).join("");
                if (snapshotText.length > 0) {
                  fallbackText = snapshotText;
                }
                continue;
              }

              if (message.type === "result") {
                break;
              }
            }

            const text = streamedText.trim().length > 0 ? streamedText.trim() : fallbackText.trim();
            if (text.length === 0) {
              throw new Error("Claude one-off prompt query produced no text.");
            }
            return {
              text,
            } satisfies ProviderOneOffPromptResult;
          },
          catch: (cause) => toRequestError(input.threadId, "runOneOffPrompt", cause),
        }).pipe(
          Effect.timeoutOption(
            input.timeoutMs !== undefined
              ? Duration.millis(input.timeoutMs)
              : COMPACTION_QUERY_TIMEOUT,
          ),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "runOneOffPrompt",
                    detail: "Claude one-off prompt query timed out.",
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              try {
                queryRuntime.close();
              } catch {
                // Ignore close failures for one-off prompt queries.
              }
            }),
          ),
        );

        return result;
      });

    const compactConversation: ClaudeAdapterShape["compactConversation"] = (input) =>
      runOneOffPrompt(input).pipe(
        Effect.map(
          (result) =>
            ({
              summary: result.text,
            }) satisfies ProviderConversationCompactionResult,
        ),
      );

    const startSession: ClaudeAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const startedAt = yield* nowIso;
        const resumeState = readClaudeResumeState(input.resumeCursor);
        const threadId = input.threadId;
        const existingResumeSessionId = resumeState?.resume;
        const newSessionId =
          existingResumeSessionId === undefined ? yield* Random.nextUUIDv4 : undefined;
        const sessionId = existingResumeSessionId ?? newSessionId;

        const promptQueue = yield* Queue.unbounded<PromptQueueItem>();
        const prompt = makeClaudePromptInput(promptQueue);

        const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
        const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
        const inFlightTools = new Map<number, ToolInFlight>();

        const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined);
        const providerOptions = input.providerOptions?.claudeAgent;

        /**
         * Handle AskUserQuestion tool calls by emitting a `user-input.requested`
         * runtime event and waiting for the user to respond via `respondToUserInput`.
         */
        const handleAskUserQuestion = (
          context: ClaudeSessionContext,
          toolInput: Record<string, unknown>,
          callbackOptions: { readonly signal: AbortSignal; readonly toolUseID?: string },
        ) =>
          Effect.gen(function* () {
            const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);

            // Parse questions from the SDK's AskUserQuestion input.
            const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
            const questions: Array<UserInputQuestion> = rawQuestions.map(
              (q: Record<string, unknown>, idx: number) => ({
                id: typeof q.header === "string" ? q.header : `q-${idx}`,
                header: typeof q.header === "string" ? q.header : `Question ${idx + 1}`,
                question: typeof q.question === "string" ? q.question : "",
                options: Array.isArray(q.options)
                  ? q.options.map((opt: Record<string, unknown>) => ({
                      label: typeof opt.label === "string" ? opt.label : "",
                      description: typeof opt.description === "string" ? opt.description : "",
                    }))
                  : [],
                multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : false,
              }),
            );

            const answersDeferred = yield* Deferred.make<ProviderUserInputAnswers>();
            let aborted = false;
            const markAborted = () => {
              if (aborted) return;
              aborted = true;
              Effect.runFork(Deferred.succeed(answersDeferred, {} as ProviderUserInputAnswers));
            };
            const pendingInput: PendingUserInput = {
              questions,
              answers: answersDeferred,
              cancel: markAborted,
              resolvedExternally: false,
            };

            // Emit user-input.requested so the UI can present the questions.
            const requestedStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "user-input.requested",
              eventId: requestedStamp.eventId,
              provider: PROVIDER,
              createdAt: requestedStamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              requestId: asRuntimeRequestId(requestId),
              payload: { questions },
              providerRefs: nativeProviderRefs(context, {
                providerItemId: callbackOptions.toolUseID,
              }),
              raw: {
                source: "claude.sdk.permission",
                method: "canUseTool/AskUserQuestion",
                payload: { toolName: "AskUserQuestion", input: toolInput },
              },
            });

            pendingUserInputs.set(requestId, pendingInput);

            // Handle abort (e.g. turn interrupted while waiting for user input).
            const onAbort = () => {
              if (!pendingUserInputs.has(requestId)) {
                return;
              }
              aborted = true;
              pendingUserInputs.delete(requestId);
              Effect.runFork(Deferred.succeed(answersDeferred, {} as ProviderUserInputAnswers));
            };
            callbackOptions.signal.addEventListener("abort", onAbort, { once: true });

            // Block until the user provides answers.
            const answers = yield* Deferred.await(answersDeferred);
            pendingUserInputs.delete(requestId);

            // Skip emitting user-input.resolved when the interrupt path
            // already emitted it on our behalf; otherwise consumers see a
            // duplicate terminal event for the same request.
            if (!pendingInput.resolvedExternally) {
              const resolvedStamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                type: "user-input.resolved",
                eventId: resolvedStamp.eventId,
                provider: PROVIDER,
                createdAt: resolvedStamp.createdAt,
                threadId: context.session.threadId,
                ...(context.turnState
                  ? { turnId: asCanonicalTurnId(context.turnState.turnId) }
                  : {}),
                requestId: asRuntimeRequestId(requestId),
                payload: { answers },
                providerRefs: nativeProviderRefs(context, {
                  providerItemId: callbackOptions.toolUseID,
                }),
                raw: {
                  source: "claude.sdk.permission",
                  method: "canUseTool/AskUserQuestion/resolved",
                  payload: { answers },
                },
              });
            }

            if (aborted) {
              return {
                behavior: "deny",
                message: "User cancelled tool execution.",
              } satisfies PermissionResult;
            }

            // Return the answers to the SDK in the expected format:
            // `answers` is a `{ questionId: selectedLabel }` string map. Our
            // contract carries the logical value as `string | string[]` to
            // preserve multi-select cardinality across the wire, but the
            // Claude SDK tool schema expects a single string per question —
            // join arrays with ", " only at this boundary (lossy but adequate
            // as model-visible text; structured consumers read the array form
            // from `user-input.resolved`).
            const sdkAnswers: Record<string, string> = Object.fromEntries(
              Object.entries(answers).map(([questionId, value]) => [
                questionId,
                Array.isArray(value) ? value.join(", ") : String(value ?? ""),
              ]),
            );
            return {
              behavior: "allow",
              updatedInput: {
                questions: toolInput.questions,
                answers: sdkAnswers,
              },
            } satisfies PermissionResult;
          });

        const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const context = yield* Ref.get(contextRef);
              if (!context) {
                return {
                  behavior: "deny",
                  message: "Claude session context is unavailable.",
                } satisfies PermissionResult;
              }

              // Handle AskUserQuestion: surface clarifying questions to the
              // user via the user-input runtime event channel, regardless of
              // runtime mode (plan mode relies on this heavily).
              if (toolName === "AskUserQuestion") {
                return yield* handleAskUserQuestion(context, toolInput, callbackOptions);
              }

              if (toolName === "ExitPlanMode") {
                const planMarkdown = extractExitPlanModePlan(toolInput);
                if (planMarkdown) {
                  yield* emitProposedPlanCompleted(context, {
                    planMarkdown,
                    toolUseId: callbackOptions.toolUseID,
                    rawSource: "claude.sdk.permission",
                    rawMethod: "canUseTool/ExitPlanMode",
                    rawPayload: {
                      toolName,
                      input: toolInput,
                    },
                  });
                }

                return {
                  behavior: "deny",
                  message:
                    "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
                } satisfies PermissionResult;
              }

              if (
                providerOptions?.subagentsEnabled === false &&
                classifyToolItemType(toolName) === "collab_agent_tool_call"
              ) {
                return {
                  behavior: "deny",
                  message:
                    "Sub-agents are disabled for this project. Complete the work in the main conversation instead.",
                } satisfies PermissionResult;
              }

              const runtimeMode = input.runtimeMode ?? "full-access";
              if (runtimeMode === "full-access") {
                return {
                  behavior: "allow",
                  updatedInput: toolInput,
                } satisfies PermissionResult;
              }

              const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);
              const requestType = classifyRequestType(toolName);
              const detail = summarizeToolRequest(toolName, toolInput);
              const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();
              const pendingApproval: PendingApproval = {
                requestType,
                detail,
                decision: decisionDeferred,
                resolvedExternally: false,
                ...(callbackOptions.suggestions
                  ? { suggestions: callbackOptions.suggestions }
                  : {}),
              };

              const requestedStamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                type: "request.opened",
                eventId: requestedStamp.eventId,
                provider: PROVIDER,
                createdAt: requestedStamp.createdAt,
                threadId: context.session.threadId,
                ...(context.turnState
                  ? { turnId: asCanonicalTurnId(context.turnState.turnId) }
                  : {}),
                requestId: asRuntimeRequestId(requestId),
                payload: {
                  requestType,
                  detail,
                  args: {
                    toolName,
                    input: toolInput,
                    ...(callbackOptions.toolUseID ? { toolUseId: callbackOptions.toolUseID } : {}),
                  },
                },
                providerRefs: nativeProviderRefs(context, {
                  providerItemId: callbackOptions.toolUseID,
                }),
                raw: {
                  source: "claude.sdk.permission",
                  method: "canUseTool/request",
                  payload: {
                    toolName,
                    input: toolInput,
                  },
                },
              });

              pendingApprovals.set(requestId, pendingApproval);

              const onAbort = () => {
                if (!pendingApprovals.has(requestId)) {
                  return;
                }
                pendingApprovals.delete(requestId);
                Effect.runFork(Deferred.succeed(decisionDeferred, "cancel"));
              };

              callbackOptions.signal.addEventListener("abort", onAbort, {
                once: true,
              });

              const decision = yield* Deferred.await(decisionDeferred);
              pendingApprovals.delete(requestId);

              // Skip duplicate `request.resolved` when the interrupt path
              // already emitted the terminal event for this approval.
              if (!pendingApproval.resolvedExternally) {
                const resolvedStamp = yield* makeEventStamp();
                yield* offerRuntimeEvent({
                  type: "request.resolved",
                  eventId: resolvedStamp.eventId,
                  provider: PROVIDER,
                  createdAt: resolvedStamp.createdAt,
                  threadId: context.session.threadId,
                  ...(context.turnState
                    ? { turnId: asCanonicalTurnId(context.turnState.turnId) }
                    : {}),
                  requestId: asRuntimeRequestId(requestId),
                  payload: {
                    requestType,
                    decision,
                  },
                  providerRefs: nativeProviderRefs(context, {
                    providerItemId: callbackOptions.toolUseID,
                  }),
                  raw: {
                    source: "claude.sdk.permission",
                    method: "canUseTool/decision",
                    payload: {
                      decision,
                    },
                  },
                });
              }

              if (decision === "accept" || decision === "acceptForSession") {
                return {
                  behavior: "allow",
                  updatedInput: toolInput,
                  ...(decision === "acceptForSession" && pendingApproval.suggestions
                    ? { updatedPermissions: [...pendingApproval.suggestions] }
                    : {}),
                } satisfies PermissionResult;
              }

              return {
                behavior: "deny",
                message:
                  decision === "cancel"
                    ? "User cancelled tool execution."
                    : "User declined tool execution.",
              } satisfies PermissionResult;
            }),
          );

        const requestedEffort = resolveReasoningEffortForProvider(
          "claudeAgent",
          input.modelOptions?.claudeAgent?.effort ?? null,
        );
        const supportedEffortOptions = getReasoningEffortOptions("claudeAgent", input.model);
        const effort =
          requestedEffort && supportedEffortOptions.includes(requestedEffort)
            ? requestedEffort
            : null;
        const fastMode =
          input.modelOptions?.claudeAgent?.fastMode === true && supportsClaudeFastMode(input.model);
        const thinking =
          typeof input.modelOptions?.claudeAgent?.thinking === "boolean" &&
          supportsClaudeThinkingToggle(input.model)
            ? input.modelOptions.claudeAgent.thinking
            : undefined;
        const effectiveEffort = getEffectiveClaudeCodeEffort(effort);
        const permissionMode =
          toPermissionMode(providerOptions?.permissionMode) ??
          (input.runtimeMode === "full-access" ? "bypassPermissions" : undefined);
        const translatedMcpServers = translateMcpForClaudeAgent(input.providerOptions?.mcpServers);
        const settings = {
          ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
          ...(fastMode ? { fastMode: true } : {}),
        };
        const configuredBase = {
          ...(input.model ? { model: input.model } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(effectiveEffort ? { effort: effectiveEffort } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(providerOptions?.maxThinkingTokens !== undefined
            ? { maxThinkingTokens: providerOptions.maxThinkingTokens }
            : {}),
          ...(fastMode ? { fastMode: true } : {}),
          [INSTRUCTION_PROFILE_CONFIG_KEY]: buildInstructionProfile({
            provider: "claudeAgent",
          }),
        } satisfies Record<string, unknown>;

        const appendInstructionText =
          existingResumeSessionId === undefined
            ? buildClaudeAssistantInstructions({
                ...(input.projectTitle ? { projectTitle: input.projectTitle } : {}),
                ...(input.threadTitle ? { threadTitle: input.threadTitle } : {}),
                ...(input.turnCount !== undefined ? { turnCount: input.turnCount } : {}),
                ...(input.priorWorkSummary ? { priorWorkSummary: input.priorWorkSummary } : {}),
                ...(input.preservedTranscriptBefore
                  ? { preservedTranscriptBefore: input.preservedTranscriptBefore }
                  : {}),
                ...(input.preservedTranscriptAfter
                  ? { preservedTranscriptAfter: input.preservedTranscriptAfter }
                  : {}),
                ...(input.restoredRecentFileRefs
                  ? { restoredRecentFileRefs: input.restoredRecentFileRefs }
                  : {}),
                ...(input.restoredActivePlan
                  ? { restoredActivePlan: input.restoredActivePlan }
                  : {}),
                ...(input.restoredTasks ? { restoredTasks: input.restoredTasks } : {}),
                ...(input.sessionNotes ? { sessionNotes: input.sessionNotes } : {}),
                ...(input.projectMemories ? { projectMemories: input.projectMemories } : {}),
                ...(input.cwd ? { cwd: input.cwd } : {}),
                runtimeMode: input.runtimeMode,
                currentDate: new Date().toISOString().slice(0, 10),
                ...(input.model ? { model: input.model } : {}),
                ...(effectiveEffort ? { effort: effectiveEffort } : {}),
              })
            : undefined;

        const appendSystemPrompt: ClaudeAppendSystemPromptConfig | undefined = appendInstructionText
          ? {
              type: "preset",
              preset: "claude_code",
              append: appendInstructionText,
            }
          : undefined;
        // Resume flows must not append again, or the shared host prompt would
        // be duplicated across reconnects for the same Claude session.

        const queryOptions: ClaudeQueryOptionsWithAppend = {
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.model ? { model: input.model } : {}),
          pathToClaudeCodeExecutable: providerOptions?.binaryPath ?? "claude",
          settingSources: [...CLAUDE_SETTING_SOURCES],
          ...(effectiveEffort ? { effort: effectiveEffort } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(permissionMode === "bypassPermissions"
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          ...(providerOptions?.maxThinkingTokens !== undefined
            ? { maxThinkingTokens: providerOptions.maxThinkingTokens }
            : {}),
          // `extraArgs` is forwarded by the SDK to the Claude CLI *after* its
          // own required flags, so user-supplied duplicates win last. We run
          // through `filterReservedClaudeLaunchArgs` as a defense-in-depth
          // pass — the settings-page parser already blocks reserved keys, but
          // persisted values from older builds can still land here. Values
          // are free-form; safe only because the SDK spawns claude via
          // execFile/argv-array rather than a shell string (verify this on
          // each SDK bump).
          ...(() => {
            const filtered = filterReservedClaudeLaunchArgs(providerOptions?.launchArgs);
            return filtered ? { extraArgs: filtered } : {};
          })(),
          ...(Object.keys(settings).length > 0 ? { settings } : {}),
          ...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
          ...(newSessionId ? { sessionId: newSessionId } : {}),
          includePartialMessages: true,
          canUseTool,
          env: buildClaudeQueryEnv(providerOptions),
          ...(input.cwd ? { additionalDirectories: [input.cwd] } : {}),
          ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
        };
        if (translatedMcpServers) {
          queryOptions.mcpServers = translatedMcpServers as NonNullable<
            ClaudeQueryOptions["mcpServers"]
          >;
        }

        const queryRuntime = yield* Effect.try({
          try: () =>
            createQuery({
              prompt,
              options: queryOptions,
            }),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: toMessage(cause, "Failed to start Claude runtime session."),
              cause,
            }),
        });

        const session: ProviderSession = {
          threadId,
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(threadId ? { threadId } : {}),
          resumeCursor: {
            ...(threadId ? { threadId } : {}),
            ...(sessionId ? { resume: sessionId } : {}),
            ...(resumeState?.resumeSessionAt
              ? { resumeSessionAt: resumeState.resumeSessionAt }
              : {}),
            turnCount: resumeState?.turnCount ?? 0,
          },
          createdAt: startedAt,
          updatedAt: startedAt,
        };

        const context: ClaudeSessionContext = {
          session,
          promptQueue,
          query: queryRuntime,
          streamFiber: undefined,
          startedAt,
          basePermissionMode: permissionMode,
          resumeSessionId: sessionId,
          pendingApprovals,
          pendingUserInputs,
          turns: [],
          inFlightTools,
          turnState: undefined,
          lastAssistantUuid: resumeState?.resumeSessionAt,
          lastThreadStartedId: undefined,
          configuredBase,
          interruptedTurnIds: new Set<TurnId>(),
          availableSlashCommands: [],
          slashCommandsLoaded: false,
          supportedCommandsFingerprint: fingerprintSupportedSlashCommands([]),
          baseContextChars:
            resumeState?.baseContextChars ?? Math.max(0, appendInstructionText?.length ?? 0),
          approximateConversationChars: resumeState?.approximateConversationChars ?? 0,
          compactionRecommendationEmitted: resumeState?.compactionRecommendationEmitted ?? false,
          modelContextWindowTokens: estimateModelContextWindowTokens(input.model, "claudeAgent"),
          stopped: false,
        };
        yield* Ref.set(contextRef, context);
        sessions.set(threadId, context);

        const sessionStartedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.started",
          eventId: sessionStartedStamp.eventId,
          provider: PROVIDER,
          createdAt: sessionStartedStamp.createdAt,
          threadId,
          payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
          providerRefs: {},
        });

        yield* emitSessionConfigured(context, configuredBase);

        const readyStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          eventId: readyStamp.eventId,
          provider: PROVIDER,
          createdAt: readyStamp.createdAt,
          threadId,
          payload: {
            state: "ready",
          },
          providerRefs: {},
        });

        Effect.runFork(refreshModelContextWindowTokens(context));
        let streamFiber!: Fiber.Fiber<void, Error>;
        streamFiber = Effect.runFork(
          Effect.exit(runSdkStream(context)).pipe(
            Effect.flatMap((exit) => {
              if (context.stopped) {
                return Effect.logInfo(
                  "ignored Claude stream exit because the session already stopped",
                  {
                    threadId: context.session.threadId,
                  },
                );
              }
              if (context.streamFiber === streamFiber) {
                context.streamFiber = undefined;
              }
              return handleStreamExit(context, exit);
            }),
          ),
        );
        context.streamFiber = streamFiber;
        yield* refreshSupportedCommands(context);
        streamFiber.addObserver(() => {
          if (context.streamFiber === streamFiber) {
            context.streamFiber = undefined;
          }
        });

        return {
          ...session,
        };
      });

    const sendTurn: ClaudeAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);

        if (context.turnState) {
          // Auto-close a stale synthetic turn (from background agent responses
          // between user prompts) to prevent blocking the user's next turn.
          yield* completeTurn(context, "completed");
        }

        if (input.model) {
          yield* Effect.tryPromise({
            try: () => context.query.setModel(input.model),
            catch: (cause) => toRequestError(input.threadId, "turn/setModel", cause),
          });
          context.session = {
            ...context.session,
            model: input.model,
          };
          context.configuredBase = {
            ...context.configuredBase,
            model: input.model,
          };
          context.modelContextWindowTokens = estimateModelContextWindowTokens(
            input.model,
            "claudeAgent",
          );
          Effect.runFork(refreshModelContextWindowTokens(context));
        }

        // Apply interaction mode by switching the SDK's permission mode.
        // "plan" maps directly to the SDK's "plan" permission mode;
        // "default" restores the session's original permission mode.
        // When interactionMode is absent we leave the current mode unchanged.
        if (input.interactionMode === "plan") {
          yield* Effect.tryPromise({
            try: () => context.query.setPermissionMode("plan"),
            catch: (cause) => toRequestError(input.threadId, "turn/setPermissionMode", cause),
          });
          context.configuredBase = {
            ...context.configuredBase,
            permissionMode: "plan",
          };
        } else if (input.interactionMode === "default") {
          yield* Effect.tryPromise({
            try: () =>
              context.query.setPermissionMode(context.basePermissionMode ?? "bypassPermissions"),
            catch: (cause) => toRequestError(input.threadId, "turn/setPermissionMode", cause),
          });
          context.configuredBase = {
            ...context.configuredBase,
            permissionMode: context.basePermissionMode ?? "bypassPermissions",
          };
        }

        const turnId = TurnId.makeUnsafe(yield* Random.nextUUIDv4);
        const turnState: ClaudeTurnState = {
          turnId,
          startedAt: yield* nowIso,
          items: [],
          assistantTextBlocks: new Map(),
          assistantTextBlockOrder: [],
          capturedProposedPlanKeys: new Set(),
          nextSyntheticAssistantBlockIndex: -1,
          interruptRequested: false,
        };

        // A new, intentional turn supersedes the "suppress late post-interrupt
        // output" guard. Any delayed messages from a prior interrupted turn
        // that still haven't arrived at this point are genuinely orphaned.
        context.interruptedTurnIds.clear();

        const updatedAt = yield* nowIso;
        context.turnState = turnState;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt,
        };

        const turnStartedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.started",
          eventId: turnStartedStamp.eventId,
          provider: PROVIDER,
          createdAt: turnStartedStamp.createdAt,
          threadId: context.session.threadId,
          turnId,
          payload: input.model ? { model: input.model } : {},
          providerRefs: {},
        });

        const message = yield* buildUserMessageEffect(input, {
          fileSystem,
          attachmentsDir: serverConfig.attachmentsDir,
        });

        yield* Queue.offer(context.promptQueue, {
          type: "message",
          message,
        }).pipe(Effect.mapError((cause) => toRequestError(input.threadId, "turn/start", cause)));

        return {
          threadId: context.session.threadId,
          turnId,
          ...(context.session.resumeCursor !== undefined
            ? { resumeCursor: context.session.resumeCursor }
            : {}),
        };
      });

    const interruptTurn: ClaudeAdapterShape["interruptTurn"] = (threadId, _turnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const turnState = context.turnState;
        // Idempotent: nothing to do if no live turn or already interrupting.
        if (!turnState || turnState.interruptRequested) return;
        turnState.interruptRequested = true;

        // Unblock any pending approval / AskUserQuestion callbacks so their
        // canUseTool handler can return "deny" immediately.
        yield* resolvePendingInteractions(context);

        // Ask the SDK nicely first; don't fail the whole command if this throws.
        const interruptOutcome = yield* Effect.promise(async () => {
          try {
            await context.query.interrupt();
            return { ok: true as const };
          } catch (cause) {
            return {
              ok: false as const,
              message: toMessage(cause, "Claude query.interrupt() failed."),
            };
          }
        });
        if (!interruptOutcome.ok) {
          yield* emitRuntimeWarning(context, interruptOutcome.message);
        }

        // Watchdog: if the SDK doesn't drive completeTurn within 3s, do it
        // ourselves. The deferred is resolved by completeTurn on fast paths so
        // this fiber exits promptly instead of accumulating across rapid
        // stop/resend cycles.
        const watchdogCancel = yield* Deferred.make<void>();
        turnState.watchdogCancel = watchdogCancel;
        yield* Effect.forkDetach(
          Effect.gen(function* () {
            const cancelled = yield* Effect.raceFirst(
              Effect.sleep("3 seconds").pipe(Effect.as(false)),
              Deferred.await(watchdogCancel).pipe(Effect.as(true)),
            );
            if (cancelled) return;
            if (context.stopped) return;
            if (context.turnState?.turnId !== turnState.turnId) return;
            yield* completeTurn(context, "interrupted", "Turn interrupted by user.");
          }),
        );
      });

    const readThread: ClaudeAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        return yield* snapshotThread(context);
      });

    const rollbackThread: ClaudeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const nextLength = Math.max(0, context.turns.length - numTurns);
        context.turns.splice(nextLength);
        context.approximateConversationChars = context.turns.reduce(
          (total, turn) => total + turn.approximateChars,
          0,
        );
        yield* updateResumeCursor(context);
        return yield* snapshotThread(context);
      });

    const respondToRequest: ClaudeAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/requestApproval/decision",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }

        context.pendingApprovals.delete(requestId);
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: ClaudeAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/tool/respondToUserInput",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }

        context.pendingUserInputs.delete(requestId);
        yield* Deferred.succeed(pending.answers, answers);
      });

    const stopSession: ClaudeAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* stopSessionInternal(context, {
          emitExitEvent: true,
        });
      });

    const listSessions: ClaudeAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

    const hasSession: ClaudeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped;
      });

    const stopAll: ClaudeAdapterShape["stopAll"] = () =>
      Effect.forEach(
        sessions,
        ([, context]) =>
          stopSessionInternal(context, {
            emitExitEvent: true,
          }),
        { discard: true },
      );

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        sessions,
        ([, context]) =>
          stopSessionInternal(context, {
            emitExitEvent: false,
          }),
        { discard: true },
      ).pipe(Effect.tap(() => Queue.shutdown(runtimeEventQueue))),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      runOneOffPrompt,
      compactConversation,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies ClaudeAdapterShape;
  });
}

export const ClaudeAdapterLive = Layer.effect(ClaudeAdapter, makeClaudeAdapter());

export function makeClaudeAdapterLive(options?: ClaudeAdapterLiveOptions) {
  return Layer.effect(ClaudeAdapter, makeClaudeAdapter(options));
}
