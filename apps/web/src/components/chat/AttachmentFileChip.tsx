import { FileChip } from "./FileChip";
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
  const size = (
    <span className="shrink-0 text-muted-foreground tabular-nums">
      {(file.sizeBytes / 1024).toFixed(0)} KiB
    </span>
  );
  return (
    <div className="mb-2 flex flex-col items-start gap-2">
      <FileChip
        path={file.name}
        label={file.name}
        theme={resolvedTheme}
        trailing={size}
        {...(relativePath ? { onClick: () => setOpen(true) } : { href: url, download: file.name })}
      />
      {file.mimeType.startsWith("video/") && (
        <video controls preload="metadata" src={url} className="max-w-full rounded-lg" />
      )}
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
