import type { ThreadId } from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlertIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { ensureNativeApi } from "../../nativeApi";
import { useNextTurnQueueStore } from "../../nextTurnQueueStore";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { COMPOSER_TRAY_PANEL_CLASS_NAME } from "./composer/ComposerTray";
import {
  describeWorkspaceActivity,
  heldQueueItem,
  recoverActionFor,
  WORKSPACE_ACTION_LABELS,
  type WorkspaceAction,
  workspaceNeedsCard,
} from "./WorkspaceStatusCard.logic";

/**
 * The one place the composer tray talks about a thread's workspace. The server
 * decides the status and which actions apply (it arrives with the queue
 * snapshot); this only renders it. Nothing is shown while the workspace is
 * ready, or dormant and waiting to be restored by the next message.
 */
export function WorkspaceStatusCard({
  threadId,
  turnActive = false,
  setup = null,
}: {
  threadId: ThreadId;
  /** The server refuses to change the workspace under a running turn. */
  turnActive?: boolean;
  /**
   * The first-send setup's own card, when it has something to say. It carries
   * the stage rows and the setup's actions, so it stands in for the summary.
   */
  setup?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const status = useNextTurnQueueStore((state) => state.byThreadId[threadId]?.snapshot?.workspace);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A failure belongs to the state it happened in, and to its thread.
  const statusKey = status?.kind === "attention" ? status.reason : status?.kind;
  useEffect(() => setError(null), [threadId, statusKey]);

  if (setup) return <>{setup}</>;
  if (!workspaceNeedsCard(status)) return null;

  const run = async (action: WorkspaceAction | "cancel") => {
    const api = ensureNativeApi();
    setBusy(true);
    setError(null);
    try {
      if (action === "discard") {
        // The message that is waiting for the worktree, by the server's rule.
        const queue = await api.nextTurnQueue.list({ threadId });
        const waiting = heldQueueItem(queue.items);
        if (waiting) await api.nextTurnQueue.cancel({ itemId: waiting.itemId });
      } else {
        await api.worktrees.recover({
          threadId,
          action: action === "cancel" ? "cancel" : recoverActionFor(action),
        });
      }
      useNextTurnQueueStore.getState().applySnapshot(await api.nextTurnQueue.list({ threadId }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["git"] }),
        queryClient.invalidateQueries({ queryKey: ["worktrees"] }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The workspace could not be changed.");
    } finally {
      setBusy(false);
    }
  };
  const errorLine = error ? (
    <p role="alert" className="mt-1.5 text-xs text-destructive-foreground">
      {error}
    </p>
  ) : null;

  if (status.kind === "working")
    return (
      <section
        aria-label="Workspace status"
        className={COMPOSER_TRAY_PANEL_CLASS_NAME}
        data-workspace-status="working"
      >
        <div className="flex min-h-6 min-w-0 items-center gap-2 text-xs" role="status">
          {/* Decorative: the line beside it is the status. */}
          <Spinner aria-hidden role="presentation" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            {describeWorkspaceActivity(status.activity)}{" "}
            <span className="text-muted-foreground">Messages wait until it finishes.</span>
          </span>
          {/* A first-send setup is cancelled from its own card, which knows its stages. */}
          {status.cancellable && status.activity !== "creating" ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => void run("cancel")}
            >
              Cancel
            </Button>
          ) : null}
        </div>
        {errorLine}
      </section>
    );

  // One primary action and at most two alternatives; the server lists them in that order.
  const actions = status.actions.slice(0, 3);
  return (
    <section
      aria-label="Workspace status"
      className={COMPOSER_TRAY_PANEL_CLASS_NAME}
      data-workspace-status={status.reason}
    >
      <div className="flex min-w-0 items-start gap-2 text-xs" role="status">
        <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning-foreground" />
        <p className="min-w-0 flex-1">{status.message}</p>
      </div>
      {actions.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {actions.map((action, index) => (
            <Button
              key={action}
              type="button"
              size="xs"
              variant={index === 0 ? "default" : "outline"}
              disabled={busy || turnActive}
              onClick={() => void run(action)}
            >
              {WORKSPACE_ACTION_LABELS[action]}
            </Button>
          ))}
        </div>
      ) : null}
      {turnActive ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Available after the current turn finishes.
        </p>
      ) : null}
      {errorLine}
    </section>
  );
}
