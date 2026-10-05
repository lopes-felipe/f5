import { readNativeApi } from "../../../nativeApi";
import { useSyncExternalStore, useEffect, useState } from "react";
import type { ThreadId } from "@t3tools/contracts";
import {
  getAttachmentUploadState,
  subscribeAttachmentUploads,
} from "../../../lib/attachmentUploadQueue";
import {
  persistComposerAttachment,
  useComposerDraftStore,
  type ComposerImageAttachment,
} from "../../../composerDraftStore";
export function AttachmentUploadProgress({
  image,
  threadId,
}: {
  image: ComposerImageAttachment;
  threadId: ThreadId;
}) {
  const state = useSyncExternalStore(
    subscribeAttachmentUploads,
    () => getAttachmentUploadState(image.file),
    () => undefined,
  );
  const metadata = useComposerDraftStore((store) =>
    store.draftsByThreadId[threadId]?.persistedAttachments.find((entry) => entry.id === image.id),
  );
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!metadata?.uploadId || metadata.uploadThreadId !== threadId) return;
    let active = true;
    const renew = () => {
      void readNativeApi()
        ?.attachments.getUploads({ threadId, uploadIds: [metadata.uploadId!] })
        .then(([upload]) => {
          if (active) setExpired(!upload);
        })
        .catch(() => {
          /* A disconnected server is not evidence of expiry. */
        });
    };
    renew();
    const timer = setInterval(renew, 15 * 60 * 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [metadata?.uploadId, metadata?.uploadThreadId, threadId]);
  if (expired)
    return (
      <div role="alert" className="absolute bottom-0 left-0 right-0 bg-background/95 p-1 text-2xs">
        Upload expired. Remove and re-attach this file.
      </div>
    );
  if (!state || state.status === "complete") return null;
  const retry = async () => {
    try {
      const metadata = await persistComposerAttachment(threadId, image);
      const store = useComposerDraftStore.getState();
      const draft = store.draftsByThreadId[threadId];
      if (!draft?.images.some((entry) => entry.id === image.id)) return;
      store.syncPersistedAttachments(threadId, [
        ...draft.persistedAttachments.filter((entry) => entry.id !== image.id),
        metadata,
      ]);
    } catch {
      /* The upload state displays the failure and permits another retry. */
    }
  };
  return (
    <div
      className="absolute bottom-0 left-0 right-0 bg-background/95 p-1 text-2xs"
      aria-live="polite"
    >
      {state.status === "failed" ? (
        <>
          <span title={state.error}>Upload failed</span>{" "}
          <button className="underline" onClick={() => void retry()}>
            Retry
          </button>
        </>
      ) : (
        <>
          <span>
            {state.status === "queued" ? "Waiting to upload" : `${state.progress}% uploaded`}
          </span>{" "}
          <button className="underline" onClick={state.cancel}>
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
