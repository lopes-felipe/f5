import type {
  CommandId,
  NextTurnQueueItem,
  NextTurnQueueSnapshot,
  RuntimeMode,
} from "@t3tools/contracts";
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

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { SkillInlineChip } from "./SkillInlineChip";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { buildQueueRowDisplay } from "./NextTurnQueuePanel.logic";

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
  readonly onRunNow: (item: NextTurnQueueItem) => Promise<void>;
}) {
  const disabled = busy || item.status === "dispatching";
  const display = buildQueueRowDisplay(item);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(display.visibleText);
  const [editModel, setEditModel] = useState(item.command.model ?? "");
  const [editRuntimeMode, setEditRuntimeMode] = useState(item.command.runtimeMode);
  const [editInteractionMode, setEditInteractionMode] = useState(item.command.interactionMode);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sortable = useSortable({ id: item.itemId, disabled });

  useEffect(() => {
    if (!editing) return;
    textareaRef.current?.focus();
    textareaRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (item.notBefore === null || Date.parse(item.notBefore) <= nowMs) return;
    const interval = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [item.notBefore, nowMs]);

  const retrySeconds =
    item.notBefore === null
      ? 0
      : Math.max(0, Math.ceil((Date.parse(item.notBefore) - nowMs) / 1_000));

  const statusText =
    item.status === "dispatching"
      ? "Sending this turn now."
      : retrySeconds > 0
        ? `Retrying in ${retrySeconds}s`
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
      aria-label={`Queued turn ${index + 1}: ${display.label || "Empty turn"}`}
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
      {editing ? (
        <div className="space-y-2">
          <Textarea
            ref={textareaRef}
            size="sm"
            value={editText}
            onChange={(event) => setEditText(event.currentTarget.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") {
                setEditing(false);
              } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void onUpdate(item, {
                  text: editText,
                  model: editModel.trim() || undefined,
                  runtimeMode: editRuntimeMode,
                  interactionMode: editInteractionMode,
                }).then(() => setEditing(false));
              }
            }}
            aria-label="Queued turn text"
          />
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
            <input
              className="h-8 rounded-md border bg-background px-2 text-xs"
              aria-label="Queued turn model"
              placeholder="Thread model"
              value={editModel}
              onChange={(event) => setEditModel(event.currentTarget.value)}
            />
            <select
              className="h-8 rounded-md border bg-background px-2 text-xs"
              aria-label="Queued turn mode"
              value={editInteractionMode}
              onChange={(event) =>
                setEditInteractionMode(event.currentTarget.value as "default" | "plan")
              }
            >
              <option value="default">Default mode</option>
              <option value="plan">Plan mode</option>
            </select>
            <select
              className="h-8 rounded-md border bg-background px-2 text-xs"
              aria-label="Queued turn access"
              value={editRuntimeMode}
              onChange={(event) => setEditRuntimeMode(event.currentTarget.value as RuntimeMode)}
            >
              <option value="approval-required">Ask approval</option>
              <option value="full-access">Full access</option>
            </select>
          </div>
          {display.contextCount > 0 || display.attachedFilePaths.length > 0 ? (
            <p className="text-muted-foreground text-xs">
              Editing keeps the attached files and terminal context.
            </p>
          ) : null}
          <div className="flex justify-end gap-1.5">
            <Button type="button" variant="ghost" size="xs" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="xs"
              disabled={editText.trim().length === 0}
              onClick={() =>
                void onUpdate(item, {
                  text: editText,
                  model: editModel.trim() || undefined,
                  runtimeMode: editRuntimeMode,
                  interactionMode: editInteractionMode,
                }).then(() => setEditing(false))
              }
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
            disabled={disabled}
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
                <span key={filePath} className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                  {filePath.split(/[\\/]/).at(-1)}
                </span>
              ))}
              {display.imageCount > 0 ? (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                  {display.imageCount} image{display.imageCount === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
            <p
              className={`mt-1 truncate text-[11px] ${item.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
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
            {item.status === "failed" ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={disabled}
                aria-label="Retry queued turn"
                onClick={() => void onRetry(item)}
              >
                <RotateCcwIcon />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={disabled || index === 0}
              aria-label="Move queued turn to top"
              onClick={() => void onMoveToTop(item)}
            >
              <ArrowUpIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={
                disabled ||
                snapshot.reasonCode === "delivery_rejected" ||
                snapshot.reasonCode === "delivery_ambiguous"
              }
              aria-label="Run queued turn now"
              onClick={() => void onRunNow(item)}
            >
              <PlayIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={disabled}
              aria-label="Edit queued turn"
              onClick={() => {
                setEditText(display.visibleText);
                setEditModel(item.command.model ?? "");
                setEditRuntimeMode(item.command.runtimeMode);
                setEditInteractionMode(item.command.interactionMode);
                setEditing(true);
              }}
            >
              <PencilIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={disabled || snapshot.items.length >= snapshot.maxItems}
              aria-label="Duplicate queued turn"
              onClick={() => void onDuplicate(item)}
            >
              <CopyIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={disabled}
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
