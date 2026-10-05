import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  HistoryIcon,
  PlayIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { requestComposerFocus } from "../../composerFocusRequestStore";
import { useCreateProjectBackedDraftThread } from "../../hooks/useCreateProjectBackedDraftThread";
import { groupThreadsByActivity } from "../../lib/activityGrouping";
import { QUEUE_PAUSED_REASON_TAG, resolveAttentionReasonTag } from "../../lib/attentionReason";
import {
  evaluateSmartResume,
  formatAwayDuration,
  readLastHomeVisitAt,
  writeLastHomeVisitAt,
} from "../../lib/lastHomeVisit";
import { getMostRecentProject, sortProjectsByActivity } from "../../lib/threadOrdering";
import {
  bucketThreadsByAttention,
  selectStandaloneThreadsByActivity,
  selectVisibleWorkflowThreads,
} from "../../lib/threadAttentionBuckets";
import { cn, isMacPlatform } from "../../lib/utils";
import { useStore } from "../../store";
import { orderedPinnedThreadIds, toggleThreadPin } from "../../threadPinSnooze";
import { useNextTurnQueueStore } from "../../nextTurnQueueStore";
import { resolveThreadStatusForThread, type ThreadStatus } from "../../threadStatus";
import type { Project, Thread } from "../../types";
import { resolvePrimaryNewThreadProjectId } from "../Sidebar.logic";
import { ProjectIcon } from "../ProjectIcon";
import { Kbd } from "../ui/kbd";
import { SectionLabel } from "../ui/section-label";
import { toastManager } from "../ui/toast";
import { HomeAttentionCard } from "./HomeAttentionCard";
import { HomeQuickStart } from "./HomeQuickStart";
import { HomeThreadRow } from "./HomeThreadRow";

const ATTENTION_LIMIT = 8;
const WORKING_LIMIT = 8;
const RECENT_THREADS_DEFAULT_LIMIT = 5;
const RECENT_THREADS_EXPANDED_LIMIT = 20;
/** Keep the quick-jump surface focused — more than four is noise. */
const QUICK_JUMP_PROJECT_LIMIT = 4;

type RecentStatusFilter = "all" | "completed" | "idle";

interface MissionControlBuckets {
  attention: Thread[];
  working: Thread[];
  recent: Thread[];
  workingOverflow: number;
}

function bucketThreads(
  sortedThreads: ReadonlyArray<Thread>,
  statusByThreadId: ReadonlyMap<ThreadId, ThreadStatus>,
  pausedQueueThreadIds: ReadonlySet<ThreadId>,
  workflowThreads: ReadonlyArray<Thread>,
): MissionControlBuckets {
  const {
    attention,
    working: workingAll,
    remaining,
  } = bucketThreadsByAttention(
    sortedThreads,
    statusByThreadId,
    pausedQueueThreadIds,
    workflowThreads,
  );

  const working = workingAll.slice(0, WORKING_LIMIT);
  // `attention` and `recent` are full lists; the UI decides how many to show
  // so "Show more" can surface the real total.
  return {
    attention,
    working,
    recent: remaining,
    workingOverflow: Math.max(0, workingAll.length - working.length),
  };
}

/** "Show more +N" / "Show less" under a capped list. */
function ShowMoreToggle(props: {
  readonly expanded: boolean;
  readonly hiddenCount: number;
  readonly onToggle: () => void;
}) {
  return (
    <div className="flex justify-center pt-1">
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={props.expanded}
        className="inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-2xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        {props.hiddenCount > 0 ? (
          <>
            Show more
            <span className="tabular-nums">+{props.hiddenCount}</span>
            <ChevronDownIcon className="size-3.5" aria-hidden="true" />
          </>
        ) : (
          <>
            Show less
            <ChevronDownIcon className="size-3.5 rotate-180" aria-hidden="true" />
          </>
        )}
      </button>
    </div>
  );
}

export function resolveGreeting(hour = new Date().getHours()): string {
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function Section(props: {
  readonly label: string;
  readonly count: number;
  readonly overflow?: number;
  readonly trailing?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  const overflow = props.overflow ?? 0;
  return (
    <section className="flex flex-col gap-1.5" aria-label={props.label}>
      <SectionLabel
        as="h2"
        trailing={props.trailing}
        count={overflow > 0 ? undefined : props.count}
        className="px-1"
      >
        {props.label}
        {overflow > 0 ? (
          <span className="ml-1.5 tabular-nums">
            {props.count}+{overflow}
          </span>
        ) : null}
      </SectionLabel>
      {props.children}
    </section>
  );
}

function FilterChips<T extends string>(props: {
  readonly label: string;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly value: T;
  readonly onChange: (next: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label={props.label}>
      {props.options.map((option) => {
        const isActive = option.value === props.value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => props.onChange(option.value)}
            className={cn(
              "inline-flex h-6 items-center rounded-full border px-2.5 text-2xs font-medium outline-none transition-colors duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring",
              isActive
                ? "border-transparent bg-accent text-foreground"
                : "border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function AllCaughtUpNote() {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border px-3 py-3 text-sm text-muted-foreground">
      <CheckCircle2Icon className="size-4 text-success" aria-hidden="true" />
      <span>You&apos;re all caught up — nothing needs your attention.</span>
    </div>
  );
}

interface QuickStartChip {
  readonly key: string;
  readonly label: string;
  readonly icon: React.ReactNode;
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
          className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border px-2.5 text-ui text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="text-faint-foreground">{chip.icon}</span>
          <span className="max-w-[24ch] truncate">{chip.label}</span>
        </button>
      ))}
    </div>
  );
}

function SmartResumeBanner(props: {
  readonly awayLabel: string;
  readonly thread: Thread;
  readonly project: Project | undefined;
  readonly onResume: () => void;
  readonly onDismiss: () => void;
}) {
  const title = props.thread.title.trim() || "Untitled thread";
  const projectName = props.project?.name ?? "Unknown project";
  return (
    <div
      role="region"
      aria-label="Resume last thread"
      className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-sm"
    >
      <HistoryIcon className="size-4 shrink-0 text-info" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-foreground">
          <span className="text-muted-foreground">Back after {props.awayLabel} —</span>{" "}
          <span className="font-medium">{title}</span>
        </p>
        <p className="mt-0.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
          {props.project ? (
            <ProjectIcon
              projectId={props.project.id}
              name={props.project.name}
              icon={props.project.icon}
              className="size-3"
            />
          ) : null}
          <span className="font-mono">{projectName}</span>
        </p>
      </div>
      <button
        type="button"
        onClick={props.onResume}
        className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-ui font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring"
      >
        Resume
        <ArrowRightIcon className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={props.onDismiss}
        aria-label="Dismiss resume banner"
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
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
  const investigationWorkflows = useStore((state) => state.investigationWorkflows);
  const createProjectBackedDraftThread = useCreateProjectBackedDraftThread();
  const pinRevision = useStore((state) => state.pinRevision ?? 0);
  const pinnedThreadIds = useMemo(() => orderedPinnedThreadIds(threads), [threads]);
  const queueSummary = useNextTurnQueueStore((state) => state.summary);
  const pausedQueueThreadIds = useMemo(
    () =>
      new Set(
        (queueSummary?.threads ?? [])
          .filter((entry) => entry.paused)
          .map((entry) => entry.threadId),
      ),
    [queueSummary],
  );

  // Session-scoped filters: not persisted across reloads on purpose.
  const [projectFilter, setProjectFilter] = useState<ProjectId | "all">("all");
  const [statusFilter, setStatusFilter] = useState<RecentStatusFilter>("all");
  const [isRecentExpanded, setIsRecentExpanded] = useState(false);
  const [isAttentionExpanded, setIsAttentionExpanded] = useState(false);
  // Sampled once on mount so "Back after X" stays stable during one visit.
  const [smartResume, setSmartResume] = useState<{ awayMs: number } | null>(null);
  const [smartResumeDismissed, setSmartResumeDismissed] = useState(false);

  const sectionRef = useRef<HTMLElement | null>(null);

  const {
    buckets,
    statusByThreadId,
    projectsById,
    mostRecentProject,
    mostRecentThread,
    quickJumpProjects,
    recentAll,
    totalVisibleThreads,
    allProjectsInRecent,
    attentionReasonByThreadId,
  } = useMemo(() => {
    // Workflow sub-threads surface through their parent workflow, not Home,
    // unless a step is blocked on the user: that one joins Needs you.
    const workflowInput = {
      threads,
      planningWorkflows,
      codeReviewWorkflows,
      investigationWorkflows,
    };
    const sorted = selectStandaloneThreadsByActivity(workflowInput);
    const workflowThreads = selectVisibleWorkflowThreads(workflowInput);
    const statusById = new Map<ThreadId, ThreadStatus>();
    for (const thread of [...sorted, ...workflowThreads]) {
      statusById.set(thread.id, resolveThreadStatusForThread(thread));
    }
    const projectMap = new Map<ProjectId, Project>();
    for (const project of projects) {
      projectMap.set(project.id, project);
    }
    const reasonByThreadId = new Map<ThreadId, string>();
    for (const thread of [...sorted, ...workflowThreads]) {
      const status = statusById.get(thread.id) ?? "none";
      const tag = resolveAttentionReasonTag(status, thread.lastInteractionAt);
      if (pausedQueueThreadIds.has(thread.id))
        reasonByThreadId.set(thread.id, QUEUE_PAUSED_REASON_TAG);
      else if (tag) reasonByThreadId.set(thread.id, tag);
    }

    const recentAllList: Thread[] = [];
    for (const thread of sorted) {
      const status = statusById.get(thread.id) ?? "none";
      if (
        !pausedQueueThreadIds.has(thread.id) &&
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
    for (const thread of recentAllList) projectIdsInRecent.add(thread.projectId);
    const projectsInRecent: Project[] = [];
    for (const projectId of projectIdsInRecent) {
      const project = projectMap.get(projectId);
      if (project) projectsInRecent.push(project);
    }
    projectsInRecent.sort((a, b) => a.name.localeCompare(b.name));

    // Top active projects for the ⌘1..⌘N quick-jump shortcuts.
    const sortedProjects = sortProjectsByActivity(
      projects,
      threads,
      planningWorkflows,
      codeReviewWorkflows,
      investigationWorkflows,
    ).slice(0, QUICK_JUMP_PROJECT_LIMIT);

    return {
      buckets: bucketThreads(sorted, statusById, pausedQueueThreadIds, workflowThreads),
      statusByThreadId: statusById,
      projectsById: projectMap,
      mostRecentProject: getMostRecentProject(
        projects,
        threads,
        planningWorkflows,
        codeReviewWorkflows,
        investigationWorkflows,
      ),
      mostRecentThread: sorted[0] ?? null,
      quickJumpProjects: sortedProjects,
      recentAll: recentAllList,
      totalVisibleThreads: sorted.length,
      allProjectsInRecent: projectsInRecent,
      attentionReasonByThreadId: reasonByThreadId,
    };
  }, [
    codeReviewWorkflows,
    investigationWorkflows,
    pausedQueueThreadIds,
    planningWorkflows,
    projects,
    threads,
  ]);

  // Pinned threads float above everything and ignore the Recent filters.
  const pinnedThreads = useMemo(() => {
    if (pinnedThreadIds.length === 0) return [] as Thread[];
    const byId = new Map<ThreadId, Thread>();
    for (const thread of threads) byId.set(thread.id, thread);
    const collected: Thread[] = [];
    for (const id of pinnedThreadIds) {
      const thread = byId.get(id);
      if (thread) collected.push(thread);
    }
    return collected;
  }, [pinnedThreadIds, threads]);

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
            return status === "none";
          });
    return filteredByStatus.filter((thread) => !pinnedIdSet.has(thread.id));
  }, [pinnedIdSet, projectFilter, recentAll, statusFilter]);

  const recentLimit = isRecentExpanded
    ? RECENT_THREADS_EXPANDED_LIMIT
    : RECENT_THREADS_DEFAULT_LIMIT;
  const visibleAttention = isAttentionExpanded
    ? buckets.attention
    : buckets.attention.slice(0, ATTENTION_LIMIT);
  const hiddenAttentionCount = buckets.attention.length - visibleAttention.length;

  const recentTruncated = filteredRecent.slice(0, recentLimit);
  const hasMoreRecent = filteredRecent.length > recentTruncated.length;

  const onSelectThread = useCallback(
    (threadId: ThreadId) => {
      void navigate({ to: "/$threadId", params: { threadId } });
    },
    [navigate],
  );

  // Deep link from a "Needs you" card: open the thread and hand focus to its
  // composer, where the plan, question and approval controls live.
  const onOpenAttentionThread = useCallback(
    (threadId: ThreadId) => {
      requestComposerFocus(threadId);
      void navigate({ to: "/$threadId", params: { threadId } });
    },
    [navigate],
  );

  const onTogglePin = useCallback(
    (threadId: ThreadId) => {
      void toggleThreadPin({ threadId, threads, expectedRevision: pinRevision }).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Failed to update pinned threads",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      });
    },
    [pinRevision, threads],
  );

  const modifierKey =
    typeof navigator !== "undefined" && isMacPlatform(navigator.platform) ? "⌘" : "Ctrl+";

  // j/k cycle through rows and cards; ⌘/Ctrl+1..N start a thread in a top
  // project. Both are ignored while typing.
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

      const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-home-row-index]"));
      if (rows.length === 0) return;

      const active = document.activeElement as HTMLElement | null;
      const currentIndex = active ? rows.findIndex((row) => row === active) : -1;
      const delta = event.key === "j" ? 1 : -1;
      const nextIndex =
        currentIndex === -1
          ? delta === 1
            ? 0
            : rows.length - 1
          : (currentIndex + delta + rows.length) % rows.length;
      const nextRow = rows[nextIndex];
      if (nextRow) {
        event.preventDefault();
        nextRow.focus();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [createProjectBackedDraftThread, quickJumpProjects]);

  // Record the visit on mount (not unmount, which is unreliable on tab close)
  // and offer a resume banner after a meaningful break.
  useEffect(() => {
    const signal = evaluateSmartResume(readLastHomeVisitAt());
    if (signal.shouldOffer) setSmartResume({ awayMs: signal.awayMs });
    writeLastHomeVisitAt();
  }, []);

  const recentGroups = useMemo(() => groupThreadsByActivity(recentTruncated), [recentTruncated]);
  const greeting = resolveGreeting();
  const defaultProjectId = resolvePrimaryNewThreadProjectId({
    activeThreadProjectId: null,
    activeDraftProjectId: null,
    mostRecentProjectId: mostRecentProject?.id ?? null,
    firstProjectId: projects[0]?.id ?? null,
  });

  // One flat index so j/k spans every section in reading order.
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
    { value: "all", label: "All projects" },
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
    // Skip "Continue" while the resume banner already offers the same thread.
    if (mostRecentThread && !smartResume) {
      const title = mostRecentThread.title.trim() || "Untitled thread";
      chips.push({
        key: "continue-last",
        label: `Continue: ${title}`,
        icon: <PlayIcon className="size-3" />,
        onClick: () => onSelectThread(mostRecentThread.id),
      });
    }
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

  // `self-start` keeps tall content from being vertically centered and
  // clipped above the scroll viewport.
  return (
    <section
      ref={sectionRef}
      aria-label="Home"
      className="mx-auto flex w-full max-w-4xl flex-col gap-8 self-start px-6 py-10 motion-safe:animate-in motion-safe:fade-in-50 motion-safe:duration-300"
    >
      <div className="flex flex-col gap-3">
        <HomeQuickStart
          greeting={greeting}
          projects={projects}
          defaultProjectId={defaultProjectId}
        />
        {quickStartChips.length > 0 ? <QuickStartChips chips={quickStartChips} /> : null}
      </div>

      {smartResume && !smartResumeDismissed && mostRecentThread ? (
        <SmartResumeBanner
          awayLabel={formatAwayDuration(smartResume.awayMs)}
          thread={mostRecentThread}
          project={projectsById.get(mostRecentThread.projectId)}
          onResume={() => onSelectThread(mostRecentThread.id)}
          onDismiss={() => setSmartResumeDismissed(true)}
        />
      ) : null}

      <div className="flex flex-col gap-8">
        {pinnedThreads.length > 0 ? (
          <Section label="Pinned" count={pinnedThreads.length}>
            <div className="flex flex-col">
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
          <Section label="Needs you" count={buckets.attention.length}>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {visibleAttention.map((thread) => (
                <HomeAttentionCard
                  key={thread.id}
                  thread={thread}
                  project={projectsById.get(thread.projectId)}
                  status={statusByThreadId.get(thread.id)}
                  reasonTag={attentionReasonByThreadId.get(thread.id)}
                  rowIndex={nextRowIndex()}
                  onOpen={onOpenAttentionThread}
                />
              ))}
            </div>
            {hiddenAttentionCount > 0 || isAttentionExpanded ? (
              <ShowMoreToggle
                expanded={isAttentionExpanded}
                hiddenCount={hiddenAttentionCount}
                onToggle={() => setIsAttentionExpanded((prev) => !prev)}
              />
            ) : null}
          </Section>
        ) : totalVisibleThreads > 0 ? (
          <Section label="Needs you" count={0}>
            <AllCaughtUpNote />
          </Section>
        ) : null}

        {buckets.working.length > 0 ? (
          <Section
            label="Working"
            count={buckets.working.length}
            overflow={buckets.workingOverflow}
          >
            <div className="flex flex-col">
              {buckets.working.map((thread) => (
                <HomeThreadRow
                  key={thread.id}
                  thread={thread}
                  project={projectsById.get(thread.projectId)}
                  onSelect={onSelectThread}
                  rowIndex={nextRowIndex()}
                  isPinned={pinnedIdSet.has(thread.id)}
                  onTogglePin={onTogglePin}
                  urgencyStatus={statusByThreadId.get(thread.id)}
                />
              ))}
            </div>
          </Section>
        ) : null}

        {recentAll.length > 0 ? (
          <Section label="Recent" count={filteredRecent.length}>
            <div className="flex flex-col gap-3">
              {allProjectsInRecent.length > 1 || recentAll.length > 3 ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-1">
                  {allProjectsInRecent.length > 1 ? (
                    <FilterChips
                      label="Filter by project"
                      options={projectFilterOptions}
                      value={projectFilter}
                      onChange={setProjectFilter}
                    />
                  ) : null}
                  {recentAll.length > 3 ? (
                    <FilterChips
                      label="Filter by status"
                      options={statusFilterOptions}
                      value={statusFilter}
                      onChange={setStatusFilter}
                    />
                  ) : null}
                </div>
              ) : null}
              {filteredRecent.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                  No threads match the current filters.
                </p>
              ) : (
                <>
                  {recentGroups.map((group) => (
                    <div key={group.bucket} className="flex flex-col">
                      <SectionLabel as="h3" className="px-2.5">
                        {group.label}
                      </SectionLabel>
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
                  ))}
                  {hasMoreRecent || isRecentExpanded ? (
                    <ShowMoreToggle
                      expanded={isRecentExpanded}
                      hiddenCount={filteredRecent.length - recentTruncated.length}
                      onToggle={() => setIsRecentExpanded((prev) => !prev)}
                    />
                  ) : null}
                </>
              )}
            </div>
          </Section>
        ) : null}
      </div>

      <p className="flex flex-wrap items-center gap-1 border-t border-border pt-4 text-ui text-muted-foreground">
        Tip: press <Kbd>{modifierKey}K</Kbd> to search commands, <Kbd>j</Kbd>/<Kbd>k</Kbd> to move
        between threads
        {quickJumpProjects.length > 0 ? (
          <>
            , or <Kbd>{modifierKey}1</Kbd>–
            <Kbd>
              {modifierKey}
              {quickJumpProjects.length}
            </Kbd>{" "}
            to start a thread in a top project
          </>
        ) : null}
        .
      </p>
    </section>
  );
}
