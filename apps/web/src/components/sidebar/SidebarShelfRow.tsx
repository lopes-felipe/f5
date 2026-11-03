import type { ProjectId } from "@t3tools/contracts";
import { EllipsisIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { SIDEBAR_TREE_LEVEL_CLASS_NAME, type SidebarShelfBucket } from "../Sidebar.logic";
import { SidebarMenuSub, SidebarMenuSubItem } from "../ui/sidebar";
import { SidebarTreeParentContext, useSidebarTreeRowProps } from "./sidebarTreeRow";

export interface SidebarShelfSegment {
  bucket: SidebarShelfBucket;
  count: number;
  /** Status marks after the label (the scheduled bucket's attention and running counts). */
  indicator?: ReactNode;
  onContextMenu?: ((position: { x: number; y: number }) => void) | undefined;
}

export function sidebarShelfRowId(projectId: ProjectId): string {
  return `shelf:${projectId}`;
}

/**
 * One quiet line per project for its scheduled, snoozed, settled and archived lists:
 * "⋯ 3 scheduled · 2 snoozed · 31 archived". Each segment opens its list under the row,
 * one at a time. In the tree the line is one row and the segments are its controls.
 */
export function SidebarShelfRow(props: {
  projectId: ProjectId;
  segments: readonly SidebarShelfSegment[];
  openBucket: SidebarShelfBucket | null;
  onToggle: (bucket: SidebarShelfBucket) => void;
  /** The open bucket's rows. */
  children?: ReactNode;
}) {
  "use memo";
  const rowId = sidebarShelfRowId(props.projectId);
  const treeRowProps = useSidebarTreeRowProps(rowId);
  const isTreeRow = "data-sidebar-row" in treeRowProps;
  const segments = props.segments.filter((segment) => segment.count > 0);
  if (segments.length === 0) return null;
  const openBucket = segments.some((segment) => segment.bucket === props.openBucket)
    ? props.openBucket
    : null;
  // The row itself (Enter, or Right/Left in the tree) toggles the open bucket, else the first.
  const toggleFromRow = () => props.onToggle(openBucket ?? segments[0]!.bucket);

  return (
    <SidebarMenuSubItem className="w-full" data-testid="sidebar-shelf">
      <div
        {...treeRowProps}
        {...(isTreeRow ? { "aria-expanded": openBucket !== null } : {})}
        aria-label={`Shelf: ${segments.map((segment) => `${segment.count} ${segment.bucket}`).join(", ")}`}
        data-thread-selection-safe
        className="mt-1 flex h-6 w-full min-w-0 cursor-default items-center gap-1 rounded-md px-2 text-2xs text-muted-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          toggleFromRow();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          toggleFromRow();
        }}
      >
        <EllipsisIcon aria-hidden="true" className="size-3.5 shrink-0 text-faint-foreground" />
        <span className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden whitespace-nowrap">
          {segments.map((segment, index) => (
            <Fragment key={segment.bucket}>
              {index > 0 ? (
                <span aria-hidden="true" className="text-faint-foreground">
                  ·
                </span>
              ) : null}
              <button
                type="button"
                aria-expanded={openBucket === segment.bucket}
                data-shelf-bucket={segment.bucket}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded-sm px-1 py-px tabular-nums outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                  openBucket === segment.bucket && "bg-accent font-medium text-foreground",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onToggle(segment.bucket);
                }}
                {...(segment.onContextMenu
                  ? {
                      onContextMenu: (event: React.MouseEvent) => {
                        event.preventDefault();
                        event.stopPropagation();
                        segment.onContextMenu?.({ x: event.clientX, y: event.clientY });
                      },
                    }
                  : {})}
              >
                {segment.count} {segment.bucket}
                {segment.indicator}
              </button>
            </Fragment>
          ))}
        </span>
      </div>
      {openBucket !== null && props.children ? (
        <SidebarTreeParentContext.Provider value={isTreeRow ? rowId : null}>
          <SidebarMenuSub
            className={cn(SIDEBAR_TREE_LEVEL_CLASS_NAME, "mt-px")}
            data-shelf-open={openBucket}
          >
            {props.children}
          </SidebarMenuSub>
        </SidebarTreeParentContext.Provider>
      ) : null}
    </SidebarMenuSubItem>
  );
}
