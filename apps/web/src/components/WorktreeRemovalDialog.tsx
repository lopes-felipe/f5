import type { WorktreesInspectResult } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { readNativeApi } from "../nativeApi";
import type { WorktreeRemovalRow } from "../worktreeRemovalDialogStore";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { WorktreeIgnoredFilesList } from "./worktrees/WorktreeIgnoredFilesList";
interface RowState {
  inspection?: WorktreesInspectResult;
  selected: boolean;
  deleteBranch: boolean;
  ignoredApproved: boolean;
  error?: string;
  removed?: boolean;
  inspecting?: boolean;
}
export function WorktreeRemovalDialog({
  rows,
  onClose,
}: {
  rows: ReadonlyArray<WorktreeRemovalRow>;
  onClose: () => void;
}) {
  const [states, setStates] = useState<RowState[]>(() =>
    rows.map(() => ({ selected: false, deleteBranch: false, ignoredApproved: false })),
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
          ignoredApproved: false,
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
                      ignoredApproved: false,
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
  const refreshInspection = async (index: number, row: WorktreeRemovalRow, reason?: string) => {
    const api = readNativeApi();
    setStates((current) =>
      current.map((state, i) =>
        i === index
          ? {
              selected: false,
              ignoredApproved: false,
              deleteBranch: false,
              inspecting: true,
              ...(reason ? { error: reason } : {}),
            }
          : state,
      ),
    );
    try {
      if (!api) throw new Error("Server connection is unavailable.");
      const inspection = await api.worktrees.inspect(row);
      update(index, {
        inspection,
        inspecting: false,
        ...(reason
          ? { error: reason + " Review the refreshed inspection and confirm again." }
          : {}),
      });
    } catch (error) {
      update(index, {
        inspecting: false,
        error: error instanceof Error ? error.message : "Inspection failed.",
      });
    }
  };
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
          ...(state.ignoredApproved && state.inspection.ignoredFiles
            ? { approvedIgnoredEntries: state.inspection.ignoredFiles.entries }
            : {}),
        });
        const error = result.blockedReasons.join("; ");
        if (!result.removed || error) failed = true;
        if (result.removed) {
          update(index, { removed: true, selected: false, error });
        } else {
          await refreshInspection(index, row, error || "Worktree removal was blocked.");
        }
      } catch (error) {
        failed = true;
        await refreshInspection(
          index,
          row,
          error instanceof Error ? error.message : "Removal failed.",
        );
      }
    }
    await queryClient.invalidateQueries({ queryKey: ["git"] });
    await queryClient.invalidateQueries({ queryKey: ["worktrees"] });
    setBusy(false);
    if (!failed) onClose();
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
            const ignored = inspection?.ignoredFiles;
            const canApproveIgnored = ignored?.canRemoveAfterApproval === true;
            const hardBlocked =
              !inspection || (inspection.blockedReasons.length > 0 && !canApproveIgnored);
            const blocked = hardBlocked || (ignored?.requiresApproval && !state.ignoredApproved);
            return (
              <fieldset
                key={`${row.projectId}:${row.path}`}
                disabled={busy || state.removed || state.inspecting}
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
                    : state.inspecting
                      ? "Inspecting…"
                      : inspection
                        ? blocked
                          ? inspection.blockedReasons.join("; ") ||
                            "Confirm deletion of the ignored files below."
                          : state.ignoredApproved
                            ? "Ready to remove (ignored files will be deleted)"
                            : "Safe to remove"
                        : state.error
                          ? "Inspection failed"
                          : "Inspecting…"}
                </p>
                {ignored && (ignored.entries.length > 0 || ignored.truncated) && (
                  <div className="space-y-2">
                    <WorktreeIgnoredFilesList files={ignored} />
                    {!ignored.truncated && ignored.requiresApproval && (
                      <label className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={state.ignoredApproved}
                          disabled={hardBlocked}
                          onChange={(event) =>
                            update(index, {
                              ignoredApproved: event.target.checked,
                              selected: event.target.checked && !hardBlocked,
                            })
                          }
                        />
                        <span>
                          Also delete the ignored files and folders listed above.
                          <span className="block text-muted-foreground">
                            These local files are not saved by Git. Deleting a folder deletes
                            everything inside it.
                          </span>
                        </span>
                      </label>
                    )}
                  </div>
                )}
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
                        ? " (upstream deleted)"
                        : ""}
                    </span>
                  </label>
                )}
                {state.error && (
                  <div className="space-y-2">
                    <p role="alert" className="text-destructive">
                      {state.error}
                    </p>
                    {!state.removed && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void refreshInspection(index, row)}
                      >
                        Inspect again
                      </Button>
                    )}
                  </div>
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
