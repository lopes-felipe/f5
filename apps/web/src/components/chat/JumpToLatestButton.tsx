import { ArrowDownIcon, LoaderIcon } from "lucide-react";
import { useState } from "react";

import type { ChatMessage } from "../../types";
import { messageTextRevision } from "../../lib/streamingTextRevision";
import { Kbd } from "../ui/kbd";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { classifyTimelineTailChange, type TimelineTailSnapshot } from "./MessagesTimeline.logic";

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
 * Floating scroll controls, also kept visible while following is enabled.
 * A dot marks content that arrived after the reader scrolled away:
 * new rows, or more text in the response they left streaming. The baseline is
 * taken on mount and refreshed when the reader returns to the end.
 */
export function JumpToLatestButton(props: {
  tail: TimelineTailSnapshot;
  shortcutLabel: string | null;
  onJump: () => void;
  following?: boolean;
  onFollowingChange?: (following: boolean) => void;
  isAtEnd?: boolean;
  jumping?: boolean;
}) {
  const [baseline, setBaseline] = useState(props.tail);
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
    <div className="pointer-events-none absolute bottom-[calc(var(--composer-dock-height,0px)+0.25rem)] left-1/2 z-30 flex max-w-[calc(100%_-_1rem)] -translate-x-1/2 justify-center py-1.5">
      <div className="pointer-events-auto flex items-center rounded-full border border-border bg-popover shadow-md">
        <button
          type="button"
          onClick={props.onJump}
          disabled={props.jumping}
          aria-busy={props.jumping || undefined}
          className="relative flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-ui text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-70"
        >
          {hasNewContent ? (
            <span
              aria-hidden="true"
              data-slot="jump-to-latest-new-content"
              className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-info ring-2 ring-background motion-safe:animate-fade-in"
            />
          ) : null}
          {props.jumping ? (
            <LoaderIcon className="size-3.5 animate-spin" />
          ) : (
            <ArrowDownIcon className="size-3.5" />
          )}
          <span>
            {props.jumping
              ? "Jumping…"
              : props.following && props.isAtEnd
                ? "Following"
                : "Jump to latest"}
          </span>
          {latched === "new-messages" ? (
            <span className="sr-only">, new messages</span>
          ) : latched === "response-updated" ? (
            <span className="sr-only">, response updated</span>
          ) : null}
          {props.shortcutLabel && !props.isAtEnd ? (
            <Kbd className="h-4 min-w-4 px-1 text-2xs">{props.shortcutLabel}</Kbd>
          ) : null}
        </button>
        {props.onFollowingChange ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex shrink-0 items-center border-l border-border px-2" />
              }
            >
              <Switch
                aria-label="Follow new messages"
                checked={props.following ?? false}
                onCheckedChange={props.onFollowingChange}
                className="[--thumb-size:--spacing(3.5)] sm:[--thumb-size:--spacing(3.5)]"
              />
            </TooltipTrigger>
            <TooltipPopup side="top">
              Follow new messages. Scrolling up turns this off.
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}
