import type { ThreadId } from "@t3tools/contracts";

const listeners = new Set<(threadId: ThreadId) => void>();
const pending = new Map<ThreadId, Promise<unknown>>();

export function notifyComposerModelPick(threadId: ThreadId): void {
  for (const listener of listeners) listener(threadId);
}

export function subscribeComposerModelPicks(listener: (threadId: ThreadId) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function queueComposerModelPick(threadId: ThreadId, save: () => Promise<unknown>) {
  const previous = pending.get(threadId);
  const next = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(save);
  pending.set(threadId, next);
  const clear = () => {
    if (pending.get(threadId) === next) pending.delete(threadId);
  };
  void next.then(clear, clear);
  return next;
}

export function pendingComposerModelPick(threadId: ThreadId): Promise<unknown> | undefined {
  return pending.get(threadId);
}
