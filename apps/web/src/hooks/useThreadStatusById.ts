import type { ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { resolveThreadStatusForThread, type ThreadStatus } from "../threadStatus";
import type { Thread } from "../types";

export type ThreadStatusById = ReadonlyMap<ThreadId, ThreadStatus>;

export function buildThreadStatusById(threads: ReadonlyArray<Thread>): ThreadStatusById {
  const statusById = new Map<ThreadId, ThreadStatus>();
  for (const thread of threads) {
    statusById.set(thread.id, resolveThreadStatusForThread(thread));
  }
  return statusById;
}

/**
 * One memoized status per thread, shared by lists (sidebar, Home) so each row
 * does a map lookup instead of re-deriving pending approvals and user input.
 * Threads missing from the map (unsaved drafts) have no status.
 */
export function useThreadStatusById(threads: ReadonlyArray<Thread>): ThreadStatusById {
  return useMemo(() => buildThreadStatusById(threads), [threads]);
}
