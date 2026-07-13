import { forwardRef, useEffect, useRef } from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { XCircleIcon } from "lucide-react";
import type { PullRequestKey, TrackedPullRequest } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { attentionAccentClass } from "./prHubPresentation";

/** Lists longer than this render through LegendList to stay responsive. */
const VIRTUALIZE_THRESHOLD = 60;

const PrSpineRow = forwardRef<
  HTMLButtonElement,
  {
    pr: TrackedPullRequest;
    selected: boolean;
    onSelect: (key: PullRequestKey) => void;
  }
>(function PrSpineRow({ pr, selected, onSelect }, ref) {
  const ciFailing = pr.checkRollup === "failure" || pr.checkRollup === "error";
  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={selected}
      onClick={() => onSelect(pr.key)}
      className={cn(
        "flex w-full items-center gap-2.5 border-b border-border px-3 py-2 text-left last:border-b-0",
        selected ? "bg-primary/8 ring-1 ring-inset ring-primary/35" : "hover:bg-accent/24",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-2 shrink-0 rounded-full", attentionAccentClass(pr))}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "truncate text-sm leading-snug",
            pr.notificationPending ? "font-semibold text-foreground" : "text-foreground/90",
          )}
        >
          {pr.title}
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {pr.repository.nameWithOwner}#{pr.number}
        </span>
      </span>
      {ciFailing ? (
        <XCircleIcon
          className="size-3.5 shrink-0 text-destructive-foreground"
          aria-label="CI failed"
        />
      ) : null}
    </button>
  );
});

/**
 * The Inbox spine: an ultra-minimal, scannable list. Each row shows only a
 * status dot, the title, and `repo#num` (plus a CI-failed glyph). All richer
 * metadata lives in the detail pane. Selection is owned by the parent; the
 * selected row is kept scrolled into view.
 */
export function PrSpineList({
  prs,
  selectedKey,
  onSelect,
}: {
  prs: readonly TrackedPullRequest[];
  selectedKey: PullRequestKey | null;
  onSelect: (key: PullRequestKey) => void;
}) {
  const virtualize = prs.length > VIRTUALIZE_THRESHOLD;
  const selectedIndex = prs.findIndex((pr) => pr.key === selectedKey);
  const listRef = useRef<LegendListRef | null>(null);
  const selectedRowRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (selectedIndex < 0) return;
    if (virtualize) {
      listRef.current?.scrollIndexIntoView?.({ index: selectedIndex, animated: false });
    } else {
      selectedRowRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, virtualize]);

  if (virtualize) {
    return (
      <div role="listbox" aria-label="Pull requests" className="min-h-0 flex-1">
        <LegendList<TrackedPullRequest>
          ref={listRef}
          data={prs as TrackedPullRequest[]}
          extraData={selectedKey}
          keyExtractor={(pr) => pr.key}
          renderItem={({ item }) => (
            <PrSpineRow pr={item} selected={item.key === selectedKey} onSelect={onSelect} />
          )}
          estimatedItemSize={52}
          style={{ height: "100%" }}
        />
      </div>
    );
  }

  return (
    <div role="listbox" aria-label="Pull requests" className="min-h-0 flex-1 overflow-y-auto">
      {prs.map((pr) => {
        const selected = pr.key === selectedKey;
        return (
          <PrSpineRow
            key={pr.key}
            ref={selected ? selectedRowRef : undefined}
            pr={pr}
            selected={selected}
            onSelect={onSelect}
          />
        );
      })}
    </div>
  );
}
