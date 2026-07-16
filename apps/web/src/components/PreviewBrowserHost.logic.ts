import type { ThreadId } from "@t3tools/contracts";

export interface PreviewProjectionEntry<TTarget = HTMLDivElement> {
  readonly threadId: ThreadId;
  readonly target: TTarget | null;
  readonly visible: boolean;
  readonly onClose: () => void;
}

export const MAX_PERSISTENT_PREVIEW_INSTANCES = 4;

export function projectPreviewEntry<TTarget>(
  current: ReadonlyMap<ThreadId, PreviewProjectionEntry<TTarget>>,
  entry: PreviewProjectionEntry<TTarget>,
  maximumEntries = MAX_PERSISTENT_PREVIEW_INSTANCES,
): ReadonlyMap<ThreadId, PreviewProjectionEntry<TTarget>> {
  const existing = current.get(entry.threadId);
  if (
    existing?.target === entry.target &&
    existing.visible === entry.visible &&
    existing.onClose === entry.onClose
  ) {
    return current;
  }
  const next = new Map(current);
  // Map insertion order doubles as an LRU. Re-projecting a thread makes it the
  // most recently used persistent preview instance.
  next.delete(entry.threadId);
  next.set(entry.threadId, entry);
  while (next.size > Math.max(1, maximumEntries)) {
    const evictionCandidate = [...next.entries()].find(
      ([threadId, candidate]) => threadId !== entry.threadId && !candidate.visible,
    );
    if (!evictionCandidate) break;
    next.delete(evictionCandidate[0]);
  }
  return next;
}

export function clearPreviewProjection<TTarget>(
  current: ReadonlyMap<ThreadId, PreviewProjectionEntry<TTarget>>,
  threadId: ThreadId,
  target: TTarget,
): ReadonlyMap<ThreadId, PreviewProjectionEntry<TTarget>> {
  const existing = current.get(threadId);
  if (!existing || existing.target !== target) return current;
  const next = new Map(current);
  next.set(threadId, { ...existing, target: null, visible: false });
  return next;
}
