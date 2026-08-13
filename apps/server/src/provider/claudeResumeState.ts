import { ThreadId } from "@t3tools/contracts";

export interface ClaudeResumeState {
  readonly threadId?: ThreadId;
  readonly resume?: string;
  readonly resumeSessionAt?: string;
  readonly turnCount?: number;
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
    threadId?: unknown;
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
  return {
    ...(threadId ? { threadId } : {}),
    ...(resume ? { resume } : {}),
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    ...(turnCount !== undefined ? { turnCount } : {}),
    ...(baseContextChars !== undefined ? { baseContextChars } : {}),
    ...(approximateConversationChars !== undefined ? { approximateConversationChars } : {}),
    ...(compactionRecommendationEmitted !== undefined ? { compactionRecommendationEmitted } : {}),
  };
}
