import type { ThreadId } from "@t3tools/contracts";
import { automationToolSurface } from "@t3tools/shared/computerAction";

export const TOOL_UPDATE_COALESCE_WINDOW_MS = 50;
export const MAX_PENDING_TOOL_UPDATES_PER_THREAD = 512;

/**
 * Clients fold every snapshot of a Codex collaboration or computer/preview call and keep
 * fields that only earlier snapshots carried, so those updates are never superseded.
 */
export function isSupersedableToolUpdate(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return true;
  const fields = payload as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  if (fields.codexCollaborationTool !== undefined) return false;
  return (
    automationToolSurface({
      computerTool: fields.computerTool === true,
      itemType: text(fields.itemType),
      mcpServerName: text(fields.mcpServerName),
      mcpToolName: text(fields.mcpToolName),
    }) === undefined
  );
}

interface ThreadWindow<A> {
  timer: ReturnType<typeof setTimeout> | null;
  readonly updates: Map<string, A>;
}

/**
 * Holds in-flight tool updates per thread for a short window and keeps only
 * the newest update per tool item. The window opens with the first pending
 * update and closes after `windowMs` regardless of later updates, so a busy
 * tool still reports progress at a steady cadence. Survivors are returned in
 * the order of their latest update.
 *
 * Callers flush a thread before any other event for it, so the newest update
 * always lands ahead of the event that follows it.
 */
export interface ToolUpdateCoalescer<A> {
  /** Returns true when the thread reached its pending limit and must flush now. */
  readonly offer: (threadId: ThreadId, key: string, update: A) => boolean;
  readonly discard: (threadId: ThreadId, key: string) => void;
  readonly take: (threadId: ThreadId) => ReadonlyArray<A>;
  readonly threadIds: () => ReadonlyArray<ThreadId>;
  readonly cancelTimers: () => void;
}

export function makeToolUpdateCoalescer<A>(options: {
  readonly onWindowClosed: (threadId: ThreadId) => void;
  readonly windowMs?: number;
  readonly maxPendingPerThread?: number;
}): ToolUpdateCoalescer<A> {
  const windowMs = options.windowMs ?? TOOL_UPDATE_COALESCE_WINDOW_MS;
  const maxPending = options.maxPendingPerThread ?? MAX_PENDING_TOOL_UPDATES_PER_THREAD;
  const windows = new Map<ThreadId, ThreadWindow<A>>();

  const clearTimer = (window: ThreadWindow<A>) => {
    if (window.timer !== null) clearTimeout(window.timer);
    window.timer = null;
  };

  return {
    offer(threadId, key, update) {
      let window = windows.get(threadId);
      if (!window) {
        window = { timer: null, updates: new Map() };
        windows.set(threadId, window);
      }
      window.updates.delete(key);
      window.updates.set(key, update);
      if (window.timer === null) {
        const opened = window;
        window.timer = setTimeout(() => {
          opened.timer = null;
          if (windows.get(threadId) === opened) options.onWindowClosed(threadId);
        }, windowMs);
        window.timer.unref?.();
      }
      return window.updates.size >= maxPending;
    },
    discard(threadId, key) {
      const window = windows.get(threadId);
      if (!window) return;
      window.updates.delete(key);
      if (window.updates.size > 0) return;
      clearTimer(window);
      windows.delete(threadId);
    },
    take(threadId) {
      const window = windows.get(threadId);
      if (!window) return [];
      clearTimer(window);
      windows.delete(threadId);
      return [...window.updates.values()];
    },
    threadIds: () => [...windows.keys()],
    cancelTimers() {
      for (const window of windows.values()) clearTimer(window);
    },
  };
}
