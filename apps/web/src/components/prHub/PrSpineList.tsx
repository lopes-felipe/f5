import { usePrQuickActionModifier } from "../../hooks/usePrQuickActionModifier";
import {
  prQuickActions,
  PR_QUICK_ACTION_LABELS,
  type PrQuickAction,
} from "../../lib/prQuickActions";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Button } from "../ui/button";
import { forwardRef, useEffect, useRef, useState } from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { XCircleIcon } from "lucide-react";
import type { PullRequestKey, TrackedPullRequest } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { attentionAccentClass } from "./prHubPresentation";

/** Lists longer than this render through LegendList to stay responsive. */
const VIRTUALIZE_THRESHOLD = 60;

const PrSpineRow = forwardRef<
  HTMLDivElement,
  {
    pr: TrackedPullRequest;
    selected: boolean;
    onSelect: (key: PullRequestKey) => void;
    quick: boolean;
    onQuickAction?: ((pr: TrackedPullRequest, action: PrQuickAction) => void) | undefined;
    onMenu: (pr: TrackedPullRequest, x: number, y: number) => void;
  }
>(function PrSpineRow({ pr, selected, onSelect, quick, onQuickAction, onMenu }, ref) {
  const ciFailing = pr.checkRollup === "failure" || pr.checkRollup === "error";
  return (
    <div
      ref={ref}
      tabIndex={0}
      role="option"
      aria-selected={selected}
      onClick={() => onSelect(pr.key)}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onSelect(pr.key);
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onMenu(pr, event.clientX, event.clientY);
      }}
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
            pr.notificationPending ? "font-semibold text-foreground" : "text-foreground",
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
      {quick && onQuickAction ? (
        <span className="flex shrink-0 gap-1">
          {prQuickActions(pr).map((action) => (
            <Button
              key={action}
              size="xs"
              variant="outline"
              aria-label={`${PR_QUICK_ACTION_LABELS[action]} PR #${pr.number}`}
              onClick={(event) => {
                event.stopPropagation();
                onQuickAction(pr, action);
              }}
            >
              {PR_QUICK_ACTION_LABELS[action]}
            </Button>
          ))}
        </span>
      ) : null}
    </div>
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
  onQuickAction,
}: {
  prs: readonly TrackedPullRequest[];
  selectedKey: PullRequestKey | null;
  onSelect: (key: PullRequestKey) => void;
  onQuickAction?: ((pr: TrackedPullRequest, action: PrQuickAction) => void) | undefined;
}) {
  const quick = usePrQuickActionModifier();
  const [menu, setMenu] = useState<{ pr: TrackedPullRequest; x: number; y: number } | null>(null);
  const onMenu = (pr: TrackedPullRequest, x: number, y: number) => setMenu({ pr, x, y });
  const menuContent = (
    <Menu open={menu !== null} onOpenChange={(open) => !open && setMenu(null)}>
      <MenuTrigger tabIndex={-1} aria-hidden="true" className="sr-only">
        PR row actions
      </MenuTrigger>
      <MenuPopup
        anchor={
          menu ? { getBoundingClientRect: () => new DOMRect(menu.x, menu.y, 0, 0) } : undefined
        }
        align="start"
      >
        <MenuItem
          onClick={() => {
            if (menu) onSelect(menu.pr.key);
          }}
        >
          Open pull request
        </MenuItem>
        {menu && onQuickAction
          ? prQuickActions(menu.pr).map((action) => (
              <MenuItem key={action} onClick={() => onQuickAction(menu.pr, action)}>
                {PR_QUICK_ACTION_LABELS[action]}…
              </MenuItem>
            ))
          : null}
      </MenuPopup>
    </Menu>
  );
  const virtualize = prs.length > VIRTUALIZE_THRESHOLD;
  const selectedIndex = prs.findIndex((pr) => pr.key === selectedKey);
  const listRef = useRef<LegendListRef | null>(null);
  const selectedRowRef = useRef<HTMLDivElement | null>(null);

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
        {menuContent}
        <LegendList<TrackedPullRequest>
          ref={listRef}
          data={prs as TrackedPullRequest[]}
          extraData={`${selectedKey}:${quick}`}
          keyExtractor={(pr) => pr.key}
          renderItem={({ item }) => (
            <PrSpineRow
              pr={item}
              selected={item.key === selectedKey}
              onSelect={onSelect}
              quick={quick}
              onQuickAction={onQuickAction}
              onMenu={onMenu}
            />
          )}
          estimatedItemSize={52}
          style={{ height: "100%" }}
        />
      </div>
    );
  }

  return (
    <div role="listbox" aria-label="Pull requests" className="min-h-0 flex-1 overflow-y-auto">
      {menuContent}
      {prs.map((pr) => {
        const selected = pr.key === selectedKey;
        return (
          <PrSpineRow
            key={pr.key}
            ref={selected ? selectedRowRef : undefined}
            pr={pr}
            selected={selected}
            onSelect={onSelect}
            quick={quick}
            onQuickAction={onQuickAction}
            onMenu={onMenu}
          />
        );
      })}
    </div>
  );
}
