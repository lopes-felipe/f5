import { ListTreeIcon, LoaderIcon, SearchIcon } from "lucide-react";
import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { TimestampFormat } from "../../appSettings";
import { cn } from "../../lib/utils";
import { formatShortTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import type { TimelineTurnRailItem } from "./MessagesTimeline.logic";

export interface ConversationNavigationSnapshot {
  readonly items: readonly TimelineTurnRailItem[];
  /** Index into `items` of the turn currently in view, or -1. */
  readonly activeIndex: number;
  readonly hasOlderHistory: boolean;
  readonly isLoadingOlderHistory: boolean;
  readonly hasHistoryLoadError: boolean;
}

const EMPTY_SNAPSHOT: ConversationNavigationSnapshot = {
  items: [],
  activeIndex: -1,
  hasOlderHistory: false,
  isLoadingOlderHistory: false,
  hasHistoryLoadError: false,
};

/**
 * Timeline-local publication of the turn list. The timeline publishes on every
 * change; only an open popover subscribes, so a closed control costs nothing.
 */
export interface ConversationNavigationStore {
  getSnapshot: () => ConversationNavigationSnapshot;
  subscribe: (listener: () => void) => () => void;
  publish: (snapshot: ConversationNavigationSnapshot) => void;
  subscriberCount: () => number;
}

export function createConversationNavigationStore(): ConversationNavigationStore {
  let snapshot = EMPTY_SNAPSHOT;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish: (next) => {
      snapshot = next;
      for (const listener of listeners) listener();
    },
    subscriberCount: () => listeners.size,
  };
}

export interface ConversationNavigationProps {
  store: ConversationNavigationStore;
  disabled: boolean;
  timestampFormat: TimestampFormat;
  onSelectTurn: (item: TimelineTurnRailItem) => void;
  onOpenFind?: (() => void) | undefined;
  onLoadOlderHistory?: (() => void) | undefined;
  onRetryOlderHistory?: (() => void) | undefined;
}

export const ConversationNavigation = memo(function ConversationNavigation(
  props: ConversationNavigationProps,
) {
  const [open, setOpen] = useState(false);
  if (open && props.disabled) setOpen(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Conversation navigation"
            title="Conversation navigation"
            disabled={props.disabled}
          />
        }
      >
        <ListTreeIcon aria-hidden="true" />
      </PopoverTrigger>
      {open ? (
        <PopoverPopup
          side="bottom"
          align="end"
          className="w-[min(24rem,calc(100vw-2rem))]"
          data-slot="conversation-navigation"
        >
          <ConversationNavigationContent
            {...props}
            onClose={() => {
              setOpen(false);
            }}
          />
        </PopoverPopup>
      ) : null}
    </Popover>
  );
});

function ConversationNavigationContent({
  store,
  timestampFormat,
  onSelectTurn,
  onOpenFind,
  onLoadOlderHistory,
  onRetryOlderHistory,
  onClose,
}: ConversationNavigationProps & { onClose: () => void }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const listRef = useRef<HTMLOListElement>(null);
  // Opens on the turn in view, or the newest one.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const index = snapshot.activeIndex >= 0 ? snapshot.activeIndex : snapshot.items.length - 1;
    list.children[index]?.scrollIntoView({ block: "nearest" });
    // Only on open: later updates must not move the list under the pointer.
  }, []);
  return (
    <div className="flex flex-col gap-3" data-thread-find-ignore>
      {onOpenFind ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="justify-start"
          onClick={() => {
            onClose();
            onOpenFind();
          }}
        >
          <SearchIcon aria-hidden="true" />
          Find in thread
        </Button>
      ) : null}
      {snapshot.hasOlderHistory ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <p role="status">
            {snapshot.isLoadingOlderHistory
              ? "Loading earlier turns…"
              : snapshot.hasHistoryLoadError
                ? "Could not load earlier turns."
                : "Loaded turns only. Earlier turns are not loaded yet."}
          </p>
          {snapshot.isLoadingOlderHistory ? (
            <LoaderIcon aria-hidden="true" className="size-3.5 animate-spin" />
          ) : snapshot.hasHistoryLoadError ? (
            onRetryOlderHistory ? (
              <Button type="button" size="xs" variant="outline" onClick={onRetryOlderHistory}>
                Retry
              </Button>
            ) : null
          ) : onLoadOlderHistory ? (
            <Button type="button" size="xs" variant="outline" onClick={onLoadOlderHistory}>
              Load earlier
            </Button>
          ) : null}
        </div>
      ) : null}
      {snapshot.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No turns loaded yet.</p>
      ) : (
        <ol
          ref={listRef}
          aria-label="Turns"
          className="-mx-1 flex max-h-80 flex-col gap-0.5 overflow-y-auto"
        >
          {snapshot.items.map((item, index) => (
            <li key={item.id}>
              <button
                type="button"
                aria-current={index === snapshot.activeIndex ? "true" : undefined}
                className={cn(
                  "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                  index === snapshot.activeIndex && "bg-accent/60",
                )}
                onClick={() => {
                  onClose();
                  onSelectTurn(item);
                }}
              >
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {item.userText ?? "Message"}
                  </span>
                  {item.createdAt ? (
                    <time
                      dateTime={item.createdAt}
                      className="shrink-0 text-xs text-muted-foreground tabular-nums"
                    >
                      {formatShortTimestamp(item.createdAt, timestampFormat)}
                    </time>
                  ) : null}
                </span>
                {item.assistantText ? (
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {item.assistantText}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
