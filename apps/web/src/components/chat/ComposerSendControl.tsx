import { ArrowUpIcon, ChevronDownIcon, LoaderCircleIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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
  sendShortcutLabel,
  onIntent,
  onInterrupt,
}: {
  readonly sendShortcutLabel?: string | undefined;
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
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="submit"
                  className={cn(
                    "flex size-8 items-center justify-center bg-primary text-primary-foreground outline-none transition-colors duration-(--duration-fast) hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:opacity-40",
                    showMenu ? "rounded-l-full rounded-r-none" : "rounded-full",
                  )}
                  disabled={disabled}
                  aria-label={connecting ? "Connecting" : busy ? busyLabel : "Send message"}
                />
              }
            >
              {busy || connecting ? (
                <LoaderCircleIcon className="size-4 animate-spin" />
              ) : (
                <ArrowUpIcon className="size-4" aria-hidden="true" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {sendShortcutLabel ? `Send (${sendShortcutLabel})` : "Send"}
            </TooltipPopup>
          </Tooltip>
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
          className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-destructive text-white outline-none transition-colors duration-(--duration-fast) hover:bg-destructive/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          onClick={onInterrupt}
          aria-label="Stop generation"
          title="Stop generation"
        >
          <span className="size-2.5 rounded-xs bg-current" />
        </button>
      ) : null}
    </div>
  );
}
