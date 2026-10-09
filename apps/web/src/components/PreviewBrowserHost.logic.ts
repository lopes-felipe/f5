import type { ThreadId } from "@t3tools/contracts";

export interface PreviewProjectionEntry<TTarget = HTMLDivElement> {
  readonly threadId: ThreadId;
  readonly target: TTarget | null;
  readonly visible: boolean;
  readonly onClose: () => void;
  /** Agent-requested headless preview; never evicted while pinned. */
  readonly pinned?: boolean;
  /** Created for an agent and never shown to the user. */
  readonly headless?: boolean;
}

export const MAX_PERSISTENT_PREVIEW_INSTANCES = 4;
export const MAX_PINNED_PREVIEW_INSTANCES = 2;
export const PINNED_PREVIEW_IDLE_MS = 10 * 60_000;

function evictUntilWithinLimit<TTarget>(
  next: Map<ThreadId, PreviewProjectionEntry<TTarget>>,
  keepThreadId: ThreadId,
  maximumEntries: number,
): void {
  while (next.size > Math.max(1, maximumEntries)) {
    const evictionCandidate = [...next.entries()].find(
      ([threadId, candidate]) =>
        threadId !== keepThreadId && !candidate.visible && candidate.pinned !== true,
    );
    if (!evictionCandidate) break;
    next.delete(evictionCandidate[0]);
  }
}

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
  next.set(entry.threadId, existing?.pinned ? { ...entry, pinned: true } : entry);
  evictUntilWithinLimit(next, entry.threadId, maximumEntries);
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

export type EnsureHeadlessPreviewResult<TTarget> =
  | { readonly ok: true; readonly entries: ReadonlyMap<ThreadId, PreviewProjectionEntry<TTarget>> }
  | { readonly ok: false; readonly reason: "capacity-exceeded" };

/**
 * Mounts (or pins) a preview for an agent without projecting it anywhere. Pinned entries
 * survive LRU eviction; when every slot is pinned or visible the request is refused.
 */
export function ensureHeadlessPreviewEntry<TTarget>(
  current: ReadonlyMap<ThreadId, PreviewProjectionEntry<TTarget>>,
  threadId: ThreadId,
  onClose: () => void,
  limits: { readonly maximumEntries?: number; readonly maximumPinned?: number } = {},
): EnsureHeadlessPreviewResult<TTarget> {
  const maximumEntries = limits.maximumEntries ?? MAX_PERSISTENT_PREVIEW_INSTANCES;
  const maximumPinned = limits.maximumPinned ?? MAX_PINNED_PREVIEW_INSTANCES;
  const existing = current.get(threadId);
  if (existing?.pinned) return { ok: true, entries: current };
  const pinnedElsewhere = [...current.values()].filter(
    (entry) => entry.pinned && entry.threadId !== threadId,
  ).length;
  if (pinnedElsewhere >= maximumPinned) return { ok: false, reason: "capacity-exceeded" };
  const next = new Map(current);
  next.set(
    threadId,
    existing
      ? { ...existing, pinned: true }
      : { threadId, target: null, visible: false, onClose, pinned: true, headless: true },
  );
  evictUntilWithinLimit(next, threadId, maximumEntries);
  if (next.size > Math.max(1, maximumEntries)) return { ok: false, reason: "capacity-exceeded" };
  return { ok: true, entries: next };
}

/** Makes an agent preview evictable again; a never-projected headless entry is dropped. */
export function unpinPreviewEntry<TTarget>(
  current: ReadonlyMap<ThreadId, PreviewProjectionEntry<TTarget>>,
  threadId: ThreadId,
): ReadonlyMap<ThreadId, PreviewProjectionEntry<TTarget>> {
  const existing = current.get(threadId);
  if (!existing?.pinned) return current;
  const next = new Map(current);
  if (existing.headless && existing.target === null) next.delete(threadId);
  else next.set(threadId, { ...existing, pinned: false });
  return next;
}
