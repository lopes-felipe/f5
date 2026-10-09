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

export function GitBranchWorkspaceDialog(props: {
  branch: string;
  cwd: string;
  onClose: () => void;
  onUseWorkspace: () => void;
  onSeparateWorktree: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Choose workspace for {props.branch}</DialogTitle>
          <DialogDescription>
            This conversation will use the workspace shown below.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3 text-sm">
          <p className="break-all font-mono text-xs">{props.cwd}</p>
          <p>
            Git can check out a branch in one workspace at a time. Open a separate worktree with a
            new branch to keep this branch available in its current workspace.
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="outline" onClick={props.onUseWorkspace}>
            Use this workspace
          </Button>
          <Button onClick={props.onSeparateWorktree}>Open a separate worktree</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
