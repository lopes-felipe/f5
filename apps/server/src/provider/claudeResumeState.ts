import { ThreadId } from "@t3tools/contracts";

export interface ClaudeTurnBoundary {
  readonly turnId: string;
  readonly assistantUuid: string;
}

export interface ClaudeResumeState {
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
