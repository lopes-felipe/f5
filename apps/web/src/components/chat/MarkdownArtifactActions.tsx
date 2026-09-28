import { normalizeDocumentMarkdown } from "@t3tools/shared/documentWorkflow";
import { useState, useId } from "react";
import {
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
} from "../../proposedPlan";
import { EllipsisIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { toastManager } from "../ui/toast";
import { readNativeApi } from "~/nativeApi";

export function MarkdownArtifactActions({
  markdown: planMarkdown,
  workspaceRoot,
  artifactNoun,
}: {
  markdown: string;
  workspaceRoot: string | undefined;
  artifactNoun: "plan" | "document";
}) {
  const capitalizedNoun = artifactNoun === "plan" ? "Plan" : "Document";
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [savePath, setSavePath] = useState("");
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: `Could not copy ${artifactNoun}`,
        description: error instanceof Error ? error.message : "An error occurred while copying.",
      });
    },
  });
  const savePathInputId = useId();
  const downloadFilename = buildProposedPlanMarkdownFilename(planMarkdown, artifactNoun);
  const saveContents =
    artifactNoun === "document"
      ? normalizeDocumentMarkdown(planMarkdown)
      : normalizePlanMarkdownForExport(planMarkdown);

  const handleDownload = () => {
    downloadPlanAsTextFile(downloadFilename, saveContents);
  };

  const handleCopyPlan = () => {
    copyToClipboard(saveContents, undefined);
  };

  const openSaveDialog = () => {
    if (!workspaceRoot) {
      toastManager.add({
        type: "error",
        title: "Workspace path is unavailable",
        description: "This thread does not have a workspace path to save into.",
      });
      return;
    }
    setSavePath((existing) => (existing.length > 0 ? existing : downloadFilename));
    setIsSaveDialogOpen(true);
  };

  const handleSaveToWorkspace = () => {
    const api = readNativeApi();
    const relativePath = savePath.trim();
    if (!api || !workspaceRoot) {
      return;
    }
    if (!relativePath) {
      toastManager.add({
        type: "warning",
        title: "Enter a workspace path",
      });
      return;
    }

    setIsSavingToWorkspace(true);
    void api.projects
      .writeFile({
        cwd: workspaceRoot,
        relativePath,
        contents: saveContents,
      })
      .then((result) => {
        setIsSaveDialogOpen(false);
        toastManager.add({
          type: "success",
          title: `${capitalizedNoun} saved to workspace`,
          description: result.relativePath,
        });
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: `Could not save ${artifactNoun}`,
          description: error instanceof Error ? error.message : "An error occurred while saving.",
        });
      })
      .then(
        () => {
          setIsSavingToWorkspace(false);
        },
        () => {
          setIsSavingToWorkspace(false);
        },
      );
  };

  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button aria-label={`${capitalizedNoun} actions`} size="icon-xs" variant="outline" />
          }
        >
          <EllipsisIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={handleCopyPlan}>{isCopied ? "Copied!" : "Copy to clipboard"}</MenuItem>
          <MenuItem onClick={handleDownload}>Download as markdown</MenuItem>
          <MenuItem onClick={openSaveDialog} disabled={!workspaceRoot || isSavingToWorkspace}>
            Save to workspace
          </MenuItem>
        </MenuPopup>
      </Menu>{" "}
      <Dialog
        open={isSaveDialogOpen}
        onOpenChange={(open) => {
          if (!isSavingToWorkspace) {
            setIsSaveDialogOpen(open);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Save {artifactNoun} to workspace</DialogTitle>
            <DialogDescription>
              Enter a path relative to <code>{workspaceRoot ?? "the workspace"}</code>.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <label htmlFor={savePathInputId} className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Workspace path</span>
              <Input
                id={savePathInputId}
                value={savePath}
                onChange={(event) => setSavePath(event.target.value)}
                placeholder={downloadFilename}
                spellCheck={false}
                disabled={isSavingToWorkspace}
              />
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsSaveDialogOpen(false)}
              disabled={isSavingToWorkspace}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSaveToWorkspace()}
              disabled={isSavingToWorkspace}
            >
              {isSavingToWorkspace ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
