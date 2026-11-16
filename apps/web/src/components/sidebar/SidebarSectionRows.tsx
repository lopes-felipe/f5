import type { ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";
import { useSidebarTreeRowProps } from "./sidebarTreeRow";

/** "Show more" / "Show less" under a list. */
export function ListToggleRow(props: { label: string; onSelect: () => void }) {
  const treeRowProps = useSidebarTreeRowProps();
  return (
    <SidebarMenuSubItem className="w-full">
      <SidebarMenuSubButton
        render={<button type="button" {...treeRowProps} />}
        data-thread-selection-safe
        size="sm"
        className="h-6 w-full translate-x-0 justify-start rounded-md pl-8 text-left text-2xs text-muted-foreground hover:bg-transparent hover:text-foreground"
        onClick={props.onSelect}
      >
        <span>{props.label}</span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

/**
 * The project list's single disclosure row: "Show N more" for the preview limit, then
 * "· M older than 7 days ›" for the threads aging folds away. Each part is its own button
 * and tree row, side by side on one line; either may be absent.
 */
export function MoreAndOlderRow(props: {
  more?: { label: string; onToggle: () => void } | undefined;
  older?: { label: string; expanded: boolean; onToggle: () => void } | undefined;
}) {
  const moreRowProps = useSidebarTreeRowProps();
  const olderRowProps = useSidebarTreeRowProps();
  const { more, older } = props;
  if (!more && !older) return null;
  const partClassName =
    "h-6 w-auto max-w-full shrink-0 translate-x-0 gap-1 rounded-sm px-0 text-2xs text-muted-foreground hover:bg-transparent hover:text-foreground active:bg-transparent";
  // One line, two sibling tree rows: each part is its own button and tree stop.
  return (
    <SidebarMenuSubItem className="w-full">
      <div
        data-testid="sidebar-more-and-older"
        className="flex h-6 w-full min-w-0 items-center gap-1 pl-8"
      >
        {more ? (
          <SidebarMenuSubButton
            render={<button type="button" {...moreRowProps} />}
            data-thread-selection-safe
            data-testid="sidebar-show-more"
            size="sm"
            className={partClassName}
            onClick={more.onToggle}
          >
            <span>{more.label}</span>
          </SidebarMenuSubButton>
        ) : null}
        {more && older ? (
          <span aria-hidden="true" className="text-2xs text-faint-foreground">
            ·
          </span>
        ) : null}
        {older ? (
          <SidebarMenuSubButton
            render={<button type="button" {...olderRowProps} />}
            data-thread-selection-safe
            data-testid="sidebar-older-toggle"
            aria-expanded={older.expanded}
            size="sm"
            className={partClassName}
            onClick={older.onToggle}
          >
            <span>{older.label}</span>
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 text-faint-foreground transition-transform duration-(--duration-fast)",
                older.expanded && "rotate-90",
              )}
            />
          </SidebarMenuSubButton>
        ) : null}
      </div>
    </SidebarMenuSubItem>
  );
}

/** Collapsible "Archived" section label (a scheduled bucket's past runs). */
export function SectionToggleRow(props: {
  label: ReactNode;
  expanded: boolean;
  onToggle: () => void;
}) {
  const treeRowProps = useSidebarTreeRowProps();
  return (
    <SidebarMenuSubItem className="w-full">
      <SidebarMenuSubButton
        render={<button type="button" {...treeRowProps} />}
        data-thread-selection-safe
        aria-expanded={props.expanded}
        size="sm"
        className="mt-1 h-6 w-full translate-x-0 justify-start gap-1 rounded-md px-2 text-left text-2xs font-medium text-muted-foreground hover:bg-transparent hover:text-foreground"
        onClick={props.onToggle}
      >
        <span>{props.label}</span>
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-faint-foreground transition-transform duration-(--duration-fast)",
            props.expanded && "rotate-90",
          )}
        />
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}
