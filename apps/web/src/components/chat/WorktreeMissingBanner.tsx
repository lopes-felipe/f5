import type { ThreadId } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { canRecreateOriginal, useWorktreeRecovery } from "./useWorktreeRecovery";

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
  const { state, busy, error, recover } = useWorktreeRecovery(threadId, { worktreePath, branch });
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
          Continue in Local
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
        (state.data.branchExists && !state.data.directoryExists)))
  )
    return null;
  const data = state.data;
  const recovering = data.recovery === "running";
  const transitionDisabled = busy || recovering || turnActive;

  const recreatable = canRecreateOriginal(data);
  return (
    <div
      className="space-y-2 rounded border border-warning/40 bg-warning/5 p-3 text-sm"
      role="status"
    >
      <p>
        {data.recovery === "interrupted"
          ? "Worktree recovery was interrupted. Retry preparation or continue in Local."
          : recovering
            ? "Worktree recovery is in progress."
            : data.registration === "foreign"
              ? "The folder recorded for this thread's worktree no longer belongs to this repository. Its files have been kept. Choose another workspace to continue."
              : data.branchExists || data.directoryExists
                ? "This conversation's worktree needs recovery."
                : `This thread's worktree and branch ${data.branch ?? "(unknown)"} are gone.`}
      </p>
      <div className="flex flex-wrap gap-2">
        {data.worktreePath &&
          (recreatable ? (
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
              // A folder that belongs to something else is never recreated over.
              disabled={
                transitionDisabled || !data.defaultBranch || data.registration === "foreign"
              }
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
          Continue in Local
        </Button>
      </div>
      {!recovering && turnLine}
      {errorLine}
    </div>
  );
}
