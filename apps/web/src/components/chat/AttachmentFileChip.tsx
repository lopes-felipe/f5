import { VscodeEntryIcon } from "./VscodeEntryIcon";
import { useTheme } from "../../hooks/useTheme";
import { useState } from "react";
import type { ChatAttachment } from "../../types";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { WorkspaceMediaView } from "../WorkspaceMediaView";

/** Persisted attachments are viewed through a capability, never a backend-authenticated iframe. */
export function AttachmentFileChip({ file }: { file: ChatAttachment }) {
  const { resolvedTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const url = file.sourceUrl ?? file.previewUrl;
  let relativePath: string | undefined;
  try {
    const pathname = new URL(url ?? "", window.location.href).pathname;
    if (pathname.startsWith("/attachments/"))
      relativePath = decodeURIComponent(pathname.slice("/attachments/".length));
  } catch {
    /* Optimistic local files can still be downloaded until the server publishes them. */
  }
  return (
    <div className="mb-2 rounded border border-border p-2">
      <VscodeEntryIcon
        pathValue={file.name}
        kind="file"
        theme={resolvedTheme}
        className="mr-1 inline-block"
      />
      {relativePath ? (
        <button className="underline" onClick={() => setOpen(true)}>
          {file.name}
        </button>
      ) : (
        <a href={url} download={file.name} className="underline">
          {file.name}
        </a>
      )}
      <span className="ml-2 text-xs text-muted-foreground">
        {(file.sizeBytes / 1024).toFixed(0)} KiB
      </span>
      {file.mimeType.startsWith("video/") && <video controls preload="metadata" src={url} />}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="h-[80vh] max-w-5xl p-4">
          <DialogTitle>{file.name}</DialogTitle>
          {relativePath && (
            <WorkspaceMediaView
              name={file.name}
              relativePath={relativePath}
              identity={{ kind: "attachments" }}
            />
          )}
        </DialogPopup>
      </Dialog>
    </div>
  );
}
