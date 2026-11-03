import type { ProjectId, ThreadId } from "@t3tools/contracts";
import {
  type ThreadStatusPill,
  hasUnseenCompletion,
  resolveThreadStatusPill,
} from "../threadStatus";
import { cn } from "../lib/utils";
import {
  composerDraftPreview,
  hasSendableComposerDraftContent,
  type ComposerDraftPreviewInput,
} from "../composerDraftStore";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export type SidebarNewThreadEnvMode = "local" | "worktree";
/** Per-project lists whose "Show more" / "N older" expansion the sidebar remembers. */
export type SidebarThreadBucket = "active" | "archived" | "older" | "snoozed" | "settled";

export function resolveSidebarComposerDraftPreview(
  draft: ComposerDraftPreviewInput | null | undefined,
): string | null {
  return draft && hasSendableComposerDraftContent(draft) ? composerDraftPreview(draft) : null;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

export function isTrailingDoubleClick(detail: number): boolean {
  return detail > 1;
}

export function shouldStartThreadRowRenameOnDoubleClick(input: {
  isDraft: boolean;
  isRenaming: boolean;
  hasModifierKey: boolean;
  target: HTMLElement | null;
}): boolean {
  if (input.isDraft || input.isRenaming || input.hasModifierKey) {
    return false;
  }

  return !input.target?.closest("button, a, input, textarea, select");
}

export function resolveSidebarNewThreadEnvMode(input: {
  requestedEnvMode?: SidebarNewThreadEnvMode;
  defaultEnvMode: SidebarNewThreadEnvMode;
}): SidebarNewThreadEnvMode {
  return input.requestedEnvMode ?? input.defaultEnvMode;
}

export function resolveSidebarNewThreadIntent(input: {
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}): {
  readonly forceNonDefaultEnvMode: boolean;
  readonly openInNewWindow: boolean;
} {
  return {
    forceNonDefaultEnvMode: input.shiftKey,
    openInNewWindow: input.shiftKey && (input.metaKey || input.ctrlKey),
  };
}

/**
 * Project targeted by global "new thread" / "new workflow" commands: the
 * project of the open thread or draft, else the most recently active project,
 * else the first project.
 */
export function resolvePrimaryNewThreadProjectId(input: {
  readonly projects?: ReadonlyArray<{ readonly id: ProjectId }>;
  readonly activeThreadProjectId: ProjectId | null | undefined;
  readonly activeDraftProjectId: ProjectId | null | undefined;
  readonly mostRecentProjectId: ProjectId | null;
  readonly firstProjectId: ProjectId | null;
}): ProjectId | null {
  return (
    [
      input.activeThreadProjectId,
      input.activeDraftProjectId,
      input.mostRecentProjectId,
      input.firstProjectId,
    ].find(
      (id): id is ProjectId =>
        id != null &&
        (input.projects === undefined || input.projects.some((project) => project.id === id)),
    ) ?? null
  );
}

export function reconcileFrozenOrder<T, Key extends string>(input: {
  items: readonly T[];
  getKey: (item: T) => Key;
  frozenOrder?: readonly Key[] | null | undefined;
  prependUnseenKeys?: readonly Key[];
}): T[] {
  const { items, getKey, frozenOrder, prependUnseenKeys = [] } = input;
  if (!frozenOrder) {
    return [...items];
  }

  const itemByKey = new Map(items.map((item) => [getKey(item), item] as const));
  const frozenKeySet = new Set(frozenOrder);
  const ordered: T[] = [];
  const seen = new Set<Key>();

  for (const key of prependUnseenKeys) {
    if (seen.has(key) || frozenKeySet.has(key)) {
      continue;
    }
    const item = itemByKey.get(key);
    if (!item) {
      continue;
    }
    ordered.push(item);
    seen.add(key);
  }

  for (const key of frozenOrder) {
    if (seen.has(key)) {
      continue;
    }
    const item = itemByKey.get(key);
    if (!item) {
      continue;
    }
    ordered.push(item);
    seen.add(key);
  }

  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) {
      continue;
    }
    ordered.push(item);
    seen.add(key);
  }

  return ordered;
}

/**
 * Whether a workflow row lists its threads: the user's toggle, else open while it holds the
 * open thread, else collapsed once the workflow completed, else the expand-by-default setting.
 */
export function resolveWorkflowThreadListExpanded(input: {
  overrideExpanded?: boolean | undefined;
  expandByDefault: boolean;
  activeThreadId: ThreadId | null;
  workflowThreadIds: readonly ThreadId[];
  overallState?: "error" | "active" | "completed" | "pending" | undefined;
}): boolean {
  if (typeof input.overrideExpanded === "boolean") {
    return input.overrideExpanded;
  }

  if (input.activeThreadId !== null && input.workflowThreadIds.includes(input.activeThreadId)) {
    return true;
  }

  if (input.overallState === "completed") return false;

  return input.expandByDefault;
}

export function toggleWorkflowThreadListExpansion(input: {
  workflowId: string;
  workflowExpandedById: Readonly<Record<string, boolean>>;
  fallbackExpanded: boolean;
}): Record<string, boolean> {
  const currentExpanded = input.workflowExpandedById[input.workflowId] ?? input.fallbackExpanded;
  const nextExpanded = !currentExpanded;

  if (nextExpanded === input.fallbackExpanded) {
    if (!(input.workflowId in input.workflowExpandedById)) {
      return input.workflowExpandedById;
    }

    const { [input.workflowId]: _removed, ...remaining } = input.workflowExpandedById;
    return remaining;
  }

  return {
    ...input.workflowExpandedById,
    [input.workflowId]: nextExpanded,
  };
}

/**
 * One level of the sidebar tree (a project's threads and workflows, a
 * workflow's threads): indented under the parent row's 16px icon, whose centre
 * sits 16px in (8px row padding + 8px), with a hairline guide on that centre.
 */
export const SIDEBAR_TREE_LEVEL_CLASS_NAME =
  "my-0 ms-4 me-0 translate-x-0 gap-px border-l border-sidebar-border ps-0 pe-0 py-px";

/** 2px primary bar on the leading edge of the active row. */
export const SIDEBAR_ACTIVE_ROW_BAR_CLASS_NAME =
  "before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-primary";

/**
 * Sidebar row recipe: 32px, `text-ui`, focus ring. Active rows get `bg-accent`
 * and the primary bar; selected rows a primary tint; unread rows are
 * `font-medium text-foreground`.
 */
export function resolveThreadRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
  isUnread?: boolean | undefined;
}): string {
  const baseClassName =
    "relative h-8 w-full translate-x-0 cursor-pointer justify-start gap-2 rounded-lg px-2 text-left text-ui select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

  if (input.isSelected && input.isActive) {
    return cn(
      baseClassName,
      SIDEBAR_ACTIVE_ROW_BAR_CLASS_NAME,
      "bg-primary/15 font-medium text-foreground hover:bg-primary/20 hover:text-foreground dark:bg-primary/22 dark:hover:bg-primary/28",
    );
  }

  if (input.isSelected) {
    return cn(
      baseClassName,
      "bg-primary/10 text-foreground hover:bg-primary/15 hover:text-foreground dark:bg-primary/16 dark:hover:bg-primary/22",
    );
  }

  if (input.isActive) {
    return cn(
      baseClassName,
      SIDEBAR_ACTIVE_ROW_BAR_CLASS_NAME,
      "bg-sidebar-accent font-medium text-foreground hover:bg-sidebar-accent hover:text-foreground",
    );
  }

  return cn(
    baseClassName,
    input.isUnread ? "font-medium text-foreground" : "text-muted-foreground",
    "hover:bg-accent/60 hover:text-foreground",
  );
}

export function threadBucketExpansionKey(
  projectId: ProjectId,
  bucket: SidebarThreadBucket,
): string {
  return `${projectId}:${bucket}`;
}

export function getVisibleSidebarThreadIds(
  threadIds: readonly ThreadId[],
  expanded: boolean,
  previewLimit: number,
): readonly ThreadId[] {
  if (expanded || threadIds.length <= previewLimit) {
    return threadIds;
  }
  return threadIds.slice(0, previewLimit);
}

export function buildRenderedProjectThreadIds(input: {
  readonly activeThreadIds: readonly ThreadId[];
  readonly archivedThreadIds: readonly ThreadId[];
  readonly activeExpanded: boolean;
  readonly archivedExpanded: boolean;
  readonly previewLimit: number;
}): readonly ThreadId[] {
  return [
    ...getVisibleSidebarThreadIds(input.activeThreadIds, input.activeExpanded, input.previewLimit),
    ...getVisibleSidebarThreadIds(
      input.archivedThreadIds,
      input.archivedExpanded,
      input.previewLimit,
    ),
  ];
}

/** A nav badge count: exact below 1000, then one decimal of thousands ("2.2k", "15k"). */
export function formatCompactCount(count: number): string {
  if (count < 1000) return String(count);
  const thousands = count / 1000;
  const rounded = thousands < 10 ? Math.floor(thousands * 10) / 10 : Math.floor(thousands);
  return `${String(rounded)}k`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Splits items into recent ones and those idle longer than `days`, keeping each side in input
 * order. Exempt keys and items without a parseable activity time stay recent; `days` 0 is off.
 */
export function partitionAgedSidebarItems<T>(
  items: readonly T[],
  now: number,
  days: number,
  exemptKeys: ReadonlySet<string>,
  accessors: {
    readonly getKey: (item: T) => string;
    readonly getActivityAt: (item: T) => string | null | undefined;
  },
): { readonly recent: T[]; readonly older: T[] } {
  if (days <= 0) return { recent: [...items], older: [] };
  const cutoff = now - days * DAY_MS;
  const recent: T[] = [];
  const older: T[] = [];
  for (const item of items) {
    const activityAt = accessors.getActivityAt(item);
    const activityMs = activityAt ? Date.parse(activityAt) : Number.NaN;
    if (
      !exemptKeys.has(accessors.getKey(item)) &&
      Number.isFinite(activityMs) &&
      activityMs < cutoff
    )
      older.push(item);
    else recent.push(item);
  }
  return { recent, older };
}

/** The quiet lists a project's shelf row holds, in the row's order. */
export const SIDEBAR_SHELF_BUCKETS = ["scheduled", "snoozed", "settled", "archived"] as const;
export type SidebarShelfBucket = (typeof SIDEBAR_SHELF_BUCKETS)[number];

/** The shelf bucket that lists a thread, or null when the thread is not on the shelf. */
export function findShelfBucketForThread(
  lists: {
    readonly scheduledThreads: ReadonlyArray<{ readonly id: ThreadId }>;
    readonly snoozedThreads: ReadonlyArray<{ readonly id: ThreadId }>;
    readonly settledThreads: ReadonlyArray<{ readonly id: ThreadId }>;
    readonly archivedSidebarItems: ReadonlyArray<
      | { readonly kind: "thread"; readonly thread: { readonly id: ThreadId } }
      | { readonly kind: "workflow" }
    >;
  },
  threadId: ThreadId | null,
): SidebarShelfBucket | null {
  if (threadId === null) return null;
  if (lists.scheduledThreads.some((thread) => thread.id === threadId)) return "scheduled";
  if (lists.snoozedThreads.some((thread) => thread.id === threadId)) return "snoozed";
  if (lists.settledThreads.some((thread) => thread.id === threadId)) return "settled";
  if (
    lists.archivedSidebarItems.some((item) => item.kind === "thread" && item.thread.id === threadId)
  )
    return "archived";
  return null;
}

export interface SidebarGitTarget {
  readonly threadId: ThreadId;
  readonly branch: string | null;
  readonly archived: boolean;
  readonly cwd: string | null;
}

/**
 * Workspaces whose sidebar git status polls: those of live branch threads and
 * of the open thread. Archived rows keep a disabled observer, so they show a
 * cached status without fetching one.
 */
export function polledSidebarGitStatusCwds(
  targets: ReadonlyArray<SidebarGitTarget>,
  routeThreadId: ThreadId | null | undefined,
): ReadonlySet<string> {
  const cwds = new Set<string>();
  for (const target of targets)
    if (
      target.branch !== null &&
      target.cwd !== null &&
      (!target.archived || target.threadId === routeThreadId)
    )
      cwds.add(target.cwd);
  return cwds;
}

export { hasUnseenCompletion, resolveThreadStatusPill, type ThreadStatusPill };
