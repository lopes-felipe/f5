import { ThreadId } from "@t3tools/contracts";

export interface ClaudeTurnBoundary {
  readonly turnId: string;
  readonly assistantUuid: string;
  readonly userMessageUuid?: string | undefined;
  readonly fileCheckpointing?: boolean;
}

export interface ClaudeResumeState {
  readonly hostContractVersion?: string;
  readonly turnBoundaries?: ReadonlyArray<ClaudeTurnBoundary>;
  readonly threadId?: ThreadId;
  readonly resume?: string;
  readonly resumeSessionAt?: string;
  readonly turnCount?: number;
  readonly lastTotalCostUsd?: number;
  readonly baseContextChars?: number;
  readonly approximateConversationChars?: number;
  readonly compactionRecommendationEmitted?: boolean;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isSyntheticClaudeThreadId(value: string): boolean {
  return value.startsWith("claude-thread-");
}

export function readClaudeResumeCandidate(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") return undefined;
  const cursor = resumeCursor as { resume?: unknown; sessionId?: unknown };
  return typeof cursor.resume === "string"
    ? cursor.resume
    : typeof cursor.sessionId === "string"
      ? cursor.sessionId
      : undefined;
}

export function readClaudeResumeState(resumeCursor: unknown): ClaudeResumeState | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") return undefined;
  const cursor = resumeCursor as {
    hostContractVersion?: unknown;
    turnBoundaries?: unknown;
    threadId?: unknown;
    resumeSessionAt?: unknown;
    turnCount?: unknown;
    lastTotalCostUsd?: unknown;
    baseContextChars?: unknown;
    approximateConversationChars?: unknown;
    compactionRecommendationEmitted?: unknown;
  };
  const threadIdCandidate = typeof cursor.threadId === "string" ? cursor.threadId : undefined;
  const threadId =
    threadIdCandidate && !isSyntheticClaudeThreadId(threadIdCandidate)
      ? ThreadId.makeUnsafe(threadIdCandidate)
      : undefined;
  const resumeCandidate = readClaudeResumeCandidate(resumeCursor);
  const resume = resumeCandidate && isUuid(resumeCandidate) ? resumeCandidate : undefined;
  const resumeSessionAt =
    typeof cursor.resumeSessionAt === "string" ? cursor.resumeSessionAt : undefined;
  const turnCount =
    typeof cursor.turnCount === "number" &&
    Number.isInteger(cursor.turnCount) &&
    cursor.turnCount >= 0
      ? cursor.turnCount
      : undefined;
  const lastTotalCostUsd =
    typeof cursor.lastTotalCostUsd === "number" &&
    Number.isFinite(cursor.lastTotalCostUsd) &&
    cursor.lastTotalCostUsd >= 0
      ? cursor.lastTotalCostUsd
      : undefined;
  const baseContextChars =
    typeof cursor.baseContextChars === "number" &&
    Number.isInteger(cursor.baseContextChars) &&
    cursor.baseContextChars >= 0
      ? cursor.baseContextChars
      : undefined;
  const approximateConversationChars =
    typeof cursor.approximateConversationChars === "number" &&
    Number.isInteger(cursor.approximateConversationChars) &&
    cursor.approximateConversationChars >= 0
      ? cursor.approximateConversationChars
      : undefined;
  const compactionRecommendationEmitted =
    typeof cursor.compactionRecommendationEmitted === "boolean"
      ? cursor.compactionRecommendationEmitted
      : undefined;
  const turnBoundaries = Array.isArray(cursor.turnBoundaries)
    ? cursor.turnBoundaries
        .filter(
          (entry): entry is ClaudeTurnBoundary =>
            entry !== null &&
            typeof entry === "object" &&
            typeof entry.turnId === "string" &&
            isUuid(entry.assistantUuid),
        )
        .slice(-200)
    : undefined;
  return {
    ...(typeof cursor.hostContractVersion === "string"
      ? { hostContractVersion: cursor.hostContractVersion }
      : {}),
    ...(turnBoundaries ? { turnBoundaries } : {}),
    ...(threadId ? { threadId } : {}),
    ...(resume ? { resume } : {}),
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    ...(turnCount !== undefined ? { turnCount } : {}),
    ...(lastTotalCostUsd !== undefined ? { lastTotalCostUsd } : {}),
    ...(baseContextChars !== undefined ? { baseContextChars } : {}),
    ...(approximateConversationChars !== undefined ? { approximateConversationChars } : {}),
    ...(compactionRecommendationEmitted !== undefined ? { compactionRecommendationEmitted } : {}),
  };
}

/** Metadata for transcript recovery remains attached to the durable cursor. */
export function readClaudeRecoveryMetadata(cursor: unknown): {
  resumeRecoveryGeneration?: string;
  transcriptRepairBackupId?: string;
  missingResumePoint?: string;
} {
  if (!cursor || typeof cursor !== "object") return {};
  const value = cursor as Record<string, unknown>;
  return {
    ...(typeof value.resumeRecoveryGeneration === "string"
      ? { resumeRecoveryGeneration: value.resumeRecoveryGeneration }
      : {}),
    ...(typeof value.transcriptRepairBackupId === "string"
      ? { transcriptRepairBackupId: value.transcriptRepairBackupId }
      : {}),
    ...(typeof value.missingResumePoint === "string"
      ? { missingResumePoint: value.missingResumePoint }
      : {}),
  };
}

/** Bounded native identity metadata, independent of the conversation turn projection. */
export function readClaudeNativeResumeMetadata(cursor: unknown) {
  const record = cursor && typeof cursor === "object" ? (cursor as Record<string, unknown>) : {};
  const tasks: Array<{
    taskId: string;
    toolUseId?: string;
    model?: string;
    description?: string;
    taskType?: string;
  }> = [];
  for (const value of Array.isArray(record.backgroundTasks)
    ? record.backgroundTasks.slice(-512)
    : []) {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.taskId !== "string" ||
      value.taskId.length > 200
    )
      continue;
    const task: (typeof tasks)[number] = { taskId: value.taskId };
    for (const key of ["toolUseId", "model", "description", "taskType"] as const)
      if (typeof value[key] === "string" && value[key].length <= 4000) task[key] = value[key];
    tasks.push(task);
  }
  const receipts: Array<[string, { state: "completed" | "failed"; result?: unknown }]> = [];
  for (const value of Array.isArray(record.nativeReceipts)
    ? record.nativeReceipts.slice(-32)
    : []) {
    if (
      !Array.isArray(value) ||
      typeof value[0] !== "string" ||
      value[0].length > 200 ||
      !value[1] ||
      !["completed", "failed"].includes(value[1].state) ||
      JSON.stringify(value).length > 2048
    )
      continue;
    receipts.push([value[0], { state: value[1].state, result: value[1].result }]);
  }
  const taskIds = Array.isArray(record.nativeTaskIds)
    ? record.nativeTaskIds
        .filter((id): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(id))
        .slice(-512)
    : tasks.map((task) => task.taskId);
  const taskRuns = (Array.isArray(record.nativeTaskRuns) ? record.nativeTaskRuns : [])
    .filter(
      (entry): entry is [string, string] =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        entry.every((value) => typeof value === "string" && value.length <= 2000),
    )
    .slice(-512);
  const taskStops = (Array.isArray(record.nativeTaskStops) ? record.nativeTaskStops : [])
    .filter(
      (entry): entry is [string, string] =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        entry.every((value) => typeof value === "string" && value.length <= 200),
    )
    .slice(-32);
  const providerTitle =
    typeof record.nativeProviderTitle === "string" && record.nativeProviderTitle.length <= 4000
      ? record.nativeProviderTitle
      : undefined;
  return { tasks, receipts, taskIds, taskRuns, taskStops, providerTitle };
}
