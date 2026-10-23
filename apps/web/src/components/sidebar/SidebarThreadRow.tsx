import type { ThreadId } from "@t3tools/contracts";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  GitPullRequestIcon,
  LoaderCircleIcon,
  MoonIcon,
  PinIcon,
  SquarePenIcon,
  SunriseIcon,
  TerminalIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { useStore } from "../../store";
import { ProjectIcon } from "../ProjectIcon";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { synchronizeStatusPulse } from "../../lib/statusPulse";
import { cn } from "../../lib/utils";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import type { ThreadStatusPill } from "../../threadStatus";
import type { ThreadListItem } from "../../types";
import { InlineTitleEditor } from "../InlineTitleEditor";
import { resolveSidebarComposerDraftPreview, resolveThreadRowClassName } from "../Sidebar.logic";
import { ThreadRelativeActivityTime } from "../thread/ThreadActivityTime";
import { ThreadQueueCountBadge } from "../thread/ThreadQueueCountBadge";
import { ThreadStatusPillBadge } from "../thread/ThreadStatusPillBadge";
import { ThreadWorktreeIndicator } from "../ThreadWorktreeIndicator";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type PrStatusIndicator,
  type TerminalStatusIndicator,
  pinnedThreadSortableId,
} from "./sidebarLists";
import type { SidebarThreadActions } from "./useSidebarThreadActions";

/**
 * Which list a row lives in. Each list keeps its own affordances:
 * - `workflow`: child of a workflow row; shows the role label and model.
 * - `active`: project thread list; drafts, pins, queue badge, rename, archive.
 * - `snoozed`: no status/PR, single-thread context menu, no keyboard open.
 * - `archived`: rename and unarchive.
 * - `settled`: quiet completed work, with an explicit Unsettle action.
 * - `attention`: "Needs you"; plain navigation, no multi-select, shows the project.
 */
export type SidebarThreadRowSection =
  | "workflow"
  | "active"
  | "snoozed"
  | "archived"
  | "settled"
  | "attention";

export interface SidebarThreadRowProps {
  thread: ThreadListItem;
  section: SidebarThreadRowSection;
  isActive: boolean;
  isDraft?: boolean | undefined;
  /** Visible thread ids for shift-click range selection. */
  orderedIds: readonly ThreadId[];
  /** Overrides the visible title (workflow role label); the full title stays in the tooltip. */
  displayTitle?: string | undefined;
  /** Extra trailing content before the timestamp (model chip, project name). */
  trailingMeta?: ReactNode;
  threadStatus: ThreadStatusPill | null;
  prStatus: PrStatusIndicator | null;
  terminalStatus: TerminalStatusIndicator | null;
  /** A completed turn the user has not seen yet. */
  isUnread: boolean;
  isRenaming: boolean;
  actions: SidebarThreadActions;
}

/** Hover-revealed controls also reveal on keyboard focus and coarse pointers (F5). */
export const SIDEBAR_ROW_REVEAL_CLASS_NAME =
  "opacity-0 group-hover/thread-row:opacity-100 group-focus-within/thread-row:opacity-100 pointer-coarse:opacity-100";

export function SidebarThreadRow(props: SidebarThreadRowProps) {
  "use memo";
  const {
    thread,
    section,
    isActive,
    isDraft = false,
    orderedIds,
    threadStatus,
    prStatus,
    terminalStatus,
    isUnread,
    isRenaming,
    actions,
  } = props;
  const project = useStore((state) =>
    section === "settled"
      ? state.projects.find((project) => project.id === thread.projectId)
      : undefined,
  );
  const selectable = section !== "snoozed" && section !== "attention" && !isDraft;
  const isSelected = useThreadSelectionStore(
    (state) => selectable && state.selectedThreadIds.has(thread.id),
  );
  const isHighlighted = isActive || isSelected;
  const testId =
    section === "active" || section === "archived" || section === "settled"
      ? `thread-row-${thread.id}`
      : section === "attention"
        ? `attention-thread-row-${thread.id}`
        : undefined;
  const canRename = section === "active" || section === "archived" || section === "settled";
  const action =
    section === "active" && !isDraft
      ? {
          label: "Archive",
          ariaLabel: `Archive ${thread.title}`,
          icon: ArchiveIcon,
          onClick: () => {
            void actions.archiveThread(thread.id, true);
          },
        }
      : section === "archived"
        ? {
            label: "Unarchive",
            ariaLabel: `Unarchive ${thread.title}`,
            icon: ArchiveRestoreIcon,
            onClick: () => {
              void actions.archiveThread(thread.id, false);
            },
          }
        : section === "settled"
          ? {
              label: "Unsettle",
              ariaLabel: `Unsettle ${thread.title}`,
              icon: SunriseIcon,
              onClick: () => {
                void actions.unsettleThread(thread.id);
              },
            }
          : null;

  return (
    <SidebarMenuSubItem
      className="group/thread-row w-full"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(event) => actions.attachDropToThread(event, thread)}
      {...(section === "attention" ? {} : { "data-thread-item": true })}
    >
      <SidebarMenuSubButton
        render={<div role="button" tabIndex={0} />}
        size="md"
        isActive={isActive}
        {...(testId ? { "data-testid": testId } : {})}
        className={cn(
          resolveThreadRowClassName({
            isActive,
            isSelected,
            isUnread: section !== "archived" && isUnread,
          }),
          section === "settled" &&
            "text-muted-foreground [&:not(:hover):not(:focus-within)_*]:text-muted-foreground",
        )}
        onClick={(event) => {
          if (section === "attention") {
            actions.openThread(thread.id);
            return;
          }
          if (section === "workflow" || section === "active") {
            actions.handleThreadClick(event, thread.id, orderedIds, { isDraft });
            return;
          }
          actions.handleThreadClick(event, thread.id, orderedIds);
        }}
        {...(canRename
          ? {
              onDoubleClick: (event: React.MouseEvent) => {
                actions.handleThreadRowDoubleClick(
                  event,
                  thread,
                  section === "active" ? { isDraft } : undefined,
                );
              },
            }
          : {})}
        {...(section !== "snoozed"
          ? {
              onKeyDown: (event: React.KeyboardEvent) => {
                // Nested controls (PR status, archive, rename input) handle
                // their own Enter/Space.
                if (event.target !== event.currentTarget) return;
                if (section === "attention") {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  actions.openThread(thread.id);
                  return;
                }
                actions.handleThreadRowKeyDown(event, thread.id, { isDraft });
              },
            }
          : {})}
        onContextMenu={(event) => {
          actions.openThreadContextMenu(event, thread.id, {
            isDraft,
            allowMultiSelect: section !== "snoozed" && section !== "attention",
          });
        }}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {section === "settled" ? (
            <ProjectIcon
              projectId={thread.projectId}
              name={project?.name ?? "Project"}
              icon={project?.icon}
              className="size-4"
            />
          ) : section === "snoozed" ? (
            <MoonIcon aria-label="Snoozed" className="size-3.5 text-faint-foreground" />
          ) : threadStatus ? (
            <ThreadStatusPillBadge pill={threadStatus} variant="icon" live={false} />
          ) : null}
        </span>
        {section !== "snoozed" && prStatus ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={prStatus.tooltip}
                  className={cn(
                    "-mx-0.5 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-ring",
                    section === "settled"
                      ? cn(
                          "text-muted-foreground",
                          prStatus.label === "PR open"
                            ? "group-hover/thread-row:text-success-foreground group-focus-within/thread-row:text-success-foreground"
                            : prStatus.label === "PR merged"
                              ? "group-hover/thread-row:text-attention-foreground group-focus-within/thread-row:text-attention-foreground"
                              : "group-hover/thread-row:text-muted-foreground",
                        )
                      : prStatus.colorClass,
                  )}
                  onClick={(event) => {
                    actions.openPrLink(event, prStatus.url);
                  }}
                >
                  <GitPullRequestIcon className="size-3.5" />
                </button>
              }
            />
            <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
          </Tooltip>
        ) : null}
        {section === "active" ? <ThreadQueueCountBadge compact threadId={thread.id} /> : null}
        {canRename && !isDraft && isRenaming ? (
          <InlineTitleEditor
            initialValue={thread.title}
            className="min-w-0 flex-1 text-ui"
            onCommit={(nextValue) => {
              void actions.commitRename(thread.id, nextValue);
            }}
            onCancel={actions.cancelRename}
          />
        ) : (
          <SidebarThreadTitle
            thread={thread}
            {...(props.displayTitle ? { displayTitle: props.displayTitle } : {})}
            withTestId={section === "active" || section === "snoozed"}
          />
        )}
        {props.trailingMeta}
        {section === "active" && thread.pinnedAt != null ? (
          <PinnedThreadDragHandle threadId={thread.id} />
        ) : null}
        <ThreadRowTrailingMeta
          thread={thread}
          lastInteractionAt={thread.lastInteractionAt}
          terminalStatus={section === "snoozed" ? null : terminalStatus}
          isHighlighted={isHighlighted}
          {...(section === "active" ? { showDraftIndicator: !isDraft } : {})}
          action={action}
        />
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

export function SidebarThreadTitle({
  thread,
  displayTitle,
  withTestId = true,
}: {
  thread: ThreadListItem;
  displayTitle?: string | undefined;
  withTestId?: boolean | undefined;
}) {
  "use memo";
  const suppressTooltip = useMediaQuery("(hover: none), (pointer: coarse)");
  const visibleTitle = displayTitle ?? thread.title;
  const tooltip = displayTitle && displayTitle !== thread.title ? thread.title : visibleTitle;
  const title = (
    <span
      className="min-w-0 flex-1 truncate"
      {...(withTestId ? { "data-testid": `thread-title-${thread.id}` } : {})}
    >
      {visibleTitle}
      {tooltip !== visibleTitle ? <span className="sr-only">{`, ${tooltip}`}</span> : null}
    </span>
  );

  if (suppressTooltip) {
    return title;
  }

  return (
    <Tooltip>
      <TooltipTrigger delay={250} render={title} />
      <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
        {tooltip}
      </TooltipPopup>
    </Tooltip>
  );
}

export function PinnedThreadDragHandle({ threadId }: { threadId: ThreadId }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: pinnedThreadSortableId(threadId),
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      aria-label="Reorder pinned thread"
      className={cn(
        "inline-flex size-5 shrink-0 cursor-grab items-center justify-center rounded-md text-warning-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing",
        isDragging && "z-20 opacity-70",
      )}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      {...attributes}
      {...listeners}
    >
      <PinIcon className="size-3.5" />
    </button>
  );
}

/** Opens the thread's terminal drawer on a running terminal, including one in a split. */
function revealRunningTerminal(threadId: ThreadId) {
  const store = useTerminalStateStore.getState();
  const terminalId = selectThreadTerminalState(store.terminalStateByThreadId, threadId)
    .runningTerminalIds[0];
  if (!terminalId) return;
  store.setActiveTerminal(threadId, terminalId);
  store.setTerminalOpen(threadId, true);
}

export function ThreadRowTrailingMeta(props: {
  thread: Pick<ThreadListItem, "id" | "branch" | "worktreePath" | "titleRegeneration">;
  lastInteractionAt: string;
  terminalStatus: TerminalStatusIndicator | null;
  isHighlighted: boolean;
  showDraftIndicator?: boolean | undefined;
  action?: {
    label: string;
    ariaLabel: string;
    icon: typeof ArchiveIcon;
    onClick: () => void;
  } | null;
}) {
  "use memo";
  const action = props.action ?? null;
  const draft = useComposerDraftStore((store) => store.draftsByThreadId[props.thread.id]);
  const draftPreview =
    props.showDraftIndicator === false ? null : resolveSidebarComposerDraftPreview(draft);
  const ActionIcon = action?.icon;

  return (
    <div className="ml-auto flex shrink-0 items-center gap-1.5">
      {props.thread.titleRegeneration ? (
        <LoaderCircleIcon
          aria-label="Regenerating thread title"
          className="size-3.5 animate-spin text-faint-foreground"
        />
      ) : null}
      {draftPreview ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label="Unsent draft"
                className="inline-flex items-center justify-center text-faint-foreground"
              >
                <SquarePenIcon className="size-3.5" />
              </span>
            }
          />
          <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
            Draft: {draftPreview}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <ThreadWorktreeIndicator thread={props.thread} />
      {props.terminalStatus ? (
        <button
          type="button"
          aria-label={`${props.terminalStatus.label}. Show terminal`}
          title={props.terminalStatus.label}
          className={cn(
            "inline-flex items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
            props.terminalStatus.colorClass,
          )}
          // The row's own click then opens the thread; this picks which terminal shows.
          onClick={() => revealRunningTerminal(props.thread.id)}
        >
          <TerminalIcon
            className={cn(
              "size-3.5",
              props.terminalStatus.pulse && "motion-safe:animate-status-pulse",
            )}
            onAnimationStart={synchronizeStatusPulse}
          />
        </button>
      ) : null}
      <span className="relative flex shrink-0 items-center justify-end">
        <span
          className={cn(
            "text-2xs font-normal tabular-nums",
            props.isHighlighted ? "text-foreground" : "text-muted-foreground",
            action &&
              "group-hover/thread-row:invisible group-focus-within/thread-row:invisible pointer-coarse:invisible",
          )}
        >
          <ThreadRelativeActivityTime
            threadId={props.thread.id}
            fallback={props.lastInteractionAt}
          />
        </span>
        {action && ActionIcon ? (
          <span className="absolute inset-y-0 right-0 flex items-center">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={action.ariaLabel}
                    className={cn(
                      "-mr-1 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                      SIDEBAR_ROW_REVEAL_CLASS_NAME,
                    )}
                    onMouseDown={(event) => {
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      action.onClick();
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                    }}
                  >
                    <ActionIcon className="size-3.5" />
                  </button>
                }
              />
              <TooltipPopup side="top">{action.label}</TooltipPopup>
            </Tooltip>
          </span>
        ) : null}
      </span>
    </div>
  );
}
