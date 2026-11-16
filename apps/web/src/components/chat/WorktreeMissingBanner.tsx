import type { ThreadId, WorktreesRecoverInput } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { ensureNativeApi } from "../../nativeApi";
import { useNextTurnQueueStore } from "../../nextTurnQueueStore";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

const AFTER_TURN_REASON = "Available after the current turn finishes.";

export function WorktreeMissingBanner({
  threadId,
  worktreePath,
  branch,
  queueBlocked = false,
  turnActive = false,
}: {
  threadId: ThreadId;
  worktreePath?: string | null;
  branch?: string | null;
  /** The queue is paused on this workspace, so a lazily recreatable worktree still needs action. */
  queueBlocked?: boolean;
  /** Workspace transitions are refused while a turn is active or pending. */
  turnActive?: boolean;
}) {
  const queryClient = useQueryClient();
  const revision = useNextTurnQueueStore((state) => state.byThreadId[threadId]?.snapshot?.revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = useQuery({
    queryKey: ["worktrees", "threadState", threadId, worktreePath, branch, revision],
    queryFn: () => ensureNativeApi().worktrees.threadState({ threadId }),
    enabled: true,
    staleTime: 30_000,
    // Committing or stashing in a terminal changes no query input, so keep a
    // drift banner's "Switch back" availability current while it is shown.
    refetchInterval: (query) => (query.state.data?.branchDriftOnly ? 5_000 : false),
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
      await queryClient.invalidateQueries({ queryKey: ["worktrees"] });
      setBusy(false);
    }
  };
  const errorLine = error && (
    <p role="alert" className="text-destructive">
      {error}
    </p>
  );
  const turnLine = turnActive && (
    <p className="text-muted-foreground text-xs">{AFTER_TURN_REASON}</p>
  );
  if (state.error)
    return (
      <div role="alert" className="space-y-2 rounded border border-warning/40 p-3 text-sm">
        <p>The recorded workspace could not be verified. {state.error.message}</p>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || turnActive || state.data?.recovery === "running"}
          onClick={() => void recover("useProjectCheckout")}
        >
          Continue in project checkout
        </Button>
        {turnLine}
        {error && <p className="text-destructive">{error}</p>}
      </div>
    );
  if (
    !state.data ||
    (!state.data.worktreePath &&
      state.data.recovery !== "running" &&
      state.data.recovery !== "interrupted") ||
    (!queueBlocked &&
      state.data.recovery !== "interrupted" &&
      state.data.recovery !== "running" &&
      (state.data.registration === "matching" ||
        (state.data.branchExists &&
          !state.data.directoryExists &&
          state.data.registration !== "otherBranch")))
  )
    return null;
  const data = state.data;
  const recovering = data.recovery === "running";
  const transitionDisabled = busy || recovering || turnActive;

  if (data.branchDriftOnly && data.recovery !== "interrupted" && !recovering && data.branch) {
    // The end-of-turn sync re-records the current branch, so a switch back
    // "after the turn" would never be offered; say what will happen instead.
    const followsAtTurnEnd = turnActive && data.followsCheckoutAtTurnEnd === true;
    const switchBackReason = !data.checkoutBranch
      ? "Check out a branch in the worktree first, so commits on the detached HEAD are kept."
      : !data.branchExists
        ? `Branch ${data.branch} no longer exists.`
        : data.checkoutDirty !== false
          ? "Commit or stash the worktree's changes to switch back."
          : null;
    return (
      <div
        className="space-y-2 rounded border border-warning/40 bg-warning/5 p-3 text-sm"
        role="status"
      >
        <p>
          This worktree is on{" "}
          {data.checkoutBranch ? <code>{data.checkoutBranch}</code> : "a detached HEAD"}, but this
          thread expects <code>{data.branch}</code>. Your files are untouched.
          {followsAtTurnEnd && (
            <>
              {" "}
              When this turn ends, the thread switches to <code>{data.checkoutBranch}</code>.
            </>
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          {data.checkoutBranch && (
            <Button size="sm" disabled={busy} onClick={() => void recover("adoptCheckoutBranch")}>
              Use {data.checkoutBranch}
            </Button>
          )}
          {!followsAtTurnEnd && (
            <Button
              size="sm"
              variant={data.checkoutBranch ? "outline" : "default"}
              disabled={transitionDisabled || switchBackReason !== null}
              title={switchBackReason ?? undefined}
              onClick={() => void recover("restoreRecordedBranch")}
            >
              Switch back to {data.branch}
            </Button>
          )}
          <Menu>
            <MenuTrigger render={<Button size="sm" variant="ghost" disabled={busy} />}>
              More options <ChevronDownIcon aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="start" className="min-w-52">
              <MenuItem
                disabled={transitionDisabled || !data.defaultBranch}
                onClick={() => void recover("recreateFromBase")}
              >
                Recreate from {data.defaultBranch ?? "default branch"}
              </MenuItem>
              <MenuItem
                disabled={transitionDisabled}
                onClick={() => void recover("useProjectCheckout")}
              >
                Continue in project checkout
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
        {switchBackReason && !followsAtTurnEnd && (
          <p className="text-muted-foreground text-xs">{switchBackReason}</p>
        )}
        {turnLine}
        {errorLine}
      </div>
    );
  }

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
        {data.recovery === "interrupted"
          ? "Worktree recovery was interrupted. Retry preparation or continue in the project checkout."
          : recovering
            ? "Worktree recovery is in progress."
            : data.directoryExists && data.registration === "otherBranch"
              ? "This checkout no longer matches the recorded worktree. Its files have been kept. Choose another workspace to continue."
              : data.branchExists || data.directoryExists
                ? "This conversation's worktree needs recovery."
                : `This thread's worktree and branch ${data.branch ?? "(unknown)"} are gone.`}
      </p>
      <div className="flex flex-wrap gap-2">
        {data.worktreePath &&
          (canRecreateOriginal ? (
            <Button
              size="sm"
              disabled={transitionDisabled}
              onClick={() => void recover("recreate")}
            >
              {data.recovery === "interrupted" ? "Retry recovery" : "Recreate now"}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={transitionDisabled || !data.defaultBranch}
              onClick={() => void recover("recreateFromBase")}
            >
              Recreate from {data.defaultBranch ?? "default branch"}
            </Button>
          ))}
        {recovering && (
          <Button size="sm" variant="outline" onClick={() => void recover("cancel")}>
            Cancel preparation
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={transitionDisabled}
          onClick={() => void recover("useProjectCheckout")}
        >
          Continue in project checkout
        </Button>
      </div>
      {!recovering && turnLine}
      {errorLine}
    </div>
  );
}
