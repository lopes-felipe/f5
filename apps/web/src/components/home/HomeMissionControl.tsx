import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  threadIdsForCodeReviewWorkflow,
  threadIdsForPlanningWorkflow,
} from "@t3tools/shared/workflowThreads";
import {
  ArrowRightIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  FolderPlusIcon,
  HistoryIcon,
  MoonIcon,
  PinIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  SunIcon,
  SunriseIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { APP_BASE_NAME } from "../../branding";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { useCreateProjectBackedDraftThread } from "../../hooks/useCreateProjectBackedDraftThread";
import { groupThreadsByActivity } from "../../lib/activityGrouping";
import { resolveAttentionReasonTag } from "../../lib/attentionReason";
import {
  evaluateSmartResume,
  formatAwayDuration,
  readLastHomeVisitAt,
  writeLastHomeVisitAt,
} from "../../lib/lastHomeVisit";
import { getProjectColorClasses } from "../../lib/projectColor";
import {
  getMostRecentProject,
  getVisibleThreads,
  sortProjectsByActivity,
  sortThreadsByActivity,
} from "../../lib/threadOrdering";
import { cn, isMacPlatform } from "../../lib/utils";
import { togglePinned, usePinnedThreadIds } from "../../pinnedThreadsStore";
import { useStore } from "../../store";
import { resolveThreadStatusForThread, type ThreadStatus } from "../../threadStatus";
import type { CodeReviewWorkflow, PlanningWorkflow, Project, Thread } from "../../types";
import { Button } from "../ui/button";
import { HomeThreadRow } from "./HomeThreadRow";

const ATTENTION_LIMIT = 8;
const WORKING_LIMIT = 8;
const RECENT_THREADS_DEFAULT_LIMIT = 5;
const RECENT_THREADS_EXPANDED_LIMIT = 20;
/** Keep the quick-jump surface focused — more than four is noise. */
const QUICK_JUMP_PROJECT_LIMIT = 4;

// Order `attention` so the most urgent status sorts first.
const ATTENTION_PRIORITY: Record<"pending-approval" | "awaiting-input" | "plan-ready", number> = {
  "pending-approval": 0,
  "awaiting-input": 1,
  "plan-ready": 2,
};

type RecentStatusFilter = "all" | "completed" | "idle";

interface MissionControlBuckets {
  attention: Thread[];
  working: Thread[];
  recent: Thread[];
  attentionOverflow: number;
  workingOverflow: number;
}

function collectAllWorkflowThreadIds(
  planningWorkflows: ReadonlyArray<PlanningWorkflow>,
  codeReviewWorkflows: ReadonlyArray<CodeReviewWorkflow>,
): Set<ThreadId> {
  const ids = new Set<ThreadId>();
  for (const workflow of planningWorkflows) {
    for (const id of threadIdsForPlanningWorkflow(workflow)) {
      ids.add(id);
    }
  }
  for (const workflow of codeReviewWorkflows) {
    for (const id of threadIdsForCodeReviewWorkflow(workflow)) {
      ids.add(id);
    }
  }
  return ids;
}

function bucketThreads(
  sortedThreads: ReadonlyArray<Thread>,
  statusByThreadId: ReadonlyMap<ThreadId, ThreadStatus>,
): MissionControlBuckets {
  const attentionAll: Thread[] = [];
  const workingAll: Thread[] = [];
  const remaining: Thread[] = [];

  for (const thread of sortedThreads) {
    const status = statusByThreadId.get(thread.id) ?? "none";
    if (status === "pending-approval" || status === "awaiting-input" || status === "plan-ready") {
      attentionAll.push(thread);
    } else if (status === "working" || status === "connecting") {
      workingAll.push(thread);
    } else {
      remaining.push(thread);
    }
  }

  // Stable-sort `attention` by priority while preserving recency within each bucket.
  attentionAll.sort((left, right) => {
    const leftKey = statusByThreadId.get(left.id) as keyof typeof ATTENTION_PRIORITY;
    const rightKey = statusByThreadId.get(right.id) as keyof typeof ATTENTION_PRIORITY;
    return ATTENTION_PRIORITY[leftKey] - ATTENTION_PRIORITY[rightKey];
  });

  const attention = attentionAll.slice(0, ATTENTION_LIMIT);
  const working = workingAll.slice(0, WORKING_LIMIT);
  // `recent` here is the full remaining list; the UI itself decides how many
  // to show (respecting the "show more" expansion). Keeping it complete in
  // the bucket lets the `Show more` button surface the real total.
  const recent = remaining;

  return {
    attention,
    working,
    recent,
    attentionOverflow: Math.max(0, attentionAll.length - attention.length),
    workingOverflow: Math.max(0, workingAll.length - working.length),
  };
}

interface Greeting {
  readonly label: string;
  readonly Icon: typeof SunIcon;
}

function resolveGreeting(): Greeting {
  const hour = new Date().getHours();
  if (hour < 5) return { label: "Good evening", Icon: MoonIcon };
  if (hour < 12) return { label: "Good morning", Icon: SunriseIcon };
  if (hour < 18) return { label: "Good afternoon", Icon: SunIcon };
  return { label: "Good evening", Icon: MoonIcon };
}

interface SectionProps {
  readonly label: string;
  readonly count: number;
  readonly overflow?: number;
  readonly children: React.ReactNode;
  readonly trailing?: React.ReactNode;
}

function Section({ label, count, overflow = 0, children, trailing }: SectionProps) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between gap-2 border-b border-border/40 pb-2">
        <h2 className="flex items-baseline gap-2 px-0.5 text-xs font-semibold uppercase tracking-wider text-foreground/80">
          {label}
          <span className="font-normal text-muted-foreground/60">
            {count}
            {overflow > 0 ? `+${overflow}` : ""}
          </span>
        </h2>
        {trailing}
      </div>
      {children}
    </section>
  );
}

interface StatStripProps {
  readonly attentionCount: number;
  readonly workingCount: number;
  readonly recentCount: number;
  readonly totalVisibleThreads: number;
}

function StatStrip({
  attentionCount,
  workingCount,
  recentCount,
  totalVisibleThreads,
}: StatStripProps) {
  const items: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly value: number;
    readonly accent: string;
  }> = [
    {
      key: "attention",
      label: "Need attention",
      value: attentionCount,
      accent: "text-amber-600 dark:text-amber-300",
    },
    {
      key: "working",
      label: "In flight",
      value: workingCount,
      accent: "text-sky-600 dark:text-sky-300",
    },
    {
      key: "recent",
      label: "Recent",
      value: recentCount,
      accent: "text-violet-600 dark:text-violet-300",
    },
    {
      key: "total",
      label: "Total threads",
      value: totalVisibleThreads,
      accent: "text-foreground",
    },
  ];

  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map((item) => (
        <div
          key={item.key}
          className="rounded-xl border border-border/60 bg-background/40 px-3 py-2.5"
        >
          <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {item.label}
          </dt>
          <dd className={cn("mt-0.5 text-lg font-semibold tabular-nums", item.accent)}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

interface FilterChipsProps<T extends string> {
  readonly options: ReadonlyArray<{
    readonly value: T;
    readonly label: string;
    readonly count?: number;
  }>;
  readonly value: T;
  readonly onChange: (next: T) => void;
}

function FilterChips<T extends string>({ options, value, onChange }: FilterChipsProps<T>) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="tablist">
      {options.map((option) => {
        const isActive = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
              isActive
                ? "border-foreground/30 bg-foreground/10 text-foreground"
                : "border-border/50 bg-background/30 text-muted-foreground hover:border-foreground/20 hover:bg-background/60 hover:text-foreground",
            )}
          >
            {option.label}
            {option.count !== undefined ? (
              <span className="tabular-nums text-muted-foreground/70">{option.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function AllCaughtUpNote() {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border/40 bg-emerald-500/5 px-3 py-3 text-sm text-muted-foreground">
      <CheckCircle2Icon className="size-4 text-emerald-500" aria-hidden="true" />
      <span>You&apos;re all caught up — nothing needs your attention.</span>
    </div>
  );
}

interface QuickStartChip {
  readonly key: string;
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly hint?: string;
  readonly onClick: () => void;
}

function QuickStartChips({ chips }: { readonly chips: ReadonlyArray<QuickStartChip> }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          onClick={chip.onClick}
          className="group inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-background/40 px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-accent/60 hover:text-foreground"
        >
          <span className="text-muted-foreground/80 group-hover:text-foreground/80">
            {chip.icon}
          </span>
          <span className="max-w-[24ch] truncate">{chip.label}</span>
          {chip.hint ? (
            <span className="hidden text-[10px] text-muted-foreground/60 sm:inline">
              {chip.hint}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

interface SmartResumeBannerProps {
  readonly awayLabel: string;
  readonly thread: Thread;
  readonly project: Project | undefined;
  readonly onResume: () => void;
  readonly onDismiss: () => void;
}

function SmartResumeBanner({
  awayLabel,
  thread,
  project,
  onResume,
  onDismiss,
}: SmartResumeBannerProps) {
  const title = thread.title.trim() || "Untitled thread";
  const projectName = project?.name ?? "Unknown project";
  const projectColor = getProjectColorClasses(project?.id ?? projectName);
  return (
    <div
      role="region"
      aria-label="Resume last thread"
      className="flex items-center gap-3 rounded-xl border border-foreground/10 bg-gradient-to-r from-sky-500/10 via-violet-500/5 to-transparent px-3 py-2.5 text-sm"
    >
      <HistoryIcon className="size-4 shrink-0 text-sky-500 dark:text-sky-300" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-foreground">
          <span className="text-muted-foreground">Back after {awayLabel} —</span>{" "}
          <span className="font-medium">{title}</span>
        </p>
        <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
          <span
            className={cn(
              "inline-block size-1.5 rounded-full ring-2",
              projectColor.bg,
              projectColor.ring,
            )}
            aria-hidden="true"
          />
          <span className="font-mono">{projectName}</span>
        </p>
      </div>
      <button
        type="button"
        onClick={onResume}
        className="inline-flex items-center gap-1 rounded-full border border-foreground/30 bg-foreground/10 px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-foreground/15"
      >
        Resume
        <ArrowRightIcon className="size-3" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss resume banner"
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
      >
        <XIcon className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

export function HomeMissionControl() {
  const navigate = useNavigate();
  const projects = useStore((state) => state.projects);
  const threads = useStore((state) => state.threads);
  const planningWorkflows = useStore((state) => state.planningWorkflows);
  const codeReviewWorkflows = useStore((state) => state.codeReviewWorkflows);
  const createProjectBackedDraftThread = useCreateProjectBackedDraftThread();
  const pinnedThreadIds = usePinnedThreadIds();

  // Home-specific UI state: filter recent threads by project or lifecycle. We
  // keep this local (not in Zustand) because it's session-scoped: users don't
  // want their filter persisted across reloads.
  const [projectFilter, setProjectFilter] = useState<ProjectId | "all">("all");
  const [statusFilter, setStatusFilter] = useState<RecentStatusFilter>("all");
  const [isRecentExpanded, setIsRecentExpanded] = useState(false);
  // Smart resume signal — sampled once on mount. We don't re-sample on every
  // render because the "Back after X" phrasing should feel stable during a
  // single Home visit, not recompute as the user clicks around.
  const [smartResume, setSmartResume] = useState<{ awayMs: number } | null>(null);
  const [smartResumeDismissed, setSmartResumeDismissed] = useState(false);

  const sectionRef = useRef<HTMLElement | null>(null);

  const {
    buckets,
    projectsById,
    mostRecentProject,
    mostRecentThread,
    quickJumpProjects,
    recentAll,
    totalVisibleThreads,
    allProjectsInRecent,
    attentionReasonByThreadId,
  } = useMemo(() => {
    // Workflow sub-threads (Branch A/B, Review A/B, Merge, etc.) are surfaced via their
    // parent workflow elsewhere. Hide them from the home page so Mission Control isn't
    // flooded by dozens of "Plan Ready" rows that belong to a handful of workflows.
    const workflowThreadIds = collectAllWorkflowThreadIds(planningWorkflows, codeReviewWorkflows);
    const visible = getVisibleThreads(threads, planningWorkflows, codeReviewWorkflows).filter(
      (thread) => !workflowThreadIds.has(thread.id),
    );
    const sorted = sortThreadsByActivity(visible);
    const statusByThreadId = new Map<ThreadId, ThreadStatus>();
    for (const thread of sorted) {
      statusByThreadId.set(thread.id, resolveThreadStatusForThread(thread));
    }
    const projectMap = new Map<ProjectId, Project>();
    for (const project of projects) {
      projectMap.set(project.id, project);
    }
    // Pre-compute attention-reason tags so the UI layer stays presentational.
    const reasonByThreadId = new Map<ThreadId, string>();
    for (const thread of sorted) {
      const status = statusByThreadId.get(thread.id) ?? "none";
      const tag = resolveAttentionReasonTag(status, thread.lastInteractionAt);
      if (tag) reasonByThreadId.set(thread.id, tag);
    }

    // For the Recent section's project filter chips we want the full set of
    // projects that currently have any non-attention / non-working threads —
    // not every project in the workspace. This keeps the chip row meaningful
    // and short.
    const recentAllList: Thread[] = [];
    for (const thread of sorted) {
      const status = statusByThreadId.get(thread.id) ?? "none";
      if (
        status !== "pending-approval" &&
        status !== "awaiting-input" &&
        status !== "plan-ready" &&
        status !== "working" &&
        status !== "connecting"
      ) {
        recentAllList.push(thread);
      }
    }
    const projectIdsInRecent = new Set<ProjectId>();
    for (const thread of recentAllList) {
      projectIdsInRecent.add(thread.projectId);
    }
    const projectsInRecent: Project[] = [];
    for (const projectId of projectIdsInRecent) {
      const project = projectMap.get(projectId);
      if (project) {
        projectsInRecent.push(project);
      }
    }
    projectsInRecent.sort((a, b) => a.name.localeCompare(b.name));

    // Top N active projects, ordered by their most recent thread. Used for
    // ⌘1..⌘N quick-jump keyboard shortcuts so power users can spawn a new
    // thread in any frequently-used project without touching the mouse.
    const sortedProjects = sortProjectsByActivity(
      projects,
      threads,
      planningWorkflows,
      codeReviewWorkflows,
    ).slice(0, QUICK_JUMP_PROJECT_LIMIT);

    return {
      buckets: bucketThreads(sorted, statusByThreadId),
      projectsById: projectMap,
      mostRecentProject: getMostRecentProject(
        projects,
        threads,
        planningWorkflows,
        codeReviewWorkflows,
      ),
      mostRecentThread: sorted[0] ?? null,
      quickJumpProjects: sortedProjects,
      recentAll: recentAllList,
      totalVisibleThreads: visible.length,
      allProjectsInRecent: projectsInRecent,
      attentionReasonByThreadId: reasonByThreadId,
    };
  }, [codeReviewWorkflows, planningWorkflows, projects, threads]);

  // Partition Recent into pinned + rest so users see their pinned threads
  // above the main activity grouping. Pinned items are pulled out of the main
  // filter/status flow so they don't get hidden by a project filter — pins
  // should be persistently visible regardless of filters.
  const pinnedThreads = useMemo(() => {
    if (pinnedThreadIds.length === 0) return [] as Thread[];
    const byId = new Map<ThreadId, Thread>();
    for (const thread of recentAll) byId.set(thread.id, thread);
    // Also allow pinning attention/working threads; fall back to scanning all
    // threads so a pinned thread that's currently in another bucket still
    // shows up in the Pinned strip.
    for (const thread of threads) byId.set(thread.id, thread);
    const collected: Thread[] = [];
    for (const id of pinnedThreadIds) {
      const thread = byId.get(id);
      if (thread) collected.push(thread);
    }
    return collected;
  }, [pinnedThreadIds, recentAll, threads]);

  const pinnedIdSet = useMemo(() => new Set<ThreadId>(pinnedThreadIds), [pinnedThreadIds]);

  const filteredRecent = useMemo(() => {
    const filteredByProject =
      projectFilter === "all"
        ? recentAll
        : recentAll.filter((thread) => thread.projectId === projectFilter);
    const filteredByStatus =
      statusFilter === "all"
        ? filteredByProject
        : filteredByProject.filter((thread) => {
            const status = resolveThreadStatusForThread(thread);
            if (statusFilter === "completed") return status === "completed";
            // "idle" = anything neither explicitly completed nor in another bucket.
            return status === "none";
          });
    // Exclude pinned threads from the main list: they appear in the dedicated
    // Pinned strip, so showing them twice would waste space and confuse the
    // mental model that pins "float to the top".
    return filteredByStatus.filter((thread) => !pinnedIdSet.has(thread.id));
  }, [pinnedIdSet, projectFilter, recentAll, statusFilter]);

  const recentLimit = isRecentExpanded
    ? RECENT_THREADS_EXPANDED_LIMIT
    : RECENT_THREADS_DEFAULT_LIMIT;
  const recentTruncated = filteredRecent.slice(0, recentLimit);
  const hasMoreRecent = filteredRecent.length > recentTruncated.length;

  const onSelectThread = useCallback(
    (threadId: ThreadId) => {
      void navigate({ to: "/$threadId", params: { threadId } });
    },
    [navigate],
  );

  const onTogglePin = useCallback((threadId: ThreadId) => {
    togglePinned(threadId);
  }, []);

  const onNewThread = () => {
    if (!mostRecentProject) {
      useCommandPaletteStore.getState().openAddProject();
      return;
    }
    void createProjectBackedDraftThread(mostRecentProject.id);
  };

  const onAddProject = () => useCommandPaletteStore.getState().openAddProject();
  const onOpenCommandPalette = () => useCommandPaletteStore.getState().setOpen(true);

  const hasAnyThread =
    buckets.attention.length + buckets.working.length + filteredRecent.length > 0;
  const modifierKey =
    typeof navigator !== "undefined" && isMacPlatform(navigator.platform) ? "⌘" : "Ctrl+";

  // Global keyboard navigation handler. Scoped to the home section so j/k
  // don't fight with other views. Three concerns live here:
  //   1. j/k row cycling (existing).
  //   2. Cmd/Ctrl+1..N quick-jump into one of the top projects.
  //   3. Ignore when the user is typing in an input/textarea/contenteditable.
  useEffect(() => {
    const container = sectionRef.current;
    if (!container) return;

    const isTypingTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
    };

    const handler = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;

      // Project quick-jump. Use (Cmd or Ctrl) + digit — this mirrors browser
      // tab switching and matches the plan's `⌘1`/`⌘2` suggestion without
      // colliding with Alt+digit browser shortcuts.
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        const digit = Number.parseInt(event.key, 10);
        if (digit >= 1 && digit <= 9) {
          const target = quickJumpProjects[digit - 1];
          if (target) {
            event.preventDefault();
            void createProjectBackedDraftThread(target.id);
          }
          return;
        }
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== "j" && event.key !== "k") return;

      const rows = Array.from(
        container.querySelectorAll<HTMLButtonElement>("[data-home-row-index]"),
      );
      if (rows.length === 0) return;

      const active = document.activeElement as HTMLElement | null;
      const currentIndex = active ? rows.findIndex((row) => row === active) : -1;
      const delta = event.key === "j" ? 1 : -1;
      let nextIndex: number;
      if (currentIndex === -1) {
        nextIndex = delta === 1 ? 0 : rows.length - 1;
      } else {
        nextIndex = (currentIndex + delta + rows.length) % rows.length;
      }
      const nextRow = rows[nextIndex];
      if (nextRow) {
        event.preventDefault();
        nextRow.focus();
      }
    };

    // Listen on window so Cmd+digit works even when no Home element has
    // focus. Other handlers still get a shot (we call preventDefault only
    // when we actually consume the event).
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [createProjectBackedDraftThread, quickJumpProjects]);

  // Smart resume: on first mount, check how long the user was away and if
  // it crosses the threshold, surface a banner pointing at their most recent
  // thread. Then record the current timestamp so the next visit starts the
  // clock fresh. We write on every mount rather than on unmount so the
  // signal reflects "last time Home was actually seen" — including forced
  // tab closes where unmount handlers don't run reliably.
  useEffect(() => {
    const lastVisitAt = readLastHomeVisitAt();
    const signal = evaluateSmartResume(lastVisitAt);
    if (signal.shouldOffer) {
      setSmartResume({ awayMs: signal.awayMs });
    }
    writeLastHomeVisitAt();
  }, []);

  const recentGroups = useMemo(() => groupThreadsByActivity(recentTruncated), [recentTruncated]);
  const greeting = resolveGreeting();
  const GreetingIcon = greeting.Icon;

  // Build a flat row-index so j/k navigation spans all sections uniformly.
  let rowCursor = 0;
  const nextRowIndex = () => {
    const value = rowCursor;
    rowCursor += 1;
    return value;
  };

  const projectFilterOptions: ReadonlyArray<{
    readonly value: ProjectId | "all";
    readonly label: string;
  }> = [
    { value: "all", label: "All" },
    ...allProjectsInRecent.map((project) => ({ value: project.id, label: project.name })),
  ];

  const statusFilterOptions: ReadonlyArray<{
    readonly value: RecentStatusFilter;
    readonly label: string;
  }> = [
    { value: "all", label: "Any status" },
    { value: "completed", label: "Completed" },
    { value: "idle", label: "Idle" },
  ];

  const quickStartChips = useMemo<ReadonlyArray<QuickStartChip>>(() => {
    const chips: QuickStartChip[] = [];

    // "Continue last thread" — only when the thread is not already surfaced
    // by the smart-resume banner (avoid duplicating the same action).
    if (mostRecentThread && !smartResume) {
      const title = mostRecentThread.title.trim() || "Untitled thread";
      chips.push({
        key: "continue-last",
        label: `Continue: ${title}`,
        icon: <PlayIcon className="size-3" />,
        onClick: () => onSelectThread(mostRecentThread.id),
      });
    }

    // Surface the first plan-ready thread as "Resume plan" — plans tend to
    // be the highest-leverage resume target.
    const firstPlanReady = buckets.attention.find(
      (thread) => resolveThreadStatusForThread(thread) === "plan-ready",
    );
    if (firstPlanReady && firstPlanReady.id !== mostRecentThread?.id) {
      const title = firstPlanReady.title.trim() || "Untitled thread";
      chips.push({
        key: "resume-plan",
        label: `Resume plan: ${title}`,
        icon: <SparklesIcon className="size-3" />,
        onClick: () => onSelectThread(firstPlanReady.id),
      });
    }

    return chips;
  }, [buckets.attention, mostRecentThread, onSelectThread, smartResume]);

  // `self-start` prevents the parent's `items-center` from vertically centering tall
  // content and clipping the header above the scrollable viewport. `my-auto` on a
  // sibling would solve it too, but `self-start` keeps the layout simple: short content
  // still sits at the top-left and long content scrolls naturally.
  return (
    <section
      ref={sectionRef}
      className="mx-auto flex w-full max-w-4xl flex-col gap-8 self-start px-6 py-10 motion-safe:animate-in motion-safe:fade-in-50 motion-safe:duration-300"
    >
      <header className="flex flex-col gap-2 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2 motion-safe:duration-300">
        <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          <GreetingIcon className="size-3.5 opacity-70" aria-hidden="true" />
          <span>{greeting.label}</span>
        </p>
        <h1 className="font-heading text-2xl font-semibold leading-tight tracking-tight text-foreground md:text-3xl">
          {APP_BASE_NAME} Home
        </h1>
        <p className="text-sm text-muted-foreground">
          {hasAnyThread ? (
            <>
              <span className="tabular-nums font-medium text-foreground">
                {buckets.attention.length}
              </span>{" "}
              {buckets.attention.length === 1 ? "thread needs" : "threads need"} attention ·{" "}
              <span className="tabular-nums font-medium text-foreground">
                {buckets.working.length}
              </span>{" "}
              in flight
            </>
          ) : (
            "Start your first thread when you're ready."
          )}
        </p>
      </header>

      {/* Smart resume: surfaces the most recent thread when coming back after
          a meaningful break. Skippable without penalty so power users aren't
          forced through the friction of dismissing it every time. */}
      {smartResume && !smartResumeDismissed && mostRecentThread ? (
        <SmartResumeBanner
          awayLabel={formatAwayDuration(smartResume.awayMs)}
          thread={mostRecentThread}
          project={projectsById.get(mostRecentThread.projectId)}
          onResume={() => onSelectThread(mostRecentThread.id)}
          onDismiss={() => setSmartResumeDismissed(true)}
        />
      ) : null}

      {/* Compact stat strip — communicates state at a glance on first paint. */}
      <StatStrip
        attentionCount={buckets.attention.length}
        workingCount={buckets.working.length}
        recentCount={recentAll.length}
        totalVisibleThreads={totalVisibleThreads}
      />

      <div className="flex flex-wrap items-center gap-2">
        {mostRecentProject ? (
          <Button onClick={onNewThread}>
            <PlusIcon />
            New thread in {mostRecentProject.name}
          </Button>
        ) : (
          <Button onClick={onAddProject}>
            <FolderPlusIcon />
            Add a project
          </Button>
        )}
        {mostRecentProject ? (
          <Button variant="outline" onClick={onAddProject}>
            <FolderPlusIcon />
            Add project
          </Button>
        ) : null}
        <Button variant="ghost" onClick={onOpenCommandPalette}>
          <SearchIcon />
          Open command palette
          <kbd className="ml-1 rounded border border-foreground/20 bg-background/30 px-1 py-px font-mono text-[10px] text-foreground/70">
            {modifierKey}K
          </kbd>
        </Button>
      </div>

      {/* Quick-start chips: contextual shortcuts derived from current state
          (last thread, earliest plan-ready). Only rendered when chips exist
          so we don't leave a visually empty slot. */}
      {quickStartChips.length > 0 ? <QuickStartChips chips={quickStartChips} /> : null}

      <div className="flex flex-col gap-8">
        {/* Pinned: dedicated strip above everything else. Only shown when
            the user has actually pinned something so empty-state users
            don't see a confusing empty section. */}
        {pinnedThreads.length > 0 ? (
          <Section
            label="Pinned"
            count={pinnedThreads.length}
            trailing={
              <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-300/80">
                <PinIcon className="size-3" aria-hidden="true" />
                starred
              </span>
            }
          >
            <div className="flex flex-col gap-1.5">
              {pinnedThreads.map((thread) => (
                <HomeThreadRow
                  key={thread.id}
                  thread={thread}
                  project={projectsById.get(thread.projectId)}
                  onSelect={onSelectThread}
                  rowIndex={nextRowIndex()}
                  isPinned
                  onTogglePin={onTogglePin}
                />
              ))}
            </div>
          </Section>
        ) : null}

        {buckets.attention.length > 0 ? (
          <Section
            label="Needs attention"
            count={buckets.attention.length}
            overflow={buckets.attentionOverflow}
          >
            <div className="flex flex-col gap-1.5">
              {buckets.attention.map((thread) => (
                <HomeThreadRow
                  key={thread.id}
                  thread={thread}
                  project={projectsById.get(thread.projectId)}
                  onSelect={onSelectThread}
                  rowIndex={nextRowIndex()}
                  isPinned={pinnedIdSet.has(thread.id)}
                  onTogglePin={onTogglePin}
                  reasonTag={attentionReasonByThreadId.get(thread.id)}
                  urgencyStatus={resolveThreadStatusForThread(thread)}
                />
              ))}
            </div>
          </Section>
        ) : totalVisibleThreads > 0 ? (
          <Section label="Needs attention" count={0}>
            <AllCaughtUpNote />
          </Section>
        ) : null}

        {buckets.working.length > 0 ? (
          <Section
            label="Currently working"
            count={buckets.working.length}
            overflow={buckets.workingOverflow}
            trailing={
              <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-sky-600 dark:text-sky-300/80">
                <SparklesIcon className="size-3" aria-hidden="true" />
                live
              </span>
            }
          >
            <div className="flex flex-col gap-1.5">
              {buckets.working.map((thread) => (
                <HomeThreadRow
                  key={thread.id}
                  thread={thread}
                  project={projectsById.get(thread.projectId)}
                  onSelect={onSelectThread}
                  rowIndex={nextRowIndex()}
                  isPinned={pinnedIdSet.has(thread.id)}
                  onTogglePin={onTogglePin}
                  urgencyStatus={resolveThreadStatusForThread(thread)}
                />
              ))}
            </div>
          </Section>
        ) : null}

        {recentAll.length > 0 ? (
          <Section
            label="Recent"
            count={filteredRecent.length}
            trailing={
              // Only surface filter chips when there's enough content to warrant
              // filtering — avoid cognitive overhead for new users.
              allProjectsInRecent.length > 1 ? (
                <FilterChips
                  options={projectFilterOptions}
                  value={projectFilter}
                  onChange={setProjectFilter}
                />
              ) : null
            }
          >
            <div className="flex flex-col gap-3">
              {recentAll.length > 3 ? (
                <FilterChips
                  options={statusFilterOptions}
                  value={statusFilter}
                  onChange={setStatusFilter}
                />
              ) : null}
              {filteredRecent.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border/60 bg-background/30 px-3 py-4 text-center text-xs text-muted-foreground">
                  No threads match the current filters.
                </p>
              ) : (
                <>
                  {recentGroups.map((group) => (
                    <div key={group.bucket} className="flex flex-col gap-1.5">
                      <h3 className="px-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                        {group.label}
                      </h3>
                      <div className="flex flex-col gap-1.5">
                        {group.threads.map((thread) => (
                          <HomeThreadRow
                            key={thread.id}
                            thread={thread}
                            project={projectsById.get(thread.projectId)}
                            onSelect={onSelectThread}
                            rowIndex={nextRowIndex()}
                            isPinned={pinnedIdSet.has(thread.id)}
                            onTogglePin={onTogglePin}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                  {hasMoreRecent || isRecentExpanded ? (
                    <div className="flex justify-center pt-1">
                      <button
                        type="button"
                        onClick={() => setIsRecentExpanded((prev) => !prev)}
                        className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-background/30 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-foreground/20 hover:bg-background/60 hover:text-foreground"
                      >
                        {hasMoreRecent ? (
                          <>
                            Show more
                            <span className="tabular-nums text-muted-foreground/70">
                              +{filteredRecent.length - recentTruncated.length}
                            </span>
                            <ChevronDownIcon className="size-3" aria-hidden="true" />
                          </>
                        ) : (
                          <>
                            Show less
                            <ChevronDownIcon className="size-3 rotate-180" aria-hidden="true" />
                          </>
                        )}
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </Section>
        ) : null}
      </div>

      <p className="border-t border-border/40 pt-4 text-sm text-muted-foreground">
        Tip: press{" "}
        <kbd className="rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-xs text-foreground">
          {modifierKey}K
        </kbd>{" "}
        to search commands,{" "}
        <kbd className="rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-xs text-foreground">
          j
        </kbd>
        /
        <kbd className="rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-xs text-foreground">
          k
        </kbd>{" "}
        to move between threads
        {quickJumpProjects.length > 0 ? (
          <>
            , or{" "}
            <kbd className="rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-xs text-foreground">
              {modifierKey}1
            </kbd>
            –
            <kbd className="rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-xs text-foreground">
              {modifierKey}
              {quickJumpProjects.length}
            </kbd>{" "}
            to start a thread in a top project
          </>
        ) : null}
        .
      </p>
    </section>
  );
}
