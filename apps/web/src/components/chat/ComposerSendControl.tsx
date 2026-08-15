import { ChevronDownIcon, LoaderCircleIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

type SendIntent = "auto" | "queue-tail" | "queue-head" | "send-now";

export function ComposerSendControl({
  running,
  hasSendableContent,
  dispatchBlocked,
  connecting,
  busy,
  busyLabel = "Sending",
  paused,
  runnableQueueCount,
  itemCount,
  maxItems,
  serverThread,
  onIntent,
  onInterrupt,
}: {
  readonly running: boolean;
  readonly hasSendableContent: boolean;
  readonly dispatchBlocked: boolean;
  readonly connecting: boolean;
  readonly busy: boolean;
  readonly busyLabel?: string;
  readonly paused: boolean;
  readonly runnableQueueCount: number;
  readonly itemCount: number;
  readonly maxItems: number;
  readonly serverThread: boolean;
  readonly onIntent: (intent: SendIntent) => void;
  readonly onInterrupt: () => void;
}) {
  const full = itemCount >= maxItems;
  const disabled = !hasSendableContent || dispatchBlocked || connecting || busy || full;
  const likelyQueued = running || runnableQueueCount > 0;
  const textLabel = full
    ? "Queue full"
    : connecting || busy
      ? `${connecting ? "Connecting" : busyLabel}...`
      : likelyQueued
        ? "Queue"
        : paused || itemCount > 0
          ? "Send now"
          : null;
  const showMenu = serverThread && (running || itemCount > 0 || paused);

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center">
        {textLabel ? (
          <Button
            type="submit"
            size="sm"
            variant={running ? "outline" : "default"}
            className={showMenu ? "rounded-l-full rounded-r-none" : "rounded-full"}
            disabled={disabled}
            title={full ? `A thread can queue at most ${maxItems} turns.` : undefined}
            onClick={(event) => {
              if (!likelyQueued && (paused || itemCount > 0)) {
                event.preventDefault();
                onIntent("send-now");
              }
            }}
          >
            {busy || connecting ? <LoaderCircleIcon className="animate-spin" /> : null}
            {textLabel}
          </Button>
        ) : (
          <button
            type="submit"
            className={`flex h-9 w-9 items-center justify-center bg-primary/90 text-primary-foreground transition-all duration-150 hover:bg-primary hover:scale-105 disabled:opacity-30 disabled:hover:scale-100 sm:h-8 sm:w-8 ${showMenu ? "rounded-l-full rounded-r-none" : "rounded-full"}`}
            disabled={disabled}
            aria-label={connecting ? "Connecting" : busy ? busyLabel : "Send message"}
          >
            {busy || connecting ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path
                  d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        )}
        {showMenu ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  type="button"
                  size="sm"
                  variant={running ? "outline" : "default"}
                  className="rounded-l-none rounded-r-full px-2"
                  aria-label="Queue options"
                  disabled={!hasSendableContent || dispatchBlocked || connecting || busy}
                />
              }
            >
              <ChevronDownIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" side="top">
              <MenuItem disabled={full} onClick={() => onIntent("queue-tail")}>
                Queue at end
              </MenuItem>
              <MenuItem disabled={full} onClick={() => onIntent("queue-head")}>
                Queue next
              </MenuItem>
              <MenuItem onClick={() => onIntent("send-now")}>Send now</MenuItem>
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
      {running ? (
        <button
          type="button"
          className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-rose-500/90 text-white transition-all duration-150 hover:bg-rose-500 hover:scale-105"
          onClick={onInterrupt}
          aria-label="Stop generation"
        >
          <span className="size-2 rounded-sm bg-current" />
        </button>
      ) : null}
    </div>
  );
}
