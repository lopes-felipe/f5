import type { ThreadId, WorktreesRecoverInput } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ensureNativeApi } from "../../nativeApi";
import { useNextTurnQueueStore } from "../../nextTurnQueueStore";

/**
 * The recorded worktree's state and the `worktrees.recover` call, shared by the
 * missing-worktree banner and the header's "Recreate worktree" control.
 */
export function useWorktreeRecovery(
  threadId: ThreadId | null,
  options: {
    worktreePath?: string | null | undefined;
    branch?: string | null | undefined;
    enabled?: boolean;
  } = {},
) {
  const queryClient = useQueryClient();
  const revision = useNextTurnQueueStore((state) =>
    threadId ? state.byThreadId[threadId]?.snapshot?.revision : undefined,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = useQuery({
    queryKey: [
      "worktrees",
      "threadState",
      threadId,
      options.worktreePath,
      options.branch,
      revision,
    ],
    queryFn: () => ensureNativeApi().worktrees.threadState({ threadId: threadId! }),
    enabled: threadId !== null && options.enabled !== false,
    staleTime: 30_000,
    // Committing or stashing in a terminal changes no query input, so keep a
    // drift banner's "Switch back" availability current while it is shown.
    refetchInterval: (query) => (query.state.data?.branchDriftOnly ? 5_000 : false),
  });
  const recover = async (action: WorktreesRecoverInput["action"]) => {
    if (!threadId) return;
    setBusy(true);
    setError(null);
    try {
      const api = ensureNativeApi();
      const snapshot = await api.nextTurnQueue.list({ threadId });
      await api.worktrees.recover({ threadId, action, expectedQueueRevision: snapshot.revision });
      await queryClient.invalidateQueries({ queryKey: ["git"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Recovery failed.");
    } finally {
      await queryClient.invalidateQueries({ queryKey: ["worktrees"] });
      setBusy(false);
    }
  };
  return { state, busy, error, recover };
}
