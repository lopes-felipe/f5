import { ArrowDownIcon, LoaderIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import type { ChatMessage } from "../../types";
import { messageTextRevision } from "../../lib/streamingTextRevision";
import { Kbd } from "../ui/kbd";
import { classifyTimelineTailChange, type TimelineTailSnapshot } from "./MessagesTimeline.logic";
import { CHAT_CONTENT_COLUMN_CLASS_NAME } from "./chatLayout";

/** The last timeline entry, as the pill compares it. */
export function timelineTailSnapshot(
  entry: { readonly id: string; readonly kind: string; readonly message?: ChatMessage } | undefined,
): TimelineTailSnapshot {
  const message = entry?.kind === "message" ? entry.message : undefined;
  const revision = message ? messageTextRevision(message) : undefined;
  return {
    rowId: entry?.id ?? null,
    textEpoch: revision?.epoch ?? null,
    textRevision: revision?.revision ?? null,
    text: message?.text ?? null,
  };
}

/**
 * Floating "Jump to latest" pill shown while the reader is scrolled away from
 * the end, and while a jump is still loading. A dot marks content that arrived
 * after the reader scrolled away: new rows, or more text in the response they
 * left streaming. The baseline is `leftEndTail` (the tail when the reader left
 * the end, since the pill mounts after a debounce) or else the tail at mount,
 * and is refreshed when the reader returns to the end.
 */
export function JumpToLatestButton(props: {
  tail: TimelineTailSnapshot;
  leftEndTail?: TimelineTailSnapshot | null;
  shortcutLabel: string | null;
  onJump: () => void;
  isAtEnd?: boolean;
  jumping?: boolean;
}) {
  const controlRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const control = controlRef.current;
    const host = control?.closest<HTMLElement>("[data-composer-dock-host]");
    if (!control || !host) return;
    // Keep the Working activity to the left of the centered overlay.
    const publishWidth = () => {
      host.style.setProperty(
        "--timeline-follow-controls-width",
        "calc(50% + " + String(Math.ceil(control.offsetWidth / 2) + 12) + "px)",
      );
    };
    publishWidth();
    const observer = new ResizeObserver(publishWidth);
    observer.observe(control);
    return () => {
      observer.disconnect();
      host.style.removeProperty("--timeline-follow-controls-width");
    };
  }, []);
  const [baseline, setBaseline] = useState(props.leftEndTail ?? props.tail);
  const [latched, setLatched] = useState<"new-messages" | "response-updated" | null>(null);
  const change = classifyTimelineTailChange(baseline, props.tail);
  if (props.isAtEnd && (change || latched)) {
    setBaseline(props.tail);
    setLatched(null);
  } else if (!props.isAtEnd && change && latched !== "new-messages" && change !== latched) {
    setLatched(change);
  }
  const hasNewContent = !props.isAtEnd && latched !== null;

  return (
    <div
      className={
        CHAT_CONTENT_COLUMN_CLASS_NAME +
        " pointer-events-none absolute inset-x-0 bottom-(--composer-dock-height) z-30 flex justify-center py-1 sm:bottom-[calc(var(--composer-dock-height,0px)+0.25rem)]"
      }
    >
      <div
        ref={controlRef}
        className="pointer-events-auto relative flex max-w-full items-center rounded-full border border-border bg-popover shadow-md"
      >
        <button
          type="button"
          onClick={props.onJump}
          disabled={props.jumping}
          aria-busy={props.jumping || undefined}
          className="relative flex h-6 items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-xs text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-70"
        >
          {props.jumping ? (
            <LoaderIcon className="size-3.5 animate-spin" />
          ) : (
            <ArrowDownIcon className="size-3.5" />
          )}
          <span>{props.jumping ? "Jumping…" : "Jump to latest"}</span>
          {latched === "new-messages" ? (
            <span className="sr-only">, new messages</span>
          ) : latched === "response-updated" ? (
            <span className="sr-only">, response updated</span>
          ) : null}
          {props.shortcutLabel && !props.isAtEnd ? (
            <Kbd className="h-4 min-w-4 px-1 text-2xs">{props.shortcutLabel}</Kbd>
          ) : null}
        </button>
        {hasNewContent ? (
          <span
            aria-hidden="true"
            data-slot="jump-to-latest-new-content"
            className="absolute -top-0.5 -right-1 size-2 rounded-full bg-info ring-2 ring-background motion-safe:animate-fade-in"
          />
        ) : null}
      </div>
    </div>
  );
}
