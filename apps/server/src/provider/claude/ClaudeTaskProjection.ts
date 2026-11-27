import {
  classifyToolItemType,
  extractTextContent,
  normalizeOptionalString,
} from "../claudeToolPresentation.ts";

import {
  type PermissionMode,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  ProviderItemId,
  type ProviderRequestKind,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type RuntimeItemStatus,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
} from "@t3tools/contracts";

import { buildClaudeFileChangeStructuredChanges } from "../Layers/claudeFileChangePatch.ts";

import {
  type ClaudeBackgroundStatus,
  type ClaudeSessionContext,
  type ClaudeTaskState,
  type ClaudeTaskTerminalStatus,
  type ClaudeTaskUpdatedMessage,
  type ClaudeTaskUpdatedPatch,
  type ClaudeTextStreamKind,
  type ClaudeThinkingTokenAccount,
  type ClaudeToolResultStreamKind,
  type ToolInFlight,
} from "./ClaudeTypes.ts";
import { isInterruptedResult, resultErrorsText } from "./ClaudeSdkResultHelpers.ts";

export function accumulateClaudeThinkingTokens(
  account: ClaudeThinkingTokenAccount | undefined,
  estimatedTokens: number,
  estimatedTokensDelta?: number,
): ClaudeThinkingTokenAccount {
  const lastEstimate = account?.lastEstimate ?? 0;
  const pending = account?.pending ?? 0;
  const added =
    typeof estimatedTokensDelta === "number" &&
    Number.isFinite(estimatedTokensDelta) &&
    estimatedTokensDelta >= 0
      ? estimatedTokensDelta
      : estimatedTokens >= lastEstimate
        ? estimatedTokens - lastEstimate
        : estimatedTokens;
  return { lastEstimate: estimatedTokens, pending: pending + added };
}

export function claudeTurnCost(
  context: ClaudeSessionContext,
  current: number | undefined,
  failed: boolean,
): {
  totalCostUsd?: number;
} {
  if (current === undefined || !Number.isFinite(current) || current < 0) return {};
  if (current === 0) return !failed && context.lastTotalCostUsd === 0 ? { totalCostUsd: 0 } : {};
  const previous = context.lastTotalCostUsd;
  if (previous === undefined) {
    context.lastTotalCostUsd = current;
    return {};
  }
  const delta = current >= previous ? current - previous : current;
  context.lastTotalCostUsd = current;
  return { totalCostUsd: Number(delta.toFixed(6)) };
}

export function readClaudeCacheWriteSplit(
  modelUsage: unknown,
): { ephemeral5mInputTokens: number; ephemeral1hInputTokens: number } | undefined {
  const models = asUnknownRecord(modelUsage);
  if (!models) return undefined;
  let reported = false;
  let ephemeral5mInputTokens = 0;
  let ephemeral1hInputTokens = 0;
  for (const value of Object.values(models)) {
    const usage = asUnknownRecord(value);
    const fiveMinutes = usage?.cacheCreationEphemeral5mInputTokens;
    const oneHour = usage?.cacheCreationEphemeral1hInputTokens;
    if (typeof fiveMinutes === "number" && Number.isFinite(fiveMinutes) && fiveMinutes >= 0) {
      reported = true;
      ephemeral5mInputTokens += fiveMinutes;
    }
    if (typeof oneHour === "number" && Number.isFinite(oneHour) && oneHour >= 0) {
      reported = true;
      ephemeral1hInputTokens += oneHour;
    }
  }
  return reported
    ? {
        ephemeral5mInputTokens: Math.round(ephemeral5mInputTokens),
        ephemeral1hInputTokens: Math.round(ephemeral1hInputTokens),
      }
    : undefined;
}

export const CLAUDE_SEARCH_TIMED_OUT_NOTE = "Search stopped at time limit; more matches may exist";

/**
 * A short note from a tool's structured result for its completed row: Grep/Glob that hit
 * the time limit, and the next run of a CronCreate/CronList job (local absolute time).
 */
export function claudeToolResultNote(
  toolName: string,
  structuredOutput: unknown,
  formatTime: (epochMs: number) => string = (epochMs) => new Date(epochMs).toLocaleString(),
): string | undefined {
  const output = asUnknownRecord(structuredOutput);
  if (!output) return undefined;
  if ((toolName === "Grep" || toolName === "Glob") && output.timedOut === true)
    return CLAUDE_SEARCH_TIMED_OUT_NOTE;
  const fireTimes =
    toolName === "CronCreate"
      ? [output.nextFireAt]
      : toolName === "CronList" && Array.isArray(output.jobs)
        ? output.jobs.map((job) => asUnknownRecord(job)?.nextFireAt)
        : [];
  const next = fireTimes
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .reduce<number | undefined>((soonest, value) => Math.min(soonest ?? value, value), undefined);
  return next === undefined ? undefined : `Next run: ${formatTime(next)}`;
}

/**
 * `annotations[question].unanswered` for an AskUserQuestion answer, sent only to a CLI
 * advertising `ask_user_question_unanswered_v1` (older strict hosts refuse the whole
 * answer). Empty answers mean the card was dismissed; a submit marks blank questions
 * skipped. F5 never closes a blocking question from chat, so `replied_in_chat` is unused.
 */
export function claudeAskUserQuestionAnnotations(
  questionIds: ReadonlyArray<string>,
  answers: Readonly<Record<string, string>>,
  supported: boolean,
): Record<string, { unanswered: "skipped" | "dismissed" }> | undefined {
  if (!supported) return undefined;
  const answered = (id: string) => (answers[id] ?? "").trim().length > 0;
  const dismissed = !questionIds.some(answered);
  const entries = questionIds
    .filter((id) => !answered(id))
    .map((id) => [id, { unanswered: dismissed ? "dismissed" : "skipped" }] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/**
 * F5 guidance for startup failures whose fix lives in F5's launch setup. Other reasons
 * keep Claude's own message. None of these are retried: the same launch fails again.
 */

export function asRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(value);
}

export function asCanonicalTurnId(value: TurnId): TurnId {
  return value;
}

export function asRuntimeRequestId(value: ApprovalRequestId): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(value);
}

export function toPermissionMode(value: unknown): PermissionMode | undefined {
  switch (value) {
    case "default":
    case "acceptEdits":
    case "bypassPermissions":
    case "plan":
    case "dontAsk":
    case "auto":
      return value;
    default:
      return undefined;
  }
}

export function classifyToolRequestKind(
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

export function isReadOnlyToolName(toolName: string): boolean {
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

export function classifyRequestType(toolName: string): CanonicalRequestType {
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

export function normalizeOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function normalizeClaudeTaskStatus(value: unknown): ClaudeTaskTerminalStatus | undefined {
  switch (value) {
    case "completed":
    case "failed":
    case "stopped":
      return value;
    default:
      return undefined;
  }
}

export function normalizeClaudeTaskEndTime(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const timestampMs = value > 10_000_000_000 ? value : value * 1000;
  const date = new Date(timestampMs);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function readClaudeTaskUpdatedPatch(
  patch: Record<string, unknown>,
): ClaudeTaskUpdatedPatch | undefined {
  const isBackgrounded = patch.is_backgrounded === true;
  const terminalStatus = normalizeClaudeTaskStatus(patch.status);
  const backgroundEndedAt = normalizeClaudeTaskEndTime(patch.end_time);

  if (!isBackgrounded && !terminalStatus) {
    return undefined;
  }

  return {
    ...(isBackgrounded ? { isBackgrounded: true as const } : {}),
    ...(terminalStatus ? { terminalStatus } : {}),
    ...(backgroundEndedAt ? { backgroundEndedAt } : {}),
  };
}

export function readClaudeTaskUpdatedMessage(
  message: SDKMessage,
): ClaudeTaskUpdatedMessage | undefined {
  if (sdkMessageType(message) !== "system" || sdkMessageSubtype(message) !== "task_updated") {
    return undefined;
  }

  const record = asUnknownRecord(message);
  const taskId = normalizeOptionalString(record?.task_id);
  const patchRecord = asUnknownRecord(record?.patch);
  if (!taskId || !patchRecord) {
    return {
      malformed: true,
    };
  }

  const patch = readClaudeTaskUpdatedPatch(patchRecord);
  return {
    taskId,
    ...(patch ? { patch } : {}),
    malformed: false,
  };
}

export function runtimeItemStatusFromClaudeTaskStatus(
  status: ClaudeTaskTerminalStatus,
): RuntimeItemStatus {
  return status === "completed" ? "completed" : "failed";
}

export function backgroundToolTitle(tool: ToolInFlight, status: ClaudeBackgroundStatus): string {
  return `${tool.title} — ${status}`;
}

export function backgroundTaskResult(input: {
  readonly result?: Record<string, unknown>;
  readonly backgroundTaskId: string;
  readonly backgroundStatus: ClaudeBackgroundStatus;
  readonly backgroundEndedAt?: string;
}): Record<string, unknown> {
  return {
    ...input.result,
    backgroundTaskId: input.backgroundTaskId,
    backgroundStatus: input.backgroundStatus,
    ...(input.backgroundEndedAt ? { backgroundEndedAt: input.backgroundEndedAt } : {}),
  };
}

/** Claude cache reads/writes are separate from input_tokens; zero totals are placeholders. */
export function claudeInputTokens(usage: Readonly<Record<string, unknown>> | undefined): number {
  return ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].reduce(
    (total, key) => total + (typeof usage?.[key] === "number" ? (usage[key] as number) : 0),
    0,
  );
}

export function usageFromClaudeStreamEvent(
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

export function readSubagentMetadata(
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

export function buildToolLifecycleData(input: {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
}): Record<string, unknown> {
  const itemType = classifyToolItemType(input.toolName);
  const subagentMetadata =
    itemType === "collab_agent_tool_call"
      ? readSubagentMetadata(input.toolInput, input.result)
      : undefined;
  // Claude does not emit a unified-diff patch with its edits, so synthesize
  // Codex-shaped structured `changes` from the tool input. ProviderRuntimeIngestion
  // turns these into the file-change patch, letting Claude diffs render through
  // the same exact-diff path as Codex instead of the checkpoint fallback.
  const changes =
    itemType === "file_change"
      ? buildClaudeFileChangeStructuredChanges(input.toolName, input.toolInput)
      : undefined;

  return {
    toolName: input.toolName,
    input: input.toolInput,
    ...(input.result ? { result: input.result } : {}),
    ...(changes ? { changes } : {}),
    ...subagentMetadata,
  };
}

export function turnStatusFromResult(result: SDKResultMessage): ProviderRuntimeTurnStatus {
  if (isInterruptedResult(result)) return "interrupted";
  // api_error means Claude gave up after repeated API errors, even when the
  // result is not flagged is_error.
  if (
    result.terminal_reason === "blocking_limit" ||
    result.terminal_reason === "prompt_too_long" ||
    result.terminal_reason === "api_error"
  )
    return "failed";
  if (result.subtype === "success") {
    return result.is_error ? "failed" : "completed";
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

export function streamKindFromDeltaType(deltaType: string): ClaudeTextStreamKind {
  return deltaType.includes("thinking") ? "reasoning_text" : "assistant_text";
}

export function nativeProviderRefs(
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

export function extractContentBlockText(block: unknown): string {
  if (!block || typeof block !== "object") {
    return "";
  }

  const candidate = block as { type?: unknown; text?: unknown };
  return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
}

export function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

export function approximateContextCharsFromContentBlock(block: unknown): number {
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

export function approximateContextCharsFromMessageContent(content: unknown): number {
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

export function approximateContextCharsFromTurnItems(items: ReadonlyArray<unknown>): number {
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

export function extractExitPlanModePlan(value: unknown): string | undefined {
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

export function exitPlanCaptureKey(input: {
  readonly toolUseId?: string | undefined;
  readonly planMarkdown: string;
}): string {
  return input.toolUseId && input.toolUseId.length > 0
    ? `tool:${input.toolUseId}`
    : `plan:${input.planMarkdown}`;
}

export function tryParseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function toolInputFingerprint(input: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(input);
  } catch {
    return undefined;
  }
}

export function toolResultStreamKind(
  itemType: CanonicalItemType,
): ClaudeToolResultStreamKind | undefined {
  switch (itemType) {
    case "command_execution":
      return "command_output";
    case "file_change":
      return "file_change_output";
    default:
      return undefined;
  }
}

export function toolResultBlocksFromUserMessage(message: SDKMessage): Array<{
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

export function readBackgroundTaskIdFromToolResult(
  message: SDKMessage,
  toolResult: {
    readonly block: Record<string, unknown>;
    readonly text: string;
  },
): string | undefined {
  const topLevelResult = asUnknownRecord(asUnknownRecord(message)?.tool_use_result);
  const candidates = [
    topLevelResult?.backgroundTaskId,
    topLevelResult?.background_task_id,
    toolResult.block.backgroundTaskId,
    toolResult.block.background_task_id,
  ];

  for (const candidate of candidates) {
    const taskId = normalizeOptionalString(candidate);
    if (taskId) {
      return taskId;
    }
  }

  const match = toolResult.text.match(
    /\bbackground(?:\s+task)?(?:\s+with)?\s+id:\s*([A-Za-z0-9_-]+)/i,
  );
  return normalizeOptionalString(match?.[1]);
}

export function findInFlightToolEntryByItemId(
  context: ClaudeSessionContext,
  itemId: string,
): readonly [number, ToolInFlight] | undefined {
  return Array.from(context.inFlightTools.entries()).find(([, tool]) => tool.itemId === itemId);
}

export function claimTaskCompletion(context: ClaudeSessionContext, taskId: string): boolean {
  const runId = context.nativeTaskRuns.get(taskId);
  if (
    context.completedTaskNotifications.has(taskId) &&
    context.completedTaskNotifications.get(taskId) === runId
  )
    return false;
  context.completedTaskNotifications.set(taskId, runId);
  if (context.completedTaskNotifications.size > 512) {
    context.completedTaskNotifications.delete(
      context.completedTaskNotifications.keys().next().value!,
    );
  }
  return true;
}

export function findTaskStateEntryByToolUseId(
  context: ClaudeSessionContext,
  toolUseId: string,
): readonly [string, ClaudeTaskState] | undefined {
  return Array.from(context.taskStates.entries()).find(
    ([, state]) => state.toolUseId === toolUseId,
  );
}

export function hasBackgroundTaskStateForTool(
  context: ClaudeSessionContext,
  toolUseId: string,
): boolean {
  return Array.from(context.taskStates.values()).some(
    (state) => state.toolUseId === toolUseId && state.backgrounded === true,
  );
}

export function sdkMessageType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { type?: unknown };
  return typeof record.type === "string" ? record.type : undefined;
}

export function sdkMessageSubtype(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { subtype?: unknown };
  return typeof record.subtype === "string" ? record.subtype : undefined;
}

export function sdkNativeMethod(message: SDKMessage): string {
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

export function sdkNativeItemId(message: SDKMessage): string | undefined {
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
