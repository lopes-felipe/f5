import {
  formatThreadReference,
  isThreadReferenceId,
  THREAD_REFERENCE_MAX_PER_MESSAGE,
} from "@t3tools/shared/threadReferences";

import { promptLinkScheme } from "../components/promptLinks/copyPromptLink";

export const F5_THREAD_REFERENCE_MIME = "application/x-f5-thread-reference";
const MAX_PAYLOAD_LENGTH = 16 * 1024;
const MAX_TITLE_LENGTH = 500;

export interface ThreadReferenceDragItem {
  readonly threadId: string;
  readonly title: string;
}

export function hasThreadReferenceDrag(types: ArrayLike<string>): boolean {
  return Array.from(types).includes(F5_THREAD_REFERENCE_MIME);
}

/** Starts a thread drag. Text fields that do not claim the drop receive the plain links. */
export function writeThreadReferenceDrag(
  transfer: Pick<DataTransfer, "setData" | "effectAllowed">,
  threads: ReadonlyArray<ThreadReferenceDragItem>,
): boolean {
  const items = threads
    .filter((thread) => isThreadReferenceId(thread.threadId))
    .slice(0, THREAD_REFERENCE_MAX_PER_MESSAGE)
    .map((thread) => ({
      threadId: thread.threadId,
      title: thread.title.slice(0, MAX_TITLE_LENGTH),
    }));
  if (items.length === 0) return false;
  transfer.effectAllowed = "copy";
  transfer.setData(F5_THREAD_REFERENCE_MIME, JSON.stringify({ version: 1, threads: items }));
  transfer.setData(
    "text/plain",
    items.map((item) => formatThreadReference({ ...item, scheme: promptLinkScheme })).join(" "),
  );
  return true;
}

export function readThreadReferenceDrag(
  transfer: Pick<DataTransfer, "getData" | "types">,
): ThreadReferenceDragItem[] | null {
  if (!hasThreadReferenceDrag(transfer.types)) return null;
  const raw = transfer.getData(F5_THREAD_REFERENCE_MIME);
  if (raw.length > MAX_PAYLOAD_LENGTH) return null;
  try {
    const value = JSON.parse(raw) as { version?: unknown; threads?: unknown } | null;
    if (value?.version !== 1 || !Array.isArray(value.threads)) return null;
    const threads: unknown[] = value.threads;
    if (threads.length === 0 || threads.length > THREAD_REFERENCE_MAX_PER_MESSAGE) return null;
    const items: ThreadReferenceDragItem[] = [];
    for (const entry of threads) {
      if (!entry || typeof entry !== "object") return null;
      const { threadId, title } = entry as { threadId?: unknown; title?: unknown };
      if (typeof threadId !== "string" || !isThreadReferenceId(threadId)) return null;
      if (typeof title !== "string" || title.length > MAX_TITLE_LENGTH) return null;
      items.push({ threadId, title });
    }
    return items;
  } catch {
    return null;
  }
}
