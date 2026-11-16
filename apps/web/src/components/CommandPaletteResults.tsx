import { type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { ChevronRightIcon } from "lucide-react";
import { type RefObject } from "react";
import { shortcutLabelForCommand } from "../keybindings";
import {
  type CommandPaletteActionItem,
  type CommandPaletteRow,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import {
  CommandItem,
  CommandListHeading,
  CommandListVirtualized,
  CommandShortcut,
} from "./ui/command";
import { ThreadStatusPillBadge } from "./thread/ThreadStatusPillBadge";
import { cn } from "~/lib/utils";

interface CommandPaletteResultsProps {
  emptyStateMessage?: string;
  rows: ReadonlyArray<CommandPaletteRow>;
  listRef: RefObject<LegendListRef | null>;
  highlightedItemValue?: string | null;
  isActionsOnly: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
}

const RESULT_LIST_CONTENT_STYLE = { paddingInline: "0.5rem" } as const;

/**
 * Scrolls a keyboard highlight into view: nearest edge when its row is mounted,
 * otherwise through the list, which mounts it.
 */
export function scrollCommandPaletteRowIntoView(list: LegendListRef | null, rowIndex: number) {
  const element = list?.getState?.().elementAtIndex(rowIndex);
  if (element instanceof HTMLElement) {
    element.scrollIntoView({ block: "nearest" });
    return;
  }
  void list?.scrollIndexIntoView?.({ index: rowIndex, animated: false });
}

/**
 * Renders only the visible rows. The palette passes the flat item order to the
 * Command root as `items` with `virtualized`, scrolls keyboard highlights into
 * view through `listRef`, and runs Enter itself since the row may be unmounted.
 */
export function CommandPaletteResults(props: CommandPaletteResultsProps) {
  "use memo";
  if (props.rows.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        {props.emptyStateMessage ??
          (props.isActionsOnly
            ? "No matching actions."
            : "No matching commands, projects, or threads.")}
      </div>
    );
  }

  return (
    <CommandListVirtualized>
      <LegendList<CommandPaletteRow>
        ref={props.listRef}
        data={props.rows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => row.kind}
        extraData={props.highlightedItemValue}
        renderItem={({ item: row }) =>
          row.kind === "label" ? (
            <div className={row.first ? undefined : "pt-1.5"}>
              <CommandListHeading>{row.label}</CommandListHeading>
            </div>
          ) : (
            <CommandPaletteResultRow
              index={row.itemIndex}
              item={row.item}
              keybindings={props.keybindings}
              isActive={props.highlightedItemValue === row.item.value}
              onExecuteItem={props.onExecuteItem}
            />
          )
        }
        estimatedItemSize={40}
        drawDistance={400}
        contentContainerStyle={RESULT_LIST_CONTENT_STYLE}
        className="min-h-0 scroll-py-2 overflow-x-hidden overscroll-y-contain py-2"
      />
    </CommandListVirtualized>
  );
}

function CommandPaletteResultRow(props: {
  index: number;
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
  isActive: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
}) {
  "use memo";
  const shortcutLabel = props.item.shortcutCommand
    ? shortcutLabelForCommand(props.keybindings, props.item.shortcutCommand)
    : null;

  return (
    <CommandItem
      index={props.index}
      value={props.item.value}
      className={cn(
        "cursor-pointer gap-2 hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit data-selected:bg-transparent data-selected:text-inherit [&[data-highlighted][data-selected]]:bg-transparent [&[data-highlighted][data-selected]]:text-inherit",
        props.isActive && "bg-accent! text-accent-foreground!",
      )}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onExecuteItem(props.item);
      }}
    >
      {props.item.icon}
      {props.item.description ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
            <span className="truncate">{props.item.title}</span>
            {props.item.statusPill ? (
              <ThreadStatusPillBadge pill={props.item.statusPill} hideLabelBelowMd />
            ) : null}
          </span>
          <span className="truncate text-muted-foreground text-xs">{props.item.description}</span>
        </span>
      ) : (
        <span className="flex min-w-0 items-center gap-1.5 truncate text-sm text-foreground">
          <span className="truncate">{props.item.title}</span>
          {props.item.statusPill ? (
            <ThreadStatusPillBadge pill={props.item.statusPill} hideLabelBelowMd />
          ) : null}
        </span>
      )}
      {props.item.timestamp ? (
        <span className="min-w-12 shrink-0 text-right text-2xs tabular-nums text-muted-foreground">
          {props.item.timestamp}
        </span>
      ) : null}
      {shortcutLabel ? <CommandShortcut>{shortcutLabel}</CommandShortcut> : null}
      {props.item.kind === "submenu" ? (
        <ChevronRightIcon className="ml-auto size-4 shrink-0 text-muted-foreground" />
      ) : null}
    </CommandItem>
  );
}
