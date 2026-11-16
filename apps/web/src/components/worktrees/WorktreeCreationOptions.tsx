import type { ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { useComposerDraftStore } from "../../composerDraftStore";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverTrigger, PopoverPopup } from "../ui/popover";

export function WorktreeCreationOptions({
  threadId,
  multiModel,
  hasSetupScript,
}: {
  threadId: ThreadId;
  multiModel: boolean;
  hasSetupScript: boolean;
}) {
  const draft = useComposerDraftStore((s) => s.getDraftThread(threadId));
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const update = useComposerDraftStore((s) => s.setDraftThreadContext);
  if (!draft) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) {
            setName(draft.worktreeBranchName ?? "");
            setError(null);
          }
        }}
      >
        <PopoverTrigger
          className="max-w-48 truncate rounded px-2 py-1 text-2xs hover:text-foreground"
          title={
            multiModel ? "Branch names are generated independently for each model." : undefined
          }
        >
          Branch: {multiModel ? "auto" : (draft.worktreeBranchName ?? "auto")}
        </PopoverTrigger>
        <PopoverPopup align="start" className="w-80 max-w-[calc(100vw-2rem)]">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (multiModel) return;
              if (!name || /\s/.test(name)) {
                setError("Enter a branch name without whitespace, or Clear to use auto.");
                return;
              }
              update(threadId, { worktreeBranchName: name });
              setOpen(false);
            }}
          >
            <label className="space-y-1 text-sm">
              <span>Branch name</span>
              <Input
                aria-label="Branch name"
                value={name}
                disabled={multiModel}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                placeholder="feature/my-change"
              />
            </label>
            {multiModel && (
              <p className="text-xs text-muted-foreground">
                Branch names are generated independently for each model.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              The new worktree starts from committed contents of the base branch; uncommitted edits
              stay where they are.
            </p>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                type="button"
                disabled={multiModel}
                onClick={() => {
                  update(threadId, { worktreeBranchName: null });
                  setOpen(false);
                }}
              >
                Clear
              </Button>
              <Button size="sm" type="submit" disabled={multiModel}>
                Save
              </Button>
            </div>
          </form>
        </PopoverPopup>
      </Popover>
      {hasSetupScript && (
        <label className="inline-flex items-center gap-1 whitespace-nowrap text-2xs">
          <input
            type="checkbox"
            checked={draft.runSetupScript ?? true}
            onChange={(e) => update(threadId, { runSetupScript: e.target.checked })}
          />
          Run setup script
        </label>
      )}
    </div>
  );
}
