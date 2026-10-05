import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { ChevronRightIcon } from "lucide-react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import type { Project, Thread } from "../../types";
import { SidebarMenuSub } from "../ui/sidebar";
import { SidebarThreadRow } from "./SidebarThreadRow";
import type { SidebarThreadRowIndicators } from "./SidebarWorkflowItem";
import type { SidebarThreadActions } from "./useSidebarThreadActions";

export const SIDEBAR_ATTENTION_LIMIT = 5;
export const SIDEBAR_ATTENTION_COLLAPSED_STORAGE_KEY = "f5:sidebar:attention-collapsed";

const EMPTY_THREAD_IDS: readonly ThreadId[] = [];

/**
 * "Needs you": threads waiting on the user (approval, input, plan ready, paused
 * queue), most urgent first, capped at five with a link to Home for the rest.
 * Rows navigate plainly and stay out of multi-select.
 */
export function SidebarAttentionSection(props: {
  /** Ordered attention threads (already frozen while the sidebar is hovered). */
  threads: readonly Thread[];
  projectsById: ReadonlyMap<ProjectId, Project>;
  routeThreadId: ThreadId | null;
  indicatorsForThread: (thread: Thread) => SidebarThreadRowIndicators;
  actions: SidebarThreadActions;
}) {
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useLocalStorage(
    SIDEBAR_ATTENTION_COLLAPSED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const total = props.threads.length;
  if (total === 0) return null;
  const visible = props.threads.slice(0, SIDEBAR_ATTENTION_LIMIT);
  const headingId = "sidebar-attention-heading";

  return (
    <section aria-labelledby={headingId} className="pb-3" data-testid="sidebar-attention-section">
      <div className="flex h-7 items-center gap-1 px-2">
        <button
          type="button"
          id={headingId}
          aria-expanded={!collapsed}
          className="flex items-center gap-1 rounded-md text-2xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setCollapsed((current) => !current)}
        >
          Needs you
          <span className="tabular-nums">{total}</span>
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 text-faint-foreground transition-transform duration-(--duration-fast)",
              !collapsed && "rotate-90",
            )}
          />
        </button>
        {total > SIDEBAR_ATTENTION_LIMIT ? (
          <button
            type="button"
            className="ml-auto rounded-md px-1 text-2xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => void navigate({ to: "/" })}
          >
            Show all ({total})
          </button>
        ) : null}
      </div>
      {collapsed ? null : (
        <SidebarMenuSub className="mx-0 w-full translate-x-0 gap-px border-l-0 px-0 py-0">
          {visible.map((thread) => (
            <SidebarThreadRow
              key={thread.id}
              thread={thread}
              section="attention"
              isActive={props.routeThreadId === thread.id}
              orderedIds={EMPTY_THREAD_IDS}
              trailingMeta={
                <span
                  title={props.projectsById.get(thread.projectId)?.name}
                  className="min-w-0 max-w-14 shrink truncate text-2xs font-normal text-muted-foreground"
                >
                  {props.projectsById.get(thread.projectId)?.name}
                </span>
              }
              isRenaming={false}
              actions={props.actions}
              {...props.indicatorsForThread(thread)}
            />
          ))}
        </SidebarMenuSub>
      )}
    </section>
  );
}
