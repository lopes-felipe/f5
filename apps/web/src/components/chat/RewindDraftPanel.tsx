import { useEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  CircleAlertIcon,
  FileIcon,
  HistoryIcon,
  ImageIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { CommandId, type RewindDraft, type ThreadId } from "@t3tools/contracts";
import { readNativeApi } from "~/nativeApi";
import {
  flushComposerDraftPersistence,
  getComposerReloadStatus,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { getServerHttpOrigin } from "~/lib/serverHttpOrigin";
import { cn } from "~/lib/utils";
import { rewindUi, type LandedRewind } from "~/rewindUi";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { describeRewindDraft, type RewindDraftTone } from "./rewindDraftCopy";

const DISCARD_UNDO_MS = 6000;
const PREVIEW_CLAMP_CHARACTERS = 240;
const PREVIEW_CLAMP_LINES = 3;

type PlaceMode = "replace" | "append";

const TONE_ICON: Record<RewindDraftTone, typeof HistoryIcon> = {
  working: LoaderCircleIcon,
  error: CircleAlertIcon,
  warning: TriangleAlertIcon,
  ready: HistoryIcon,
};

export interface RewindDraftPanelProps {
  threadId: ThreadId;
  /** The server's draft. Absent while only the just-landed revert is known. */
  draft?: RewindDraft | undefined;
  /**
   * The revert that just landed, shown from its captured prompt until the
   * snapshot refetch delivers `draft`. Actions wait for the real draft.
   */
  provisional?: LandedRewind | undefined;
  onFocusComposer?: (() => void) | undefined;
}

export function RewindDraftPanel({
  threadId,
  draft,
  provisional,
  onFocusComposer,
}: RewindDraftPanelProps) {
  // A ref, not state: two fast clicks land in the same render, before any
  // state update could disable the buttons.
  const inFlightRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [placed, setPlaced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [entered, setEntered] = useState(false);
  const composerHasText = useComposerDraftStore(
    (state) => (state.draftsByThreadId[threadId]?.prompt.trim().length ?? 0) > 0,
  );

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const text = draft?.text ?? provisional?.prompt?.text ?? "";
  const attachments = draft?.attachments ?? provisional?.prompt?.attachments ?? [];
  const copy = describeRewindDraft({ state: draft?.state ?? "completed", error: draft?.error });
  const actionsReady = draft !== undefined;

  const run = async (action: () => Promise<void>) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  const resolveDraft = async (intent?: "cancel") => {
    const api = readNativeApi();
    if (!api || !draft) return;
    await api.orchestration.dispatchCommand({
      type: "thread.rewind-draft.resolve",
      // Resolving is idempotent per draft; cancelling gets a fresh id per click
      // so one rejected attempt can't block the next.
      commandId: CommandId.makeUnsafe(
        intent === "cancel" ? crypto.randomUUID() : `rewind-draft:${draft.operationId}`,
      ),
      operationId: draft.operationId,
      threadId,
      ...(intent ? { intent } : {}),
      createdAt: new Date().toISOString(),
    });
  };

  const placeInComposer = (mode: PlaceMode) =>
    run(async () => {
      const api = readNativeApi();
      if (!api || !draft) return;
      if (!placed) {
        const store = useComposerDraftStore.getState();
        const existing = store.draftsByThreadId[threadId];
        const promptBeforeClone = existing?.prompt ?? "";
        const recoveredId = (id: string) => `rewind:${draft.operationId}:${id}`;
        const pendingAttachments = draft.attachments.filter(
          (attachment) =>
            !existing?.persistedAttachments.some(
              (entry) => entry.id === recoveredId(attachment.id),
            ),
        );
        const results = await Promise.allSettled(
          pendingAttachments.map((attachment) =>
            api.attachments.cloneToUpload({ threadId, source: { attachmentId: attachment.id } }),
          ),
        );
        const uploads = results.flatMap((result, index) =>
          result.status === "fulfilled"
            ? [{ ...result.value, recoveredId: recoveredId(pendingAttachments[index]!.id) }]
            : [],
        );
        const failure = results.find((result) => result.status === "rejected");
        // The composer stays editable while attachments clone. Replacing text the
        // user typed in the meantime would lose it without asking again.
        const editedMeanwhile =
          mode === "replace" &&
          (useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt ?? "") !==
            promptBeforeClone;
        if (failure?.status === "rejected" || editedMeanwhile) {
          await api.attachments.releaseUploads({
            threadId,
            uploadIds: uploads.map((upload) => upload.uploadId),
          });
          if (failure?.status === "rejected") throw failure.reason;
          throw new Error("The composer changed while the prompt was loading. Choose again.");
        }
        useComposerDraftStore
          .getState()
          .placeRecoveredPrompt(threadId, draft.operationId, draft.text, mode);
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
        // After the composer re-renders with the new text, so the caret lands at its end.
        if (onFocusComposer) window.requestAnimationFrame(onFocusComposer);
      }
      await resolveDraft();
      setResolved(true);
    });

  // Discard hides the panel at once and only releases the draft when the undo
  // window closes. If the app quits first, the draft simply survives.
  const discard = () => {
    if (!draft || inFlightRef.current) return;
    const discardedOperationId = draft.operationId;
    let undone = false;
    rewindUi.setDraftHidden(discardedOperationId, true);
    toastManager.add({
      title: "Prompt discarded",
      timeout: DISCARD_UNDO_MS,
      data: { threadId },
      actionProps: {
        children: "Undo",
        onClick: () => {
          undone = true;
          rewindUi.setDraftHidden(discardedOperationId, false);
        },
      },
      onClose: () => {
        if (undone) return;
        void resolveDraft().catch((cause: unknown) => {
          rewindUi.setDraftHidden(discardedOperationId, false);
          toastManager.add({
            type: "error",
            title: "Couldn't discard the prompt",
            description: cause instanceof Error ? cause.message : String(cause),
            data: { threadId },
          });
        });
      },
    });
  };

  const retry = () =>
    run(async () => {
      const api = readNativeApi();
      if (!api || !draft?.targetMessageId) return;
      await api.orchestration.dispatchCommand({
        type: "thread.conversation.revert",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        operationId: draft.operationId,
        threadId,
        targetMessageId: draft.targetMessageId,
        restoreFiles: draft.restoreFiles ?? false,
        createdAt: new Date().toISOString(),
      });
    });

  // Only offered for `prepared` rewinds: the server keeps that state only when the
  // provider history is untouched, so cancelling cannot leave it half-rewound. The
  // `cancel` intent makes the server reject it once the rewind has moved on.
  const cancel = () =>
    run(async () => {
      await resolveDraft("cancel");
      setResolved(true);
    });

  if (resolved) return null;
  const StateIcon = TONE_ICON[copy.tone];
  const disabled = busy || !actionsReady;
  // Attachments are always added, never swapped: dropping the user's own
  // attachments silently would be worse than an extra one to remove.
  const placeTitle = !actionsReady
    ? "Saving your prompt…"
    : attachments.length > 0
      ? "Its attachments are added alongside any already in the composer."
      : undefined;
  const isLongText =
    text.length > PREVIEW_CLAMP_CHARACTERS || text.split("\n").length > PREVIEW_CLAMP_LINES;

  return (
    <section
      className={cn(
        "mx-auto mb-2 w-full max-w-3xl rounded-xl border border-border/70 bg-card/95 px-3 py-2.5 text-sm shadow-sm",
        "transition-[opacity,translate] duration-200 ease-out motion-reduce:transition-none",
        entered ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
        copy.tone === "error" && "border-destructive/30",
        copy.tone === "warning" && "border-warning/40",
      )}
      aria-label={copy.title}
      data-slot="rewind-draft-panel"
      data-rewind-tone={copy.tone}
    >
      <div className="flex items-center gap-2">
        <StateIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground",
            copy.tone === "working" && "animate-spin motion-reduce:animate-none",
            copy.tone === "error" && "text-destructive",
            copy.tone === "warning" && "text-warning-foreground",
          )}
        />
        <span className="font-medium text-xs">{copy.title}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {copy.actions.includes("discard") ? (
            <Button size="xs" variant="ghost" disabled={disabled} onClick={discard}>
              Discard
            </Button>
          ) : null}
          {copy.actions.includes("edit") ? (
            composerHasText ? (
              <div className="flex items-center">
                <Button
                  size="xs"
                  className="rounded-r-none"
                  disabled={disabled}
                  title={placeTitle}
                  onClick={() => void placeInComposer("replace")}
                >
                  Replace composer text
                </Button>
                <Menu>
                  <MenuTrigger
                    disabled={disabled}
                    render={
                      <Button
                        size="xs"
                        className="rounded-l-none border-l-white/12 px-1.5"
                        aria-label="More ways to use this prompt"
                      />
                    }
                  >
                    <ChevronDownIcon className="size-3.5" />
                  </MenuTrigger>
                  <MenuPopup align="end" side="top">
                    <MenuItem onClick={() => void placeInComposer("append")}>
                      Add below current text
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </div>
            ) : (
              <Button
                size="xs"
                disabled={disabled}
                title={placeTitle}
                onClick={() => void placeInComposer("replace")}
              >
                Edit in composer
              </Button>
            )
          ) : null}
          {copy.actions.includes("cancel") ? (
            <Button size="xs" variant="ghost" disabled={disabled} onClick={() => void cancel()}>
              Cancel revert
            </Button>
          ) : null}
          {(copy.actions.includes("retry") || copy.actions.includes("recheck")) &&
          draft?.targetMessageId ? (
            <Button size="xs" variant="outline" disabled={disabled} onClick={() => void retry()}>
              {copy.actions.includes("retry") ? "Try again" : "Recheck"}
            </Button>
          ) : null}
        </div>
      </div>
      {copy.tone === "ready" && text ? (
        <div className="mt-2 rounded-md bg-muted/40 px-2 py-1.5">
          <p
            className={cn(
              "whitespace-pre-wrap text-muted-foreground text-xs",
              !expanded && "line-clamp-3",
            )}
          >
            {text}
          </p>
          {isLongText ? (
            <button
              type="button"
              className="mt-1 text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Show less" : "Show all"}
            </button>
          ) : null}
        </div>
      ) : null}
      {copy.tone === "ready" && attachments.length > 0 ? (
        <ul className="mt-1.5 flex flex-wrap gap-1" aria-label="Attachments">
          {attachments.map((attachment) => {
            const AttachmentIcon = attachment.type === "image" ? ImageIcon : FileIcon;
            return (
              <li
                key={attachment.id}
                className="inline-flex max-w-48 items-center gap-1 rounded-md border border-border/70 px-1.5 py-0.5 text-muted-foreground text-xs"
              >
                <AttachmentIcon aria-hidden className="size-3 shrink-0" />
                <span className="truncate">{attachment.name}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {copy.tone !== "ready" && draft?.error ? (
        <p className="mt-1.5 text-muted-foreground text-xs">{draft.error}</p>
      ) : null}
      {copy.hint ? <p className="mt-1 text-muted-foreground text-xs">{copy.hint}</p> : null}
      {error ? (
        <p role="alert" className="mt-1.5 text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </section>
  );
}
