import type { ThreadId, WorktreesRecoverInput } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ensureNativeApi } from "../../nativeApi";
import { useNextTurnQueueStore } from "../../nextTurnQueueStore";
import { Button } from "../ui/button";

export function WorktreeMissingBanner({
  threadId,
  worktreePath,
  branch,
  queue = false,
}: {
  threadId: ThreadId;
  worktreePath?: string | null;
  branch?: string | null;
  queue?: boolean;
}) {
  const queryClient = useQueryClient();
  const revision = useNextTurnQueueStore((state) => state.byThreadId[threadId]?.snapshot?.revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = useQuery({
    queryKey: ["worktrees", "threadState", threadId, worktreePath, branch, revision],
    queryFn: () => ensureNativeApi().worktrees.threadState({ threadId }),
    enabled: queue || Boolean(worktreePath),
    staleTime: 30_000,
  });
  const recover = async (action: WorktreesRecoverInput["action"]) => {
    setBusy(true);
    setError(null);
    try {
      const api = ensureNativeApi();
      const snapshot = await api.nextTurnQueue.list({ threadId });
      await api.worktrees.recover({ threadId, action, expectedQueueRevision: snapshot.revision });
      await queryClient.invalidateQueries({ queryKey: ["worktrees"] });
      await queryClient.invalidateQueries({ queryKey: ["git"] });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Recovery failed.");
    } finally {
      setBusy(false);
    }
  };
  if (state.error)
    return (
      <div role="alert" className="space-y-2 rounded border border-warning/40 p-3 text-sm">
        <p>The recorded workspace could not be verified. {state.error.message}</p>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void recover("useProjectCheckout")}
        >
          Continue in project checkout
        </Button>
        {error && <p className="text-destructive">{error}</p>}
      </div>
    );
  if (
    !state.data?.worktreePath ||
    (!queue &&
      (state.data.registration === "matching" ||
        (state.data.branchExists &&
          !state.data.directoryExists &&
          state.data.registration !== "otherBranch")))
  )
    return null;
  const data = state.data;
  const canRecreateOriginal =
    data.branchExists &&
    (data.registration === "matching" ||
      (!data.directoryExists && data.registration !== "otherBranch"));
  return (
    <div
      className="space-y-2 rounded border border-warning/40 bg-warning/5 p-3 text-sm"
      role="status"
    >
      <p>
        {data.branchExists || data.directoryExists
          ? "This conversation's worktree needs recovery."
          : `This thread's worktree and branch ${data.branch ?? "(unknown)"} are gone.`}
      </p>
      <div className="flex flex-wrap gap-2">
        {canRecreateOriginal ? (
          <Button size="sm" disabled={busy} onClick={() => void recover("recreate")}>
            Recreate now
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy || !data.defaultBranch}
            onClick={() => void recover("recreateFromBase")}
          >
            Recreate from {data.defaultBranch ?? "default branch"}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void recover("useProjectCheckout")}
        >
          Continue in project checkout
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
