import { ArrowDownIcon } from "lucide-react";
import { useState } from "react";

import { Kbd } from "../ui/kbd";

/**
 * Floating "Jump to latest" pill shown while the reader is scrolled away from
 * the end. A dot marks rows that arrived after the reader scrolled away.
 */
export function JumpToLatestButton(props: {
  lastRowId: string | null;
  shortcutLabel: string | null;
  onJump: () => void;
}) {
  const [seenRowId] = useState(props.lastRowId);
  const hasNewContent = props.lastRowId !== seenRowId;

  return (
    <div className="pointer-events-none absolute bottom-[calc(var(--composer-dock-height,0px)+0.25rem)] left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5">
      <button
        type="button"
        onClick={props.onJump}
        className="pointer-events-auto relative flex h-7 items-center gap-1.5 rounded-full border border-border bg-popover px-3 text-ui text-muted-foreground shadow-md outline-none transition-colors duration-(--duration-fast) hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        {hasNewContent ? (
          <span
            aria-hidden="true"
            data-slot="jump-to-latest-new-content"
            className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-info ring-2 ring-background"
          />
        ) : null}
        <ArrowDownIcon className="size-3.5" />
        <span>Jump to latest</span>
        {hasNewContent ? <span className="sr-only">, new messages</span> : null}
        {props.shortcutLabel ? (
          <Kbd className="h-4 min-w-4 px-1 text-2xs">{props.shortcutLabel}</Kbd>
        ) : null}
      </button>
    </div>
  );
}
