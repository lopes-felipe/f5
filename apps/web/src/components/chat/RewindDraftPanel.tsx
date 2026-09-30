import { useState } from "react";
import { CommandId, type RewindDraft, type ThreadId } from "@t3tools/contracts";
import { readNativeApi } from "~/nativeApi";
import {
  flushComposerDraftPersistence,
  getComposerReloadStatus,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { getServerHttpOrigin } from "~/lib/serverHttpOrigin";

export function RewindDraftPanel({ threadId, draft }: { threadId: ThreadId; draft: RewindDraft }) {
  const [busy, setBusy] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [placed, setPlaced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finish = async (use: boolean) => {
    const api = readNativeApi();
    if (!api || busy) return;
    setBusy(true);
    try {
      if (use && !placed) {
        const store = useComposerDraftStore.getState();
        const existing = store.draftsByThreadId[threadId];
        const recoveredId = (id: string) => `rewind:${draft.operationId}:${id}`;
        const attachments = draft.attachments.filter(
          (attachment) =>
            !existing?.persistedAttachments.some(
              (entry) => entry.id === recoveredId(attachment.id),
            ),
        );
        const results = await Promise.allSettled(
          attachments.map((attachment) =>
            api.attachments.cloneToUpload({ threadId, source: { attachmentId: attachment.id } }),
          ),
        );
        const uploads = results.flatMap((result, index) =>
          result.status === "fulfilled"
            ? [{ ...result.value, recoveredId: recoveredId(attachments[index]!.id) }]
            : [],
        );
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") {
          await api.attachments.releaseUploads({
            threadId,
            uploadIds: uploads.map((upload) => upload.uploadId),
          });
          throw failure.reason;
        }
        const text = useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt ?? "";
        if (text !== draft.text && !text.endsWith(`\n\n${draft.text}`))
          store.setPrompt(threadId, [text, draft.text].filter(Boolean).join("\n\n"));
        store.addImages(
          threadId,
          uploads.map((upload) => ({
            id: upload.recoveredId,
            type: upload.kind,
            name: upload.name,
            mimeType: upload.mimeType,
            sizeBytes: upload.sizeBytes,
            uploadId: upload.uploadId,
            uploadThreadId: threadId,
            previewUrl: `${getServerHttpOrigin()}/api/attachments/uploads/${upload.uploadId}`,
            file: new File([], upload.name, { type: upload.mimeType }),
          })),
        );
        store.syncPersistedAttachments(threadId, [
          ...(useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments ??
            []),
          ...uploads.map((upload) => ({
            id: upload.recoveredId,
            name: upload.name,
            mimeType: upload.mimeType,
            sizeBytes: upload.sizeBytes,
            dataUrl: "",
            type: upload.kind,
            uploadId: upload.uploadId,
            uploadThreadId: threadId,
          })),
        ]);
        flushComposerDraftPersistence();
        await Promise.resolve();
        if (getComposerReloadStatus() !== "ready")
          throw new Error("Save the recovered attachments before releasing this draft.");
        setPlaced(true);
      }
      await api.orchestration.dispatchCommand({
        type: "thread.rewind-draft.resolve",
        commandId: CommandId.makeUnsafe(`rewind-draft:${draft.operationId}`),
        operationId: draft.operationId,
        threadId,
        createdAt: new Date().toISOString(),
      });
      setResolved(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const recheck = async () => {
    const api = readNativeApi();
    if (!api || busy || !draft.targetMessageId) return;
    setBusy(true);
    setError(null);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.conversation.revert",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        operationId: draft.operationId,
        threadId,
        targetMessageId: draft.targetMessageId,
        restoreFiles: draft.restoreFiles ?? false,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  if (resolved) return null;
  return (
    <section
      className="mb-2 rounded-lg border border-border p-3 text-sm"
      aria-label="Recovered rewind draft"
    >
      <p>{draft.state === "completed" ? "Recovered prompt" : `Rewind: ${draft.state}`}</p>
      <p className="my-2 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
        {draft.text}
      </p>
      {draft.state === "completed" ? (
        <div className="flex gap-3 text-xs">
          <button disabled={busy} type="button" onClick={() => void finish(true)}>
            Use recovered draft
          </button>
          <button disabled={busy} type="button" onClick={() => void finish(false)}>
            Discard
          </button>
        </div>
      ) : null}
      {draft.state === "reconciliation-required" && draft.targetMessageId ? (
        <button type="button" disabled={busy} onClick={() => void recheck()}>
          Recheck rewind
        </button>
      ) : null}
      {draft.error ? <p className="mt-2 text-xs text-destructive">{draft.error}</p> : null}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
