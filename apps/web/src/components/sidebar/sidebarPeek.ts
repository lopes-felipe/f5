import {
  type OrchestrationLatestTurn,
  type OrchestrationThreadPeek,
  type PendingUserInput,
  THREAD_PEEK_ASSISTANT_TEXT_MAX_CHARS,
  THREAD_PEEK_USER_TEXT_MAX_CHARS,
  type ThreadId,
} from "@t3tools/contracts";
import { isTurnInProgress, truncateMessagePreview } from "@t3tools/shared/turnAssistantMessage";
import { queryOptions } from "@tanstack/react-query";

import { formatRelativeTimeLabel } from "../../lib/relativeTime";
import { rpcQueryContext } from "../../lib/rpcQueryContext";
import { ensureNativeApi } from "../../nativeApi";
import { formatDuration } from "../../session-logic";
import type { ThreadStatusPill } from "../../threadStatus";
import type { Thread } from "../../types";

/** Hover delay before a sidebar row's peek card opens; moving to another row swaps it at once. */
export const SIDEBAR_PEEK_DELAY_MS = 500;
export const SIDEBAR_PEEK_CLOSE_DELAY_MS = 100;

/**
 * Markdown as one line of plain text for the peek card's reply snippet: keeps code, link and
 * image text, drops markup, and collapses whitespace.
 */
export function stripMarkdownToPlainText(markdown: string): string {
  return (
    markdown
      // Fenced code keeps its contents, without the fence or language.
      .replace(/^\s*(```|~~~)[^\n]*$/gm, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<\/?[a-z][^>]*>/gi, "")
      .replace(/^\s*(?:>\s?)+/gm, "")
      .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "")
      .replace(/^\s*(?:[-*_]\s*){3,}$/gm, "")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
      .replace(/\*(?=\S)(.+?)(?<=\S)\*/g, "$1")
      // Underscores only emphasize at word edges, so snake_case survives.
      .replace(/(^|\W)_(?=\S)(.+?)(?<=\S)_(?=\W|$)/g, "$1$2")
      .replace(/~~(.+?)~~/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** The first question of the oldest pending request, shown in place of the reply. */
export function firstPendingQuestion(
  pendingUserInputs: ReadonlyArray<Pick<PendingUserInput, "questions">> | undefined,
): string | null {
  for (const input of pendingUserInputs ?? []) {
    const question = input.questions[0]?.question.trim();
    if (question) return question;
  }
  return null;
}

/** Whole-percent context use, or null when either count is unknown. */
export function contextUsagePercent(
  estimatedTokens: number | null | undefined,
  windowTokens: number | null | undefined,
): number | null {
  if (estimatedTokens == null || windowTokens == null || windowTokens <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((estimatedTokens / windowTokens) * 100)));
}

export interface SidebarPeekStatus {
  readonly label: string;
  readonly detail: string | null;
}

/**
 * The card's status line: how long a turn has been working, when a done turn finished (and
 * whether it is unread), or the first line of a failure.
 */
export function resolveSidebarPeekStatus(input: {
  readonly pill: ThreadStatusPill | null;
  readonly latestTurn: Pick<
    OrchestrationLatestTurn,
    "requestedAt" | "startedAt" | "completedAt"
  > | null;
  readonly error: string | null;
  readonly isUnread: boolean;
  readonly now: number;
}): SidebarPeekStatus | null {
  const { pill, latestTurn, now } = input;
  const errorLine =
    input.error
      ?.split("\n")
      .find((line) => line.trim())
      ?.trim() ?? null;
  if (!pill) return errorLine ? { label: "Failed", detail: errorLine } : null;
  switch (pill.label) {
    case "Working":
    case "Connecting": {
      const startedAt = Date.parse(latestTurn?.startedAt ?? latestTurn?.requestedAt ?? "");
      return {
        label: pill.label,
        detail: Number.isFinite(startedAt) ? `for ${formatDuration(now - startedAt)}` : null,
      };
    }
    case "Completed": {
      const finished = latestTurn?.completedAt
        ? formatRelativeTimeLabel(latestTurn.completedAt, now)
        : "";
      const detail = [finished, input.isUnread ? "unread" : ""].filter(Boolean).join(" · ");
      return { label: "Done", detail: detail || null };
    }
    case "Failed":
      return { label: "Failed", detail: errorLine };
    default:
      return { label: pill.label, detail: null };
  }
}

/**
 * The RPC's fields derived from a thread whose details are already loaded, so the card skips
 * the request. The reply comes from the newest settled assistant message outside a running turn.
 */
export function localThreadPeek(
  thread: Pick<
    Thread,
    "id" | "detailsLoaded" | "messages" | "latestTurn" | "turnDiffSummaries" | "history"
  >,
): OrchestrationThreadPeek | null {
  if (!thread.detailsLoaded) return null;
  // Same rule as the server's `readThreadPeek`: skip only a turn still producing output.
  const inProgressTurnId =
    thread.latestTurn && isTurnInProgress(thread.latestTurn.state)
      ? thread.latestTurn.turnId
      : null;
  const lastUser = thread.messages.findLast(
    (message) => message.role === "user" && message.text.trim().length > 0,
  );
  const lastReply = thread.messages.findLast(
    (message) =>
      message.role === "assistant" &&
      !message.streaming &&
      message.text.trim().length > 0 &&
      (inProgressTurnId === null || message.turnId !== inProgressTurnId),
  );
  // Only a tail of history is loaded: what is missing may be older, so ask the server.
  if (thread.history?.hasOlderMessages && (!lastUser || !lastReply)) return null;
  const latestDiff = thread.turnDiffSummaries.at(-1);
  const files = latestDiff?.files ?? [];
  return {
    threadId: thread.id,
    lastUserText: lastUser
      ? truncateMessagePreview(lastUser.text, THREAD_PEEK_USER_TEXT_MAX_CHARS)
      : null,
    lastAssistantText: lastReply
      ? truncateMessagePreview(lastReply.text, THREAD_PEEK_ASSISTANT_TEXT_MAX_CHARS)
      : null,
    latestTurnDiff:
      files.length === 0
        ? null
        : {
            files: files.length,
            additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
            deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
          },
  };
}

/**
 * The peek RPC, cached per thread and latest turn state, so a finished or new turn refetches
 * while hovering back and forth within 30s does not.
 */
export function threadPeekQueryOptions(
  threadId: ThreadId,
  latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "state"> | null,
) {
  return queryOptions({
    queryKey: [
      "sidebar-thread-peek",
      threadId,
      latestTurn ? `${latestTurn.turnId}:${latestTurn.state}` : null,
    ] as const,
    // Forwards the abort signal and `meta.priority` (the hover prefetch is background).
    queryFn: (context) =>
      ensureNativeApi().orchestration.getThreadPeek({ threadId }, rpcQueryContext(context)),
    staleTime: 30_000,
  });
}
