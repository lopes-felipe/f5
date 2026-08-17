import type { OrchestrationSession, ThreadId } from "@t3tools/contracts";
import { sanitizeThreadErrorMessage } from "./transportError";

const MAX_DISMISSED_ERRORS_PER_THREAD = 32;
const MAX_THREADS_WITH_DISMISSALS = 256;
const dismissedErrorIdsByThread = new Map<string, string[]>();

export function dismissThreadSessionError(threadId: ThreadId, errorId: string | null): void {
  if (!errorId) return;
  const existing = dismissedErrorIdsByThread.get(threadId) ?? [];
  const next = [...existing.filter((id) => id !== errorId), errorId].slice(
    -MAX_DISMISSED_ERRORS_PER_THREAD,
  );
  dismissedErrorIdsByThread.delete(threadId);
  dismissedErrorIdsByThread.set(threadId, next);
  while (dismissedErrorIdsByThread.size > MAX_THREADS_WITH_DISMISSALS) {
    const oldestThreadId = dismissedErrorIdsByThread.keys().next().value;
    if (typeof oldestThreadId !== "string") break;
    dismissedErrorIdsByThread.delete(oldestThreadId);
  }
}

export function isThreadSessionErrorDismissed(threadId: ThreadId, errorId: string | null): boolean {
  if (!errorId) return false;
  return dismissedErrorIdsByThread.get(threadId)?.includes(errorId) ?? false;
}

export function visibleThreadSessionError(
  threadId: ThreadId,
  session: OrchestrationSession | null | undefined,
): string | null {
  const message = sanitizeThreadErrorMessage(session?.lastError);
  if (!message) return null;
  if (isThreadSessionErrorDismissed(threadId, session?.lastErrorId ?? null)) return null;
  return message;
}

export function resetThreadErrorDismissalsForTests(): void {
  dismissedErrorIdsByThread.clear();
}
