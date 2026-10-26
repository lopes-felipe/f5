import type { ThreadId } from "@t3tools/contracts";
import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { ChevronRightIcon, CircleAlertIcon, FolderClockIcon, LoaderIcon } from "lucide-react";

import { isSnoozedThread } from "../../lib/threadOrdering";
import { cn } from "../../lib/utils";
import type { ThreadListItem } from "../../types";
import { SIDEBAR_TREE_LEVEL_CLASS_NAME } from "../Sidebar.logic";
import { SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";
import { SidebarThreadRow } from "./SidebarThreadRow";
import type { SidebarThreadRowIndicators } from "./SidebarWorkflowItem";
import type { SidebarThreadActions } from "./useSidebarThreadActions";
import { ListToggleRow, SectionToggleRow } from "./SidebarSectionRows";

export function SidebarScheduledFolder(props: {
  threads: readonly ThreadListItem[];
  visibleThreads: readonly ThreadListItem[];
  currentThreadCount: number;
  archivedThreads: readonly ThreadListItem[];
  visibleArchivedThreads: readonly ThreadListItem[];
  archivedExpanded: boolean;
  archivedShowingAll: boolean;
  onToggleArchived: () => void;
  onToggleArchivedShowAll: () => void;
  expanded: boolean;
  showingAll: boolean;
  previewLimit: number;
  onToggle: () => void;
  onToggleShowAll: () => void;
  routeThreadId: ThreadId | null;
  orderedIds: readonly ThreadId[];
  indicatorsForThread: (thread: ThreadListItem) => SidebarThreadRowIndicators;
  actions: SidebarThreadActions;
}) {
  const markThreadsVisited = useStore((state) => state.markThreadsVisited);
  const openFolderMenu = async (position: { x: number; y: number }) => {
    const api = readNativeApi();
    if (!api) return;
    const action = await api.contextMenu.show(
      [
        {
          id: "mark-all-read",
          label: "Mark all as read",
          disabled: !props.threads.some((thread) => props.indicatorsForThread(thread).isUnread),
        },
      ],
      position,
    );
    if (action === "mark-all-read") markThreadsVisited(props.threads.map((thread) => thread.id));
  };
  let attention = 0;
  let running = 0;
  let unread = 0;
  for (const thread of props.threads) {
    if (thread.archivedAt !== null || isSnoozedThread(thread)) continue;
    const indicators = props.indicatorsForThread(thread);
    if (indicators.isUnread) unread++;
    const status = indicators.threadStatus;
    if (!status) continue;
    if (["Pending Approval", "Awaiting Input", "Plan Ready"].includes(status.label)) attention++;
    else if (status.pulse) running++;
  }

  const renderThread = (thread: ThreadListItem) => {
    const section =
      thread.archivedAt !== null ? "archived" : isSnoozedThread(thread) ? "snoozed" : "active";
    const indicators = props.indicatorsForThread(thread);
    return (
      <SidebarThreadRow
        key={thread.id}
        thread={thread}
        section={section}
        isActive={props.routeThreadId === thread.id}
        orderedIds={props.orderedIds}
        isRenaming={props.actions.renamingThreadId === thread.id}
        trailingMeta={
          section === "snoozed" ? (
            <span className="text-2xs text-muted-foreground">Snoozed</span>
          ) : undefined
        }
        actions={props.actions}
        {...indicators}
        threadStatus={section === "snoozed" ? null : indicators.threadStatus}
      />
    );
  };

  return (
    <SidebarMenuSubItem className="w-full" data-testid="scheduled-thread-folder">
      <SidebarMenuSubButton
        render={<button type="button" />}
        data-thread-selection-safe
        aria-label={`Scheduled (${props.threads.length})`}
        aria-expanded={props.expanded}
        className="h-8 w-full translate-x-0 gap-2 rounded-md px-2 text-left"
        onClick={props.onToggle}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void openFolderMenu({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          void openFolderMenu({ x: rect.left, y: rect.bottom });
        }}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn("size-3 shrink-0 transition-transform", props.expanded && "rotate-90")}
        />
        <FolderClockIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate">Scheduled</span>
        {attention > 0 && (
          <span
            className="flex items-center gap-1 text-attention-foreground"
            title={`${attention} need attention`}
          >
            <CircleAlertIcon aria-hidden="true" className="size-3.5" />
            <span className="sr-only">Needs attention: </span>
            {attention}
          </span>
        )}
        {running > 0 && (
          <span
            className="flex items-center gap-1 text-info-foreground"
            title={`${running} running`}
          >
            <LoaderIcon aria-hidden="true" className="size-3.5 animate-status-pulse" />
            <span className="sr-only">Running: </span>
            {running}
          </span>
        )}
        {unread > 0 && (
          <span className="size-1.5 shrink-0 rounded-full bg-primary" title={`${unread} unread`}>
            <span className="sr-only">Unread: {unread}</span>
          </span>
        )}
        <span className="text-2xs tabular-nums text-muted-foreground">{props.threads.length}</span>
      </SidebarMenuSubButton>
      {props.expanded && (
        <SidebarMenuSub className={SIDEBAR_TREE_LEVEL_CLASS_NAME}>
          {props.visibleThreads.map(renderThread)}
          {props.currentThreadCount > props.previewLimit && (
            <ListToggleRow
              label={props.showingAll ? "Show less" : "Show more"}
              onSelect={props.onToggleShowAll}
            />
          )}
          {props.archivedThreads.length > 0 && (
            <SectionToggleRow
              label="Archived"
              expanded={props.archivedExpanded}
              onToggle={props.onToggleArchived}
            />
          )}
          {props.archivedExpanded && props.visibleArchivedThreads.map(renderThread)}
          {props.archivedExpanded && props.archivedThreads.length > props.previewLimit && (
            <ListToggleRow
              label={props.archivedShowingAll ? "Show less" : "Show more"}
              onSelect={props.onToggleArchivedShowAll}
            />
          )}
        </SidebarMenuSub>
      )}
    </SidebarMenuSubItem>
  );
}
