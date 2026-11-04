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
 * "· M older than 7 days ›" for the threads aging folds away. The row's own action is the
 * first part present; the older part is also its own in-row button, which Tab reaches.
 */
export function MoreAndOlderRow(props: {
  more?: { label: string; onToggle: () => void } | undefined;
  older?: { label: string; expanded: boolean; onToggle: () => void } | undefined;
}) {
  const treeRowProps = useSidebarTreeRowProps();
  const { more, older } = props;
  const primary = more?.onToggle ?? older?.onToggle;
  if (!primary) return null;
  return (
    <SidebarMenuSubItem className="w-full">
      <SidebarMenuSubButton
        render={<div role="button" tabIndex={0} {...treeRowProps} />}
        data-thread-selection-safe
        data-testid="sidebar-more-and-older"
        {...(more ? {} : { "aria-expanded": older?.expanded })}
        size="sm"
        className="h-6 w-full translate-x-0 justify-start gap-1 rounded-md pl-8 text-left text-2xs text-muted-foreground hover:bg-transparent"
        onClick={primary}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          primary();
        }}
      >
        {more ? <span className="hover:text-foreground">{more.label}</span> : null}
        {more && older ? (
          <span aria-hidden="true" className="text-faint-foreground">
            ·
          </span>
        ) : null}
        {older ? (
          <button
            type="button"
            data-testid="sidebar-older-toggle"
            aria-expanded={older.expanded}
            className="inline-flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => {
              event.stopPropagation();
              older.onToggle();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") event.stopPropagation();
            }}
          >
            {older.label}
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 text-faint-foreground transition-transform duration-(--duration-fast)",
                older.expanded && "rotate-90",
              )}
            />
          </button>
        ) : null}
      </SidebarMenuSubButton>
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
