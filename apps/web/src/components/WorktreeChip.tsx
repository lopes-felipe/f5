import { useQueryClient } from "@tanstack/react-query";
import { MoveToWorktreeDialog, discardMovedChanges } from "./worktrees/MoveToWorktreeDialog";
import { useRef, useState } from "react";
import type { ProjectId, ThreadId, WorkspaceTransitionSnapshot } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FolderIcon, GitForkIcon } from "lucide-react";
import { openInPreferredEditor } from "../editorPreferences";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { ensureNativeApi } from "../nativeApi";
import { formatWorktreePathForDisplay } from "../worktreeCleanup";
import { useWorktreeRemovalDialogStore } from "../worktreeRemovalDialogStore";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "./ui/menu";
import { toastManager } from "./ui/toast";

export function WorktreeChip({
  threadId,
  projectId,
  branch,
  path,
  isWorktree,
  creatingWorktree = false,
  onOpenTerminal,
  onNewWorktree,
  canMove = false,
  moveDisabled = false,
}: {
  threadId: ThreadId;
  projectId: ProjectId;
  branch: string | null;
  path: string;
  isWorktree: boolean;
  /** The thread's worktree is still being created; `path` is the project checkout. */
  creatingWorktree?: boolean;
  onOpenTerminal?: () => void;
  onNewWorktree?: () => void;
  canMove?: boolean;
  moveDisabled?: boolean;
}) {
  const navigate = useNavigate();
  const [moveOpen, setMoveOpen] = useState(false);
  const [completedMove, setCompletedMove] = useState<WorkspaceTransitionSnapshot | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const run = (action: () => Promise<unknown>) =>
    void action().catch((error) =>
      toastManager.add({
        type: "error",
        title: "Workspace action failed",
        description: String(error),
      }),
    );
  const dir = formatWorktreePathForDisplay(path);
  const label = isWorktree ? "Worktree" : creatingWorktree ? "New worktree" : "Local";
  return (
    <>
      {moveOpen && (
        <MoveToWorktreeDialog
          threadId={threadId}
          projectCwd={path}
          disabled={moveDisabled}
          onClose={() => setMoveOpen(false)}
        />
      )}
      <Menu
        onOpenChange={(open) => {
          if (open && isWorktree) {
            const api = ensureNativeApi();
            void api.worktrees
              ?.getTransition({ threadId })
              .then((record) => {
                setCompletedMove(
                  record?.intent === "move_to_new_worktree" &&
                    record.phase === "completed" &&
                    record.target.path === path &&
                    !record.move?.discarded
                    ? record
                    : null,
                );
              })
              .catch(() => setCompletedMove(null));
          }
        }}
      >
        <MenuTrigger
          ref={triggerRef}
          data-composer-control={isWorktree ? undefined : "envMode"}
          className="inline-flex min-w-0 max-w-60 items-center gap-1 rounded px-2 py-1 text-2xs text-muted-foreground hover:text-foreground focus-visible:outline-ring"
          aria-label={`${label}: ${branch ?? dir} · ${path}`}
          title={path}
        >
          {isWorktree || creatingWorktree ? (
            <GitForkIcon className="size-3 shrink-0" />
          ) : (
            <FolderIcon className="size-3 shrink-0" />
          )}
          <span className="truncate">{isWorktree ? `${branch ?? dir} · …/${dir}` : label}</span>
        </MenuTrigger>
        <MenuPopup
          finalFocus={triggerRef}
          align="start"
          className="max-w-[min(32rem,calc(100vw-2rem))]"
        >
          <div className="space-y-1 px-2 py-2 text-xs">
            <p className="break-all font-medium">{branch ?? dir}</p>
            <p className="break-all whitespace-pre-wrap font-mono text-muted-foreground">{path}</p>
          </div>
          <MenuSeparator />
          <MenuItem onClick={() => run(() => writeTextToClipboard(path))}>Copy path</MenuItem>
          <MenuItem onClick={() => run(() => openInPreferredEditor(ensureNativeApi(), path))}>
            Open in editor
          </MenuItem>
          <MenuItem
            onClick={() => run(() => ensureNativeApi().shell.openInEditor(path, "file-manager"))}
          >
            Reveal
          </MenuItem>
          <MenuItem disabled={!onOpenTerminal} onClick={onOpenTerminal}>
            Open terminal here
          </MenuItem>
          <MenuSeparator />
          {onNewWorktree && <MenuItem onClick={onNewWorktree}>New worktree</MenuItem>}
          <MenuItem
            onClick={() => void navigate({ to: "/worktrees", search: { projectId, threadId } })}
          >
            {isWorktree ? "Manage worktrees…" : "Use existing worktree…"}
          </MenuItem>
          {!isWorktree && canMove && (
            <MenuItem disabled={moveDisabled} onClick={() => setMoveOpen(true)}>
              Move to new worktree…
            </MenuItem>
          )}
          {completedMove && (
            <DiscardMovedChangesMenuItem
              threadId={threadId}
              operationId={completedMove.operationId}
              sourcePath={completedMove.source.path}
              branch={completedMove.target.branch ?? "worktree"}
              onDiscarded={() => setCompletedMove(null)}
            />
          )}
          {isWorktree && (
            <MenuItem
              variant="destructive"
              onClick={() =>
                void useWorktreeRemovalDialogStore.getState().request([{ projectId, path }])
              }
            >
              Remove worktree…
            </MenuItem>
          )}
        </MenuPopup>
      </Menu>
    </>
  );
}

function DiscardMovedChangesMenuItem({
  threadId,
  operationId,
  sourcePath,
  branch,
  onDiscarded,
}: {
  threadId: ThreadId;
  operationId: string;
  sourcePath: string;
  branch: string;
  onDiscarded: () => void;
}) {
  const queryClient = useQueryClient();
  return (
    <MenuItem
      onClick={() => {
        void discardMovedChanges(threadId, operationId, sourcePath, branch)
          .then(async (discarded) => {
            if (!discarded) return;
            onDiscarded();
            await queryClient.invalidateQueries({ queryKey: ["worktrees"] });
            await queryClient.invalidateQueries({ queryKey: ["git"] });
          })
          .catch((error) =>
            toastManager.add({
              type: "error",
              title: "Could not discard originals",
              description: String(error),
            }),
          );
      }}
    >
      Discard originals from move…
    </MenuItem>
  );
}
