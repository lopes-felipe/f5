import { recoverRestartBackgroundWork } from "../../nextTurnQueue/restartMarkerCapture.ts";
import { readMcpAppReferenceForTool, readMcpAppToolResult } from "@t3tools/shared/mcpApp";
import { stringifyWithinBytes } from "@t3tools/shared/boundedJson";
import { LosslessCommandAdmission } from "../commandAdmission.ts";
import { startTerminalReceiptRetries } from "../terminalReceiptRecovery.ts";
import { PerformanceStageProbe } from "../../observability/Metrics.ts";
import { registerShutdown, AcceptedShutdownWork } from "../../shutdown.ts";
import { tryWithProviderThreadAccess } from "../../provider/providerThreadAccess.ts";
import { readPersistedSessionGeneration } from "../../provider/sessionCapabilities.ts";
import { CodexMcpEventBus } from "../../codex/CodexMcpEventBus.ts";
import { isPreparedComputerEvent } from "../../provider/prepareAutomationRuntimeEvent";
import { computerToolHeading } from "@t3tools/shared/computerAction";
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
import { readProjectSettings } from "../../project/projectSettings";
import { createHash } from "node:crypto";
import * as NodeFs from "node:fs/promises";

import { ServerConfig } from "../../config.ts";
import {
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../../attachmentPaths.ts";
import {
  ApprovalRequestId,
  type AssistantDeliveryMode,
  CommandId,
  ProviderInstanceId,
  EventId,
  MessageId,
  OrchestrationCommandExecutionId,
  type OrchestrationCommandExecutionStatus,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  OrchestrationFileChangeId,
  type OrchestrationFileChangeStatus,
  type OrchestrationProposedPlanId,
  ProviderItemId,
  CheckpointRef,
  isToolLifecycleItemType,
  type TaskItem,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  type ProviderSessionCapabilities,
  type OrchestrationUsageLimit,
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
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { enqueueBackgroundWork, makeBackgroundWorker } from "../../backgroundWorker.ts";
import { isBlockingUserInput } from "@t3tools/shared/pendingUserInputs";
import { reconcileElicitationsOnStartup } from "../elicitationSubmission.ts";
import {
  deriveNarratedActivityDisplayHints,
  deriveSearchCommandSummary,
  isGenericCommandTitle,
} from "@t3tools/shared/commandSummary";
import {
  compactThreadActivityPayload,
  readToolActivityPayload,
  REASONING_STATUS_ACTIVITY_KIND,
} from "@t3tools/shared/orchestrationActivityPayload";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { isSyntheticClaudeThreadId, isUuid } from "../../provider/claudeResumeState.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import {
  makeOrphanedSessionExitedEvent,
  PROVIDER_SHUTDOWN_RUNTIME_EVENTS,
  readPersistedActiveTurnId,
  readPersistedLastRuntimeEvent,
  readPersistedLastRuntimeEventAt,
} from "../../provider/orphanedTurnRecovery.ts";
import { readPersistedInstructionContext } from "../../provider/runtimePayload.ts";
import {
  INSTRUCTION_PROFILE_CONFIG_KEY,
  readInstructionProfile,
} from "../../provider/sharedAssistantContract.ts";
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
  isTaskToolName,
  reduceTaskToolLifecycle,
  type TaskToolLifecycleInput,
  type TaskToolName,
} from "@t3tools/shared/claudeTaskToolProjection";
import { ThreadBackgroundWork } from "../Services/ThreadBackgroundWork.ts";
import { increment, providerProjectionWriteFailuresTotal } from "../../observability/Metrics.ts";
import {
  extractContextTokens,
  extractTurnCompletedContextTokens,
  makeCompletedTurnUsageFact,
  makeTurnCompletedSessionSetCommand,
  mergeProviderReportedContextTokens,
  providerCommandId,
  runtimeTurnErrorMessage,
  runtimeTurnState,
} from "../providerTerminalLifecycle.ts";

/** Equal snapshots differ only in when they were taken. */
function sameSessionCapabilities(
  left: ProviderSessionCapabilities | null,
  right: ProviderSessionCapabilities | null,
): boolean {
  if (left === null || right === null) return left === right;
  const { checkedAt: _leftCheckedAt, ...leftRest } = left;
  const { checkedAt: _rightCheckedAt, ...rightRest } = right;
  return JSON.stringify(leftRest) === JSON.stringify(rightRest);
}

const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;

interface ReasoningStatusEntry {
  readonly providerItemId: string | null;
  readonly state: "active" | "idle";
  readonly detail: string | null;
  readonly sequence: number | undefined;
  readonly createdAt: string;
  /** Summary text scanned for a heading, per summary part; `null` once done. */
  readonly headingParts: Readonly<Record<string, string | null>>;
}

interface ReasoningSection {
  readonly key: string;
  /** The streamed message that last received this turn's reasoning, if any. */
  readonly messageId: MessageId | null;
}

/**
 * The decider rejected the command outright (for example, a delta for a
 * message it already closed). Retrying cannot succeed, so taken text is not
 * restored: it would otherwise land on the next message.
 */
function isPermanentDispatchRejection(cause: Cause.Cause<unknown>): boolean {
  const error = Cause.squash(cause) as { readonly _tag?: unknown } | null;
  return (
    error?._tag === "OrchestrationCommandInvariantError" ||
    error?._tag === "OrchestrationCommandPreviouslyRejectedError"
  );
}

function reasoningStatusActivityId(threadId: ThreadId, turnId: TurnId): EventId {
  return EventId.make(`reasoning-status:${threadId}:${turnId}`);
}

/** Rebuilds the cached status from the persisted record, e.g. after a restart. */
function restoreReasoningStatusEntry(
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

function eventSessionSequence(event: ProviderRuntimeEvent): number | undefined {
  return (event as ProviderRuntimeEvent & { sessionSequence?: number }).sessionSequence;
}

const DEFAULT_ASSISTANT_DELIVERY_MODE: AssistantDeliveryMode = "buffered";
const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;
const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
const BUFFERED_REASONING_TEXT_BY_TURN_KEY_CACHE_CAPACITY = 10_000;
const BUFFERED_REASONING_TEXT_BY_TURN_KEY_TTL = Duration.minutes(120);
const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000;
const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);
const LAST_THINKING_TOKENS_BY_THREAD_CACHE_CAPACITY = 10_000;
const LAST_THINKING_TOKENS_BY_THREAD_TTL = Duration.minutes(120);
const REASONING_STATUS_BY_TURN_KEY_CACHE_CAPACITY = 10_000;
const REASONING_STATUS_BY_TURN_KEY_TTL = Duration.minutes(120);
const REASONING_SECTION_BY_TURN_KEY_CACHE_CAPACITY = 10_000;
const REASONING_SECTION_BY_TURN_KEY_TTL = Duration.minutes(120);
// A summary part that has not produced a `**Heading**` within this many
// characters never will; stop scanning it.
const REASONING_HEADING_SCAN_CHARS = 400;
const REASONING_HEADING_REGEX = /^\s*\*\*([^*\n]{1,200}?)\*\*/;
// Live `thinking_tokens` frames arrive at high frequency. Coalesce them so the
// event store only sees a bounded number of `thread.session.set` dispatches per
// turn: dispatch only when the running estimate grows by at least this many
// tokens since the last dispatch (or when it drops, signalling a new thinking
// block within the same turn).
const THINKING_TOKENS_DISPATCH_THRESHOLD = 500;
const PROFILED_WORKFLOW_TURN_TIMEOUT_MS = 30 * 60 * 1_000;
// Tool items that never complete are evicted oldest first past this many.
const MAX_TRACKED_TOOL_UPDATES = 512;
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
const MAX_BUFFERED_REASONING_CHARS = 200_000;
const COMMAND_OUTPUT_FLUSH_INTERVAL_MS = 100;
const COMMAND_OUTPUT_BUFFER_FLUSH_BYTES = 4 * 1024;
// File-change output (unlike command output) is not flushed incrementally; it
// accumulates in `pendingFileChanges` until the change finalizes. Bound it so a
// single huge write cannot grow the buffer without limit. The resolved patch is
// normally sourced from a structured `exactPatch`; this buffer is only a
// fallback, so head+tail truncation with a visible marker is safe.
const MAX_FILE_CHANGE_OUTPUT_BYTES = 1024 * 1024;
const FILE_CHANGE_OUTPUT_HEAD_BYTES = 512 * 1024;
const FILE_CHANGE_OUTPUT_TRUNCATION_MARKER =
  "\n\n[... file change output truncated; middle omitted ...]\n\n";
// Only re-truncate once the buffer grows past this slack threshold (then back
// down to MAX_FILE_CHANGE_OUTPUT_BYTES). This keeps memory bounded while
// amortizing the truncation cost across many small deltas instead of
// re-scanning/allocating the whole buffer on every delta.
const FILE_CHANGE_OUTPUT_TRUNCATE_THRESHOLD_BYTES = 2 * MAX_FILE_CHANGE_OUTPUT_BYTES;
const MAX_HOOK_DIAGNOSTIC_TEXT_BYTES = 64 * 1024;
const HOOK_DIAGNOSTIC_TEXT_HEAD_BYTES = 48 * 1024;
const HOOK_DIAGNOSTIC_TEXT_TRUNCATION_MARKER =
  "\n\n[... hook diagnostic output truncated; middle omitted ...]\n\n";
const MAX_APPROVAL_DETAIL_BYTES = 32 * 1024;
const APPROVAL_DETAIL_HEAD_BYTES = 24 * 1024;
const APPROVAL_DETAIL_TRUNCATION_MARKER =
  "\n\n[... approval detail truncated; middle omitted ...]\n\n";
const MAX_HOOK_DIAGNOSTIC_ENTRIES = 32;
const MAX_HOOK_DIAGNOSTIC_ENTRY_BYTES = 16 * 1024;
const MAX_HOOK_DIAGNOSTIC_ENTRIES_BYTES = 64 * 1024;
const STRICT_PROVIDER_LIFECYCLE_GUARD = process.env.T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";

type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;
type ItemLifecycleRuntimeEvent = Extract<
  ProviderRuntimeEvent,
  { type: "item.started" | "item.updated" | "item.completed" }
>;

type RuntimeIngestionInput =
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
    };

interface OpenCommandExecutionState {
  readonly id: OrchestrationCommandExecutionId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly providerItemId: ProviderItemId;
  readonly command: string;
  cwd: string | undefined;
  title: string | null;
  detail: string | null;
  status: OrchestrationCommandExecutionStatus;
  exitCode: number | null;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
  bufferedOutput: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

interface PendingCommandExecutionOutputState {
  bufferedOutput: string;
  updatedAt: string;
}

interface PendingFileChangeState {
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

function clearCommandExecutionFlushTimer(commandExecution: OpenCommandExecutionState) {
  if (commandExecution.flushTimer !== null) {
    clearTimeout(commandExecution.flushTimer);
    commandExecution.flushTimer = null;
  }
}

function laterIsoTimestamp(left: string, right: string): string {
  return left >= right ? left : right;
}

function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.makeUnsafe(String(value));
}

function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.makeUnsafe(value);
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function truncateApprovalDetail(value: string): string {
  return truncateMiddleByBytes(value, {
    maxBytes: MAX_APPROVAL_DETAIL_BYTES,
    headBytes: APPROVAL_DETAIL_HEAD_BYTES,
    marker: APPROVAL_DETAIL_TRUNCATION_MARKER,
  }).output;
}

function truncateHookDiagnosticText(value: string): string {
  return truncateMiddleByBytes(value, {
    maxBytes: MAX_HOOK_DIAGNOSTIC_TEXT_BYTES,
    headBytes: HOOK_DIAGNOSTIC_TEXT_HEAD_BYTES,
    marker: HOOK_DIAGNOSTIC_TEXT_TRUNCATION_MARKER,
  }).output;
}

function serializeDiagnosticEntry(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function hookDiagnosticEntryPreview(serialized: string): Record<string, unknown> {
  return {
    truncated: true,
    preview: truncateMiddleByBytes(serialized, {
      maxBytes: MAX_HOOK_DIAGNOSTIC_ENTRY_BYTES - 256,
      headBytes: 12 * 1024,
      marker: "\n[... diagnostic entry truncated ...]\n",
    }).output,
  };
}

function boundHookDiagnosticEntries(
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

function normalizeProposedPlanMarkdown(planMarkdown: string | undefined): string | undefined {
  const trimmed = planMarkdown?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function capBufferedReasoningText(value: string): string {
  if (value.length <= MAX_BUFFERED_REASONING_CHARS) {
    return value;
  }
  return value.slice(-MAX_BUFFERED_REASONING_CHARS);
}

function proposedPlanIdForTurn(threadId: ThreadId, turnId: TurnId): string {
  return `plan:${threadId}:turn:${turnId}`;
}

function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): string {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    return proposedPlanIdForTurn(threadId, turnId);
  }
  if (event.itemId) {
    return `plan:${threadId}:item:${event.itemId}`;
  }
  return `plan:${threadId}:event:${event.eventId}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asTrimmedNonEmptyString(value: unknown): string | undefined {
  const candidate = asString(value)?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function extractThreadTokenUsageContextTokens(usage: unknown): number | undefined {
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

function nextResumeCursorFromThreadStartedEvent(
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

function normalizeCommandValue(value: unknown): string | undefined {
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

function normalizeLifecycleCommandExecutionTitle(
  title: string | undefined,
  command: string,
): string | undefined {
  if (!title) {
    return undefined;
  }
  // Providers use generic titles like "Ran command" for shell fallbacks. When
  // that happens we replace the placeholder with a derived search summary, but
  // preserve any provider-authored specific title verbatim.
  return isGenericCommandTitle(title) ? (deriveSearchCommandSummary(command) ?? title) : title;
}

function extractCommandExecutionCommand(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
): string {
  const data = asRecord(event.payload.data);
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const payloadTitle =
    typeof event.payload.title === "string" && !isGenericCommandTitle(event.payload.title)
      ? event.payload.title
      : undefined;
  return (
    normalizeCommandValue(item?.command) ??
    normalizeCommandValue(itemInput?.command) ??
    normalizeCommandValue(itemResult?.command) ??
    normalizeCommandValue(data?.command) ??
    event.payload.detail ??
    payloadTitle ??
    event.payload.title ??
    "[command unavailable]"
  );
}

function commandExecutionLifecycleTitle(
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

function extractCommandExecutionCwd(
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

function parseExitCodeFromDetail(detail: string | undefined): number | null {
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

function extractCommandExecutionExitCode(
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
  return parseExitCodeFromDetail(event.payload.detail);
}

function commandExecutionStatusFromLifecycleEvent(
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

function commandExecutionIdForRuntimeItem(
  threadId: ThreadId,
  itemId: string,
): OrchestrationCommandExecutionId {
  return OrchestrationCommandExecutionId.makeUnsafe(`cmdexec:${threadId}:${itemId}`);
}

function fileChangeIdForRuntimeItem(threadId: ThreadId, itemId: string): OrchestrationFileChangeId {
  return OrchestrationFileChangeId.makeUnsafe(`filechange:${threadId}:${itemId}`);
}

function fileChangeStatusFromLifecycleEvent(
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

function extractFileChangePreview(
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

interface StructuredFileChangePatchInput {
  readonly path: string;
  readonly kind?: string;
  readonly movePath?: string;
  readonly diff?: string;
  readonly content?: string;
}

function normalizePatchText(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function ensurePatchTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function splitPatchContentLines(value: string): {
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

function formatUnifiedRange(start: number, count: number): string {
  if (count === 0) {
    return `${start},0`;
  }
  return count === 1 ? `${start}` : `${start},${count}`;
}

function normalizeGitDiffPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function hasUnifiedDiffFileHeaders(value: string): boolean {
  return /^--- [^\n]+\n\+\+\+ [^\n]+(?:\n|$)/.test(value);
}

function hasRenameMetadata(value: string): boolean {
  return /(?:^|\n)rename from [^\n]+\nrename to [^\n]+(?:\n|$)/.test(value);
}

function buildAddedOrDeletedFilePatch(input: {
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

function buildUpdatedFilePatch(input: StructuredFileChangePatchInput): string | undefined {
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

function toStructuredFileChangePatchInput(
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

const STRUCTURED_FILE_CHANGE_UPDATE_KINDS = new Set(["update", "move"]);
const STRUCTURED_FILE_CHANGE_KINDS = new Set([
  "add",
  "delete",
  "remove",
  ...STRUCTURED_FILE_CHANGE_UPDATE_KINDS,
]);

function extractStructuredFileChangePatchInputs(
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

function extractUnknownStructuredFileChangeKinds(
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

function synthesizeStructuredFileChangePatch(
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

function renderablePatchFromBufferedOutput(value: string): string {
  const normalized = normalizePatchText(value).trim();
  if (
    normalized.length === 0 ||
    (!normalized.startsWith("diff --git ") && !/^--- [^\n]+\n\+\+\+ [^\n]+/s.test(normalized))
  ) {
    return "";
  }
  return ensurePatchTrailingNewline(normalized);
}

function resolvedFileChangePatch(fileChange: PendingFileChangeState): string {
  return fileChange.exactPatch || renderablePatchFromBufferedOutput(fileChange.bufferedOutput);
}

function compactFileChangeIdForLifecycleEvent(
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

function runtimePayloadRecord(event: ProviderRuntimeEvent): Record<string, unknown> | undefined {
  const payload = (event as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  return payload as Record<string, unknown>;
}

function runtimeRawPayloadRecord(event: ProviderRuntimeEvent): Record<string, unknown> | undefined {
  const rawPayload = event.raw?.payload;
  if (!rawPayload || typeof rawPayload !== "object") {
    return undefined;
  }
  return rawPayload as Record<string, unknown>;
}

function joinDiagnosticDetail(parts: ReadonlyArray<string | undefined>): string | undefined {
  const normalized = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part && part.length > 0));
  return normalized.length > 0 ? normalized.join("\n\n") : undefined;
}

function hookRunRecord(event: ProviderRuntimeEvent): Record<string, unknown> | undefined {
  return asRecord(runtimeRawPayloadRecord(event)?.run);
}

function hookEventNameFromEvent(event: ProviderRuntimeEvent): string | undefined {
  const payload = runtimePayloadRecord(event);
  return (
    asString(payload?.hookEvent) ??
    asString(payload?.hookName) ??
    asString(hookRunRecord(event)?.eventName)
  );
}

function hookRawStatusFromEvent(event: ProviderRuntimeEvent): string | undefined {
  return asString(runtimePayloadRecord(event)?.rawStatus) ?? asString(hookRunRecord(event)?.status);
}

function hookStatusMessageFromEvent(event: ProviderRuntimeEvent): string | undefined {
  return (
    asString(runtimePayloadRecord(event)?.statusMessage) ??
    asString(hookRunRecord(event)?.statusMessage)
  );
}

function hookSourcePathFromEvent(event: ProviderRuntimeEvent): string | undefined {
  return (
    asString(runtimePayloadRecord(event)?.sourcePath) ?? asString(hookRunRecord(event)?.sourcePath)
  );
}

function mcpStatusRecord(
  event: Extract<ProviderRuntimeEvent, { type: "mcp.status.updated" }>,
): Record<string, unknown> | undefined {
  return asRecord(event.payload.status);
}

function runtimeErrorMessageFromEvent(event: ProviderRuntimeEvent): string | undefined {
  const payloadMessage = asString(runtimePayloadRecord(event)?.message);
  return payloadMessage;
}

/** Display shape that lets the work log render one local-time usage-limit row. */
function usageLimitActivityPayload(
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

function usageLimitFromRuntimeError(
  event: Extract<ProviderRuntimeEvent, { type: "runtime.error" }>,
) {
  const limit = event.payload.usageLimit;
  if (!limit) return undefined;
  const window =
    limit.windows.find((candidate) => candidate.label && candidate.resetsAt === limit.resetsAt) ??
    limit.windows.find((candidate) => candidate.label);
  return usageLimitActivityPayload(event, window?.label ?? null, limit.resetsAt);
}

function usageLimitFromRuntimeWarning(
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

function orchestrationSessionStatusFromRuntimeState(
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

function requestKindFromCanonicalRequestType(
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

function isTodoWriteToolName(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "todowrite";
}

function todoWriteInputFromLifecycleEvent(
  event: ItemLifecycleRuntimeEvent,
): Record<string, unknown> | undefined {
  const data = asRecord(event.payload.data);
  if (!isTodoWriteToolName(data?.toolName)) {
    return undefined;
  }
  return asRecord(data?.input);
}

function taskToolNameFromLifecycleEvent(
  event: ItemLifecycleRuntimeEvent,
): TaskToolName | undefined {
  const toolName = asRecord(event.payload.data)?.toolName;
  return isTaskToolName(toolName) ? toolName : undefined;
}

/** TodoWrite and native Task tool calls feed the task panel, not the work log. */
function isTaskTrackingLifecycleEvent(event: ItemLifecycleRuntimeEvent): boolean {
  return (
    todoWriteInputFromLifecycleEvent(event) !== undefined ||
    taskToolNameFromLifecycleEvent(event) !== undefined
  );
}

function taskToolLifecycleInput(
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
const MAX_TASK_TOOL_ARTIFACT_BYTES = 8 * 1024 * 1024;

function attachmentIdBelongsToThread(attachmentId: string, threadId: ThreadId): boolean {
  const segment = parseThreadSegmentFromAttachmentId(attachmentId);
  return segment !== null && segment === toSafeThreadAttachmentSegment(threadId)?.toLowerCase();
}

/**
 * Whether a Task tool event belongs to a turn a revert discarded. Only threads
 * whose task tracking has seen a revert (generation > 0) are checked; a turn
 * is kept while it is active, latest, or still has messages or checkpoints.
 */
function isDiscardedTaskToolTurn(
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

function buildTodoTaskId(content: string, activeForm: string, occurrence: number): string {
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

function extractTodoWriteTasksFromLifecycleEvent(
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

function shouldSuppressCollaborationUpdate(event: ItemLifecycleRuntimeEvent): boolean {
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

function areTaskListsEqual(left: ReadonlyArray<TaskItem>, right: ReadonlyArray<TaskItem>): boolean {
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

function buildCompactToolLifecyclePayload(
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
interface ToolImageRefs {
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
            ...(requestKind === "permission" && event.payload.requestedPermissions
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
      const reference =
        event.provider === "codex" &&
        native &&
        typeof native.server === "string" &&
        typeof native.tool === "string"
          ? readMcpAppReferenceForTool(data?.mcpApp, native.server, native.tool)
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

const make = Effect.gen(function* () {
  const probe = yield* PerformanceStageProbe;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const providerService = yield* ProviderService;
  const usageService = yield* Effect.serviceOption(UsageService);
  const ingestionScope = yield* Effect.scope;
  const mcpEventBus = yield* Effect.serviceOption(CodexMcpEventBus);
  const pendingMcpPushes = new Map<
    string,
    Set<import("@t3tools/contracts").ProviderInstanceId | null>
  >();
  // Last tool.updated activity appended per open tool item. Providers such as OpenCode resend
  // the whole tool state on every part update, so a repeat that matches it is not stored again.
  const lastToolUpdates = new Map<string, string>();
  // Runtime error and terminal reports share one refresh, without blocking the serial worker.
  const refreshedUsageFailures = new Map<ThreadId, string>();
  let enqueueResolvedUsageLimit: (input: RuntimeIngestionInput) => Effect.Effect<void> = () =>
    Effect.void;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
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
      unattendedDeclineCounts.set(threadId, { turnId, count: next });
      return next;
    });

  const clearUnattendedDeclines = (threadId: ThreadId, turnId?: TurnId) =>
    Effect.sync(() => {
      const existing = unattendedDeclineCounts.get(threadId);
      if (!existing || (turnId !== undefined && existing.turnId !== turnId)) return;
      unattendedDeclineCounts.delete(threadId);
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

    yield* providerService
      .interruptTurn({
        threadId: input.threadId,
        turnId: input.turnId,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to interrupt profiled workflow turn", {
            threadId: input.threadId,
            turnId: input.turnId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    yield* orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(
        `workflow-profile-failure:${input.threadId}:${input.turnId}:${crypto.randomUUID()}`,
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
        lastErrorId: `workflow-profile-failure:${input.turnId}`,
        lastErrorOccurredAt: input.createdAt,
        lastErrorRetryability: input.retryable ? "retryable" : "non-retryable",
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
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

      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: providerCommandId(input.event, `${input.commandTag}:${input.messageId}`),
        threadId: input.threadId,
        messageId: input.messageId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
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
      commandId: CommandId.makeUnsafe(`provider:cmd-output:${crypto.randomUUID()}`),
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
    const command = extractCommandExecutionCommand(input.event);
    const normalizedTitle = normalizeLifecycleCommandExecutionTitle(
      input.event.payload.title,
      command,
    );
    const fallbackCwd =
      eventCwd ?? existing?.cwd ?? (yield* resolveWorkspaceCwdForThread(input.threadId));
    const commandExecution: OpenCommandExecutionState =
      existing ??
      ({
        id: input.commandExecutionId,
        threadId: input.threadId,
        turnId: input.turnId,
        providerItemId: input.providerItemId,
        command,
        cwd: fallbackCwd,
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
      } satisfies OpenCommandExecutionState);

    commandExecution.cwd = eventCwd ?? commandExecution.cwd ?? fallbackCwd;
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
    }
  });

  const appendCommandExecutionOutput = Effect.fnUntraced(function* (input: {
    readonly event: Extract<ProviderRuntimeEvent, { type: "content.delta" }>;
    readonly commandExecutionId: OrchestrationCommandExecutionId;
  }) {
    const commandExecution = openCommandExecutions.get(input.commandExecutionId);
    if (!commandExecution) {
      const existingPendingOutput = pendingCommandExecutionOutput.get(input.commandExecutionId);
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
        `provider:source-proposed-plan-implemented:${implementationThreadId}:${crypto.randomUUID()}`,
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
      yield* providerSessionDirectory.updateTerminalLifecycleIfCurrent({
        threadId: event.threadId,
        instanceId: binding.providerInstanceId ?? ProviderInstanceId.makeUnsafe(binding.provider),
        generation: event.sessionGeneration ?? 0,
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
      if (isProviderTerminalRuntimeEvent(event)) {
        const binding = Option.getOrUndefined(
          yield* providerSessionDirectory.getBinding(event.threadId),
        );
        const generation = readPersistedSessionGeneration(binding?.runtimePayload);
        const currentInstance = binding?.providerInstanceId ?? thread.session?.providerInstanceId;
        const legacyTurnMatches =
          event.turnId !== undefined &&
          (thread.session?.activeTurnId === event.turnId ||
            (thread.session?.activeTurnId == null && thread.latestTurn?.turnId === event.turnId));
        const staleOrigin =
          (event.sessionGeneration === undefined
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

      if (workflowExecutionProfile && event.type === "request.opened" && profiledTurnId) {
        if (event.requestId !== undefined) {
          yield* providerService
            .respondToRequest({
              threadId: thread.id,
              requestId: ApprovalRequestId.makeUnsafe(String(event.requestId)),
              decision: "decline",
            })
            .pipe(
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
        yield* clearProfiledTurnWatchdog(thread.id, profiledTurnId);
        yield* recordProfiledTurnFailure({
          threadId: thread.id,
          turnId: profiledTurnId,
          error: `Workflow read-only profile violation: provider requested '${event.payload.requestType}'. The attempted operation was declined and the turn was interrupted.`,
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

      const shouldApplyThreadLifecycle = (() => {
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
            // If no active turn is tracked, accept completion scoped to this thread.
            return true;
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
        const reportedStatus = (() => {
          switch (event.type) {
            case "session.state.changed":
              return orchestrationSessionStatusFromRuntimeState(event.payload.state);
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
              return activeTurnId !== null ? "running" : "ready";
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
          const providerReportedContextTokens =
            event.type === "turn.completed" ? extractTurnCompletedContextTokens(event) : undefined;
          const estimatedContextTokens = mergeProviderReportedContextTokens({
            provider: event.provider,
            eventType: "turn.completed",
            providerReportedContextTokens,
            previousEstimatedContextTokens: thread.estimatedContextTokens ?? null,
          });
          const tokenUsageSource =
            estimatedContextTokens === undefined
              ? undefined
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
            yield* orchestrationEngine.dispatch(
              makeTurnCompletedSessionSetCommand({ event, thread, createdAt: now }),
            );
          } else {
            yield* orchestrationEngine.dispatch({
              type: "thread.session.set",
              commandId: providerCommandId(event, "thread-session-set"),
              threadId: thread.id,
              ...(event.type === "session.exited" && activeTurnId !== null
                ? { settledTurnId: activeTurnId }
                : {}),
              session: {
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
              createdAt: now,
            });
          }
        }
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
      }
      if (event.type === "session.exited") {
        yield* clearProfiledTurnWatchdog(thread.id);
        yield* clearUnattendedDeclines(thread.id);
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

      if (event.type === "thread.token-usage.updated") {
        const normalizedContextTokens = event.payload.contextTokens;
        const providerReportedContextTokens =
          normalizedContextTokens ?? extractThreadTokenUsageContextTokens(event.payload?.usage);
        const estimatedContextTokens = mergeProviderReportedContextTokens({
          provider: event.provider,
          eventType: "thread.token-usage.updated",
          providerReportedContextTokens,
          previousEstimatedContextTokens: thread.estimatedContextTokens ?? null,
          authoritativeSnapshot: normalizedContextTokens !== undefined,
        });
        const modelContextWindowTokens = event.payload.modelContextWindowTokens;
        if (estimatedContextTokens !== undefined || modelContextWindowTokens !== undefined) {
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
                ? {
                    estimatedContextTokens,
                    tokenUsageSource:
                      estimatedContextTokens === providerReportedContextTokens
                        ? ("provider" as const)
                        : ("estimated" as const),
                  }
                : {}),
              ...(modelContextWindowTokens !== undefined ? { modelContextWindowTokens } : {}),
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
                messageId: assistantMessageId,
                turnId,
                createdAt: now,
                commandTag: "assistant-complete-finalize",
                finalDeltaCommandTag: "assistant-delta-finalize-fallback",
              }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
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
            messageId,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
            commandTag: "assistant-interrupted-finalize",
            finalDeltaCommandTag: "assistant-interrupted-flush",
          });
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
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "runtime-error-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "error",
              providerName: event.provider,
              providerInstanceId:
                event.providerInstanceId ?? thread.session?.providerInstanceId ?? null,
              runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
              activeTurnId: eventTurnId ?? null,
              lastError: runtimeErrorMessage,
              lastErrorId: event.eventId,
              usageLimit: toOrchestrationUsageLimit(event.payload.usageLimit, event, thread),
              lastErrorOccurredAt: now,
              updatedAt: now,
            },
            createdAt: now,
          });
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
        ("nativeAttachment" in event.payload.metadata || "nativeGoal" in event.payload.metadata)
      ) {
        yield* orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: providerCommandId(event, "native-metadata"),
          threadId: thread.id,
          activity: {
            id: EventId.makeUnsafe(`${event.eventId}:native-metadata`),
            kind: "native.metadata",
            tone: "info",
            summary: "Provider metadata updated",
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
      yield* Effect.forEach(activities, (activity) =>
        Effect.gen(function* () {
          const signature =
            toolUpdateKey && activity.kind === "tool.updated"
              ? JSON.stringify([activity.tone, activity.summary, activity.turnId, activity.payload])
              : undefined;
          if (signature && lastToolUpdates.get(toolUpdateKey!) === signature) return;
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: providerCommandId(event, `thread-activity-append:${activity.id}`),
            threadId: thread.id,
            activity,
            createdAt: activity.createdAt,
          });
          // Recorded only after the append succeeds, so a retried event is not skipped.
          if (!signature) return;
          lastToolUpdates.delete(toolUpdateKey!);
          lastToolUpdates.set(toolUpdateKey!, signature);
          if (lastToolUpdates.size > MAX_TRACKED_TOOL_UPDATES)
            lastToolUpdates.delete(lastToolUpdates.keys().next().value!);
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
            refreshedUsageFailures.set(thread.id, key);
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
                ? processDomainEvent(input.event)
                : input.source === "command-output-flush"
                  ? flushCommandExecutionOutput(input.commandExecutionId).pipe(Effect.asVoid)
                  : flushAllCommandExecutionOutput();

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
      yield* worker.enqueue({ source: "assistant-delta-flush-all" });
      yield* worker.drain.pipe(Effect.orDie);
    }),
  );
  enqueueCommandOutputFlush = (commandExecutionId) => {
    enqueueBackgroundWork(worker.enqueue({ source: "command-output-flush", commandExecutionId }));
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
        if (
          thread.session?.status !== "running" ||
          activeTurnId === null ||
          activeTurnId === undefined ||
          thread.latestTurn?.state !== "running" ||
          thread.latestTurn.turnId !== activeTurnId ||
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
        yield* providerTerminalEventRepository.record(event);
        yield* enqueueRuntimeEvent(event);
        recoveredCount += 1;
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
          return worker.enqueue({
            source: "assistant-delta-flush-thread",
            threadId: event.payload.threadId,
          });
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
