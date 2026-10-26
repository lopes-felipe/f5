import type { ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";

/** "Show more" / "Show less" under a list. */
export function ListToggleRow(props: { label: string; onSelect: () => void }) {
  return (
    <SidebarMenuSubItem className="w-full">
      <SidebarMenuSubButton
        render={<button type="button" />}
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

/** Collapsible "Snoozed (n)" / "Archived" section label. */
export function SectionToggleRow(props: {
  label: ReactNode;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <SidebarMenuSubItem className="w-full">
      <SidebarMenuSubButton
        render={<button type="button" />}
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
