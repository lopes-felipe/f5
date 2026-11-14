import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { isScratchProject, withoutScratchProjects } from "@t3tools/shared/scratchProject";
import { useNavigate } from "@tanstack/react-router";
import { CheckCircle2Icon } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { requestComposerFocus } from "../../composerFocusRequestStore";
import {
  type ThreadActionMenuItem,
  useThreadActionController,
} from "../../hooks/useThreadActionController";
import { usePrHubNeedsYouCount } from "../../hooks/useSurfaceCounts";
import { resolveHomeSelection, stepHomeSelection } from "../../lib/homeQueue";
import { observeResize } from "../../lib/observeResize";
import { getMostRecentProject, getVisibleThreads } from "../../lib/threadOrdering";
import { useStore } from "../../store";
import { useThreadSummaries } from "../../threadSelectors";
import type { Project } from "../../types";
import { workflowRouteForType } from "../sidebar/sidebarLists";
import { Kbd } from "../ui/kbd";
import { Skeleton } from "../ui/skeleton";
import {
  HOME_REPLY_BOX_BY_KIND,
  type HomeItem,
  homeSettleBlocker,
  type HomeWorkflowRow,
} from "./homeItems";
import type { HomePreviewKeys } from "./HomeInlineActions";
import type { HomePreviewActions, HomePreviewHandle } from "./HomePreviewPane";
import type { HomeProjectSelection } from "./HomeProjectPickerPlaceholder";
import { HomeQueueList } from "./HomeQueueList";
import { HomeQuickStart } from "./HomeQuickStart";
import { useHomeSelectionStore } from "./homeSelectionStore";
import { HomeStatusStrip } from "./HomeStatusStrip";
import { useHomeQueue, useHomeThreadPeeks } from "./useHomeQueue";

// The preview brings the markdown renderer; Home's first paint does not need it.
const HomePreviewPane = lazy(() => import("./HomePreviewPane"));

/** Below this width the queue and the preview take turns instead of sharing the row. */
export const HOME_NARROW_WIDTH_PX = 720;

function isTypingTarget(target: HTMLElement): boolean {
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function PreviewSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 rounded-xl border border-border bg-card p-4"
    >
      <Skeleton className="h-3 w-32 rounded-full" />
      <Skeleton className="h-5 w-2/3 rounded-full" />
      <Skeleton className="mt-3 h-3 w-full rounded-full" />
      <Skeleton className="h-3 w-5/6 rounded-full" />
      <Skeleton className="h-3 w-3/4 rounded-full" />
    </div>
  );
}

function EmptyQueue(props: { readonly otherSurfacesNeedYou: boolean }) {
  return (
    <div
      data-slot="home-empty-queue"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border px-6 py-10 text-center"
    >
      <CheckCircle2Icon className="size-5 text-success" aria-hidden="true" />
      {/* Never "all caught up" while the strip above still counts work elsewhere. */}
      <p className="text-sm font-medium text-foreground">
        {props.otherSurfacesNeedYou ? "No threads need you" : "Nothing needs you"}
      </p>
      <p className="max-w-md text-ui text-muted-foreground">
        Approvals, questions, plans and finished work show up here, next to the agents that are
        still running.
      </p>
    </div>
  );
}

interface KeyHint {
  readonly keys: ReadonlyArray<string>;
  readonly label: string;
}

/**
 * The keys that act on the selected item. On an approval or a plan, Enter and D belong to
 * what the preview has on screen: `keys` says what they would do there, and is null until
 * the preview shows the item. A key that would do nothing is not listed.
 */
function keyHintsFor(item: HomeItem | null, keys: HomePreviewKeys | null): ReadonlyArray<KeyHint> {
  const thread = item?.type === "thread" ? item : null;
  const kind = thread?.kind ?? null;
  const reply = kind ? HOME_REPLY_BOX_BY_KIND[kind] : null;
  const settles =
    thread !== null &&
    homeSettleBlocker({ kind: thread.kind, pinned: thread.thread.pinnedAt != null }) === null;
  return [
    { keys: ["J", "K"], label: "move" },
    ...(kind === "approval" || kind === "plan"
      ? [
          ...(keys?.primary ? [{ keys: ["↵"], label: keys.primary }] : []),
          ...(keys?.deny ? [{ keys: ["D"], label: "deny" }] : []),
          { keys: ["O"], label: "open" },
        ]
      : [{ keys: ["↵", "O"], label: "open" }]),
    ...(reply ? [{ keys: ["R"], label: reply.label.toLowerCase() }] : []),
    ...(thread
      ? [
          ...(settles ? [{ keys: ["E"], label: "settle" }] : []),
          { keys: ["H"], label: "snooze" },
          { keys: ["P"], label: "pin" },
        ]
      : []),
    { keys: ["/"], label: "new thread" },
  ];
}

/**
 * Home: a triage queue (what needs a decision, what is ready for review, what is running,
 * what is pinned) beside the selected item's context and actions, under a quick-start bar
 * and a one-line strip for the other surfaces.
 */
export function HomeMissionControl() {
  const navigate = useNavigate();
  const projects = useStore((state) => state.projects);
  const threads = useThreadSummaries();
  const planningWorkflows = useStore((state) => state.planningWorkflows);
  const codeReviewWorkflows = useStore((state) => state.codeReviewWorkflows);
  const investigationWorkflows = useStore((state) => state.investigationWorkflows);
  const queue = useHomeQueue();
  const prsNeedingYou = usePrHubNeedsYouCount();
  const controller = useThreadActionController({ activeThreadId: null });

  const sectionRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // Set by the preview once it shows the selected item; null while it loads.
  const previewRef = useRef<HomePreviewHandle | null>(null);
  // What Enter and D do in the preview, by the item it reported them for.
  const [previewKeys, setPreviewKeys] = useState<{
    readonly itemId: string;
    readonly keys: HomePreviewKeys;
  } | null>(null);
  const onPreviewKeysChange = useCallback((itemId: string, keys: HomePreviewKeys) => {
    setPreviewKeys((current) =>
      current?.itemId === itemId &&
      current.keys.primary === keys.primary &&
      current.keys.deny === keys.deny
        ? current
        : { itemId, keys },
    );
  }, []);

  // ── Selection ──────────────────────────────────────────────────────
  // A string key, so a rebuilt queue with the same rows does not count as a change.
  const itemIdsKey = queue.items.map((item) => item.id).join("\n");
  const itemIds = useMemo(() => (itemIdsKey ? itemIdsKey.split("\n") : []), [itemIdsKey]);
  const storedSelectedId = useHomeSelectionStore((state) => state.selectedId);
  const setSelectedId = useHomeSelectionStore((state) => state.setSelectedId);
  // The ids the stored selection was last reconciled against: when its item leaves the
  // queue, here or while another page was open, the selection moves to the item that
  // followed it there.
  const reconciledIds = useHomeSelectionStore((state) => state.itemIds);
  const reconcileSelection = useHomeSelectionStore((state) => state.reconcile);
  const selectedId = resolveHomeSelection(reconciledIds, itemIds, storedSelectedId);
  useEffect(() => {
    reconcileSelection(itemIds, selectedId);
  }, [itemIds, reconcileSelection, selectedId]);
  const selectedItem = queue.items.find((item) => item.id === selectedId) ?? null;
  const selectedThread = selectedItem?.type === "thread" ? selectedItem.thread : null;

  // ── Layout ─────────────────────────────────────────────────────────
  const [narrow, setNarrow] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const measure = () => setNarrow(section.clientWidth < HOME_NARROW_WIDTH_PX);
    measure();
    return observeResize(section, measure);
  }, []);
  const showList = !narrow || !detailOpen;
  const showPreview = selectedItem !== null && (!narrow || detailOpen);

  // ── Data for the rows ──────────────────────────────────────────────
  const projectsById = useMemo(() => {
    const map = new Map<ProjectId, Project>();
    for (const project of projects) map.set(project.id, project);
    return map;
  }, [projects]);
  const peekThreadIds = useMemo(
    () => queue.items.flatMap((item) => (item.type === "thread" ? [item.thread.id] : [])),
    [queue.items],
  );
  const peeks = useHomeThreadPeeks(peekThreadIds);

  const defaultSelection = useMemo((): HomeProjectSelection => {
    const visibleProjectIds = new Set(
      getVisibleThreads(
        threads,
        planningWorkflows,
        codeReviewWorkflows,
        investigationWorkflows,
      ).map((thread) => thread.projectId),
    );
    const mostRecentProject = getMostRecentProject(
      projects.filter((project) => !isScratchProject(project) || visibleProjectIds.has(project.id)),
      threads,
      planningWorkflows,
      codeReviewWorkflows,
      investigationWorkflows,
    );
    return !mostRecentProject || isScratchProject(mostRecentProject)
      ? { kind: "none" }
      : { kind: "project", projectId: mostRecentProject.id };
  }, [codeReviewWorkflows, investigationWorkflows, planningWorkflows, projects, threads]);

  // ── Actions ────────────────────────────────────────────────────────
  const [snoozeMenu, setSnoozeMenu] = useState<{
    readonly open: boolean;
    readonly items: ReadonlyArray<ThreadActionMenuItem>;
  }>({ open: false, items: [] });

  const openThread = useCallback(
    (threadId: ThreadId) => {
      void navigate({ to: "/$threadId", params: { threadId } });
    },
    [navigate],
  );
  const openWorkflow = useCallback(
    (workflow: HomeWorkflowRow) => {
      void navigate({
        to: workflowRouteForType(workflow.entry.type),
        params: { workflowId: workflow.entry.workflow.id },
      });
    },
    [navigate],
  );
  const openItem = useCallback(
    (item: HomeItem) => {
      if (item.type === "workflow") {
        openWorkflow(item.workflow);
        return;
      }
      // A decision is answered in the composer: hand it focus, as the thread's own
      // approval, question and plan controls live there.
      if (item.group === "decision") requestComposerFocus(item.thread.id);
      openThread(item.thread.id);
    },
    [openThread, openWorkflow],
  );
  // The queue holds focus for Home's keys; while the preview stands alone, the preview does.
  const focusQueue = useCallback(() => {
    const target =
      listRef.current ??
      sectionRef.current?.querySelector<HTMLElement>('[data-slot="home-preview"]');
    target?.focus({ preventScroll: true });
  }, []);
  const closeDetail = useCallback(() => {
    setDetailOpen(false);
    // The list mounts with this update; focus it once it is there.
    requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }));
  }, []);
  const { executeAction, menuItemsForThread } = controller;
  const actions = useMemo(
    (): HomePreviewActions => ({
      openThread: (threadId) => {
        const item = queue.items.find(
          (entry) => entry.type === "thread" && entry.thread.id === threadId,
        );
        if (item) openItem(item);
        else openThread(threadId);
      },
      openWorkflow,
      settle: (threadId) => void executeAction(threadId, "settle"),
      togglePin: (threadId) => {
        const pinned = threads.find((thread) => thread.id === threadId)?.pinnedAt != null;
        void executeAction(threadId, pinned ? "unpin" : "pin");
      },
      snooze: (threadId, actionId) => void executeAction(threadId, actionId),
      focusQueue,
    }),
    [executeAction, focusQueue, openItem, openThread, openWorkflow, queue.items, threads],
  );
  const setSnoozeMenuOpen = useCallback(
    (open: boolean) => {
      if (!open || !selectedThread) {
        setSnoozeMenu((current) => ({ ...current, open: false }));
        return;
      }
      // Read the options as the menu opens, so each shows the wake time it will use.
      setSnoozeMenu({
        open: true,
        items: menuItemsForThread(selectedThread).filter((entry) => entry.id.startsWith("snooze:")),
      });
    },
    [menuItemsForThread, selectedThread],
  );

  // ── Focus ──────────────────────────────────────────────────────────
  // Home's keys are handled on this section, so something in it has to hold focus. The
  // queue takes it when Home opens with focus nowhere, and again when the focused control
  // went away with its item (answered, settled) and focus fell back to the page. In the
  // narrow layout the preview replaces the queue and takes its place here too.
  const selectedKind = selectedItem?.type === "thread" ? selectedItem.kind : null;
  const hasItems = itemIds.length > 0;
  useEffect(() => {
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    focusQueue();
  }, [focusQueue, hasItems, selectedId, selectedKind, showList]);

  const select = useCallback(
    (itemId: string) => {
      setSelectedId(itemId);
      if (narrow) setDetailOpen(true);
    },
    [narrow, setSelectedId],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    const target = event.target;
    // React bubbles events out of portals: a key pressed in a menu or dialog opened from
    // here is not Home's.
    if (!(target instanceof HTMLElement) || !event.currentTarget.contains(target)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const typing = isTypingTarget(target);
    if (event.key === "Escape") {
      if (typing) {
        // Leave a text box for the queue; what was typed stays in it.
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        focusQueue();
        return;
      }
      if (!narrow || !detailOpen) return;
      event.preventDefault();
      closeDetail();
      return;
    }
    // Text boxes, and panels with keys of their own (the question form), keep their keys.
    if (typing || target.closest('[data-home-keys="ignore"]')) return;
    // The queue, or the preview only while it stands in for the queue. A click in the
    // preview beside the queue focuses it too: that is reading, and must not hand it
    // Enter (which approves or implements) or the arrow keys.
    const onQueue =
      target === listRef.current ||
      (narrow && detailOpen && target.dataset.slot === "home-preview");
    const selectedKind = selectedItem?.type === "thread" ? selectedItem.kind : null;
    const move = (delta: 1 | -1) => {
      const next = stepHomeSelection(itemIds, selectedId, delta);
      if (next === null) return;
      event.preventDefault();
      setSelectedId(next);
    };

    if (event.key === "/") {
      event.preventDefault();
      composerRef.current?.focus();
      return;
    }
    if (onQueue && !event.shiftKey) {
      // Arrow keys and Enter belong to whatever has focus; only the queue itself gives
      // them to Home.
      if (event.key === "ArrowDown") return move(1);
      if (event.key === "ArrowUp") return move(-1);
      if (event.key === "Home" && itemIds.length > 0) {
        event.preventDefault();
        setSelectedId(itemIds[0]!);
        return;
      }
      if (event.key === "End" && itemIds.length > 0) {
        event.preventDefault();
        setSelectedId(itemIds[itemIds.length - 1]!);
        return;
      }
      if (event.key === "Enter" && selectedItem) {
        event.preventDefault();
        if (narrow && !detailOpen) setDetailOpen(true);
        // Enter answers what the preview shows, so it waits for the preview: it does
        // nothing while the request or plan is still loading, and never falls back to
        // opening the thread.
        else if (selectedKind === "approval" || selectedKind === "plan") {
          previewRef.current?.primary();
        } else openItem(selectedItem);
        return;
      }
    }
    if (event.shiftKey) return;
    switch (event.key) {
      case "j":
        return move(1);
      case "k":
        return move(-1);
      case "d":
        if (selectedKind === "approval" && previewRef.current?.deny()) event.preventDefault();
        return;
      case "r":
        // Prevented, or the key would land in the box it just focused.
        if (previewRef.current?.focusReply()) event.preventDefault();
        return;
      case "o":
        if (!selectedItem) return;
        event.preventDefault();
        openItem(selectedItem);
        return;
      case "e":
        if (selectedItem?.type !== "thread") return;
        // The same rule as the Settle button, which says why.
        if (
          homeSettleBlocker({
            kind: selectedItem.kind,
            pinned: selectedItem.thread.pinnedAt != null,
          }) !== null
        )
          return;
        event.preventDefault();
        actions.settle(selectedItem.thread.id);
        return;
      case "p":
        if (!selectedThread) return;
        event.preventDefault();
        actions.togglePin(selectedThread.id);
        return;
      case "h":
        if (!selectedThread) return;
        event.preventDefault();
        // The menu hangs off the preview's Snooze button.
        if (narrow) setDetailOpen(true);
        setSnoozeMenuOpen(true);
        return;
      default:
        return;
    }
  };

  // `self-stretch` gives the section the route's height, so the queue and the preview
  // scroll on their own; `min-h` lets a short window scroll the page instead.
  return (
    <section
      ref={sectionRef}
      aria-label="Home"
      onKeyDown={onKeyDown}
      className="mx-auto flex min-h-128 w-full max-w-6xl flex-col gap-3 self-stretch px-6 py-6 motion-safe:animate-in motion-safe:fade-in-50 motion-safe:duration-300"
    >
      <HomeQuickStart
        projects={withoutScratchProjects(projects)}
        defaultSelection={defaultSelection}
        inputRef={composerRef}
      />
      <HomeStatusStrip prsNeedingYou={prsNeedingYou} />

      {hasItems ? (
        <div className="flex min-h-0 flex-1 gap-3">
          {showList ? (
            <div
              className={
                narrow
                  ? "flex min-h-0 min-w-0 flex-1 flex-col"
                  : "flex min-h-0 w-80 shrink-0 flex-col"
              }
            >
              <HomeQueueList
                queue={queue}
                selectedId={selectedId}
                projectsById={projectsById}
                peeks={peeks}
                listRef={listRef}
                onSelect={select}
                onOpenThread={actions.openThread}
                onOpenWorkflow={openWorkflow}
              />
            </div>
          ) : null}
          {showPreview && selectedItem ? (
            <Suspense fallback={<PreviewSkeleton />}>
              <HomePreviewPane
                item={selectedItem}
                project={projectsById.get(
                  selectedItem.type === "thread"
                    ? selectedItem.thread.projectId
                    : selectedItem.workflow.projectId,
                )}
                peek={selectedThread ? peeks.get(selectedThread.id) : undefined}
                actions={actions}
                handleRef={previewRef}
                onKeysChange={onPreviewKeysChange}
                holdsFocus={narrow}
                snoozeMenu={{ ...snoozeMenu, onOpenChange: setSnoozeMenuOpen }}
                onBack={narrow ? closeDetail : undefined}
              />
            </Suspense>
          ) : null}
        </div>
      ) : (
        <EmptyQueue otherSurfacesNeedYou={prsNeedingYou > 0} />
      )}

      {hasItems && !narrow ? (
        <p
          data-slot="home-key-hints"
          className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted-foreground"
        >
          {keyHintsFor(
            selectedItem,
            previewKeys !== null && previewKeys.itemId === selectedItem?.id
              ? previewKeys.keys
              : null,
          ).map((hint) => (
            <span key={hint.label} className="inline-flex items-center gap-1">
              {hint.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
              {hint.label}
            </span>
          ))}
        </p>
      ) : null}
    </section>
  );
}
