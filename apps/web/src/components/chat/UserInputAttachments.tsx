import { useState } from "react";
import type { AttachmentUpload, ThreadId } from "@t3tools/contracts";
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
    <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
      <button type="button" disabled={disabled || uploading} onClick={onDismiss}>
        Dismiss
      </button>
      <label>
        Attach to answer
        <input
          aria-label="Attach to answer"
          className="ml-2 max-w-48"
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
        <span key={attachment.uploadId}>{attachment.name}</span>
      ))}
      {error ? (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
