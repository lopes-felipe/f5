import type { ThreadId } from "@t3tools/contracts";
import { CircleAlertIcon, LoaderIcon } from "lucide-react";

import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { isSnoozedThread } from "../../lib/threadOrdering";
import type { ThreadListItem } from "../../types";
import { SidebarThreadRow } from "./SidebarThreadRow";
import type { SidebarIndicatorsForThread } from "./SidebarWorkflowItem";
import type { SidebarThreadActions } from "./useSidebarThreadActions";
import { ListToggleRow, SectionToggleRow } from "./SidebarSectionRows";

const ATTENTION_LABELS = new Set(["Pending Approval", "Awaiting Input", "Plan Ready"]);

/** Live scheduled runs that need the user, are running, or finished unseen. */
export function summarizeScheduledThreads(
  threads: readonly ThreadListItem[],
  indicatorsForThread: SidebarIndicatorsForThread,
): { attention: number; running: number; unread: number } {
  let attention = 0;
  let running = 0;
  let unread = 0;
  for (const thread of threads) {
    if (thread.archivedAt !== null || isSnoozedThread(thread)) continue;
    const indicators = indicatorsForThread(thread);
    if (indicators.isUnread) unread++;
    const status = indicators.threadStatus;
    if (!status) continue;
    if (ATTENTION_LABELS.has(status.label)) attention++;
    else if (status.pulse) running++;
  }
  return { attention, running, unread };
}

/** Status marks on the shelf's "scheduled" segment. */
export function ScheduledShelfIndicator(props: {
  summary: { attention: number; running: number; unread: number };
}) {
  const { attention, running, unread } = props.summary;
  return (
    <>
      {attention > 0 ? (
        <span
          className="flex items-center gap-0.5 text-attention-foreground"
          title={`${attention} need attention`}
        >
          <CircleAlertIcon aria-hidden="true" className="size-3" />
          <span className="sr-only">Needs attention: </span>
          {attention}
        </span>
      ) : null}
      {running > 0 ? (
        <span
          className="flex items-center gap-0.5 text-info-foreground"
          title={`${running} running`}
        >
          <LoaderIcon aria-hidden="true" className="size-3 animate-status-pulse" />
          <span className="sr-only">Running: </span>
          {running}
        </span>
      ) : null}
      {unread > 0 ? (
        <span className="size-1.5 shrink-0 rounded-full bg-primary" title={`${unread} unread`}>
          <span className="sr-only">Unread: {unread}</span>
        </span>
      ) : null}
    </>
  );
}

/** "Mark all as read" for a project's scheduled runs, from the shelf segment's context menu. */
export function useScheduledFolderMenu(
  threads: readonly ThreadListItem[],
  indicatorsForThread: SidebarIndicatorsForThread,
) {
  const markThreadsVisited = useStore((state) => state.markThreadsVisited);
  return async (position: { x: number; y: number }) => {
    const api = readNativeApi();
    if (!api) return;
    const action = await api.contextMenu.show(
      [
        {
          id: "mark-all-read",
          label: "Mark all as read",
          disabled: !threads.some((thread) => indicatorsForThread(thread).isUnread),
        },
      ],
      position,
    );
    if (action === "mark-all-read") markThreadsVisited(threads.map((thread) => thread.id));
  };
}

/** The open "scheduled" shelf bucket: current runs, then an Archived section for past runs. */
export function SidebarScheduledShelfList(props: {
  visibleThreads: readonly ThreadListItem[];
  currentThreadCount: number;
  archivedThreads: readonly ThreadListItem[];
  visibleArchivedThreads: readonly ThreadListItem[];
  archivedExpanded: boolean;
  archivedShowingAll: boolean;
  onToggleArchived: () => void;
  onToggleArchivedShowAll: () => void;
  showingAll: boolean;
  previewLimit: number;
  onToggleShowAll: () => void;
  routeThreadId: ThreadId | null;
  orderedIds: readonly ThreadId[];
  indicatorsForThread: SidebarIndicatorsForThread;
  actions: SidebarThreadActions;
}) {
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
    <>
      {props.visibleThreads.map(renderThread)}
      {props.currentThreadCount > props.previewLimit && (
        <ListToggleRow
          label={props.showingAll ? "Show less" : `Show all ${props.currentThreadCount}`}
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
          label={
            props.archivedShowingAll ? "Show less" : `Show all ${props.archivedThreads.length}`
          }
          onSelect={props.onToggleArchivedShowAll}
        />
      )}
    </>
  );
}
