import type { WorktreesInspectResult } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { readNativeApi } from "../nativeApi";
import {
  useWorktreeRemovalDialogStore,
  type WorktreeRemovalRow,
} from "../worktreeRemovalDialogStore";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
interface RowState {
  inspection?: WorktreesInspectResult;
  selected: boolean;
  deleteBranch: boolean;
  error?: string;
  removed?: boolean;
}
export function WorktreeRemovalDialog({
  rows,
  onClose,
}: {
  rows: ReadonlyArray<WorktreeRemovalRow>;
  onClose: () => void;
}) {
  const [states, setStates] = useState<RowState[]>(() =>
    rows.map(() => ({ selected: false, deleteBranch: false })),
  );
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  useEffect(() => {
    let active = true;
    const api = readNativeApi();
    if (!api) {
      setStates(
        rows.map(() => ({
          selected: false,
          deleteBranch: false,
          error: "Server connection is unavailable.",
        })),
      );
      return;
    }
    rows.forEach((row, index) => {
      void api.worktrees
        .inspect(row)
        .then((inspection) => {
          if (active)
            setStates((current) =>
              current.map((state, i) =>
                i === index
                  ? {
                      inspection,
                      selected: inspection.blockedReasons.length === 0,
                      deleteBranch: inspection.branchDeletable && inspection.branchMerged,
                    }
                  : state,
              ),
            );
        })
        .catch((error: unknown) => {
          if (active)
            setStates((current) =>
              current.map((state, i) =>
                i === index
                  ? {
                      ...state,
                      error: error instanceof Error ? error.message : "Inspection failed.",
                    }
                  : state,
              ),
            );
        });
    });
    return () => {
      active = false;
    };
  }, [rows]);
  const update = (index: number, patch: Partial<RowState>) =>
    setStates((current) =>
      current.map((state, i) => (i === index ? { ...state, ...patch } : state)),
    );
  const remove = async () => {
    const api = readNativeApi();
    if (!api) return;
    setBusy(true);
    let failed = false;
    for (const [index, row] of rows.entries()) {
      const state = states[index];
      if (!state?.selected || !state.inspection || state.removed) continue;
      try {
        const result = await api.worktrees.remove({
          ...row,
          deleteBranch: state.deleteBranch,
          expectedHead: state.inspection.headSha,
        });
        const error = result.blockedReasons.join("; ");
        if (!result.removed || error) failed = true;
        update(index, {
          removed: result.removed,
          selected: !result.removed,
          ...(error ? { error } : {}),
        });
      } catch (error) {
        failed = true;
        update(index, { error: error instanceof Error ? error.message : "Removal failed." });
      }
    }
    await queryClient.invalidateQueries({ queryKey: ["git"] });
    await queryClient.invalidateQueries({ queryKey: ["worktrees"] });
    setBusy(false);
    if (
      !failed &&
      states.every(
        (state) =>
          state.removed || (state.selected && state.inspection?.blockedReasons.length === 0),
      )
    )
      onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Remove worktrees</DialogTitle>
          <DialogDescription>
            Review each checkout before removing its files. Branches are kept unless selected below.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto py-3">
          {rows.map((row, index) => {
            const state = states[index]!;
            const inspection = state.inspection;
            const blocked = !inspection || inspection.blockedReasons.length > 0;
            return (
              <fieldset
                key={`${row.projectId}:${row.path}`}
                disabled={busy || state.removed}
                className="space-y-2 rounded border p-3 text-sm"
              >
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={state.selected}
                    disabled={blocked}
                    onChange={(event) => update(index, { selected: event.target.checked })}
                  />
                  <span className="break-all whitespace-pre-wrap">{row.path}</span>
                </label>
                <p>
                  {state.removed
                    ? "Worktree removed"
                    : inspection
                      ? blocked
                        ? inspection.blockedReasons.join("; ")
                        : "Safe to remove"
                      : state.error
                        ? "Inspection failed"
                        : "Inspecting…"}
                </p>
                {inspection && inspection.linkedThreads.length > 0 && (
                  <p className="text-muted-foreground">
                    Linked idle conversations will recreate on next send:{" "}
                    {inspection.linkedThreads.map((thread) => thread.title).join(", ")}
                  </p>
                )}
                {inspection?.branch && (
                  <label
                    className="flex items-center gap-2"
                    title={inspection.branchBlockedReason ?? undefined}
                  >
                    <input
                      type="checkbox"
                      checked={state.deleteBranch}
                      disabled={!inspection.branchDeletable || blocked}
                      onChange={(event) => update(index, { deleteBranch: event.target.checked })}
                    />
                    <span>
                      Also delete branch <code>{inspection.branch}</code>
                      {inspection.branchUpstreamGone && !inspection.branchMerged
                        ? " (upstream deleted, likely merged)"
                        : ""}
                    </span>
                  </label>
                )}
                {state.error && (
                  <p role="alert" className="text-destructive">
                    {state.error}
                  </p>
                )}
              </fieldset>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Keep all
          </Button>
          <Button
            disabled={busy || !states.some((state) => state.selected && !state.removed)}
            onClick={() => void remove()}
          >
            {busy ? "Removing…" : "Remove selected"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
export function WorktreeRemovalDialogHost() {
  const request = useWorktreeRemovalDialogStore((state) => state.requests[0]);
  const close = useWorktreeRemovalDialogStore((state) => state.close);
  return request ? (
    <WorktreeRemovalDialog key={request.id} rows={request.rows} onClose={close} />
  ) : null;
}
