import type { ThreadId } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useEffect } from "react";

import { derivePhase } from "../../session-logic";
import { useStore } from "../../store";
import { selectThreadById } from "../../threadSelectors";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { recreatePlan, useWorktreeRecovery } from "./useWorktreeRecovery";

const AFTER_TURN_REASON = "Available after the current turn finishes.";

/**
 * The header's control for a thread whose worktree directory is gone: recreate
 * it, recreate it from the default branch, or continue in the project folder.
 * It follows the same plan as the missing-worktree banner.
 */
export function WorktreeMissingControl({
  threadId,
  isServerThread,
}: {
  threadId: ThreadId | null;
  isServerThread: boolean;
}) {
  const thread = useStore((state) =>
    isServerThread && threadId ? selectThreadById(state, threadId) : undefined,
  );
  const archived = Boolean(thread?.archivedAt);
  const { state, busy, error, recover } = useWorktreeRecovery(thread?.id ?? null, {
    worktreePath: thread?.worktreePath ?? null,
    branch: thread?.branch ?? null,
    enabled: !archived,
  });
  useEffect(() => {
    if (error)
      toastManager.add({
        type: "error",
        title: "Could not recover the worktree",
        description: error,
      });
  }, [error]);

  if (!thread)
    return (
      <Button
        variant="outline"
        size="sm"
        disabled
        title="The worktree directory is missing. Sending a turn will attempt recovery."
      >
        Worktree missing
      </Button>
    );
  if (archived)
    return (
      <span
        className="inline-flex h-7 items-center px-2 text-xs text-muted-foreground"
        title="Unarchive to recreate it"
      >
        Worktree removed
      </span>
    );

  const data = state.data;
  // Same rule as the banner: a running session or an active turn refuses transitions.
  const turnActive =
    derivePhase(thread.session ?? null) === "running" || Boolean(thread.session?.activeTurnId);
  const recovering = data?.recovery === "running";
  const disabled = busy || recovering || turnActive;
  const defaultBranch = data?.defaultBranch ?? null;
  const run = (action: Parameters<typeof recover>[0]) => void recover(action);

  // Until the state is known, offer nothing that could pick the wrong action.
  if (state.error)
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        title={
          turnActive
            ? AFTER_TURN_REASON
            : `The recorded workspace could not be verified. ${state.error.message}`
        }
        onClick={() => run("useProjectCheckout")}
      >
        Continue in Local
      </Button>
    );

  const plan = recreatePlan(data);
  const title = turnActive
    ? AFTER_TURN_REASON
    : plan.action === "recreate"
      ? `Recreate the worktree on ${thread.branch ?? "its branch"}.`
      : plan.action === "recreateFromBase"
        ? `Branch ${thread.branch ?? "(unknown)"} is gone. Recreate from ${plan.base}.`
        : plan.reason;

  return (
    <Group aria-label="Worktree recovery" variant="track">
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || plan.action === null}
        title={title}
        onClick={() => {
          if (plan.action) run(plan.action);
        }}
      >
        {recovering
          ? "Recreating…"
          : plan.action === "recreateFromBase"
            ? `Recreate from ${plan.base}`
            : "Recreate worktree"}
      </Button>
      <GroupSeparator />
      <Menu>
        <MenuTrigger
          render={<Button aria-label="More recovery options" size="icon-xs" variant="ghost" />}
          disabled={disabled || state.isPending}
        >
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-52">
          <MenuItem disabled={!defaultBranch} onClick={() => run("recreateFromBase")}>
            Recreate from {defaultBranch ?? "default branch"}
          </MenuItem>
          <MenuItem onClick={() => run("useProjectCheckout")}>Continue in Local</MenuItem>
        </MenuPopup>
      </Menu>
    </Group>
  );
}
