import type { GitCheckoutConflict } from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { invalidateGitQueries } from "~/lib/gitReactQuery";
import { randomUUID } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

interface GitCheckoutConflictDialogProps {
  conflict: GitCheckoutConflict;
  onClose: () => void;
  onPrepared: (branch: string, worktreePath: string) => void;
}

export function GitCheckoutConflictDialog({
  conflict,
  onClose,
  onPrepared,
}: GitCheckoutConflictDialogProps) {
  const queryClient = useQueryClient();
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openWorktree = async () => {
    const api = readNativeApi();
    if (!api || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      // A fresh branch also works for remote refs and branches claimed by another checkout.
      const result = await api.git.createWorktree({
        cwd: conflict.cwd,
        branch: conflict.branch,
        newBranch: `t3code/${randomUUID().slice(0, 8)}`,
        path: null,
      });
      await invalidateGitQueries(queryClient).catch(() => undefined);
      onPrepared(result.worktree.branch, result.worktree.path);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the worktree.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pendingRef.current) onClose();
      }}
    >
      <DialogPopup showCloseButton={!pending} className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Local changes block branch switch</DialogTitle>
          <DialogDescription>
            Switching to <code>{conflict.branch}</code> would overwrite files in this workspace.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3 text-sm">
          <p className="break-all font-mono text-xs">{conflict.cwd}</p>
          <ul className="max-h-40 overflow-auto space-y-1">
            {conflict.files.map((file) => (
              <li key={file} className="break-all font-mono text-xs">
                {file}
              </li>
            ))}
          </ul>
          <p>
            Open a separate worktree with a new branch based on <code>{conflict.branch}</code>. Your
            current edits stay in this workspace. To switch here instead, commit or stash these
            files first.
          </p>
          {error ? (
            <p role="alert" className="text-destructive-foreground">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={pending} onClick={() => void openWorktree()}>
            {pending ? "Creating worktree…" : "Open in a separate worktree"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
