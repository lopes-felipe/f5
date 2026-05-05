import { createHash } from "node:crypto";

import {
  ApprovalRequestId,
  type AssistantDeliveryMode,
  CommandId,
  MessageId,
  OrchestrationCommandExecutionId,
  type OrchestrationCommandExecutionStatus,
  type OrchestrationEvent,
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
} from "@t3tools/contracts";
import { Cache, Cause, Duration, Effect, Layer, Option, Ref, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  deriveNarratedActivityDisplayHints,
  deriveSearchCommandSummary,
  isGenericCommandTitle,
} from "@t3tools/shared/commandSummary";
import {
  compactThreadActivityPayload,
  readToolActivityPayload,
} from "@t3tools/shared/orchestrationActivityPayload";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
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
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { isGitRepository } from "../../git/isRepo.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import { reconcileCodexThreadSnapshots } from "../codexSnapshotReconciliation.ts";
import { validateThreadTasks } from "../threadTasks.ts";

const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;
const providerCommandId = (event: ProviderRuntimeEvent, tag: string): CommandId =>
  CommandId.makeUnsafe(`provider:${event.eventId}:${tag}:${crypto.randomUUID()}`);

const DEFAULT_ASSISTANT_DELIVERY_MODE: AssistantDeliveryMode = "buffered";
const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;
const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
const BUFFERED_REASONING_TEXT_BY_TURN_KEY_CACHE_CAPACITY = 10_000;
const BUFFERED_REASONING_TEXT_BY_TURN_KEY_TTL = Duration.minutes(120);
const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000;
const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
const MAX_BUFFERED_REASONING_CHARS = 200_000;
const COMMAND_OUTPUT_FLUSH_INTERVAL_MS = 100;
const COMMAND_OUTPUT_BUFFER_FLUSH_BYTES = 4 * 1024;
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSyntheticClaudeThreadId(value: string): boolean {
  return value.startsWith("claude-thread-");
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
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

function extractContextTokens(usage: unknown): number | undefined {
  const usageRecord = asRecord(usage);
  const inputTokens = asNonNegativeNumber(usageRecord?.input_tokens);
  if (inputTokens === undefined) {
    return undefined;
  }

  return (
    inputTokens +
    (asNonNegativeNumber(usageRecord?.cache_creation_input_tokens) ?? 0) +
    (asNonNegativeNumber(usageRecord?.cache_read_input_tokens) ?? 0)
  );
}

function extractTurnCompletedContextTokens(
  event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
): number | undefined {
  // Claude `result.usage` aggregates the entire agentic turn. Occupancy
  // snapshots for the badge come from per-message usage stream events instead.
  if (event.provider === "claudeAgent") {
    return undefined;
  }

  return extractContextTokens(event.payload?.usage);
}

function mergeProviderReportedContextTokens(input: {
  readonly provider: ProviderRuntimeEvent["provider"];
  readonly eventType: "turn.completed" | "thread.token-usage.updated";
  readonly providerReportedContextTokens: number | undefined;
  readonly previousEstimatedContextTokens: number | null;
}): number | undefined {
  if (input.providerReportedContextTokens === undefined) {
    return undefined;
  }

  if (input.provider === "claudeAgent" && input.eventType === "thread.token-usage.updated") {
    return input.providerReportedContextTokens;
  }

  return Math.max(input.providerReportedContextTokens, input.previousEstimatedContextTokens ?? 0);
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
  return asString(hookRunRecord(event)?.status);
}

function hookStatusMessageFromEvent(event: ProviderRuntimeEvent): string | undefined {
  return asString(hookRunRecord(event)?.statusMessage);
}

function hookSourcePathFromEvent(event: ProviderRuntimeEvent): string | undefined {
  return asString(hookRunRecord(event)?.sourcePath);
}

function mcpStatusRecord(
  event: Extract<ProviderRuntimeEvent, { type: "mcp.status.updated" }>,
): Record<string, unknown> | undefined {
  return asRecord(event.payload.status);
}

function normalizeRuntimeTurnState(
  value: string | undefined,
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (value) {
    case "failed":
    case "interrupted":
    case "cancelled":
    case "completed":
      return value;
    default:
      return "completed";
  }
}

function runtimeTurnState(
  event: ProviderRuntimeEvent,
): "completed" | "failed" | "interrupted" | "cancelled" {
  const payloadState = asString(runtimePayloadRecord(event)?.state);
  return normalizeRuntimeTurnState(payloadState);
}

function runtimeTurnErrorMessage(event: ProviderRuntimeEvent): string | undefined {
  const payloadErrorMessage = asString(runtimePayloadRecord(event)?.errorMessage);
  return payloadErrorMessage;
}

function runtimeErrorMessageFromEvent(event: ProviderRuntimeEvent): string | undefined {
  const payloadMessage = asString(runtimePayloadRecord(event)?.message);
  return payloadMessage;
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
): "command" | "file-read" | "file-change" | "permission" | undefined {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    case "permissions_approval":
      return "permission";
    default:
      return undefined;
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

function hasSubagentResultInLifecycleEvent(event: ItemLifecycleRuntimeEvent): boolean {
  if (event.payload.itemType !== "collab_agent_tool_call") {
    return false;
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
) {
  const fileChangeId = compactFileChangeIdForLifecycleEvent(event);
  const normalizedTitle = commandExecutionLifecycleTitle(event);
  return {
    itemType: event.payload.itemType,
    ...(event.itemId ? { providerItemId: event.itemId } : {}),
    ...(event.payload.status ? { status: event.payload.status } : {}),
    ...(normalizedTitle ? { title: normalizedTitle } : {}),
    ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
    ...(event.payload.requestKind ? { requestKind: event.payload.requestKind } : {}),
    ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
    ...(fileChangeId ? { fileChangeId } : {}),
  };
}

function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
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
                    : "Approval requested",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
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
            ...(statusMessage ? { statusMessage } : {}),
            ...(sourcePath ? { sourcePath, detail: `Source: ${sourcePath}` } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "hook.completed": {
      const hookEvent = hookEventNameFromEvent(event) ?? event.payload.hookId;
      const rawStatus = hookRawStatusFromEvent(event) ?? event.payload.outcome;
      const detail = event.payload.output ? truncateDetail(event.payload.output) : undefined;

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.outcome === "error" ? "error" : "info",
          kind: "hook.completed",
          summary: `${hookEvent} hook (${rawStatus})`,
          payload: {
            hookId: event.payload.hookId,
            outcome: event.payload.outcome,
            rawStatus,
            ...(detail ? { detail } : {}),
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

    case "runtime.error": {
      const message = runtimeErrorMessageFromEvent(event);
      if (!message) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Runtime error",
          payload: {
            message: truncateDetail(message),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.warning": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          summary: "Runtime warning",
          payload: {
            message: truncateDetail(event.payload.message),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
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
          summary: "User input requested",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.resolved",
          summary: "User input submitted",
          payload: {
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
      if (todoWriteInputFromLifecycleEvent(event)) {
        return [];
      }
      if (hasSubagentResultInLifecycleEvent(event)) {
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
          kind: "tool.updated",
          summary: normalizedTitle ?? "Tool updated",
          payload: compactThreadActivityPayload({
            kind: "tool.updated",
            payload: buildCompactToolLifecyclePayload(event),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.completed": {
      if (todoWriteInputFromLifecycleEvent(event)) {
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
          kind: "tool.completed",
          summary: normalizedTitle ?? "Tool",
          payload: compactThreadActivityPayload({
            kind: "tool.completed",
            payload: buildCompactToolLifecyclePayload(event),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.started": {
      if (todoWriteInputFromLifecycleEvent(event)) {
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
            payload: buildCompactToolLifecyclePayload(event),
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
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const projectionTurnRepository = yield* ProjectionTurnRepository;

  const assistantDeliveryModeRef = yield* Ref.make<AssistantDeliveryMode>(
    DEFAULT_ASSISTANT_DELIVERY_MODE,
  );

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
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
    Cache.invalidate(bufferedReasoningTextByTurnKey, turnKey);

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
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      const bufferedReasoningText = input.turnId
        ? yield* takeBufferedReasoningText(providerTurnKey(input.threadId, input.turnId))
        : "";
      const text =
        bufferedText.length > 0
          ? bufferedText
          : (input.fallbackText?.trim().length ?? 0) > 0
            ? input.fallbackText!
            : "";

      if (text.length > 0) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: providerCommandId(input.event, input.finalDeltaCommandTag),
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
          commandId: providerCommandId(input.event, `${input.finalDeltaCommandTag}-reasoning-only`),
          threadId: input.threadId,
          messageId: input.messageId,
          delta: "",
          reasoningDelta: bufferedReasoningText,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: providerCommandId(input.event, input.commandTag),
        threadId: input.threadId,
        messageId: input.messageId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
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
      const planMarkdown = bufferedMarkdown ?? fallbackMarkdown;
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
        } satisfies PendingFileChangeState);
      nextState.firstSeenAt =
        nextState.firstSeenAt <= input.event.createdAt
          ? nextState.firstSeenAt
          : input.event.createdAt;
      nextState.turnId = nextState.turnId ?? turnId ?? null;
      nextState.updatedAt =
        nextState.updatedAt >= input.event.createdAt ? nextState.updatedAt : input.event.createdAt;
      nextState.bufferedOutput = `${nextState.bufferedOutput}${input.event.payload.delta}`;
      pendingFileChanges.set(input.fileChangeId, nextState);
    });

  const finalizePendingFileChanges = Effect.fnUntraced(function* (input: {
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
        commandId: CommandId.makeUnsafe(`provider:${input.commandTag}:${crypto.randomUUID()}`),
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
        commandId: CommandId.makeUnsafe(`provider:${input.commandTag}:${crypto.randomUUID()}`),
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

  const processRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === event.threadId);
      if (!thread) return;

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
      const acceptedTurnStartedSourcePlan =
        event.type === "turn.started" && shouldApplyThreadLifecycle
          ? yield* getSourceProposedPlanReferenceForAcceptedTurnStart(thread.id, eventTurnId)
          : null;

      if (
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        event.type === "turn.completed"
      ) {
        const nextActiveTurnId =
          event.type === "turn.started"
            ? (eventTurnId ?? null)
            : event.type === "turn.completed" || event.type === "session.exited"
              ? null
              : activeTurnId;
        const status = (() => {
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
        const lastError =
          event.type === "session.state.changed" && event.payload.state === "error"
            ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
            : event.type === "turn.completed" && runtimeTurnState(event) === "failed"
              ? (runtimeTurnErrorMessage(event) ?? thread.session?.lastError ?? "Turn failed")
              : status === "ready"
                ? null
                : (thread.session?.lastError ?? null);

        if (shouldApplyThreadLifecycle) {
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

          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "thread-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status,
              providerName: event.provider,
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: nextActiveTurnId,
              lastError,
              ...(turnCostUsd !== undefined ? { turnCostUsd } : {}),
              ...(estimatedContextTokens !== undefined
                ? { estimatedContextTokens, tokenUsageSource }
                : {}),
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      if (event.type === "thread.token-usage.updated") {
        const providerReportedContextTokens = extractThreadTokenUsageContextTokens(
          event.payload?.usage,
        );
        const estimatedContextTokens = mergeProviderReportedContextTokens({
          provider: event.provider,
          eventType: "thread.token-usage.updated",
          providerReportedContextTokens,
          previousEstimatedContextTokens: thread.estimatedContextTokens ?? null,
        });
        if (estimatedContextTokens !== undefined) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "thread-token-usage-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: thread.session?.status ?? "ready",
              providerName: event.provider,
              runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
              activeTurnId: thread.session?.activeTurnId ?? null,
              lastError: thread.session?.lastError ?? null,
              estimatedContextTokens,
              tokenUsageSource:
                estimatedContextTokens === providerReportedContextTokens ? "provider" : "estimated",
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
        } else if (!areTaskListsEqual(thread.tasks, todoWriteTasks)) {
          yield* orchestrationEngine.dispatch({
            type: "thread.tasks.update",
            commandId: providerCommandId(event, "thread-tasks-update"),
            threadId: thread.id,
            tasks: [...todoWriteTasks],
            ...(eventTurnId ? { turnId: eventTurnId } : {}),
            createdAt: now,
          });
        }
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

        const assistantDeliveryMode = yield* Ref.get(assistantDeliveryModeRef);
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
          yield* orchestrationEngine.dispatch({
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
          const spillChunk = yield* appendBufferedReasoningText(turnKey, reasoningDelta);
          const assistantDeliveryMode = yield* Ref.get(assistantDeliveryModeRef);
          if (assistantDeliveryMode === "streaming") {
            const assistantMessageId = yield* getLatestAssistantMessageIdForTurn(thread.id, turnId);
            if (assistantMessageId && spillChunk.length > 0) {
              yield* orchestrationEngine.dispatch({
                // Empty assistant deltas are safe because assistant completion always follows.
                type: "thread.message.assistant.delta",
                commandId: providerCommandId(event, "assistant-reasoning-buffer-spill"),
                threadId: thread.id,
                messageId: assistantMessageId,
                delta: "",
                reasoningDelta: spillChunk,
                turnId,
                createdAt: now,
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
              yield* orchestrationEngine.dispatch({
                // Empty assistant deltas are safe because assistant completion always follows.
                type: "thread.message.assistant.delta",
                commandId: providerCommandId(event, "assistant-reasoning-delta"),
                threadId: thread.id,
                messageId: assistantMessageId,
                delta: "",
                reasoningDelta: reasoningText,
                turnId,
                createdAt: now,
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
              fallbackText: event.payload.detail,
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
        const shouldApplyFallbackCompletionText =
          !existingAssistantMessage || existingAssistantMessage.text.length === 0;
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
            ? { fallbackText: assistantCompletion.fallbackText }
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

      if (event.type === "turn.completed") {
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          const openCommandStatus = runtimeTurnState(event) === "failed" ? "failed" : "interrupted";
          yield* finalizeOpenCommandExecutions({
            threadId: thread.id,
            turnId,
            status: openCommandStatus,
            updatedAt: now,
            commandTag: "command-execution-turn-complete-finalize",
          });
          yield* finalizePendingFileChanges({
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

          yield* finalizeBufferedProposedPlan({
            event,
            threadId: thread.id,
            threadProposedPlans: thread.proposedPlans,
            planId: proposedPlanIdForTurn(thread.id, turnId),
            turnId,
            updatedAt: now,
          });
        }
      }

      if (event.type === "turn.aborted") {
        yield* finalizeOpenCommandExecutions({
          threadId: thread.id,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
          status: "interrupted",
          updatedAt: now,
          commandTag: "command-execution-turn-aborted-finalize",
        });
        yield* finalizePendingFileChanges({
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
          threadId: thread.id,
          status: event.payload.exitKind === "error" ? "failed" : "interrupted",
          updatedAt: now,
          commandTag: "command-execution-session-exited-finalize",
        });
        yield* finalizePendingFileChanges({
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
          threadId: thread.id,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
          status: "failed",
          updatedAt: now,
          commandTag: "command-execution-runtime-error-finalize",
        });
        yield* finalizePendingFileChanges({
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
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: eventTurnId ?? null,
              lastError: runtimeErrorMessage,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      if (event.type === "session.state.changed" && event.payload.state === "error") {
        yield* finalizeOpenCommandExecutions({
          threadId: thread.id,
          status: "failed",
          updatedAt: now,
          commandTag: "command-execution-session-error-finalize",
        });
        yield* finalizePendingFileChanges({
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

      if (event.type === "thread.metadata.updated" && event.payload.name) {
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: providerCommandId(event, "thread-meta-update"),
          threadId: thread.id,
          title: event.payload.name,
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
              runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
              activeTurnId: thread.session?.activeTurnId ?? null,
              lastError: thread.session?.lastError ?? null,
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
            runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
            activeTurnId: thread.session?.activeTurnId ?? null,
            lastError: thread.session?.lastError ?? null,
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
        if (turnId && (yield* isGitRepoForThread(thread.id))) {
          // Re-emit a placeholder for every provider diff refresh so
          // CheckpointReactor can keep the current turn checkpoint aligned with
          // the latest filesystem state without allocating a new turn count.
          const existingCheckpoint = thread.checkpoints.find(
            (checkpoint) => checkpoint.turnId === turnId,
          );
          const assistantMessageId =
            existingCheckpoint?.assistantMessageId ??
            MessageId.makeUnsafe(`assistant:${event.itemId ?? event.turnId ?? event.eventId}`);
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
            checkpointTurnCount: existingCheckpoint?.checkpointTurnCount ?? maxTurnCount + 1,
            createdAt: now,
          });
        }
      }

      const activities = runtimeEventToActivities(event);
      yield* Effect.forEach(activities, (activity) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: providerCommandId(event, "thread-activity-append"),
          threadId: thread.id,
          activity,
          createdAt: activity.createdAt,
        }),
      ).pipe(Effect.asVoid);
    });

  const processDomainEvent = (event: TurnStartRequestedDomainEvent) =>
    Ref.set(
      assistantDeliveryModeRef,
      event.payload.assistantDeliveryMode ?? DEFAULT_ASSISTANT_DELIVERY_MODE,
    );

  const processInput = (input: RuntimeIngestionInput) =>
    input.source === "runtime"
      ? processRuntimeEvent(input.event)
      : input.source === "domain"
        ? processDomainEvent(input.event)
        : input.source === "command-output-flush"
          ? flushCommandExecutionOutput(input.commandExecutionId).pipe(Effect.asVoid)
          : flushAllCommandExecutionOutput();

  const processInputSafely = (input: RuntimeIngestionInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
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
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);
  enqueueCommandOutputFlush = (commandExecutionId) => {
    void Effect.runPromise(worker.enqueue({ source: "command-output-flush", commandExecutionId }));
  };

  const start: ProviderRuntimeIngestionShape["start"] = Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(clearAllCommandExecutionFlushTimers));
    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) =>
        worker.enqueue({ source: "runtime", event }),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.turn-start-requested") {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );
  });

  return {
    start,
    drain: worker
      .enqueue({ source: "command-output-flush-all" })
      .pipe(Effect.flatMap(() => worker.drain)),
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make,
).pipe(Layer.provide(ProjectionTurnRepositoryLive));
