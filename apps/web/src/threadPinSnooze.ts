import { MAX_PINNED_THREADS, type ThreadId } from "@t3tools/contracts";

import { newCommandId } from "./lib/utils";
import { isSnoozedThread } from "./lib/threadOrdering";
import { ensureNativeApi } from "./nativeApi";
import type { Thread } from "./types";

export function orderedPinnedThreadIds(threads: ReadonlyArray<Thread>): ThreadId[] {
  return threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.pinnedAt != null &&
        thread.pinOrderKey != null &&
        !isSnoozedThread(thread),
    )
    .toSorted(
      (left, right) =>
        (left.pinOrderKey ?? Number.MAX_SAFE_INTEGER) -
          (right.pinOrderKey ?? Number.MAX_SAFE_INTEGER) ||
        (left.pinnedAt ?? "").localeCompare(right.pinnedAt ?? "") ||
        left.id.localeCompare(right.id),
    )
    .slice(0, MAX_PINNED_THREADS)
    .map((thread) => thread.id);
}

export async function replacePinnedThreads(input: {
  readonly anchorThreadId: ThreadId;
  readonly pinnedThreadIds: ReadonlyArray<ThreadId>;
  readonly expectedRevision: number;
}): Promise<void> {
  await ensureNativeApi().orchestration.dispatchCommand({
    type: "thread.pins.replace",
    commandId: newCommandId(),
    threadId: input.anchorThreadId,
    pinnedThreadIds: [...input.pinnedThreadIds],
    expectedRevision: input.expectedRevision,
    createdAt: new Date().toISOString(),
  });
}

export async function importLegacyPinnedThreads(input: {
  readonly anchorThreadId: ThreadId;
  readonly legacyThreadIds: ReadonlyArray<ThreadId>;
  readonly expectedRevision: number;
}): Promise<void> {
  await ensureNativeApi().orchestration.dispatchCommand({
    type: "thread.pins.import-legacy",
    commandId: newCommandId(),
    threadId: input.anchorThreadId,
    legacyThreadIds: [...input.legacyThreadIds],
    expectedRevision: input.expectedRevision,
    createdAt: new Date().toISOString(),
  });
}

export async function toggleThreadPin(input: {
  readonly threadId: ThreadId;
  readonly threads: ReadonlyArray<Thread>;
  readonly expectedRevision: number;
}): Promise<void> {
  const current = orderedPinnedThreadIds(input.threads);
  const isPinned = current.includes(input.threadId);
  const next = isPinned
    ? current.filter((threadId) => threadId !== input.threadId)
    : [input.threadId, ...current].slice(0, MAX_PINNED_THREADS);
  await replacePinnedThreads({
    anchorThreadId: input.threadId,
    pinnedThreadIds: next,
    expectedRevision: input.expectedRevision,
  });
}

export async function snoozeThread(threadId: ThreadId, until: string): Promise<void> {
  await ensureNativeApi().orchestration.dispatchCommand({
    type: "thread.snooze",
    commandId: newCommandId(),
    threadId,
    until,
    createdAt: new Date().toISOString(),
  });
}

export async function wakeThread(thread: Pick<Thread, "id" | "snoozedUntil">): Promise<void> {
  await ensureNativeApi().orchestration.dispatchCommand({
    type: "thread.unsnooze",
    commandId: newCommandId(),
    threadId: thread.id,
    ...(thread.snoozedUntil != null ? { expectedSnoozedUntil: thread.snoozedUntil } : {}),
    createdAt: new Date().toISOString(),
  });
}
