import {
  type OrchestrationThreadActivity,
  type ThreadId,
  type WorktreeSetupSubscribeResult,
  WorktreeSetupSnapshot,
  worktreeSetupActivityId,
} from "@t3tools/contracts";
import { Schema } from "effect";
import { useEffect, useMemo, useState } from "react";

import { readNativeApi } from "../nativeApi";

const decodeSnapshot = Schema.decodeUnknownOption(WorktreeSetupSnapshot);

/** Newer wins: a retry starts a new operation, and sequences grow within one. */
export function isNewerWorktreeSetup(
  current: WorktreeSetupSnapshot | null,
  next: WorktreeSetupSnapshot | null,
): boolean {
  if (next === null || current === null) return true;
  if (next.generation !== current.generation) return next.generation > current.generation;
  return next.sequence > current.sequence;
}

/** The setup snapshot persisted as the thread's `worktree-setup` activity. */
export function persistedWorktreeSetup(
  threadId: ThreadId,
  activities: ReadonlyArray<OrchestrationThreadActivity> | undefined,
): WorktreeSetupSnapshot | null {
  const activity = activities?.find((entry) => entry.id === worktreeSetupActivityId(threadId));
  if (!activity) return null;
  const decoded = decodeSnapshot(activity.payload);
  return decoded._tag === "Some" ? decoded.value : null;
}

/**
 * Live worktree setup progress for a thread. The server pushes every change;
 * the persisted activity covers a reload or a client that missed the stream,
 * so progress stays visible after navigating away and back.
 */
export function useWorktreeSetup(
  threadId: ThreadId | null,
  activities: ReadonlyArray<OrchestrationThreadActivity> | undefined,
): WorktreeSetupSnapshot | null {
  const persisted = useMemo(
    () => (threadId ? persistedWorktreeSetup(threadId, activities) : null),
    [activities, threadId],
  );
  const [live, setLive] = useState<{
    readonly threadId: ThreadId;
    readonly snapshot: WorktreeSetupSnapshot | null;
    readonly generation: number;
    readonly sequence: number;
  } | null>(null);

  useEffect(() => {
    if (!threadId) return;
    const api = readNativeApi();
    if (!api) return;
    let disposed = false;
    const accept = (next: WorktreeSetupSubscribeResult) => {
      if (disposed) return;
      setLive((current) => {
        if (
          current?.threadId === threadId &&
          (current.generation > next.generation ||
            (current.generation === next.generation && current.sequence >= next.sequence))
        )
          return current;
        return { threadId, ...next };
      });
    };
    const unsubscribe = api.worktreeSetup.onUpdated((payload) => {
      if (payload.threadId === threadId) accept(payload);
    });
    void api.worktreeSetup
      .subscribe({ threadId })
      .then(accept)
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [threadId]);

  if (live?.threadId !== threadId) return persisted;
  if (
    persisted &&
    (persisted.generation > live.generation ||
      (persisted.generation === live.generation && persisted.sequence > live.sequence))
  )
    return persisted;
  return live.snapshot;
}
