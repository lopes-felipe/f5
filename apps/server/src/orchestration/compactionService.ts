import {
  isKnownProviderKind,
  type OrchestrationCheckpointSummary,
  type OrchestrationMessage,
  type OrchestrationThread,
  type TaskItem,
  type ThreadCompactionDirection,
} from "@t3tools/contracts";
import { inferProviderForModel } from "@t3tools/shared/model";
import { readToolActivityPayload } from "@t3tools/shared/orchestrationActivityPayload";

import {
  estimateModelContextWindowTokens,
  isReadOnlyToolName,
  roughTokenEstimateFromCharacters,
} from "../provider/providerContext.ts";

export const POST_COMPACT_MAX_FILES_TO_RESTORE = 5;
const MAX_COMPACTION_MESSAGE_TEXT_CHARS = 12_000;
const MAX_COMPACTION_REASONING_CHARS = 4_000;
const MAX_ACTIVITY_PAYLOAD_PREVIEW_CHARS = 800;

export type ThreadResumeContextInput = {
  readonly priorWorkSummary?: string;
  readonly preservedTranscriptBefore?: string;
  readonly preservedTranscriptAfter?: string;
  readonly restoredRecentFileRefs?: ReadonlyArray<string>;
  readonly restoredActivePlan?: string;
  readonly restoredTasks?: ReadonlyArray<string>;
  readonly sessionNotes?: NonNullable<OrchestrationThread["sessionNotes"]>;
};

export type ThreadCompactionRestoreInput = ThreadResumeContextInput;

type CompactableRange = {
  readonly compactedMessages: ReadonlyArray<OrchestrationMessage>;
  readonly preservedBefore: ReadonlyArray<OrchestrationMessage>;
  readonly preservedAfter: ReadonlyArray<OrchestrationMessage>;
};

type ThreadCompactionRange = {
  readonly fromTurnCount: number | null;
  readonly toTurnCount: number | null;
};

type TurnCandidate = {
  readonly turnId: Exclude<OrchestrationMessage["turnId"], null>;
  readonly createdAt: string;
};

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 16))}\n...[truncated]`;
}

function stringifyPreview(value: unknown, maxChars = MAX_ACTIVITY_PAYLOAD_PREVIEW_CHARS): string {
  try {
    const serialized = JSON.stringify(value, null, 2);
    return truncate(serialized, maxChars);
  } catch {
    return "[unserializable payload]";
  }
}

function formatMessage(message: OrchestrationMessage): string {
  const parts = [
    `[${message.createdAt}] ${message.role.toUpperCase()}${message.turnId ? ` (turn ${message.turnId})` : ""}`,
    truncate(message.text, MAX_COMPACTION_MESSAGE_TEXT_CHARS),
  ];

  if ((message.reasoningText ?? "").trim().length > 0) {
    parts.push(`Reasoning:\n${truncate(message.reasoningText!, MAX_COMPACTION_REASONING_CHARS)}`);
  }

  if ((message.attachments?.length ?? 0) > 0) {
    parts.push(
      `Attachments: ${message.attachments!.map((attachment) => attachment.name).join(", ")}`,
    );
  }

  return parts.join("\n");
}

function formatMessages(messages: ReadonlyArray<OrchestrationMessage>): string | undefined {
  if (messages.length === 0) {
    return undefined;
  }
  return messages.map(formatMessage).join("\n\n");
}

function collectCompactableRange(input: {
  readonly thread: OrchestrationThread;
  readonly direction: ThreadCompactionDirection | null;
  readonly pivotMessageId: string | null;
}): CompactableRange {
  const messages = input.thread.messages.toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  if (input.direction === null || input.pivotMessageId === null) {
    return {
      compactedMessages: messages,
      preservedBefore: [],
      preservedAfter: [],
    };
  }

  const pivotIndex = messages.findIndex((message) => message.id === input.pivotMessageId);
  if (pivotIndex < 0) {
    return {
      compactedMessages: messages,
      preservedBefore: [],
      preservedAfter: [],
    };
  }

  if (input.direction === "from") {
    return {
      compactedMessages: messages.slice(pivotIndex),
      preservedBefore: messages.slice(0, pivotIndex),
      preservedAfter: [],
    };
  }

  return {
    compactedMessages: messages.slice(0, pivotIndex + 1),
    preservedBefore: [],
    preservedAfter: messages.slice(pivotIndex + 1),
  };
}

function buildTurnOrdinalMap(thread: OrchestrationThread): Map<string, number> {
  const ordinals = new Map<string, number>();
  let nextOrdinal = 1;

  for (const checkpoint of thread.checkpoints.toSorted(
    (left, right) => left.checkpointTurnCount - right.checkpointTurnCount,
  )) {
    ordinals.set(checkpoint.turnId, checkpoint.checkpointTurnCount);
    nextOrdinal = Math.max(nextOrdinal, checkpoint.checkpointTurnCount + 1);
  }

  const turnCandidates = [
    ...thread.messages.map((message) => ({
      turnId: message.turnId,
      createdAt: message.createdAt,
    })),
    ...thread.activities.map((activity) => ({
      turnId: activity.turnId,
      createdAt: activity.createdAt,
    })),
    ...thread.proposedPlans.map((plan) => ({
      turnId: plan.turnId,
      createdAt: plan.createdAt,
    })),
    ...thread.checkpoints.map((checkpoint) => ({
      turnId: checkpoint.turnId,
      createdAt: checkpoint.completedAt,
    })),
  ]
    .filter((entry): entry is TurnCandidate => entry.turnId !== null)
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.turnId.localeCompare(right.turnId),
    );

  for (const entry of turnCandidates) {
    if (!ordinals.has(entry.turnId)) {
      ordinals.set(entry.turnId, nextOrdinal);
      nextOrdinal += 1;
    }
  }

  return ordinals;
}

function deriveCompactionTurnRange(
  thread: OrchestrationThread,
  compactedMessages: ReadonlyArray<OrchestrationMessage>,
): ThreadCompactionRange {
  const turnOrdinals = buildTurnOrdinalMap(thread);
  const ordinals = compactedMessages
    .flatMap((message) => (message.turnId ? [turnOrdinals.get(message.turnId) ?? null] : []))
    .filter((value): value is number => value !== null)
    .toSorted((left, right) => left - right);

  return {
    fromTurnCount: ordinals[0] ?? null,
    toTurnCount: ordinals.length > 0 ? ordinals[ordinals.length - 1]! : null,
  };
}

function normalizePathCandidate(value: unknown): string | undefined {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return undefined;
  }
  return looksLikePathCandidate(trimmed) ? trimmed : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function looksLikePathCandidate(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~/") ||
    value.includes("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\.[^/\s]+$/.test(value) ||
    /^[^\s/\\]+\.[A-Za-z0-9._-]+$/.test(value)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractPathCandidates(value: unknown): string[] {
  if (typeof value === "string") {
    return normalizePathCandidate(value) ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(extractPathCandidates);
  }
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const paths: string[] = [];
  for (const [key, entry] of Object.entries(record)) {
    if (
      key === "path" ||
      key === "filePath" ||
      key === "filename" ||
      key === "file" ||
      key === "files" ||
      key === "paths"
    ) {
      paths.push(...extractPathCandidates(entry));
    }
  }
  return paths;
}

function extractToolNameFromDetail(detail: string): string | undefined {
  const separatorIndex = detail.indexOf(":");
  if (separatorIndex <= 0) {
    return undefined;
  }
  return asTrimmedString(detail.slice(0, separatorIndex));
}

function extractPathCandidatesFromToolDetail(detail: string): string[] {
  const separatorIndex = detail.indexOf(":");
  const payloadPreview =
    separatorIndex >= 0 ? detail.slice(separatorIndex + 1).trim() : detail.trim();
  if (payloadPreview.length === 0) {
    return [];
  }
  if (
    (payloadPreview.startsWith("{") && payloadPreview.endsWith("}")) ||
    (payloadPreview.startsWith("[") && payloadPreview.endsWith("]"))
  ) {
    try {
      return extractPathCandidates(JSON.parse(payloadPreview));
    } catch {
      return [];
    }
  }
  return extractPathCandidates(payloadPreview);
}

function deriveRecentFileRefs(thread: OrchestrationThread): ReadonlyArray<string> {
  const recentRefs: string[] = [];
  const seen = new Set<string>();

  for (const activity of thread.activities.toSorted(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
  )) {
    if (activity.kind !== "tool.updated") {
      continue;
    }
    const rawPayload =
      activity.payload && typeof activity.payload === "object" && !Array.isArray(activity.payload)
        ? (activity.payload as Record<string, unknown>)
        : undefined;
    const data = asRecord(rawPayload?.data);
    const toolPayload = readToolActivityPayload(activity.payload);
    const rawToolName = asTrimmedString(data?.toolName);
    const compactToolName =
      toolPayload?.detail !== undefined ? extractToolNameFromDetail(toolPayload.detail) : undefined;
    const toolName = rawToolName ?? compactToolName;
    if (!toolName || !isReadOnlyToolName(toolName)) {
      continue;
    }
    const candidates =
      rawToolName && data?.input !== undefined
        ? extractPathCandidates(data.input)
        : toolPayload?.detail
          ? extractPathCandidatesFromToolDetail(toolPayload.detail)
          : [];
    for (const candidate of candidates) {
      const normalized = candidate.trim();
      if (normalized.length === 0 || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      recentRefs.push(normalized);
      if (recentRefs.length >= POST_COMPACT_MAX_FILES_TO_RESTORE) {
        return recentRefs;
      }
    }
  }

  return recentRefs;
}

export function deriveActivePlan(thread: OrchestrationThread): string | undefined {
  const planActivity = thread.activities
    .toSorted(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    )
    .find((activity) => activity.kind === "turn.plan.updated");
  if (!planActivity || !planActivity.payload || typeof planActivity.payload !== "object") {
    return undefined;
  }

  const payload = planActivity.payload as {
    explanation?: unknown;
    plan?: ReadonlyArray<{ step?: unknown; status?: unknown }>;
  };
  const lines: string[] = [];
  if (typeof payload.explanation === "string" && payload.explanation.trim().length > 0) {
    lines.push(payload.explanation.trim());
  }
  for (const [index, step] of (payload.plan ?? []).entries()) {
    if (!step || typeof step !== "object") {
      continue;
    }
    const stepRecord = step as { step?: unknown; status?: unknown };
    if (typeof stepRecord.step !== "string" || typeof stepRecord.status !== "string") {
      continue;
    }
    lines.push(`${index + 1}. [${stepRecord.status}] ${stepRecord.step}`);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function deriveLatestProposedPlanMarkdown(thread: OrchestrationThread): string | undefined {
  const candidatePlans = thread.proposedPlans.filter((plan) => plan.implementedAt === null);
  const orderedPlans = (candidatePlans.length > 0 ? candidatePlans : thread.proposedPlans).toSorted(
    (left, right) =>
      left.updatedAt.localeCompare(right.updatedAt) ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
  return orderedPlans.at(-1)?.planMarkdown;
}

export function deriveTaskLines(tasks: ReadonlyArray<TaskItem>): ReadonlyArray<string> {
  return tasks.map((task) => `[${task.status}] ${task.activeForm}`);
}

function summarizeActivity(activity: OrchestrationThread["activities"][number]): string {
  if (activity.kind === "turn.plan.updated") {
    return `Plan updated:\n${stringifyPreview(activity.payload)}`;
  }
  if (activity.kind.startsWith("tool.")) {
    return `Tool activity: ${activity.summary}\n${stringifyPreview(activity.payload)}`;
  }
  if (activity.kind === "runtime.error" || activity.kind === "runtime.warning") {
    return `${activity.summary}\n${stringifyPreview(activity.payload)}`;
  }
  return `${activity.summary}\n${stringifyPreview(activity.payload)}`;
}

function summarizeCheckpoint(checkpoint: OrchestrationCheckpointSummary): string {
  const fileList =
    checkpoint.files.length > 0
      ? checkpoint.files
          .map((file) => `${file.path} (+${file.additions}/-${file.deletions})`)
          .join(", ")
      : "no captured file list";
  return `[${checkpoint.completedAt}] Turn ${checkpoint.checkpointTurnCount}: ${checkpoint.status} (${fileList})`;
}

export function buildThreadCompactionTranscript(input: {
  readonly thread: OrchestrationThread;
  readonly direction: ThreadCompactionDirection | null;
  readonly pivotMessageId: string | null;
}): {
  readonly transcript: string;
  readonly preservedTranscriptBefore?: string;
  readonly preservedTranscriptAfter?: string;
  readonly estimatedTokens: number;
  readonly modelContextWindowTokens: number;
  readonly fromTurnCount: number | null;
  readonly toTurnCount: number | null;
} {
  const range = collectCompactableRange(input);
  const compactedMessages = range.compactedMessages;
  const compactedTurnIds = new Set(
    compactedMessages.flatMap((message) => (message.turnId ? [message.turnId] : [])),
  );
  const compactedStartAt = compactedMessages[0]?.createdAt ?? null;
  const compactedEndAt = compactedMessages[compactedMessages.length - 1]?.createdAt ?? null;
  const inCompactedWindow = (createdAt: string) =>
    compactedStartAt !== null &&
    compactedEndAt !== null &&
    createdAt >= compactedStartAt &&
    createdAt <= compactedEndAt;

  const relatedActivities = input.thread.activities
    .filter(
      (activity) =>
        (activity.turnId !== null && compactedTurnIds.has(activity.turnId)) ||
        (activity.turnId === null && inCompactedWindow(activity.createdAt)),
    )
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  const relatedPlans = input.thread.proposedPlans
    .filter(
      (plan) =>
        (plan.turnId !== null && compactedTurnIds.has(plan.turnId)) ||
        (plan.turnId === null && inCompactedWindow(plan.createdAt)),
    )
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  const relatedCheckpoints = input.thread.checkpoints
    .filter((checkpoint) => compactedTurnIds.has(checkpoint.turnId))
    .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount);

  const taskLines = deriveTaskLines(input.thread.tasks);
  const preservedTranscriptBefore = formatMessages(range.preservedBefore);
  const preservedTranscriptAfter = formatMessages(range.preservedAfter);

  const sections = [
    "## Thread Metadata",
    `Title: ${input.thread.title}`,
    `Model: ${input.thread.model}`,
    "",
    "## Messages",
    formatMessages(compactedMessages) ?? "[no messages selected]",
    "",
    "## Activities",
    relatedActivities.length > 0
      ? relatedActivities.map(summarizeActivity).join("\n\n")
      : "[no related activities]",
    "",
    "## Proposed Plans",
    relatedPlans.length > 0
      ? relatedPlans
          .map(
            (plan) =>
              `[${plan.updatedAt}] Proposed plan${plan.turnId ? ` (turn ${plan.turnId})` : ""}\n${plan.planMarkdown}`,
          )
          .join("\n\n")
      : "[no proposed plans]",
    "",
    "## Checkpoints",
    relatedCheckpoints.length > 0
      ? relatedCheckpoints.map(summarizeCheckpoint).join("\n")
      : "[no checkpoints]",
    "",
    "## Current Task Snapshot",
    taskLines.length > 0 ? taskLines.join("\n") : "[no active tasks]",
  ];

  const transcript = sections.join("\n");
  const turnRange = deriveCompactionTurnRange(input.thread, compactedMessages);
  const transcriptChars = transcript.length;
  const provider = isKnownProviderKind(input.thread.session?.providerName)
    ? input.thread.session.providerName
    : inferProviderForModel(input.thread.model, "codex");

  return {
    transcript,
    ...(preservedTranscriptBefore ? { preservedTranscriptBefore } : {}),
    ...(preservedTranscriptAfter ? { preservedTranscriptAfter } : {}),
    estimatedTokens: roughTokenEstimateFromCharacters(transcriptChars),
    modelContextWindowTokens:
      input.thread.modelContextWindowTokens ??
      estimateModelContextWindowTokens(input.thread.model, provider),
    fromTurnCount: turnRange.fromTurnCount,
    toTurnCount: turnRange.toTurnCount,
  };
}

export function buildThreadResumeContext(thread: OrchestrationThread): ThreadResumeContextInput {
  const restoredActivePlan = deriveLatestProposedPlanMarkdown(thread) ?? deriveActivePlan(thread);
  const taskLines = deriveTaskLines(thread.tasks);
  const sharedResumeContext = {
    ...(restoredActivePlan ? { restoredActivePlan } : {}),
    ...(taskLines.length > 0 ? { restoredTasks: taskLines } : {}),
    ...(thread.sessionNotes ? { sessionNotes: thread.sessionNotes } : {}),
  } satisfies ThreadResumeContextInput;

  if (!thread.compaction) {
    return sharedResumeContext;
  }

  const range = collectCompactableRange({
    thread,
    direction: thread.compaction.direction,
    pivotMessageId: thread.compaction.pivotMessageId,
  });
  const preservedBefore = formatMessages(range.preservedBefore);
  const preservedAfter = formatMessages(range.preservedAfter);
  const recentFileRefs = deriveRecentFileRefs(thread);

  return {
    priorWorkSummary: thread.compaction.summary,
    ...(preservedBefore ? { preservedTranscriptBefore: preservedBefore } : {}),
    ...(preservedAfter ? { preservedTranscriptAfter: preservedAfter } : {}),
    ...(recentFileRefs.length > 0 ? { restoredRecentFileRefs: recentFileRefs } : {}),
    ...sharedResumeContext,
  };
}

export function buildThreadCompactionRestoreInput(
  thread: OrchestrationThread,
): ThreadCompactionRestoreInput {
  return buildThreadResumeContext(thread);
}
