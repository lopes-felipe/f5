import { readMcpAppReferenceForTool, readMcpAppToolResult } from "@t3tools/shared/mcpApp";
import { stringifyWithinBytes } from "@t3tools/shared/boundedJson";
import { isPreparedComputerEvent } from "../../provider/prepareAutomationRuntimeEvent";
import { computerToolHeading } from "@t3tools/shared/computerAction";
import { automationEventSanitizer } from "@t3tools/shared/automationActivitySanitizer";
import { createHash } from "node:crypto";

import {
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";
import {
  ApprovalRequestId,
  type AssistantDeliveryMode,
  CommandId,
  EventId,
  MessageId,
  OrchestrationCommandExecutionId,
  type OrchestrationCommandExecutionStatus,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  OrchestrationFileChangeId,
  type OrchestrationFileChangeStatus,
  ProviderItemId,
  isToolLifecycleItemType,
  type TaskItem,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  type ProviderSessionCapabilities,
  type OrchestrationUsageLimit,
} from "@t3tools/contracts";
import { Cause, Duration } from "effect";
import {
  deriveNarratedActivityDisplayHints,
  deriveSearchCommandSummary,
  isGenericCommandTitle,
  parseCommandExecutionTitle,
} from "@t3tools/shared/commandSummary";
import {
  compactThreadActivityPayload,
  readToolActivityPayload,
} from "@t3tools/shared/orchestrationActivityPayload";

import { isSyntheticClaudeThreadId, isUuid } from "../../provider/claudeResumeState.ts";
import {
  INSTRUCTION_PROFILE_CONFIG_KEY,
  readInstructionProfile,
} from "../../provider/sharedAssistantContract.ts";
import { truncateMiddleByBytes } from "../outputTruncation.ts";
import { type ToolResultImageRef } from "../toolResultImages.ts";
import {
  isTaskToolName,
  type TaskToolLifecycleInput,
  type TaskToolName,
} from "@t3tools/shared/claudeTaskToolProjection";
import { extractContextTokens } from "../providerTerminalLifecycle.ts";

/** Equal snapshots differ only in when they were taken. */

export function sameSessionCapabilities(
  left: ProviderSessionCapabilities | null,
  right: ProviderSessionCapabilities | null,
): boolean {
  if (left === null || right === null) return left === right;
  const { checkedAt: _leftCheckedAt, ...leftRest } = left;
  const { checkedAt: _rightCheckedAt, ...rightRest } = right;
  return JSON.stringify(leftRest) === JSON.stringify(rightRest);
}

export const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;

export interface ReasoningStatusEntry {
  readonly providerItemId: string | null;
  readonly state: "active" | "idle";
  readonly detail: string | null;
  readonly sequence: number | undefined;
  readonly createdAt: string;
  /** Summary text scanned for a heading, per summary part; `null` once done. */
  readonly headingParts: Readonly<Record<string, string | null>>;
}

export interface PendingReasoningTokens {
  readonly tokens: number;
  readonly estimated: boolean;
}

export interface ReasoningSection {
  readonly key: string;
  /** The streamed message that last received this turn's reasoning, if any. */
  readonly messageId: MessageId | null;
}

/**
 * The decider rejected the command outright (for example, a delta for a
 * message it already closed). Retrying cannot succeed, so taken text is not
 * restored: it would otherwise land on the next message.
 */
export function isPermanentDispatchRejection(cause: Cause.Cause<unknown>): boolean {
  return isPermanentDispatchError(Cause.squash(cause));
}

export function isPermanentDispatchError(error: unknown): boolean {
  const tag = (error as { readonly _tag?: unknown } | null)?._tag;
  return (
    tag === "OrchestrationCommandInvariantError" ||
    tag === "OrchestrationCommandPreviouslyRejectedError"
  );
}

export function reasoningStatusActivityId(threadId: ThreadId, turnId: TurnId): EventId {
  return EventId.make(`reasoning-status:${threadId}:${turnId}`);
}

/** Rebuilds the cached status from the persisted record, e.g. after a restart. */
export function restoreReasoningStatusEntry(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  threadId: ThreadId,
  turnId: TurnId,
): ReasoningStatusEntry | null {
  const id = reasoningStatusActivityId(threadId, turnId);
  const activity = activities.find((entry) => entry.id === id);
  const payload =
    activity?.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  if (!activity || !payload) return null;
  return {
    providerItemId: typeof payload.providerItemId === "string" ? payload.providerItemId : null,
    state: payload.state === "active" ? "active" : "idle",
    detail: typeof payload.detail === "string" ? payload.detail : null,
    sequence: activity.sequence,
    createdAt: activity.createdAt,
    // Headings were already scanned before the restart; do not rescan.
    headingParts: {},
  };
}

export function eventSessionSequence(event: ProviderRuntimeEvent): number | undefined {
  return (event as ProviderRuntimeEvent & { sessionSequence?: number }).sessionSequence;
}

export const DEFAULT_ASSISTANT_DELIVERY_MODE: AssistantDeliveryMode = "buffered";
export const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;
export const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
export const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;
export const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
export const BUFFERED_REASONING_TEXT_BY_TURN_KEY_CACHE_CAPACITY = 10_000;
export const BUFFERED_REASONING_TEXT_BY_TURN_KEY_TTL = Duration.minutes(120);
export const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000;
export const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);
export const LAST_THINKING_TOKENS_BY_THREAD_CACHE_CAPACITY = 10_000;
export const LAST_THINKING_TOKENS_BY_THREAD_TTL = Duration.minutes(120);
export const REASONING_STATUS_BY_TURN_KEY_CACHE_CAPACITY = 10_000;
export const REASONING_STATUS_BY_TURN_KEY_TTL = Duration.minutes(120);
export const REASONING_SECTION_BY_TURN_KEY_CACHE_CAPACITY = 10_000;
export const REASONING_SECTION_BY_TURN_KEY_TTL = Duration.minutes(120);
export const REASONING_TOKENS_BY_TURN_KEY_CACHE_CAPACITY = 10_000;
export const REASONING_TOKENS_BY_TURN_KEY_TTL = Duration.minutes(120);
// A summary part that has not produced a `**Heading**` within this many
// characters never will; stop scanning it.
export const REASONING_HEADING_SCAN_CHARS = 400;
export const REASONING_HEADING_REGEX = /^\s*\*\*([^*\n]{1,200}?)\*\*/;
// Live `thinking_tokens` frames arrive at high frequency. Coalesce them so the
// event store only sees a bounded number of `thread.session.set` dispatches per
// turn: dispatch only when the running estimate grows by at least this many
// tokens since the last dispatch (or when it drops, signalling a new thinking
// block within the same turn).
export const THINKING_TOKENS_DISPATCH_THRESHOLD = 500;
// Providers report context usage after every model step, and each report used to become a
// durable `thread.session.set` (about a fifth of a long-lived profile's event log). While a
// turn runs, a report is persisted only once it moves the stored estimate by this much; the
// latest unpersisted one is carried by the next lifecycle dispatch, so a settled turn still
// stores the exact final value.
export const CONTEXT_TOKENS_DISPATCH_MIN_DELTA = 2_000;
export const CONTEXT_TOKENS_DISPATCH_WINDOW_FRACTION = 0.01;
export const contextTokensDispatchThreshold = (modelContextWindowTokens: number | null) =>
  Math.max(
    CONTEXT_TOKENS_DISPATCH_MIN_DELTA,
    Math.round((modelContextWindowTokens ?? 0) * CONTEXT_TOKENS_DISPATCH_WINDOW_FRACTION),
  );
export interface PendingContextTokens {
  readonly estimatedContextTokens: number;
  readonly tokenUsageSource: "provider" | "estimated";
  /** The stored estimate this report was held against. */
  readonly storedContextTokens: number;
}
/**
 * A held report is only current while the stored estimate is the one it was held against.
 * Anything else that moved the estimate since (a compaction, for example) is newer.
 */
export const currentPendingContextTokens = (
  pending: PendingContextTokens | null,
  thread: Pick<OrchestrationThread, "estimatedContextTokens">,
) =>
  pending !== null && pending.storedContextTokens === (thread.estimatedContextTokens ?? null)
    ? pending
    : null;
export const PROFILED_WORKFLOW_TURN_TIMEOUT_MS = 30 * 60 * 1_000;
// Tool items that never complete are evicted oldest first past this many.
export const MAX_TRACKED_TOOL_UPDATES = 512;
export const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
export const MAX_BUFFERED_REASONING_CHARS = 200_000;
export const COMMAND_OUTPUT_FLUSH_INTERVAL_MS = 100;
export const COMMAND_OUTPUT_BUFFER_FLUSH_BYTES = 4 * 1024;
// File-change output (unlike command output) is not flushed incrementally; it
// accumulates in `pendingFileChanges` until the change finalizes. Bound it so a
// single huge write cannot grow the buffer without limit. The resolved patch is
// normally sourced from a structured `exactPatch`; this buffer is only a
// fallback, so head+tail truncation with a visible marker is safe.
export const MAX_FILE_CHANGE_OUTPUT_BYTES = 1024 * 1024;
export const FILE_CHANGE_OUTPUT_HEAD_BYTES = 512 * 1024;
export const FILE_CHANGE_OUTPUT_TRUNCATION_MARKER =
  "\n\n[... file change output truncated; middle omitted ...]\n\n";
// Only re-truncate once the buffer grows past this slack threshold (then back
// down to MAX_FILE_CHANGE_OUTPUT_BYTES). This keeps memory bounded while
// amortizing the truncation cost across many small deltas instead of
// re-scanning/allocating the whole buffer on every delta.
export const FILE_CHANGE_OUTPUT_TRUNCATE_THRESHOLD_BYTES = 2 * MAX_FILE_CHANGE_OUTPUT_BYTES;
export const MAX_HOOK_DIAGNOSTIC_TEXT_BYTES = 64 * 1024;
export const HOOK_DIAGNOSTIC_TEXT_HEAD_BYTES = 48 * 1024;
export const HOOK_DIAGNOSTIC_TEXT_TRUNCATION_MARKER =
  "\n\n[... hook diagnostic output truncated; middle omitted ...]\n\n";
export const MAX_APPROVAL_DETAIL_BYTES = 32 * 1024;
export const APPROVAL_DETAIL_HEAD_BYTES = 24 * 1024;
export const APPROVAL_DETAIL_TRUNCATION_MARKER =
  "\n\n[... approval detail truncated; middle omitted ...]\n\n";
export const MAX_HOOK_DIAGNOSTIC_ENTRIES = 32;
export const MAX_HOOK_DIAGNOSTIC_ENTRY_BYTES = 16 * 1024;
export const MAX_HOOK_DIAGNOSTIC_ENTRIES_BYTES = 64 * 1024;
export const STRICT_PROVIDER_LIFECYCLE_GUARD =
  process.env.T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";

export type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;
export type ItemLifecycleRuntimeEvent = Extract<
  ProviderRuntimeEvent,
  { type: "item.started" | "item.updated" | "item.completed" }
>;

export type RuntimeIngestionInput =
  | {
      source: "assistant-delta-flush";
      threadId: ThreadId;
      messageId: MessageId;
      commandId: CommandId;
    }
  | { source: "assistant-delta-flush-thread"; threadId: ThreadId }
  | { source: "assistant-delta-flush-all" }
  | {
      source: "usage-limit-resolved";
      threadId: ThreadId;
      limit: OrchestrationUsageLimit;
      event: ProviderRuntimeEvent;
    }
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: TurnStartRequestedDomainEvent;
    }
  | {
      source: "command-output-flush";
      commandExecutionId: OrchestrationCommandExecutionId;
    }
  | {
      source: "command-output-flush-all";
    }
  | { source: "tool-update-flush"; threadId: ThreadId }
  | { source: "tool-update-flush-all" };

export interface OpenCommandExecutionState {
  readonly id: OrchestrationCommandExecutionId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly providerItemId: ProviderItemId;
  readonly nativeThreadId?: string;
  command: string;
  cwd: string | undefined;
  description: string | undefined;
  title: string | null;
  detail: string | null;
  status: OrchestrationCommandExecutionStatus;
  exitCode: number | null;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
  bufferedOutput: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /**
   * The output tail of a `gh pr create` run, scanned for the new PR URL on completion;
   * null for every other command.
   */
  pullRequestCreateOutput: string | null;
}

/** `gh` prints the PR URL last; a bounded tail is enough to find it. */
export const PULL_REQUEST_CREATE_OUTPUT_SCAN_CHARS = 64 * 1024;

export function appendPullRequestCreateOutput(current: string, delta: string): string {
  const next = current + delta;
  return next.length > PULL_REQUEST_CREATE_OUTPUT_SCAN_CHARS
    ? next.slice(-PULL_REQUEST_CREATE_OUTPUT_SCAN_CHARS)
    : next;
}

export interface PendingCommandExecutionOutputState {
  bufferedOutput: string;
  updatedAt: string;
}

export interface PendingFileChangeState {
  readonly id: OrchestrationFileChangeId;
  readonly threadId: ThreadId;
  readonly providerItemId: ProviderItemId;
  firstSeenAt: string;
  turnId: TurnId | null;
  title: string | null;
  detail: string | null;
  changedFiles: ReadonlyArray<string>;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  exactPatch: string;
  bufferedOutput: string;
  // UTF-8 byte length of bufferedOutput, tracked incrementally so appends do
  // not re-scan the whole buffer on every delta.
  bufferedOutputBytes: number;
}

export function clearCommandExecutionFlushTimer(commandExecution: OpenCommandExecutionState) {
  if (commandExecution.flushTimer !== null) {
    clearTimeout(commandExecution.flushTimer);
    commandExecution.flushTimer = null;
  }
}

export function laterIsoTimestamp(left: string, right: string): string {
  return left >= right ? left : right;
}

export function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.makeUnsafe(String(value));
}

export function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.makeUnsafe(value);
}

export function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

export function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

export function truncateApprovalDetail(value: string): string {
  return truncateMiddleByBytes(value, {
    maxBytes: MAX_APPROVAL_DETAIL_BYTES,
    headBytes: APPROVAL_DETAIL_HEAD_BYTES,
    marker: APPROVAL_DETAIL_TRUNCATION_MARKER,
  }).output;
}

export function truncateHookDiagnosticText(value: string): string {
  return truncateMiddleByBytes(value, {
    maxBytes: MAX_HOOK_DIAGNOSTIC_TEXT_BYTES,
    headBytes: HOOK_DIAGNOSTIC_TEXT_HEAD_BYTES,
    marker: HOOK_DIAGNOSTIC_TEXT_TRUNCATION_MARKER,
  }).output;
}

export function serializeDiagnosticEntry(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export function hookDiagnosticEntryPreview(serialized: string): Record<string, unknown> {
  return {
    truncated: true,
    preview: truncateMiddleByBytes(serialized, {
      maxBytes: MAX_HOOK_DIAGNOSTIC_ENTRY_BYTES - 256,
      headBytes: 12 * 1024,
      marker: "\n[... diagnostic entry truncated ...]\n",
    }).output,
  };
}

export function boundHookDiagnosticEntries(
  entries: ReadonlyArray<unknown> | undefined,
): ReadonlyArray<unknown> | undefined {
  if (!entries || entries.length === 0) {
    return undefined;
  }

  const bounded: unknown[] = [];
  let serializedBytes = 2;
  let nextIndex = 0;
  const countLimit =
    entries.length > MAX_HOOK_DIAGNOSTIC_ENTRIES ? MAX_HOOK_DIAGNOSTIC_ENTRIES - 1 : entries.length;

  for (; nextIndex < countLimit; nextIndex += 1) {
    const entry = entries[nextIndex];
    const serialized = serializeDiagnosticEntry(entry);
    const boundedEntry =
      serialized === undefined
        ? { truncated: true, reason: "Diagnostic entry could not be serialized" }
        : Buffer.byteLength(serialized, "utf8") > MAX_HOOK_DIAGNOSTIC_ENTRY_BYTES
          ? hookDiagnosticEntryPreview(serialized)
          : entry;
    const boundedSerialized = serializeDiagnosticEntry(boundedEntry) ?? "{}";
    const nextBytes = Buffer.byteLength(boundedSerialized, "utf8") + (bounded.length > 0 ? 1 : 0);
    if (serializedBytes + nextBytes > MAX_HOOK_DIAGNOSTIC_ENTRIES_BYTES) {
      break;
    }
    bounded.push(boundedEntry);
    serializedBytes += nextBytes;
  }

  if (nextIndex < entries.length) {
    const truncationMarker = {
      truncated: true,
      omittedEntries: entries.length - nextIndex,
    };
    while (
      bounded.length > 0 &&
      Buffer.byteLength(JSON.stringify([...bounded, truncationMarker]), "utf8") >
        MAX_HOOK_DIAGNOSTIC_ENTRIES_BYTES
    ) {
      bounded.pop();
      truncationMarker.omittedEntries += 1;
    }
    bounded.push(truncationMarker);
  }

  return bounded;
}

export function normalizeProposedPlanMarkdown(
  planMarkdown: string | undefined,
): string | undefined {
  const trimmed = planMarkdown?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

export function capBufferedReasoningText(value: string): string {
  if (value.length <= MAX_BUFFERED_REASONING_CHARS) {
    return value;
  }
  return value.slice(-MAX_BUFFERED_REASONING_CHARS);
}

export function proposedPlanIdForTurn(threadId: ThreadId, turnId: TurnId): string {
  return `plan:${threadId}:turn:${turnId}`;
}

export function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): string {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    return proposedPlanIdForTurn(threadId, turnId);
  }
  if (event.itemId) {
    return `plan:${threadId}:item:${event.itemId}`;
  }
  return `plan:${threadId}:event:${event.eventId}`;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asTrimmedNonEmptyString(value: unknown): string | undefined {
  const candidate = asString(value)?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function extractThreadTokenUsageContextTokens(usage: unknown): number | undefined {
  const inputTokens = extractContextTokens(usage);
  if (inputTokens !== undefined) {
    return inputTokens;
  }

  const usageRecord = asRecord(usage);
  const promptTokens = asNonNegativeNumber(usageRecord?.prompt_tokens);
  if (promptTokens !== undefined) {
    return (
      promptTokens +
      (asNonNegativeNumber(usageRecord?.cache_creation_input_tokens) ?? 0) +
      (asNonNegativeNumber(usageRecord?.cache_read_input_tokens) ?? 0)
    );
  }

  const totalTokens = asNonNegativeNumber(usageRecord?.total_tokens);
  if (totalTokens !== undefined) {
    return totalTokens;
  }

  return undefined;
}

export function nextResumeCursorFromThreadStartedEvent(
  event: Extract<ProviderRuntimeEvent, { type: "thread.started" }>,
  existingResumeCursor: unknown,
):
  | {
      readonly resumeCursor: Record<string, unknown>;
      readonly ignoredInvalidClaudeResumeToken?: {
        readonly reason: "synthetic_thread_id" | "invalid_uuid";
        readonly preservedExistingResume: boolean;
      };
    }
  | undefined {
  const providerThreadId = event.payload.providerThreadId?.trim();
  if (!providerThreadId) {
    return undefined;
  }

  const existingResumeCursorRecord = asRecord(existingResumeCursor);
  // Resume cursor shapes differ by provider. Claude stores the orchestration
  // thread id separately from its provider-specific `resume` token, while
  // codex-style providers use the provider thread id directly as the cursor's
  // `threadId`.
  if (event.provider === "claudeAgent") {
    const existingResumeCandidate =
      asTrimmedNonEmptyString(existingResumeCursorRecord?.resume) ??
      asTrimmedNonEmptyString(existingResumeCursorRecord?.sessionId);
    const existingResume =
      existingResumeCandidate && isUuid(existingResumeCandidate)
        ? existingResumeCandidate
        : undefined;
    // Strip both `resume` and the legacy `sessionId` field so upgraded installs
    // carrying a stale `sessionId` cursor stop retrying a known-bad token;
    // `readClaudeResumeState()` falls back to `sessionId` when `resume` is
    // absent, so leaving it behind would defeat the invalid-token guard below.
    const {
      resume: _discardResume,
      sessionId: _discardSessionId,
      ...resumeCursorWithoutResume
    } = existingResumeCursorRecord ?? {};

    if (isUuid(providerThreadId)) {
      return {
        resumeCursor: {
          ...resumeCursorWithoutResume,
          threadId: event.threadId,
          resume: providerThreadId,
        },
      };
    }

    return {
      resumeCursor: {
        ...resumeCursorWithoutResume,
        threadId: event.threadId,
        ...(existingResume ? { resume: existingResume } : {}),
      },
      ignoredInvalidClaudeResumeToken: {
        reason: isSyntheticClaudeThreadId(providerThreadId)
          ? "synthetic_thread_id"
          : "invalid_uuid",
        preservedExistingResume: existingResume !== undefined,
      },
    };
  }

  if (existingResumeCursorRecord) {
    return {
      resumeCursor: {
        ...existingResumeCursorRecord,
        threadId: providerThreadId,
      },
    };
  }
  return {
    resumeCursor: {
      threadId: providerThreadId,
    },
  };
}

export function normalizeCommandValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function normalizeLifecycleCommandExecutionTitle(
  title: string | undefined,
  command: string,
): string | undefined {
  if (!title) {
    return undefined;
  }
  // Providers use generic titles like "Ran command" for shell fallbacks. When
  // that happens we replace the placeholder with a derived search summary, but
  // preserve any provider-authored specific title verbatim.
  if (!isGenericCommandTitle(title)) {
    return title;
  }
  const searchSummary = deriveSearchCommandSummary(command);
  if (!searchSummary) {
    return title;
  }
  // The background suffix is the stored background marker; keep it on the summary.
  const { backgroundStatus } = parseCommandExecutionTitle(title);
  return backgroundStatus ? `${searchSummary} — ${backgroundStatus}` : searchSummary;
}

export function extractRawCommandExecutionCommand(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
): string | undefined {
  const data = asRecord(event.payload.data);
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const toolInput = asRecord(data?.input);
  const itemResult = asRecord(item?.result);
  return (
    normalizeCommandValue(item?.command) ??
    normalizeCommandValue(itemInput?.command) ??
    normalizeCommandValue(toolInput?.command) ??
    normalizeCommandValue(itemResult?.command) ??
    normalizeCommandValue(data?.command)
  );
}

export function extractCommandExecutionCommand(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
): string {
  const payloadTitle =
    typeof event.payload.title === "string" && !isGenericCommandTitle(event.payload.title)
      ? event.payload.title
      : undefined;
  return (
    extractRawCommandExecutionCommand(event) ??
    event.payload.detail ??
    payloadTitle ??
    event.payload.title ??
    "[command unavailable]"
  );
}

export function commandExecutionLifecycleTitle(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
): string | undefined {
  if (event.payload.itemType !== "command_execution") {
    return event.payload.title;
  }
  return normalizeLifecycleCommandExecutionTitle(
    event.payload.title,
    extractCommandExecutionCommand(event),
  );
}

export function extractCommandExecutionCwd(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
): string | undefined {
  const payload = runtimePayloadRecord(event);
  const payloadData = asRecord(event.payload.data);
  const payloadItem = asRecord(payloadData?.item);
  const payloadInput = asRecord(payloadItem?.input);
  const payloadResult = asRecord(payloadItem?.result);
  const rawPayload = runtimeRawPayloadRecord(event);
  const rawItem = asRecord(rawPayload?.item);
  const rawInput = asRecord(rawItem?.input ?? rawPayload?.input);
  const rawResult = asRecord(rawItem?.result ?? rawPayload?.result);

  return (
    asTrimmedNonEmptyString(payloadInput?.cwd) ??
    asTrimmedNonEmptyString(payloadResult?.cwd) ??
    asTrimmedNonEmptyString(payloadItem?.cwd) ??
    asTrimmedNonEmptyString(payloadData?.cwd) ??
    asTrimmedNonEmptyString(asRecord(payload?.input)?.cwd) ??
    asTrimmedNonEmptyString(asRecord(payload?.result)?.cwd) ??
    asTrimmedNonEmptyString(payload?.cwd) ??
    asTrimmedNonEmptyString(rawInput?.cwd) ??
    asTrimmedNonEmptyString(rawResult?.cwd) ??
    asTrimmedNonEmptyString(rawItem?.cwd) ??
    asTrimmedNonEmptyString(rawPayload?.cwd) ??
    asTrimmedNonEmptyString(asRecord(rawPayload?.run)?.cwd)
  );
}

export const COMMAND_EXECUTION_DESCRIPTION_MAX_CHARS = 200;

export function extractCommandExecutionDescription(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
): string | undefined {
  const payloadData = asRecord(event.payload.data);
  const payloadItem = asRecord(payloadData?.item);
  const rawPayload = runtimeRawPayloadRecord(event);
  const rawItem = asRecord(rawPayload?.item);
  const description =
    asTrimmedNonEmptyString(asRecord(payloadData?.input)?.description) ??
    asTrimmedNonEmptyString(asRecord(payloadItem?.input)?.description) ??
    asTrimmedNonEmptyString(asRecord(rawItem?.input ?? rawPayload?.input)?.description);
  if (!description) {
    return undefined;
  }
  return description.length > COMMAND_EXECUTION_DESCRIPTION_MAX_CHARS
    ? `${description.slice(0, COMMAND_EXECUTION_DESCRIPTION_MAX_CHARS - 1).trimEnd()}…`
    : description;
}

export function parseExitCodeFromDetail(detail: string | undefined): number | null {
  if (!detail) {
    return null;
  }
  const match = /<exited with exit code (?<code>\d+)>/i.exec(detail);
  if (!match?.groups?.code) {
    return null;
  }
  const parsed = Number.parseInt(match.groups.code, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

export function extractCommandExecutionExitCode(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
): number | null {
  const data = asRecord(event.payload.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const direct = itemResult?.exitCode;
  if (typeof direct === "number" && Number.isInteger(direct)) {
    return direct;
  }
  // ACP agents report it in `rawOutput`: Grok as `exitCode`, Antigravity as `exit_code`.
  const rawOutput = asRecord(data?.rawOutput);
  const acp = rawOutput?.exitCode ?? rawOutput?.exit_code;
  if (typeof acp === "number" && Number.isInteger(acp)) {
    return acp;
  }
  return parseExitCodeFromDetail(event.payload.detail);
}

export function commandExecutionStatusFromLifecycleEvent(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
): OrchestrationCommandExecutionStatus {
  const exitCode = extractCommandExecutionExitCode(event);
  const hasNonZeroExitCode = exitCode !== null && exitCode !== 0;
  if (event.type === "item.started") {
    return "running";
  }
  switch (event.payload.status) {
    case "failed":
      return "failed";
    case "declined":
      return "declined";
    case "completed":
      return hasNonZeroExitCode ? "failed" : "completed";
    case "inProgress":
    default:
      return event.type === "item.completed"
        ? hasNonZeroExitCode
          ? "failed"
          : "completed"
        : "running";
  }
}

export function fileChangeIdForRuntimeItem(
  threadId: ThreadId,
  itemId: string,
): OrchestrationFileChangeId {
  return OrchestrationFileChangeId.makeUnsafe(`filechange:${threadId}:${itemId}`);
}

export function fileChangeStatusFromLifecycleEvent(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
): OrchestrationFileChangeStatus {
  switch (event.payload.status) {
    case "failed":
      return "failed";
    case "declined":
      return "declined";
    case "completed":
    case "inProgress":
    default:
      return "completed";
  }
}

export function extractFileChangePreview(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
): {
  readonly title: string | null;
  readonly detail: string | null;
  readonly changedFiles: ReadonlyArray<string>;
} {
  const compactPayload = readToolActivityPayload({
    itemType: "file_change",
    ...(event.payload.title ? { title: event.payload.title } : {}),
    ...(event.payload.detail ? { detail: event.payload.detail } : {}),
    ...(event.payload.requestKind ? { requestKind: event.payload.requestKind } : {}),
    ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
  });
  return {
    title: event.payload.title ?? null,
    detail: event.payload.detail ?? null,
    changedFiles: compactPayload?.changedFiles ?? [],
  };
}

export interface StructuredFileChangePatchInput {
  readonly path: string;
  readonly kind?: string;
  readonly movePath?: string;
  readonly diff?: string;
  readonly content?: string;
}

export function normalizePatchText(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

export function ensurePatchTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

export function splitPatchContentLines(value: string): {
  readonly lines: ReadonlyArray<string>;
  readonly hasTrailingNewline: boolean;
} {
  const lines = normalizePatchText(value).split("\n");
  const hasTrailingNewline = lines[lines.length - 1] === "";
  if (hasTrailingNewline) {
    lines.pop();
  }
  return { lines, hasTrailingNewline };
}

export function formatUnifiedRange(start: number, count: number): string {
  if (count === 0) {
    return `${start},0`;
  }
  return count === 1 ? `${start}` : `${start},${count}`;
}

export function normalizeGitDiffPath(value: string): string {
  return value.replaceAll("\\", "/");
}

export function hasUnifiedDiffFileHeaders(value: string): boolean {
  return /^--- [^\n]+\n\+\+\+ [^\n]+(?:\n|$)/.test(value);
}

export function hasRenameMetadata(value: string): boolean {
  return /(?:^|\n)rename from [^\n]+\nrename to [^\n]+(?:\n|$)/.test(value);
}

export function buildAddedOrDeletedFilePatch(input: {
  readonly kind: "add" | "delete";
  readonly path: string;
  readonly content: string;
}): string {
  const filePath = normalizeGitDiffPath(input.path);
  const { lines, hasTrailingNewline } = splitPatchContentLines(input.content);
  const header = [`diff --git a/${filePath} b/${filePath}`];

  if (input.kind === "add") {
    header.push("new file mode 100644", "--- /dev/null", `+++ b/${filePath}`);
    if (lines.length > 0) {
      header.push(`@@ -0,0 +${formatUnifiedRange(1, lines.length)} @@`);
      header.push(...lines.map((line) => `+${line}`));
      if (!hasTrailingNewline) {
        header.push("\\ No newline at end of file");
      }
    }
  } else {
    header.push("deleted file mode 100644", `--- a/${filePath}`, "+++ /dev/null");
    if (lines.length > 0) {
      header.push(`@@ -${formatUnifiedRange(1, lines.length)} +0,0 @@`);
      header.push(...lines.map((line) => `-${line}`));
      if (!hasTrailingNewline) {
        header.push("\\ No newline at end of file");
      }
    }
  }

  return ensurePatchTrailingNewline(header.join("\n"));
}

export function buildUpdatedFilePatch(input: StructuredFileChangePatchInput): string | undefined {
  const diffText = normalizePatchText(input.diff ?? "").trim();
  if (diffText.length === 0 && !input.movePath) {
    return undefined;
  }
  if (diffText.startsWith("diff --git ")) {
    return ensurePatchTrailingNewline(diffText);
  }

  const oldPath = normalizeGitDiffPath(input.path);
  const newPath = normalizeGitDiffPath(input.movePath ?? input.path);
  const header = [`diff --git a/${oldPath} b/${newPath}`];

  if (input.movePath && input.movePath.length > 0 && !hasRenameMetadata(diffText)) {
    header.push(`rename from ${oldPath}`, `rename to ${newPath}`);
  }

  if (diffText.length === 0) {
    return ensurePatchTrailingNewline(header.join("\n"));
  }

  if (hasUnifiedDiffFileHeaders(diffText) || hasRenameMetadata(diffText)) {
    header.push(diffText);
    return ensurePatchTrailingNewline(header.join("\n"));
  }

  header.push(`--- a/${oldPath}`, `+++ b/${newPath}`, diffText);
  return ensurePatchTrailingNewline(header.join("\n"));
}

export function toStructuredFileChangePatchInput(
  value: unknown,
): StructuredFileChangePatchInput | undefined {
  const record = asRecord(value);
  const path = asTrimmedNonEmptyString(record?.path);
  if (!path) {
    return undefined;
  }

  const kindRecord = asRecord(record?.kind);
  const kind = asTrimmedNonEmptyString(kindRecord?.type) ?? asTrimmedNonEmptyString(record?.type);
  const movePath =
    asTrimmedNonEmptyString(kindRecord?.move_path) ??
    asTrimmedNonEmptyString(kindRecord?.movePath) ??
    asTrimmedNonEmptyString(record?.move_path) ??
    asTrimmedNonEmptyString(record?.movePath);
  const diff =
    asString(record?.diff) ?? asString(record?.unified_diff) ?? asString(record?.unifiedDiff);
  const content = asString(record?.content);

  return {
    path,
    ...(kind ? { kind } : {}),
    ...(movePath ? { movePath } : {}),
    ...(diff ? { diff } : {}),
    ...(content ? { content } : {}),
  };
}

export const STRUCTURED_FILE_CHANGE_UPDATE_KINDS = new Set(["update", "move"]);
export const STRUCTURED_FILE_CHANGE_KINDS = new Set([
  "add",
  "delete",
  "remove",
  ...STRUCTURED_FILE_CHANGE_UPDATE_KINDS,
]);

export function extractStructuredFileChangePatchInputs(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
): ReadonlyArray<StructuredFileChangePatchInput> {
  const data = asRecord(event.payload.data);
  const item = asRecord(data?.item);
  const source = item ?? data;
  const changes = Array.isArray(source?.changes) ? source.changes : [];

  return changes
    .map((entry) => toStructuredFileChangePatchInput(entry))
    .filter((entry): entry is StructuredFileChangePatchInput => entry !== undefined);
}

export function extractUnknownStructuredFileChangeKinds(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
): ReadonlyArray<string> {
  const unknownKinds = new Set<string>();

  for (const change of extractStructuredFileChangePatchInputs(event)) {
    const normalizedKind = change.kind?.toLowerCase();
    if (!normalizedKind || STRUCTURED_FILE_CHANGE_KINDS.has(normalizedKind)) {
      continue;
    }
    unknownKinds.add(change.kind as string);
  }

  return [...unknownKinds];
}

export function synthesizeStructuredFileChangePatch(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
): string | undefined {
  const patches = extractStructuredFileChangePatchInputs(event)
    .flatMap((change) => {
      const kind = change.kind?.toLowerCase();
      if (kind === "add") {
        return [
          buildAddedOrDeletedFilePatch({
            kind: "add",
            path: change.path,
            content: change.diff ?? change.content ?? "",
          }),
        ];
      }
      if (kind === "delete" || kind === "remove") {
        return [
          buildAddedOrDeletedFilePatch({
            kind: "delete",
            path: change.path,
            content: change.diff ?? change.content ?? "",
          }),
        ];
      }

      if (!kind || STRUCTURED_FILE_CHANGE_UPDATE_KINDS.has(kind)) {
        const patch = buildUpdatedFilePatch(change);
        return patch ? [patch] : [];
      }

      const patch = buildUpdatedFilePatch(change);
      return patch ? [patch] : [];
    })
    .map((patch) => patch.trimEnd());

  return patches.length > 0 ? ensurePatchTrailingNewline(patches.join("\n")) : undefined;
}

export function renderablePatchFromBufferedOutput(value: string): string {
  const normalized = normalizePatchText(value).trim();
  if (
    normalized.length === 0 ||
    (!normalized.startsWith("diff --git ") && !/^--- [^\n]+\n\+\+\+ [^\n]+/s.test(normalized))
  ) {
    return "";
  }
  return ensurePatchTrailingNewline(normalized);
}

export function resolvedFileChangePatch(fileChange: PendingFileChangeState): string {
  return fileChange.exactPatch || renderablePatchFromBufferedOutput(fileChange.bufferedOutput);
}

export function compactFileChangeIdForLifecycleEvent(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
): OrchestrationFileChangeId | undefined {
  if (event.payload.itemType !== "file_change" || !event.itemId) {
    return undefined;
  }
  return fileChangeIdForRuntimeItem(event.threadId, event.itemId);
}

export function runtimePayloadRecord(
  event: ProviderRuntimeEvent,
): Record<string, unknown> | undefined {
  const payload = (event as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  return payload as Record<string, unknown>;
}

export function runtimeRawPayloadRecord(
  event: ProviderRuntimeEvent,
): Record<string, unknown> | undefined {
  const rawPayload = event.raw?.payload;
  if (!rawPayload || typeof rawPayload !== "object") {
    return undefined;
  }
  return rawPayload as Record<string, unknown>;
}

export function joinDiagnosticDetail(parts: ReadonlyArray<string | undefined>): string | undefined {
  const normalized = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part && part.length > 0));
  return normalized.length > 0 ? normalized.join("\n\n") : undefined;
}

export function hookRunRecord(event: ProviderRuntimeEvent): Record<string, unknown> | undefined {
  return asRecord(runtimeRawPayloadRecord(event)?.run);
}

export function hookEventNameFromEvent(event: ProviderRuntimeEvent): string | undefined {
  const payload = runtimePayloadRecord(event);
  return (
    asString(payload?.hookEvent) ??
    asString(payload?.hookName) ??
    asString(hookRunRecord(event)?.eventName)
  );
}

export function hookRawStatusFromEvent(event: ProviderRuntimeEvent): string | undefined {
  return asString(runtimePayloadRecord(event)?.rawStatus) ?? asString(hookRunRecord(event)?.status);
}

export function hookStatusMessageFromEvent(event: ProviderRuntimeEvent): string | undefined {
  return (
    asString(runtimePayloadRecord(event)?.statusMessage) ??
    asString(hookRunRecord(event)?.statusMessage)
  );
}

export function hookSourcePathFromEvent(event: ProviderRuntimeEvent): string | undefined {
  return (
    asString(runtimePayloadRecord(event)?.sourcePath) ?? asString(hookRunRecord(event)?.sourcePath)
  );
}

export function mcpStatusRecord(
  event: Extract<ProviderRuntimeEvent, { type: "mcp.status.updated" }>,
): Record<string, unknown> | undefined {
  return asRecord(event.payload.status);
}

export function runtimeErrorMessageFromEvent(event: ProviderRuntimeEvent): string | undefined {
  const payloadMessage = asString(runtimePayloadRecord(event)?.message);
  return payloadMessage;
}

/** Display shape that lets the work log render one local-time usage-limit row. */
export function usageLimitActivityPayload(
  event: ProviderRuntimeEvent,
  windowLabel: string | null,
  resetsAt: string | null,
): {
  provider: ProviderRuntimeEvent["provider"];
  windowLabel: string | null;
  resetsAt: string | null;
} {
  // Store the provider kind; the client looks up its current display name.
  return { provider: event.provider, windowLabel, resetsAt };
}

export function usageLimitFromRuntimeError(
  event: Extract<ProviderRuntimeEvent, { type: "runtime.error" }>,
) {
  const limit = event.payload.usageLimit;
  if (!limit) return undefined;
  const window =
    limit.windows.find((candidate) => candidate.label && candidate.resetsAt === limit.resetsAt) ??
    limit.windows.find((candidate) => candidate.label);
  return usageLimitActivityPayload(event, window?.label ?? null, limit.resetsAt);
}

export function usageLimitFromRuntimeWarning(
  event: Extract<ProviderRuntimeEvent, { type: "runtime.warning" }>,
) {
  const detail = asRecord(event.payload.detail);
  if (!detail || typeof detail.rateLimitType !== "string") return undefined;
  return usageLimitActivityPayload(
    event,
    asString(detail.windowLabel) ?? null,
    asString(detail.resetsAt) ?? null,
  );
}

export function orchestrationSessionStatusFromRuntimeState(
  state: "starting" | "running" | "waiting" | "ready" | "interrupted" | "stopped" | "error",
): "starting" | "running" | "ready" | "interrupted" | "stopped" | "error" {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "ready":
      return "ready";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

export function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
):
  | "command"
  | "file-read"
  | "file-change"
  | "permission"
  | "mcp-elicitation"
  | "unknown"
  | undefined {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    case "mcp_elicitation_approval":
      return "mcp-elicitation";
    case "permissions_approval":
      return "permission";
    default:
      return requestType === undefined ? undefined : "unknown";
  }
}

export function isTodoWriteToolName(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "todowrite";
}

export function todoWriteInputFromLifecycleEvent(
  event: ItemLifecycleRuntimeEvent,
): Record<string, unknown> | undefined {
  const data = asRecord(event.payload.data);
  if (!isTodoWriteToolName(data?.toolName)) {
    return undefined;
  }
  return asRecord(data?.input);
}

export function taskToolNameFromLifecycleEvent(
  event: ItemLifecycleRuntimeEvent,
): TaskToolName | undefined {
  const toolName = asRecord(event.payload.data)?.toolName;
  return isTaskToolName(toolName) ? toolName : undefined;
}

/** TodoWrite and native Task tool calls feed the task panel, not the work log. */
export function isTaskTrackingLifecycleEvent(event: ItemLifecycleRuntimeEvent): boolean {
  return (
    todoWriteInputFromLifecycleEvent(event) !== undefined ||
    taskToolNameFromLifecycleEvent(event) !== undefined
  );
}

export function taskToolLifecycleInput(
  event: ItemLifecycleRuntimeEvent,
  turnId: TurnId | null,
): TaskToolLifecycleInput | undefined {
  const toolName = taskToolNameFromLifecycleEvent(event);
  if (!toolName || !event.itemId) return undefined;
  if (event.type === "item.started") {
    return { phase: "started", nativeCallId: event.itemId, toolName, turnId };
  }
  if (event.type === "item.completed" && event.payload.completion) {
    return {
      phase: "completed",
      nativeCallId: event.payload.completion.nativeCallId,
      toolName,
      turnId,
      completion: event.payload.completion,
    };
  }
  if (event.type === "item.completed") {
    // Turn end, interrupt, and stop complete in-flight tools without a result.
    return { phase: "abandoned", nativeCallId: event.itemId, toolName, turnId };
  }
  return undefined;
}

/** Spilled Task tool outputs above this are left for the native log. */
export const MAX_TASK_TOOL_ARTIFACT_BYTES = 8 * 1024 * 1024;

export function attachmentIdBelongsToThread(attachmentId: string, threadId: ThreadId): boolean {
  const segment = parseThreadSegmentFromAttachmentId(attachmentId);
  return segment !== null && segment === toSafeThreadAttachmentSegment(threadId)?.toLowerCase();
}

/**
 * Whether a Task tool event belongs to a turn a revert discarded. Only threads
 * whose task tracking has seen a revert (generation > 0) are checked; a turn
 * is kept while it is active, latest, or still has messages or checkpoints.
 */
export function isDiscardedTaskToolTurn(
  thread: OrchestrationReadModel["threads"][number],
  turnId: TurnId | null,
): boolean {
  if (turnId === null || (thread.tasksTracking?.generation ?? 0) === 0) return false;
  return !(
    thread.session?.activeTurnId === turnId ||
    thread.latestTurn?.turnId === turnId ||
    thread.messages.some((message) => message.turnId === turnId) ||
    thread.checkpoints.some((checkpoint) => checkpoint.turnId === turnId)
  );
}

export function buildTodoTaskId(content: string, activeForm: string, occurrence: number): string {
  const slug = content
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const fingerprint = createHash("sha256")
    .update(`${content}\u0000${activeForm}`)
    .digest("hex")
    .slice(0, 12);
  return `todo:${slug.length > 0 ? slug : "task"}:${fingerprint}:${occurrence}`;
}

export function extractTodoWriteTasksFromLifecycleEvent(
  event: ItemLifecycleRuntimeEvent,
): ReadonlyArray<TaskItem> | undefined {
  const input = todoWriteInputFromLifecycleEvent(event);
  if (!input) {
    return undefined;
  }
  const todos = input.todos;
  if (!Array.isArray(todos)) {
    return undefined;
  }

  const occurrenceByKey = new Map<string, number>();
  const tasks: TaskItem[] = [];

  for (const todo of todos) {
    const record = asRecord(todo);
    const content = asString(record?.content)?.trim();
    const activeForm = asString(record?.activeForm)?.trim();
    const status = asString(record?.status);
    if (
      !content ||
      !activeForm ||
      (status !== "pending" && status !== "in_progress" && status !== "completed")
    ) {
      return undefined;
    }

    const taskKey = `${content}\u0000${activeForm}`;
    const occurrence = (occurrenceByKey.get(taskKey) ?? 0) + 1;
    occurrenceByKey.set(taskKey, occurrence);

    tasks.push({
      id: buildTodoTaskId(content, activeForm, occurrence),
      content,
      activeForm,
      status,
    });
  }

  return tasks;
}

export function shouldSuppressCollaborationUpdate(event: ItemLifecycleRuntimeEvent): boolean {
  if (event.payload.itemType !== "collab_agent_tool_call") {
    return false;
  }

  if (
    event.provider === "codex" &&
    readToolActivityPayload({
      itemType: event.payload.itemType,
      ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
    })?.codexCollaborationTool
  ) {
    return true;
  }

  const data = asRecord(event.payload.data);
  const subagentResult = asString(data?.subagentResult)?.trim();
  return Boolean(subagentResult && subagentResult.length > 0);
}

export function areTaskListsEqual(
  left: ReadonlyArray<TaskItem>,
  right: ReadonlyArray<TaskItem>,
): boolean {
  return (
    left.length === right.length &&
    left.every((task, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        task.id === other.id &&
        task.content === other.content &&
        task.activeForm === other.activeForm &&
        task.status === other.status
      );
    })
  );
}

export function buildCompactToolLifecyclePayload(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
  toolImages?: ToolImageRefs,
  computerEvidence = false,
) {
  const fileChangeId = compactFileChangeIdForLifecycleEvent(event);
  const normalizedTitle = commandExecutionLifecycleTitle(event);
  const computerTool =
    (computerEvidence ||
      automationEventSanitizer.isComputerItem(event.threadId, event.itemId ?? event.eventId)) &&
    computerToolHeading(
      readToolActivityPayload(event.payload)?.mcpToolName,
      event.payload.status,
    ) !== undefined;
  return {
    ...toolImages,
    ...(computerTool ? { computerTool: true } : {}),
    ...(computerTool && event.payload.computerStep
      ? { computerStep: event.payload.computerStep }
      : {}),
    itemType: event.payload.itemType,
    ...(event.itemId ? { providerItemId: event.itemId } : {}),
    ...(event.payload.status ? { status: event.payload.status } : {}),
    ...(normalizedTitle ? { title: normalizedTitle } : {}),
    ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
    ...(event.payload.requestKind ? { requestKind: event.payload.requestKind } : {}),
    ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
    // Persist the typed result once, on completion only.
    ...(event.type === "item.completed" && event.payload.completion
      ? { completion: event.payload.completion }
      : {}),
    ...(fileChangeId ? { fileChangeId } : {}),
  };
}

/** Screenshot references stored before compaction (see `extractLifecycleImages`). */
export interface ToolImageRefs {
  readonly mcpImages?: ReadonlyArray<ToolResultImageRef>;
  readonly mcpImagesOmitted?: number;
}

export function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
  toolImages?: ToolImageRefs,
  computerEvidence = isPreparedComputerEvent(event),
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = (() => {
    const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
    return eventWithSequence.sessionSequence !== undefined
      ? { sequence: eventWithSequence.sessionSequence }
      : {};
  })();
  switch (event.type) {
    case "session.configured": {
      const config = event.payload.config;
      if ("extensionStatuses" in config && Object.keys(config).length === 1) return [];
      const model =
        typeof config.model === "string" && config.model.trim().length > 0
          ? config.model.trim()
          : undefined;
      const claudeCodeVersion =
        typeof config.claude_code_version === "string" &&
        config.claude_code_version.trim().length > 0
          ? config.claude_code_version.trim()
          : undefined;
      const sessionId =
        typeof config.session_id === "string" && config.session_id.trim().length > 0
          ? config.session_id.trim()
          : undefined;
      const fastModeState =
        typeof config.fast_mode_state === "string" && config.fast_mode_state.trim().length > 0
          ? config.fast_mode_state.trim()
          : undefined;
      const fastModeDisabledReason =
        typeof config.fast_mode_disabled_reason === "string" &&
        config.fast_mode_disabled_reason.trim().length > 0
          ? config.fast_mode_disabled_reason.trim()
          : undefined;
      const effort =
        typeof config.effort === "string" && config.effort.trim().length > 0
          ? config.effort.trim()
          : undefined;
      const reasoning =
        typeof config.reasoning === "string" && config.reasoning.trim().length > 0
          ? config.reasoning.trim()
          : undefined;
      const contextWindow =
        typeof config.context_window === "string" && config.context_window.trim().length > 0
          ? config.context_window.trim()
          : undefined;
      const thinkingState =
        typeof config.thinking_state === "string" && config.thinking_state.trim().length > 0
          ? config.thinking_state.trim()
          : undefined;
      const outputStyle =
        typeof config.output_style === "string" && config.output_style.trim().length > 0
          ? config.output_style.trim()
          : undefined;
      const instructionProfile = readInstructionProfile(config[INSTRUCTION_PROFILE_CONFIG_KEY]);
      const instructionContractVersion = instructionProfile?.contractVersion;
      const instructionSupplementVersion = instructionProfile?.providerSupplementVersion;
      const instructionStrategy = instructionProfile?.strategy;

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.configured",
          summary: "Runtime configured",
          payload: compactThreadActivityPayload({
            kind: "runtime.configured",
            payload: {
              ...(model ? { model } : {}),
              ...(claudeCodeVersion ? { claudeCodeVersion } : {}),
              ...(sessionId ? { sessionId } : {}),
              ...(fastModeState ? { fastModeState } : {}),
              ...(fastModeDisabledReason ? { fastModeDisabledReason } : {}),
              ...(effort ? { effort } : {}),
              ...(reasoning ? { reasoning } : {}),
              ...(contextWindow ? { contextWindow } : {}),
              ...(thinkingState ? { thinkingState } : {}),
              ...(outputStyle ? { outputStyle } : {}),
              ...(instructionContractVersion ? { instructionContractVersion } : {}),
              ...(instructionSupplementVersion ? { instructionSupplementVersion } : {}),
              ...(instructionStrategy ? { instructionStrategy } : {}),
              config,
            },
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "request.opened": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.requested",
          summary:
            requestKind === "command"
              ? "Command approval requested"
              : requestKind === "file-read"
                ? "File-read approval requested"
                : requestKind === "file-change"
                  ? "File-change approval requested"
                  : requestKind === "permission"
                    ? "Permission approval requested"
                    : requestKind === "mcp-elicitation"
                      ? `App access requested: ${event.payload.appName ?? "MCP app"}`
                      : `Unknown approval requested (${event.payload.requestType})`,
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.appName ? { appName: event.payload.appName } : {}),
            ...(event.payload.approvalOptions
              ? { approvalOptions: event.payload.approvalOptions }
              : {}),
            ...(event.payload.presentation ? { presentation: event.payload.presentation } : {}),
            ...(event.payload.detail
              ? { detail: truncateApprovalDetail(event.payload.detail) }
              : {}),
            ...(event.payload.requestedPermissions
              ? { requestedPermissions: event.payload.requestedPermissions }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "request.resolved": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.decision ? { decision: event.payload.decision } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "hook.started": {
      const hookEvent = hookEventNameFromEvent(event);
      if (!hookEvent) {
        return [];
      }
      const statusMessage = hookStatusMessageFromEvent(event);
      const sourcePath = hookSourcePathFromEvent(event);
      const run = hookRunRecord(event);

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "hook.started",
          summary: `Running ${hookEvent} hook${statusMessage ? `: ${statusMessage}` : ""}`,
          payload: {
            hookId: event.payload.hookId,
            hookName: event.payload.hookName,
            hookEvent,
            ...(event.payload.targetItemId ? { providerItemId: event.payload.targetItemId } : {}),
            ...(event.payload.handlerType ? { handlerType: event.payload.handlerType } : {}),
            ...(event.payload.executionMode ? { executionMode: event.payload.executionMode } : {}),
            ...(event.payload.scope ? { scope: event.payload.scope } : {}),
            ...((event.payload.source ?? asString(run?.source))
              ? { source: event.payload.source ?? asString(run?.source) }
              : {}),
            ...(statusMessage ? { statusMessage } : {}),
            ...(sourcePath ? { sourcePath } : {}),
            ...((event.payload.displayOrder ?? asNonNegativeNumber(run?.displayOrder)) !== undefined
              ? {
                  displayOrder:
                    event.payload.displayOrder ?? asNonNegativeNumber(run?.displayOrder),
                }
              : {}),
            ...((event.payload.startedAt ?? asNonNegativeNumber(run?.startedAt)) !== undefined
              ? { startedAt: event.payload.startedAt ?? asNonNegativeNumber(run?.startedAt) }
              : {}),
            ...(sourcePath ? { detail: `Source: ${sourcePath}` } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "hook.completed": {
      const hookEvent = hookEventNameFromEvent(event) ?? event.payload.hookId;
      const rawStatus = hookRawStatusFromEvent(event) ?? event.payload.outcome;
      const appliedOutputReplacement =
        event.payload.outcome === "success" && rawStatus === "stopped";
      const run = hookRunRecord(event);
      const sourcePath = event.payload.sourcePath ?? hookSourcePathFromEvent(event);
      const statusMessage = event.payload.statusMessage ?? hookStatusMessageFromEvent(event);
      const entries = boundHookDiagnosticEntries(event.payload.entries);
      const output = event.payload.output
        ? truncateHookDiagnosticText(event.payload.output)
        : undefined;
      const stdout = event.payload.stdout
        ? truncateHookDiagnosticText(event.payload.stdout)
        : undefined;
      const stderr = event.payload.stderr
        ? truncateHookDiagnosticText(event.payload.stderr)
        : undefined;

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.outcome === "error" ? "error" : "info",
          kind: "hook.completed",
          summary: appliedOutputReplacement
            ? `${hookEvent} hook applied output replacement`
            : `${hookEvent} hook (${rawStatus})`,
          payload: {
            hookId: event.payload.hookId,
            ...(event.payload.hookName ? { hookName: event.payload.hookName } : {}),
            hookEvent,
            outcome: event.payload.outcome,
            rawStatus,
            // The instance that ran the hook, so its diagnostics link to the right inventory.
            ...(event.providerInstanceId ? { providerInstanceId: event.providerInstanceId } : {}),
            ...(event.payload.targetItemId ? { providerItemId: event.payload.targetItemId } : {}),
            ...(event.payload.handlerType ? { handlerType: event.payload.handlerType } : {}),
            ...(event.payload.executionMode ? { executionMode: event.payload.executionMode } : {}),
            ...(event.payload.scope ? { scope: event.payload.scope } : {}),
            ...((event.payload.source ?? asString(run?.source))
              ? { source: event.payload.source ?? asString(run?.source) }
              : {}),
            ...(sourcePath ? { sourcePath } : {}),
            ...((event.payload.displayOrder ?? asNonNegativeNumber(run?.displayOrder)) !== undefined
              ? {
                  displayOrder:
                    event.payload.displayOrder ?? asNonNegativeNumber(run?.displayOrder),
                }
              : {}),
            ...(statusMessage ? { statusMessage } : {}),
            ...((event.payload.startedAt ?? asNonNegativeNumber(run?.startedAt)) !== undefined
              ? { startedAt: event.payload.startedAt ?? asNonNegativeNumber(run?.startedAt) }
              : {}),
            ...((event.payload.completedAt ?? asNonNegativeNumber(run?.completedAt)) !== undefined
              ? {
                  completedAt: event.payload.completedAt ?? asNonNegativeNumber(run?.completedAt),
                }
              : {}),
            ...((event.payload.durationMs ?? asNonNegativeNumber(run?.durationMs)) !== undefined
              ? {
                  durationMs: event.payload.durationMs ?? asNonNegativeNumber(run?.durationMs),
                }
              : {}),
            ...(entries ? { entries } : {}),
            ...(output ? { output } : {}),
            ...(stdout ? { stdout } : {}),
            ...(stderr ? { stderr } : {}),
            ...(event.payload.exitCode !== undefined ? { exitCode: event.payload.exitCode } : {}),
            ...(output
              ? { detail: truncateDetail(output) }
              : statusMessage
                ? { detail: statusMessage }
                : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "approval-review.started": {
      const actionLabel = event.payload.actionType ? ` ${event.payload.actionType}` : " approval";
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "approval-review.started",
          summary: `Reviewing${actionLabel}`,
          payload: {
            reviewId: event.payload.reviewId,
            status: event.payload.status,
            ...(event.payload.targetItemId ? { providerItemId: event.payload.targetItemId } : {}),
            ...(event.payload.actionType ? { actionType: event.payload.actionType } : {}),
            ...(event.payload.riskLevel ? { riskLevel: event.payload.riskLevel } : {}),
            ...(event.payload.userAuthorization
              ? { userAuthorization: event.payload.userAuthorization }
              : {}),
            ...(event.payload.rationale ? { rationale: event.payload.rationale } : {}),
            ...(event.payload.startedAtMs !== undefined
              ? { startedAtMs: event.payload.startedAtMs }
              : {}),
            ...(event.payload.action !== undefined ? { action: event.payload.action } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "approval-review.completed": {
      const status = event.payload.status;
      const actionLabel = event.payload.actionType ?? "approval";
      const statusLabel =
        status === "approved"
          ? "approved"
          : status === "timedOut"
            ? "timed out"
            : status === "inProgress"
              ? "in progress"
              : status;
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: status === "approved" ? "info" : "error",
          kind: "approval-review.completed",
          summary: `${actionLabel} review ${statusLabel}`,
          payload: {
            reviewId: event.payload.reviewId,
            status,
            ...(event.payload.targetItemId ? { providerItemId: event.payload.targetItemId } : {}),
            ...(event.payload.actionType ? { actionType: event.payload.actionType } : {}),
            ...(event.payload.riskLevel ? { riskLevel: event.payload.riskLevel } : {}),
            ...(event.payload.userAuthorization
              ? { userAuthorization: event.payload.userAuthorization }
              : {}),
            ...(event.payload.rationale
              ? { rationale: event.payload.rationale, detail: event.payload.rationale }
              : {}),
            ...(event.payload.decisionSource
              ? { decisionSource: event.payload.decisionSource }
              : {}),
            ...(event.payload.startedAtMs !== undefined
              ? { startedAtMs: event.payload.startedAtMs }
              : {}),
            ...(event.payload.completedAtMs !== undefined
              ? { completedAtMs: event.payload.completedAtMs }
              : {}),
            ...(event.payload.durationMs !== undefined
              ? { durationMs: event.payload.durationMs }
              : {}),
            ...(event.payload.action !== undefined ? { action: event.payload.action } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "subagent.activity": {
      const kindLabel = event.payload.kind;
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "subagent.activity",
          summary: `Subagent ${kindLabel}`,
          payload: {
            itemType: "collab_agent_tool_call",
            ...(event.itemId ? { providerItemId: event.itemId } : {}),
            title: `Subagent ${kindLabel}`,
            subagentType: event.payload.kind,
            subagentThreadId: event.payload.agentThreadId,
            subagentPath: event.payload.agentPath,
            ...(event.payload.model ? { subagentModel: event.payload.model } : {}),
            ...(event.payload.reasoningEffort
              ? { reasoningEffort: event.payload.reasoningEffort }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "mcp.status.updated": {
      const statusRecord = mcpStatusRecord(event);
      const name = asString(statusRecord?.name);
      const status = asString(statusRecord?.status) ?? "updated";
      const error = asString(statusRecord?.error);

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: status === "failed" ? "error" : "info",
          kind: "mcp.status.updated",
          summary: name ? `MCP server ${name}: ${status}` : `MCP server status: ${status}`,
          payload: {
            ...(name ? { name } : {}),
            status,
            ...(error ? { error, detail: error } : {}),
            ...(event.payload.status.toolCount !== undefined
              ? { toolCount: event.payload.status.toolCount }
              : {}),
            ...(event.payload.status.providerInstanceId
              ? { providerInstanceId: event.payload.status.providerInstanceId }
              : {}),
            ...(event.payload.status.sessionGeneration !== undefined
              ? { sessionGeneration: event.payload.status.sessionGeneration }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "mcp.oauth.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.success ? "info" : "error",
          kind: "mcp.oauth.completed",
          summary: event.payload.name
            ? `MCP OAuth completed for ${event.payload.name}`
            : "MCP OAuth completed",
          payload: {
            success: event.payload.success,
            ...(event.payload.name ? { name: event.payload.name } : {}),
            ...(event.payload.error
              ? { error: event.payload.error, detail: event.payload.error }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "config.warning": {
      const detail = joinDiagnosticDetail([
        event.payload.details,
        event.payload.path ? `Path: ${event.payload.path}` : undefined,
      ]);

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "config.warning",
          summary: event.payload.summary,
          payload: {
            summary: event.payload.summary,
            ...(event.payload.details ? { details: event.payload.details } : {}),
            ...(event.payload.path ? { path: event.payload.path } : {}),
            ...(detail ? { detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "deprecation.notice": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "deprecation.notice",
          summary: event.payload.summary,
          payload: {
            summary: event.payload.summary,
            ...(event.payload.details
              ? { details: event.payload.details, detail: event.payload.details }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "account.updated": {
      return [];
    }

    case "account.rate-limits.updated": {
      return [];
    }

    case "auth.status": {
      if (!event.payload.error) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "auth.status",
          summary: "Account login failed",
          payload: {
            message: event.payload.error,
            detail: event.payload.error,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.state.changed": {
      if (event.payload.state !== "error") {
        return [];
      }
      const detail = asRecord(event.payload.detail);
      const message =
        asString(detail?.message) ??
        asString(asRecord(detail?.error)?.message) ??
        "Codex thread reported a system error";
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.warning",
          summary: "Provider thread error",
          payload: {
            message,
            category: "provider",
            actionable: true,
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.error": {
      const message = runtimeErrorMessageFromEvent(event);
      if (!message) {
        return [];
      }
      const usageLimit = usageLimitFromRuntimeError(event);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Runtime error",
          payload: {
            message: truncateDetail(message),
            ...(usageLimit ? { usageLimit } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.warning": {
      const usageLimit = usageLimitFromRuntimeWarning(event);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone:
            event.payload.category === "guardian" || event.payload.category === "verification"
              ? "error"
              : "info",
          kind: "runtime.warning",
          summary:
            event.payload.category === "guardian"
              ? "Guardian warning"
              : event.payload.category === "verification"
                ? "Verification required"
                : event.payload.category === "protocol"
                  ? "Protocol warning"
                  : typeof asRecord(event.payload.detail)?.noticeTitle === "string"
                    ? String(asRecord(event.payload.detail)!.noticeTitle)
                    : "Runtime warning",
          payload: {
            message: event.payload.message,
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
            ...(event.payload.category ? { category: event.payload.category } : {}),
            ...(event.payload.actionable !== undefined
              ? { actionable: event.payload.actionable }
              : {}),
            ...(event.payload.protocolMethod
              ? { protocolMethod: event.payload.protocolMethod }
              : {}),
            ...(event.payload.protocolValue ? { protocolValue: event.payload.protocolValue } : {}),
            ...(usageLimit ? { usageLimit } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "model.rerouted": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.model-rerouted",
          summary: "Model rerouted",
          payload: {
            fromModel: event.payload.fromModel,
            toModel: event.payload.toModel,
            reason: event.payload.reason,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.plan.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.plan.updated",
          summary: "Plan updated",
          payload: {
            plan: event.payload.plan,
            ...(event.payload.explanation !== undefined
              ? { explanation: event.payload.explanation }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "compaction.recommended": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "thread.compaction.recommended",
          summary: "Conversation compaction recommended",
          payload: {
            estimatedTokens: event.payload.estimatedTokens,
            thresholdTokens: event.payload.thresholdTokens,
            modelContextWindowTokens: event.payload.modelContextWindowTokens,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.requested": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.requested",
          summary: event.payload.elicitation
            ? event.payload.elicitation.mode === "url"
              ? "Provider asked to open a link"
              : "Provider asked for form input"
            : "User input requested",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
            ...(event.payload.elicitation ? { elicitation: event.payload.elicitation } : {}),
            ...(event.payload.responseMode ? { responseMode: event.payload.responseMode } : {}),
            ...(event.payload.blocking === false ? { blocking: false } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.resolved": {
      const receipt = event.payload.receipt;
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: receipt === "indeterminate" ? "error" : "info",
          kind: "user-input.resolved",
          summary:
            receipt === "resolved"
              ? "Provider received the requested input"
              : receipt === "cancelled"
                ? "Input request cancelled"
                : receipt === "indeterminate"
                  ? "Input delivery could not be confirmed"
                  : "User input submitted",
          // Elicitation receipts are value-free by construction: answers stay out.
          payload: receipt
            ? { ...(event.requestId ? { requestId: event.requestId } : {}), receipt }
            : {
                ...(event.requestId ? { requestId: event.requestId } : {}),
                answers: event.payload.answers,
              },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.started": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.started",
          summary:
            event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.runId ? { runId: event.payload.runId } : {}),
            ...(event.payload.model ? { model: event.payload.model } : {}),
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      const displayHints = deriveNarratedActivityDisplayHints(event.payload.description);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.progress",
          summary: "Reasoning update",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.runId ? { runId: event.payload.runId } : {}),
            ...(event.payload.model ? { model: event.payload.model } : {}),
            detail: truncateDetail(event.payload.description),
            ...(displayHints?.readPaths && displayHints.readPaths.length > 0
              ? { readPaths: [...displayHints.readPaths] }
              : {}),
            ...(displayHints?.lineSummary ? { lineSummary: displayHints.lineSummary } : {}),
            ...(displayHints?.searchSummary ? { searchSummary: displayHints.searchSummary } : {}),
            ...(event.payload.lastToolName ? { lastToolName: event.payload.lastToolName } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.completed",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.runId ? { runId: event.payload.runId } : {}),
            status: event.payload.status,
            ...(event.payload.summary ? { detail: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.updated": {
      if (isTaskTrackingLifecycleEvent(event)) {
        return [];
      }
      if (shouldSuppressCollaborationUpdate(event)) {
        return [];
      }
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      const normalizedTitle = commandExecutionLifecycleTitle(event);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone:
            event.payload.status === "failed" || event.payload.status === "declined"
              ? "error"
              : "tool",
          kind: "tool.updated",
          summary: normalizedTitle ?? "Tool updated",
          payload: compactThreadActivityPayload({
            kind: "tool.updated",
            payload: buildCompactToolLifecyclePayload(event, toolImages, computerEvidence),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.completed": {
      if (isTaskTrackingLifecycleEvent(event)) {
        return [];
      }
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      const normalizedTitle = commandExecutionLifecycleTitle(event);
      const data = asRecord(event.payload.data);
      const native = asRecord(data?.item);
      // Codex names the server and tool on its native item. Claude's adapter adds the
      // configured names, since `mcp__<server>__<tool>` carries sanitized ones.
      const claudeAppTool = asRecord(data?.mcpAppTool);
      const appTool =
        event.provider === "codex" &&
        native &&
        typeof native.server === "string" &&
        typeof native.tool === "string"
          ? { server: native.server, tool: native.tool }
          : event.provider === "claudeAgent" &&
              typeof claudeAppTool?.server === "string" &&
              typeof claudeAppTool.tool === "string"
            ? { server: claudeAppTool.server, tool: claudeAppTool.tool }
            : null;
      const reference = appTool
        ? readMcpAppReferenceForTool(data?.mcpApp, appTool.server, appTool.tool)
        : undefined;
      const bootstrap = asRecord(data?.mcpAppBootstrap);
      const initialResult = readMcpAppToolResult(bootstrap?.result);
      const initial =
        reference && initialResult
          ? stringifyWithinBytes(
              { arguments: asRecord(bootstrap?.arguments) ?? {}, result: initialResult },
              192 * 1024,
            )
          : undefined;

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone:
            event.payload.status === "failed" || event.payload.status === "declined"
              ? "error"
              : "tool",
          kind: "tool.completed",
          summary: normalizedTitle ?? "Tool",
          payload: compactThreadActivityPayload({
            kind: "tool.completed",
            payload: buildCompactToolLifecyclePayload(event, toolImages, computerEvidence),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
        ...(reference && initial
          ? [
              {
                id: EventId.makeUnsafe(`${event.eventId}:mcp-app`),
                createdAt: event.createdAt,
                tone: "tool" as const,
                kind: "mcpApp",
                summary: reference.tool,
                payload: { reference, ...(JSON.parse(initial) as Record<string, unknown>) },
                turnId: toTurnId(event.turnId) ?? null,
                ...maybeSequence,
              },
            ]
          : []),
      ];
    }

    case "item.started": {
      if (isTaskTrackingLifecycleEvent(event)) {
        return [];
      }
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      const normalizedTitle = commandExecutionLifecycleTitle(event);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.started",
          summary: `${normalizedTitle ?? "Tool"} started`,
          payload: compactThreadActivityPayload({
            kind: "tool.started",
            payload: buildCompactToolLifecyclePayload(event, toolImages, computerEvidence),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    default:
      break;
  }

  return [];
}
