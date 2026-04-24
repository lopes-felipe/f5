import { memo, useCallback } from "react";
import { createPortal } from "react-dom";

import type { TabTargetKey } from "../tabTargets";
import type { ThreadStatusPill } from "../threadStatus";
import { Badge } from "~/components/ui/badge";
import { CommandFooter, CommandPanel } from "~/components/ui/command";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { cn, isMacPlatform } from "~/lib/utils";
import { ThreadStatusPillBadge } from "./thread/ThreadStatusPillBadge";

export interface PickerItem {
  id: TabTargetKey;
  title: string;
  subtitle: string | null;
  badgeLabel: string | null;
  threadStatusPill: ThreadStatusPill | null;
  isDraft: boolean;
  isStale: boolean;
}

export interface ThreadCyclePickerProps {
  items: readonly PickerItem[];
  currentIndex: number;
  currentItemId: TabTargetKey | null;
  onSelect: (targetKey: TabTargetKey) => void;
  onDismiss: () => void;
}

interface ThreadCyclePickerRowProps {
  item: PickerItem;
  isCurrentItem: boolean;
  isHighlighted: boolean;
  onSelect: (targetKey: TabTargetKey) => void;
  optionRef?: ((node: HTMLButtonElement | null) => void) | undefined;
}

// These classes mirror `CommandDialogBackdrop`, `CommandDialogViewport`, and
// `CommandDialogPopup` in `components/ui/command.tsx` so the Ctrl+Tab switcher
// matches the Cmd+K command palette's visual frame. They are inlined (rather
// than reusing `CommandDialogPopup` directly) because the picker's lifecycle
// is driven imperatively by `ThreadRecencyController`'s window-level keyboard
// handler — there is no Base UI Dialog root, and Base UI's `DialogPortal`
// returns null during SSR, which would break the picker's SSR tests. The
// backdrop here doubles as the viewport since we don't need Base UI's
// open/close transitions. Keep these in sync with `components/ui/command.tsx`
// when the palette's chrome changes.
const BACKDROP_CLASS =
  "fixed inset-0 z-50 flex flex-col items-center bg-black/32 px-4 py-[max(--spacing(4),4vh)] backdrop-blur-sm sm:py-[10vh]";
const POPUP_CLASS =
  "relative flex max-h-105 min-h-0 w-full min-w-0 max-w-xl flex-col overflow-hidden rounded-2xl border bg-popover not-dark:bg-clip-padding text-popover-foreground shadow-lg/5 outline-none before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:bg-muted/72 before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]";

function getModifierLabel(): string {
  if (typeof navigator === "undefined") {
    return "Ctrl";
  }
  return isMacPlatform(navigator.platform) ? "\u2303" : "Ctrl";
}

const ThreadCyclePickerRow = memo(function ThreadCyclePickerRow({
  item,
  isCurrentItem,
  isHighlighted,
  onSelect,
  optionRef,
}: ThreadCyclePickerRowProps) {
  return (
    <button
      ref={optionRef}
      id={`thread-cycle-picker-option-${item.id}`}
      data-slot="thread-cycle-picker-option"
      type="button"
      role="option"
      aria-selected={isHighlighted}
      aria-disabled={item.isStale}
      disabled={item.isStale}
      className={cn(
        "flex w-full items-start justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left outline-none",
        item.isStale
          ? "cursor-not-allowed text-muted-foreground opacity-50 line-through"
          : isHighlighted
            ? "bg-accent text-accent-foreground"
            : "cursor-default text-popover-foreground",
      )}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!item.isStale) {
          onSelect(item.id);
        }
      }}
    >
      <span className="flex min-w-0 flex-1 items-start gap-2">
        {item.threadStatusPill ? <ThreadStatusPillBadge pill={item.threadStatusPill} /> : null}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{item.title}</span>
          {item.subtitle ? (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {item.subtitle}
            </span>
          ) : null}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {item.badgeLabel ? (
          <Badge variant="outline" size="sm">
            {item.badgeLabel}
          </Badge>
        ) : null}
        {item.isDraft ? (
          <Badge variant="outline" size="sm">
            Draft
          </Badge>
        ) : null}
        {isCurrentItem ? (
          <span
            data-slot="thread-cycle-picker-current-marker"
            className="rounded-full border border-border/70 px-1.5 py-0.5 text-[10px] font-medium tracking-[0.14em] text-muted-foreground uppercase"
          >
            Current
          </span>
        ) : null}
      </span>
    </button>
  );
});

export default function ThreadCyclePicker({
  items,
  currentIndex,
  currentItemId,
  onSelect,
  onDismiss,
}: ThreadCyclePickerProps) {
  const highlightedItem = items[currentIndex] ?? null;
  const highlightedOptionId = highlightedItem
    ? `thread-cycle-picker-option-${highlightedItem.id}`
    : undefined;
  const highlightedRowRef = useCallback((node: HTMLButtonElement | null) => {
    node?.scrollIntoView({ block: "nearest" });
  }, []);

  const modifierLabel = getModifierLabel();

  const content = (
    <div
      data-slot="thread-cycle-picker-backdrop"
      className={BACKDROP_CLASS}
      onMouseDown={() => {
        onDismiss();
      }}
    >
      <div
        data-slot="thread-cycle-picker-panel"
        role="listbox"
        aria-label="Switch Tab"
        aria-activedescendant={highlightedOptionId}
        className={POPUP_CLASS}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <header
          data-slot="thread-cycle-picker-header"
          className="border-b border-border/70 px-4 py-3 text-sm font-semibold"
        >
          Switch Tab
        </header>
        <CommandPanel className="max-h-[min(28rem,70vh)] overflow-y-auto">
          <div className="space-y-1 p-2">
            {items.map((item, index) => (
              <ThreadCyclePickerRow
                key={item.id}
                item={item}
                isCurrentItem={currentItemId !== null && currentItemId === item.id}
                isHighlighted={index === currentIndex}
                onSelect={onSelect}
                optionRef={index === currentIndex ? highlightedRowRef : undefined}
              />
            ))}
          </div>
        </CommandPanel>
        <CommandFooter
          data-slot="thread-cycle-picker-footer"
          className="gap-3 max-sm:flex-col max-sm:items-start"
        >
          <div className="flex items-center gap-3">
            <KbdGroup className="items-center gap-1.5">
              <Kbd>{modifierLabel}</Kbd>
              <Kbd>Tab</Kbd>
              <span className="text-muted-foreground/80">Next</span>
            </KbdGroup>
            <KbdGroup className="items-center gap-1.5">
              <Kbd>{modifierLabel}</Kbd>
              <Kbd>Shift</Kbd>
              <Kbd>Tab</Kbd>
              <span className="text-muted-foreground/80">Previous</span>
            </KbdGroup>
            <KbdGroup className="items-center gap-1.5">
              <Kbd>Esc</Kbd>
              <span className="text-muted-foreground/80">Cancel</span>
            </KbdGroup>
          </div>
        </CommandFooter>
        <span data-slot="thread-cycle-picker-live-region" className="sr-only" aria-live="polite">
          {highlightedItem?.title ?? ""}
        </span>
      </div>
    </div>
  );

  if (typeof document === "undefined") {
    return content;
  }

  return createPortal(content, document.body);
}
