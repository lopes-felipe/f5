import { FolderGit2Icon } from "lucide-react";

import { formatWorktreePathForDisplay } from "../worktreeCleanup";
import type { Thread } from "../types";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function ThreadWorktreeIndicator(props: {
  thread: Pick<Thread, "id" | "branch" | "worktreePath">;
}) {
  const worktreePath = props.thread.worktreePath?.trim();
  if (!worktreePath) {
    return null;
  }

  const displayPath = formatWorktreePathForDisplay(worktreePath);
  const label = props.thread.branch
    ? `Worktree: ${displayPath} (${props.thread.branch})`
    : `Worktree: ${displayPath}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            data-testid={`thread-worktree-${props.thread.id}`}
            className="inline-flex items-center justify-center"
          />
        }
      >
        <FolderGit2Icon className="size-3 text-muted-foreground/55" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
