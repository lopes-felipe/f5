import { AttachmentFileChip } from "./AttachmentFileChip";
import { getServerHttpOrigin } from "../../lib/serverHttpOrigin";
import type {
  CommandId,
  NextTurnQueueItem,
  NextTurnQueueSnapshot,
  RuntimeMode,
} from "@t3tools/contracts";
import { isAdmittedDeliveryQueueItem, RUNTIME_MODE_VALUES } from "@t3tools/contracts";
import { CSS } from "@dnd-kit/utilities";
import { useSortable } from "@dnd-kit/sortable";
import {
  ArrowUpIcon,
  CopyIcon,
  GripVerticalIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlayIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { type QueueEditDraft, useNextTurnQueueStore } from "~/nextTurnQueueStore";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { SkillInlineChip } from "./SkillInlineChip";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { buildQueueRowDisplay, USAGE_LIMIT_RESUME_LABEL } from "./NextTurnQueuePanel.logic";
import { RUNTIME_MODE_PRESENTATION } from "./runtimeModePresentation";

export function NextTurnQueueRow({
  item,
  index,
  snapshot,
  busy,
  onMove,
  onUpdate,
  onCancel,
  onRetry,
  onDuplicate,
  onMoveToTop,
  onRunNow,
  canRunNow,
  onSteer,
  canSteer,
}: {
  readonly item: NextTurnQueueItem;
  readonly index: number;
  readonly snapshot: NextTurnQueueSnapshot;
  readonly busy: boolean;
  readonly onMove: (itemId: CommandId, direction: -1 | 1) => void;
  readonly onUpdate: (
    item: NextTurnQueueItem,
    update: {
      readonly text: string;
      readonly model: string | undefined;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: "default" | "plan";
    },
  ) => Promise<void>;
  readonly onCancel: (item: NextTurnQueueItem) => Promise<void>;
  readonly onRetry: (item: NextTurnQueueItem) => Promise<void>;
  readonly onDuplicate: (item: NextTurnQueueItem) => Promise<void>;
  readonly onMoveToTop: (item: NextTurnQueueItem) => Promise<void>;
  readonly onSteer?: ((item: NextTurnQueueItem) => Promise<void>) | undefined;
  readonly canSteer?: boolean | undefined;
  readonly canRunNow: boolean;
  readonly onRunNow: (item: NextTurnQueueItem) => Promise<void>;
}) {
  const admitted = isAdmittedDeliveryQueueItem(item);
  const disabled = busy || item.status === "dispatching" || admitted;
  const display = buildQueueRowDisplay(item);
  const continuation = item.command.presentation === "continuation";
  const draft = useNextTurnQueueStore(
    (store) => store.byThreadId[snapshot.threadId]?.editDrafts[item.itemId] ?? null,
  );
  const setEditDraft = useNextTurnQueueStore((store) => store.setEditDraft);
  const editing = draft !== null;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Only an edit the user just started takes focus; a draft restored when the
  // panel remounts leaves focus where it is.
  const focusEditorRef = useRef(false);
  const sortable = useSortable({ id: item.itemId, disabled });

  useEffect(() => {
    if (!editing || !focusEditorRef.current) return;
    focusEditorRef.current = false;
    textareaRef.current?.focus();
    textareaRef.current?.select();
  }, [editing]);

  const updateDraft = (patch: Partial<QueueEditDraft>) => {
    if (draft) setEditDraft(snapshot.threadId, item.itemId, { ...draft, ...patch });
  };
  const stopEditing = () => setEditDraft(snapshot.threadId, item.itemId, null);
  const saveDraft = () => {
    if (!draft) return;
    void onUpdate(item, {
      text: draft.text,
      model: draft.model.trim() || undefined,
      runtimeMode: draft.runtimeMode,
      interactionMode: draft.interactionMode,
    }).then(stopEditing);
  };

  useEffect(() => {
    if (!item.notBefore) return;
    const deadline = Date.parse(item.notBefore);
    if (!Number.isFinite(deadline) || deadline <= Date.now()) {
      setNowMs(Date.now());
      return;
    }
    if (item.scheduleReason === "usage_limit_reset" && item.attemptCount === 0) {
      let timeout: number;
      const arm = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          setNowMs(Date.now());
          return;
        }
        timeout = window.setTimeout(arm, Math.min(remaining, 86_400_000));
      };
      arm();
      return () => window.clearTimeout(timeout);
    }
    const interval = window.setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      if (now >= deadline) window.clearInterval(interval);
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [item.notBefore, item.scheduleReason, item.attemptCount]);

  const retrySeconds =
    item.notBefore === null
      ? 0
      : Math.max(0, Math.ceil((Date.parse(item.notBefore) - nowMs) / 1_000));

  const statusText = admitted
    ? snapshot.unresolvedDelivery
      ? "Delivery unconfirmed. Use Recheck, Retry or Discard above."
      : "Checking delivery…"
    : item.status === "dispatching"
      ? "Sending this turn now."
      : retrySeconds > 0
        ? item.scheduleReason === "usage_limit_reset" && item.attemptCount === 0
          ? `${USAGE_LIMIT_RESUME_LABEL} · ${new Date(item.notBefore!).toLocaleString()}`
          : `Retrying in ${retrySeconds}s`
        : item.status === "failed"
          ? (item.lastErrorDetail ?? "Delivery failed")
          : index === 0
            ? "Up next"
            : "Queued";

  return (
    <li
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Translate.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={`rounded-lg border border-border/55 bg-background/55 p-2 ${sortable.isDragging ? "z-20 opacity-70" : ""}`}
      tabIndex={0}
      aria-label={`Queued turn ${index + 1}: ${item.scheduleReason === "usage_limit_reset" ? USAGE_LIMIT_RESUME_LABEL : continuation ? "Resuming after restart" : display.label || "Empty turn"}`}
      aria-describedby="next-turn-queue-reorder-help"
      onKeyDown={(event) => {
        if (!event.altKey || disabled) return;
        if (event.key === "ArrowUp") {
          event.preventDefault();
          onMove(item.itemId, -1);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          onMove(item.itemId, 1);
        }
      }}
    >
      {draft && !admitted ? (
        <div className="space-y-2">
          <Textarea
            ref={textareaRef}
            size="sm"
            value={draft.text}
            onChange={(event) => updateDraft({ text: event.currentTarget.value })}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") {
                stopEditing();
              } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                saveDraft();
              }
            }}
            aria-label="Queued turn text"
          />
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
            <input
              className="h-8 rounded-md border bg-background px-2 text-xs"
              aria-label="Queued turn model"
              placeholder="Thread model"
              value={draft.model}
              onChange={(event) => updateDraft({ model: event.currentTarget.value })}
            />
            <select
              className="h-8 rounded-md border bg-background px-2 text-xs"
              aria-label="Queued turn mode"
              value={draft.interactionMode}
              onChange={(event) =>
                updateDraft({ interactionMode: event.currentTarget.value as "default" | "plan" })
              }
            >
              <option value="default">Default mode</option>
              <option value="plan">Plan mode</option>
            </select>
            <select
              className="h-8 rounded-md border bg-background px-2 text-xs"
              aria-label="Queued turn access"
              value={draft.runtimeMode}
              onChange={(event) =>
                updateDraft({ runtimeMode: event.currentTarget.value as RuntimeMode })
              }
            >
              {RUNTIME_MODE_VALUES.map((mode) => (
                <option key={mode} value={mode}>
                  {RUNTIME_MODE_PRESENTATION[mode].label}
                </option>
              ))}
            </select>
          </div>
          {display.contextCount > 0 || display.attachedFilePaths.length > 0 ? (
            <p className="text-muted-foreground text-xs">
              Editing keeps the attached files and terminal context.
            </p>
          ) : null}
          <div className="flex justify-end gap-1.5">
            <Button type="button" variant="ghost" size="xs" onClick={stopEditing}>
              Cancel
            </Button>
            <Button
              type="button"
              size="xs"
              disabled={draft.text.trim().length === 0}
              onClick={saveDraft}
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 items-start gap-1.5">
          <button
            type="button"
            className="mt-0.5 cursor-grab text-muted-foreground disabled:cursor-not-allowed"
            aria-label="Drag to reorder queued turn"
            disabled={disabled || continuation}
            {...sortable.attributes}
            {...sortable.listeners}
          >
            <GripVerticalIcon className="size-3.5" />
          </button>
          <span className="mt-0.5 w-5 shrink-0 text-center text-muted-foreground text-xs">
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p
              className={`line-clamp-2 whitespace-pre-wrap text-sm ${display.label === "Image-only turn" ? "italic text-muted-foreground" : ""}`}
              title={display.label}
            >
              {display.label || "Empty turn"}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {item.command.message.skillCall ? (
                <SkillInlineChip name={item.command.message.skillCall.name} />
              ) : null}
              {display.contexts.map((context) => (
                <TerminalContextInlineChip
                  key={`${context.header}:${context.body.slice(0, 20)}`}
                  label={context.header}
                  tooltipText={context.body || context.header}
                />
              ))}
              {display.attachedFilePaths.map((filePath) => (
                <span key={filePath} className="rounded bg-muted px-1.5 py-0.5 text-2xs">
                  {filePath.split(/[\\/]/).at(-1)}
                </span>
              ))}
              {display.fileCount > 0 && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-2xs">
                  {display.fileCount} file{display.fileCount === 1 ? "" : "s"}
                </span>
              )}
              {display.imageCount > 0 ? (
                <span className="rounded bg-muted px-1.5 py-0.5 text-2xs">
                  {display.imageCount} image{display.imageCount === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
            {item.command.message.attachments
              .filter((file) => file.type === "file")
              .map((file) => (
                <AttachmentFileChip
                  key={file.id}
                  file={{
                    ...file,
                    sourceUrl: `${getServerHttpOrigin()}/attachments/${encodeURIComponent(file.id)}`,
                  }}
                />
              ))}
            <p
              className={`mt-1 truncate text-2xs ${item.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
            >
              {item.status === "dispatching" ? (
                <LoaderCircleIcon className="mr-1 inline size-3 animate-spin" />
              ) : null}
              {statusText}
              {item.command.model ? ` · ${item.command.model}` : ""}
              {` · ${item.command.interactionMode} · ${item.command.runtimeMode}`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {!admitted && item.status === "failed" ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={disabled || continuation}
                aria-label="Retry queued turn"
                onClick={() => void onRetry(item)}
              >
                <RotateCcwIcon />
              </Button>
            ) : null}
            {!admitted ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={disabled || continuation || index === 0}
                aria-label="Move queued turn to top"
                onClick={() => void onMoveToTop(item)}
              >
                <ArrowUpIcon />
              </Button>
            ) : null}
            {!admitted && canRunNow ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={disabled || (snapshot.unresolvedDelivery ?? null) !== null}
                aria-label="Run queued turn now"
                onClick={() => void onRunNow(item)}
              >
                <PlayIcon />
              </Button>
            ) : null}
            {!admitted && onSteer ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={disabled || continuation || !canSteer}
                onClick={() => void onSteer(item)}
              >
                Steer now
              </Button>
            ) : null}
            {!admitted ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={disabled || continuation}
                  aria-label="Edit queued turn"
                  onClick={() => {
                    focusEditorRef.current = true;
                    setEditDraft(snapshot.threadId, item.itemId, {
                      text: display.visibleText,
                      model: item.command.model ?? "",
                      runtimeMode: item.command.runtimeMode,
                      interactionMode: item.command.interactionMode,
                    });
                  }}
                >
                  <PencilIcon />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={disabled || continuation || snapshot.items.length >= snapshot.maxItems}
                  aria-label="Duplicate queued turn"
                  onClick={() => void onDuplicate(item)}
                >
                  <CopyIcon />
                </Button>
              </>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={disabled || (continuation && item.scheduleReason !== "usage_limit_reset")}
              aria-label="Cancel queued turn"
              onClick={() => void onCancel(item)}
            >
              <Trash2Icon />
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
