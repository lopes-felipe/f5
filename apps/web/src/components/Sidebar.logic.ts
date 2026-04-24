import type { ProjectId, ThreadId } from "@t3tools/contracts";
import {
  type ThreadStatusPill,
  hasUnseenCompletion,
  resolveThreadStatusPill,
} from "../threadStatus";
import { cn } from "../lib/utils";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export type SidebarNewThreadEnvMode = "local" | "worktree";
export type SidebarThreadBucket = "active" | "archived";

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

export function resolveSidebarNewThreadEnvMode(input: {
  requestedEnvMode?: SidebarNewThreadEnvMode;
  defaultEnvMode: SidebarNewThreadEnvMode;
}): SidebarNewThreadEnvMode {
  return input.requestedEnvMode ?? input.defaultEnvMode;
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

export function resolveWorkflowThreadListExpanded(input: {
  overrideExpanded?: boolean | undefined;
  expandByDefault: boolean;
  activeThreadId: ThreadId | null;
  workflowThreadIds: readonly ThreadId[];
}): boolean {
  if (typeof input.overrideExpanded === "boolean") {
    return input.overrideExpanded;
  }

  if (input.activeThreadId !== null && input.workflowThreadIds.includes(input.activeThreadId)) {
    return true;
  }

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

export function resolveThreadRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
}): string {
  const baseClassName =
    "h-7 w-full translate-x-0 cursor-pointer justify-start px-2 text-left select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

  if (input.isSelected && input.isActive) {
    return cn(
      baseClassName,
      "bg-primary/22 text-foreground font-medium hover:bg-primary/26 hover:text-foreground dark:bg-primary/30 dark:hover:bg-primary/36",
    );
  }

  if (input.isSelected) {
    return cn(
      baseClassName,
      "bg-primary/15 text-foreground hover:bg-primary/19 hover:text-foreground dark:bg-primary/22 dark:hover:bg-primary/28",
    );
  }

  if (input.isActive) {
    return cn(
      baseClassName,
      "bg-accent/85 text-foreground font-medium hover:bg-accent hover:text-foreground dark:bg-accent/55 dark:hover:bg-accent/70",
    );
  }

  return cn(baseClassName, "text-muted-foreground hover:bg-accent hover:text-foreground");
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

export { hasUnseenCompletion, resolveThreadStatusPill, type ThreadStatusPill };
