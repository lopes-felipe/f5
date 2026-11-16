import type { ThreadId } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useEffect } from "react";

import { useStore } from "../../store";
import { selectThreadById } from "../../threadSelectors";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { useWorktreeRecovery } from "./useWorktreeRecovery";

/**
 * The header's control for a thread whose worktree directory is gone: recreate
 * it, recreate it from the default branch, or continue in the project folder.
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
  const turnActive = Boolean(thread.session?.activeTurnId);
  const recovering = data?.recovery === "running";
  const disabled = busy || recovering || turnActive;
  const defaultBranch = data?.defaultBranch ?? null;
  // The original branch can come back only when it still exists and nothing else took the path.
  const canRecreateOriginal =
    !data ||
    (data.branchExists &&
      (data.registration === "matching" ||
        (!data.directoryExists && data.registration !== "otherBranch")));
  const run = (action: Parameters<typeof recover>[0]) => void recover(action);

  return (
    <Group aria-label="Worktree recovery" variant="track">
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || (!canRecreateOriginal && !defaultBranch)}
        title={
          turnActive
            ? "Available after the current turn finishes."
            : canRecreateOriginal
              ? `Recreate the worktree on ${thread.branch ?? "its branch"}.`
              : `Branch ${thread.branch ?? "(unknown)"} is gone. Recreate from ${defaultBranch ?? "the default branch"}.`
        }
        onClick={() => run(canRecreateOriginal ? "recreate" : "recreateFromBase")}
      >
        {recovering ? "Recreating…" : "Recreate worktree"}
      </Button>
      <GroupSeparator />
      <Menu>
        <MenuTrigger
          render={<Button aria-label="More recovery options" size="icon-xs" variant="ghost" />}
          disabled={disabled}
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
