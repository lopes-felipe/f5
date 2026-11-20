import { FileChip } from "./FileChip";
import { filePreviewKind, videoPreviewMimeType } from "@t3tools/shared/filePreview";
import { useTheme } from "../../hooks/useTheme";
import { useState } from "react";
import type { ChatAttachment } from "../../types";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { WorkspaceMediaView } from "../WorkspaceMediaView";

/** Persisted attachments are viewed through a capability, never a backend-authenticated iframe. */
export function AttachmentFileChip({
  file,
  standalone = false,
  sending = false,
}: {
  file: ChatAttachment;
  standalone?: boolean;
  sending?: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const url = file.sourceUrl ?? file.previewUrl;
  const label = file.source === "pasted-text" ? "Pasted text" : file.name;
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
      {sending ? "Sending…" : `${(file.sizeBytes / 1024).toFixed(0)} KiB`}
    </span>
  );
  return (
    <div
      className={
        standalone
          ? "flex max-w-full flex-col items-start gap-2 rounded-2xl border border-border bg-secondary p-2"
          : "flex max-w-full flex-col items-start gap-2"
      }
      data-slot={standalone ? "user-file-card" : "user-file-chip"}
    >
      <FileChip
        path={file.name}
        label={label}
        theme={resolvedTheme}
        trailing={size}
        {...(standalone
          ? { className: "h-auto min-h-12 w-64 gap-3 border-0 bg-transparent px-1 py-1 text-sm" }
          : {})}
        {...(sending
          ? {}
          : relativePath
            ? { onClick: () => setOpen(true) }
            : { href: url, download: file.name })}
      />
      {filePreviewKind(file) === "audio" && !sending && (
        <audio aria-label={label} controls preload="metadata" src={url} className="max-w-full" />
      )}
      {videoPreviewMimeType(file) && (
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
