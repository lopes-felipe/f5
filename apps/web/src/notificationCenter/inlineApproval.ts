import type { ThreadId } from "@t3tools/contracts";

import { readNativeApi } from "../nativeApi";
import { derivePendingApprovals, type PendingApproval } from "../session-logic";
import type { NotificationApproval } from "./notify";

const INLINE_REQUEST_KINDS = new Set(["command", "file-read", "file-change"]);

/**
 * An approval can be answered from a notification only when it is the thread's single pending
 * one, asks about a command or a file, and offers a plain accept and decline. Anything richer
 * (several requests, permissions, MCP forms, custom choices) opens the thread instead.
 */
export function selectInlineApproval(
  threadId: ThreadId,
  approvals: readonly PendingApproval[],
): NotificationApproval | null {
  if (approvals.length !== 1) return null;
  const approval = approvals[0]!;
  if (!INLINE_REQUEST_KINDS.has(approval.requestKind)) return null;
  if (approval.approvalOptions && approval.approvalOptions.length > 0) {
    const decisions = new Set(approval.approvalOptions.map((option) => option.decision));
    if (!decisions.has("accept") || !decisions.has("decline")) return null;
  }
  return {
    threadId,
    requestId: approval.requestId,
    requestKind: approval.requestKind,
    ...(approval.detail ? { detail: approval.detail } : {}),
  };
}

const INLINE_APPROVAL_LOOKUP_TIMEOUT_MS = 1_500;

/**
 * Background threads load without activities, so the pending approval is read on demand. A
 * slow or failed read never holds the notification back: it goes out with "Open" only.
 */
export async function loadInlineApproval(
  threadId: ThreadId,
  timeoutMs = INLINE_APPROVAL_LOOKUP_TIMEOUT_MS,
): Promise<NotificationApproval | null> {
  let api: ReturnType<typeof readNativeApi>;
  try {
    api = readNativeApi();
  } catch {
    return null;
  }
  if (!api) return null;
  const orchestration = api.orchestration;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  // `Promise.resolve().then` turns a synchronous throw (no transport yet) into a rejection.
  const lookup = Promise.resolve()
    .then(() =>
      orchestration.getThreadTailDetails({ threadId, messageLimit: 0, checkpointLimit: 0 }),
    )
    .then((details) => selectInlineApproval(threadId, derivePendingApprovals(details.activities)))
    .catch(() => null);
  try {
    return await Promise.race([lookup, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
