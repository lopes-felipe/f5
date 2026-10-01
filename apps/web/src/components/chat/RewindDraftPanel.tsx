import { useState } from "react";
import { CircleAlertIcon, HistoryIcon, LoaderCircleIcon } from "lucide-react";
import { CommandId, type RewindDraft, type ThreadId } from "@t3tools/contracts";
import { readNativeApi } from "~/nativeApi";
import {
  flushComposerDraftPersistence,
  getComposerReloadStatus,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { getServerHttpOrigin } from "~/lib/serverHttpOrigin";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

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
        useComposerDraftStore
          .getState()
          .placeRecoveredPrompt(threadId, draft.operationId, draft.text);
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
  // Only offered for `prepared` rewinds: the server keeps that state only when the
  // provider history is untouched, so cancelling cannot leave it half-rewound. The
  // `cancel` intent makes the server reject it once the rewind has moved on, and a
  // fresh command id per click keeps one rejected attempt from blocking later ones.
  const cancel = async () => {
    const api = readNativeApi();
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.rewind-draft.resolve",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        operationId: draft.operationId,
        threadId,
        intent: "cancel",
        createdAt: new Date().toISOString(),
      });
      setResolved(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  if (resolved) return null;
  const StateIcon =
    draft.state === "completed"
      ? HistoryIcon
      : draft.state === "prepared"
        ? LoaderCircleIcon
        : CircleAlertIcon;
  return (
    <section
      className="mx-auto mb-2 w-full max-w-3xl rounded-xl border border-border/70 bg-card/95 px-3 py-2.5 text-sm shadow-sm"
      aria-label="Recovered rewind draft"
    >
      <div className="flex items-center gap-2">
        <StateIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground",
            draft.state === "prepared" && "animate-spin",
            draft.state === "reconciliation-required" && "text-warning-foreground",
          )}
        />
        <span className="font-medium text-xs">
          {draft.state === "completed" ? "Recovered prompt" : `Rewind: ${draft.state}`}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {draft.state === "completed" ? (
            <>
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => void finish(false)}>
                Discard
              </Button>
              <Button size="xs" disabled={busy} onClick={() => void finish(true)}>
                Use draft
              </Button>
            </>
          ) : null}
          {draft.state === "prepared" ? (
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => void cancel()}>
              Cancel rewind
            </Button>
          ) : null}
          {(draft.state === "prepared" || draft.state === "reconciliation-required") &&
          draft.targetMessageId ? (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void recheck()}>
              {draft.state === "prepared" ? "Retry rewind" : "Recheck rewind"}
            </Button>
          ) : null}
        </div>
      </div>
      {draft.text ? (
        <p className="mt-2 line-clamp-3 whitespace-pre-wrap rounded-md bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
          {draft.text}
        </p>
      ) : null}
      {draft.error ? <p className="mt-1.5 text-xs text-destructive">{draft.error}</p> : null}
      {error ? (
        <p role="alert" className="mt-1.5 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
