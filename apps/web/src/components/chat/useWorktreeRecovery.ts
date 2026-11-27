import type {
  ThreadId,
  WorktreesRecoverInput,
  WorktreesThreadStateResult,
} from "@t3tools/contracts";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { ensureNativeApi } from "../../nativeApi";
import { useNextTurnQueueStore } from "../../nextTurnQueueStore";

/** The original branch can come back only when it still exists and nothing else took the path. */
export const canRecreateOriginal = (data: WorktreesThreadStateResult) =>
  data.branchExists && (data.registration === "matching" || !data.directoryExists);

/**
 * What the main "recreate" action does for this state, or why there is none.
 * Shared by the missing-worktree banner and the header so they never disagree.
 */
export type RecreatePlan =
  | { readonly action: "recreate" }
  | { readonly action: "recreateFromBase"; readonly base: string }
  | { readonly action: null; readonly reason: string };

export function recreatePlan(data: WorktreesThreadStateResult | undefined): RecreatePlan {
  if (!data) return { action: null, reason: "Checking the worktree…" };
  if (canRecreateOriginal(data)) return { action: "recreate" };
  // The path now holds something that is not this repository's worktree; it is kept.
  if (data.registration === "foreign")
    return {
      action: null,
      reason:
        "The recorded folder no longer belongs to this repository. Choose another workspace to continue.",
    };
  if (!data.defaultBranch) return { action: null, reason: "No default branch to recreate from." };
  return { action: "recreateFromBase", base: data.defaultBranch };
}

const recoverKey = (threadId: ThreadId | null) => ["worktrees", "recover", threadId] as const;

/**
 * The recorded worktree's state and the `worktrees.recover` call, shared by the
 * missing-worktree banner and the header's "Recreate worktree" control. The
 * in-flight flag is keyed by thread, so both surfaces see the same request.
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
  });
  const mutation = useMutation({
    mutationKey: recoverKey(threadId),
    mutationFn: async (action: WorktreesRecoverInput["action"]) => {
      if (!threadId) return;
      const api = ensureNativeApi();
      const snapshot = await api.nextTurnQueue.list({ threadId });
      await api.worktrees.recover({ threadId, action, expectedQueueRevision: snapshot.revision });
      await queryClient.invalidateQueries({ queryKey: ["git"] });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["worktrees"] }),
  });
  const busy = useIsMutating({ mutationKey: recoverKey(threadId) }) > 0;
  // A component kept across threads must not show another thread's failure.
  const { reset } = mutation;
  useEffect(() => reset(), [reset, threadId]);
  const error = mutation.error
    ? mutation.error instanceof Error
      ? mutation.error.message
      : "Recovery failed."
    : null;
  const recover = (action: WorktreesRecoverInput["action"]) =>
    mutation.mutateAsync(action).catch(() => undefined);
  return { state, busy, error, recover };
}
