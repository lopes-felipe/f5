import {
  type OrchestrationThreadActivity,
  type ThreadId,
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
  if (next.operationId !== current.operationId) return next.startedAt >= current.startedAt;
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
  } | null>(null);

  useEffect(() => {
    if (!threadId) return;
    const api = readNativeApi();
    if (!api) return;
    let disposed = false;
    const accept = (snapshot: WorktreeSetupSnapshot | null) => {
      if (disposed) return;
      setLive((current) =>
        current?.threadId === threadId && !isNewerWorktreeSetup(current.snapshot, snapshot)
          ? current
          : { threadId, snapshot },
      );
    };
    const unsubscribe = api.worktreeSetup.onUpdated((payload) => {
      if (payload.threadId === threadId) accept(payload.snapshot);
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

  const liveSnapshot = live?.threadId === threadId ? live.snapshot : undefined;
  if (liveSnapshot === undefined) return persisted;
  return isNewerWorktreeSetup(persisted, liveSnapshot) ? liveSnapshot : persisted;
}
