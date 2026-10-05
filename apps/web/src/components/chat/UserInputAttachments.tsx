import { useState } from "react";
import type { AttachmentUpload, ThreadId } from "@t3tools/contracts";
import { PaperclipIcon } from "lucide-react";

import { Button } from "../ui/button";
import { uploadAttachment } from "~/lib/attachmentUploadQueue";
import { getServerHttpOrigin } from "~/lib/serverHttpOrigin";

export function UserInputAttachments({
  threadId,
  attachments,
  onChange,
  disabled,
  onDismiss,
  onUploadBusyChange,
}: {
  threadId: ThreadId;
  attachments: readonly AttachmentUpload[];
  onChange: (update: (attachments: readonly AttachmentUpload[]) => AttachmentUpload[]) => void;
  disabled: boolean;
  onDismiss: () => void;
  onUploadBusyChange?: ((busy: boolean) => void) | undefined;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div
      data-slot="user-input-attachments"
      className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
    >
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={disabled || uploading}
        onClick={onDismiss}
      >
        Dismiss
      </Button>
      <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 hover:bg-accent hover:text-foreground has-disabled:pointer-events-none has-disabled:opacity-50 has-focus-visible:ring-2 has-focus-visible:ring-ring sm:h-7">
        <PaperclipIcon aria-hidden="true" className="size-3.5" />
        {uploading ? "Uploading…" : "Attach to answer"}
        <input
          aria-label="Attach to answer"
          className="sr-only"
          type="file"
          multiple
          disabled={disabled || uploading}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            setUploading(true);
            onUploadBusyChange?.(true);
            setError(null);
            void Promise.allSettled(
              files.map((file) => uploadAttachment(getServerHttpOrigin(), threadId, file)),
            )
              .then((results) => {
                onChange((current) => [
                  ...current,
                  ...results.flatMap((result) =>
                    result.status === "fulfilled" ? [result.value] : [],
                  ),
                ]);
                const failure = results.find((result) => result.status === "rejected");
                if (failure?.status === "rejected") setError(String(failure.reason));
              })
              .finally(() => {
                setUploading(false);
                onUploadBusyChange?.(false);
              });
          }}
        />
      </label>
      {attachments.map((attachment) => (
        <span
          key={attachment.uploadId}
          className="max-w-48 truncate rounded-md border border-border bg-muted/50 px-1.5 py-0.5 text-foreground"
          title={attachment.name}
        >
          {attachment.name}
        </span>
      ))}
      {error ? (
        <span role="alert" className="text-destructive-foreground">
          {error}
        </span>
      ) : null}
    </div>
  );
}
