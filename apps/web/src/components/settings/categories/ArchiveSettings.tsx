import {
  type CodeReviewWorkflow,
  type CodeReviewWorkflowId,
  type InvestigationWorkflow,
  type InvestigationWorkflowId,
  type PlanningWorkflow,
  type PlanningWorkflowId,
  ThreadId,
} from "@t3tools/contracts";
import { isArchivedWorkflow } from "@t3tools/shared/workflowArchive";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  ArchiveRestoreIcon,
  ExternalLinkIcon,
  SearchIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  deleteThreadWithCleanup,
  deleteWorkflow,
  setThreadArchived,
  setWorkflowArchived,
  type WorkflowArchiveKind,
  type WorkflowArchiveId,
} from "../../../archiveActions";
import { useAppSettings } from "../../../appSettings";
import { useComposerDraftStore } from "../../../composerDraftStore";
import { isArchivedThread } from "../../../lib/threadOrdering";
import { gitRemoveWorktreeMutationOptions } from "../../../lib/gitReactQuery";
import { readNativeApi } from "../../../nativeApi";
import { useStore } from "../../../store";
import { useTerminalStateStore } from "../../../terminalStateStore";
import type { Project, Thread } from "../../../types";
import { cn } from "../../../lib/utils";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { toastManager } from "../../ui/toast";

export { ARCHIVE_SETTINGS_DESCRIPTORS } from "./ArchiveSettings.descriptors";

type ArchiveItem =
  | {
      kind: "thread";
      key: string;
      projectId: Project["id"];
      title: string;
      subtitle: string;
      sortAt: string;
      archivedAt: string;
      thread: Thread;
    }
  | {
      kind: "workflow";
      key: string;
      projectId: Project["id"];
      title: string;
      subtitle: string;
      sortAt: string;
      archivedAt: string;
      workflowType: WorkflowArchiveKind;
      workflowId: WorkflowArchiveId;
      workflow: PlanningWorkflow | CodeReviewWorkflow | InvestigationWorkflow;
    };

function workflowEntries(input: {
  planningWorkflows: ReadonlyArray<PlanningWorkflow>;
  codeReviewWorkflows: ReadonlyArray<CodeReviewWorkflow>;
  investigationWorkflows: ReadonlyArray<InvestigationWorkflow>;
}): ArchiveItem[] {
  const planning = input.planningWorkflows
    .filter((workflow) => isArchivedWorkflow(workflow))
    .map((workflow) => ({
      kind: "workflow" as const,
      key: `workflow:planning:${workflow.id}`,
      projectId: workflow.projectId,
      title: workflow.title,
      subtitle: "Planning workflow",
      sortAt: workflow.updatedAt,
      archivedAt: workflow.archivedAt ?? workflow.updatedAt,
      workflowType: "planning" as const,
      workflowId: workflow.id as PlanningWorkflowId,
      workflow,
    }));
  const codeReview = input.codeReviewWorkflows
    .filter((workflow) => isArchivedWorkflow(workflow))
    .map((workflow) => ({
      kind: "workflow" as const,
      key: `workflow:codeReview:${workflow.id}`,
      projectId: workflow.projectId,
      title: workflow.title,
      subtitle: "Code review workflow",
      sortAt: workflow.updatedAt,
      archivedAt: workflow.archivedAt ?? workflow.updatedAt,
      workflowType: "codeReview" as const,
      workflowId: workflow.id as CodeReviewWorkflowId,
      workflow,
    }));
  const investigation = input.investigationWorkflows
    .filter((workflow) => isArchivedWorkflow(workflow))
    .map((workflow) => ({
      kind: "workflow" as const,
      key: `workflow:investigation:${workflow.id}`,
      projectId: workflow.projectId,
      title: workflow.title,
      subtitle: "Investigation workflow",
      sortAt: workflow.updatedAt,
      archivedAt: workflow.archivedAt ?? workflow.updatedAt,
      workflowType: "investigation" as const,
      workflowId: workflow.id as InvestigationWorkflowId,
      workflow,
    }));
  return [...planning, ...codeReview, ...investigation];
}

function matchesSearch(item: ArchiveItem, projectName: string, query: string): boolean {
  if (query.length === 0) {
    return true;
  }
  const haystack = `${item.title} ${item.subtitle} ${projectName}`.toLocaleLowerCase();
  return haystack.includes(query);
}

function formatArchiveDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

export function ArchiveSettings() {
  const navigate = useNavigate();
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const planningWorkflows = useStore((store) => store.planningWorkflows);
  const codeReviewWorkflows = useStore((store) => store.codeReviewWorkflows);
  const investigationWorkflows = useStore((store) => store.investigationWorkflows);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearThreadDraft);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const clearTerminalState = useTerminalStateStore((store) => store.clearTerminalState);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const { settings } = useAppSettings();
  const queryClient = useQueryClient();
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));
  const [query, setQuery] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const allItems = useMemo<ArchiveItem[]>(() => {
    const archivedThreads = threads
      .filter((thread) => isArchivedThread(thread))
      .map((thread) => ({
        kind: "thread" as const,
        key: `thread:${thread.id}`,
        projectId: thread.projectId,
        title: thread.title,
        subtitle: thread.worktreePath ?? "Thread",
        sortAt: thread.lastInteractionAt,
        archivedAt: thread.archivedAt ?? thread.lastInteractionAt,
        thread,
      }));
    return [
      ...archivedThreads,
      ...workflowEntries({ planningWorkflows, codeReviewWorkflows, investigationWorkflows }),
    ].toSorted((left, right) => right.sortAt.localeCompare(left.sortAt));
  }, [codeReviewWorkflows, investigationWorkflows, planningWorkflows, threads]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredItems = useMemo(
    () =>
      allItems.filter((item) =>
        matchesSearch(
          item,
          projectById.get(item.projectId)?.name ?? "Unknown project",
          normalizedQuery,
        ),
      ),
    [allItems, normalizedQuery, projectById],
  );
  const groupedItems = useMemo(() => {
    const groups = new Map<Project["id"] | "__missing__", ArchiveItem[]>();
    for (const item of filteredItems) {
      const key = projectById.has(item.projectId) ? item.projectId : "__missing__";
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return [...groups.entries()].map(([projectId, items]) => ({
      projectId,
      projectName:
        projectId === "__missing__"
          ? "Unknown project"
          : (projectById.get(projectId)?.name ?? "Unknown project"),
      items,
    }));
  }, [filteredItems, projectById]);
  const selectedFilteredItems = filteredItems.filter((item) => selectedKeys.has(item.key));
  const allFilteredSelected =
    filteredItems.length > 0 && filteredItems.every((item) => selectedKeys.has(item.key));
  const someFilteredSelected = selectedFilteredItems.length > 0 && !allFilteredSelected;

  const setItemBusy = useCallback((keys: ReadonlyArray<string>, busy: boolean) => {
    setBusyKeys((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (busy) {
          next.add(key);
        } else {
          next.delete(key);
        }
      }
      return next;
    });
  }, []);

  const removeSelectedKeys = useCallback((keys: ReadonlyArray<string>) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const key of keys) {
        next.delete(key);
      }
      return next;
    });
  }, []);

  const deleteThread = useCallback(
    async (thread: Thread, deletedThreadIds?: ReadonlySet<ThreadId>) => {
      await deleteThreadWithCleanup({
        threadId: thread.id,
        threads,
        projects,
        activeThreadId: routeThreadId,
        deletedThreadIds,
        clearComposerDraftForThread,
        clearProjectDraftThreadById,
        clearTerminalState,
        navigateToThread: (threadId) => {
          void navigate({
            to: "/$threadId",
            params: { threadId },
            replace: true,
          });
        },
        navigateHome: () => {
          void navigate({ to: "/", replace: true });
        },
        removeWorktree: (input) => removeWorktreeMutation.mutateAsync(input),
      });
    },
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearTerminalState,
      navigate,
      projects,
      removeWorktreeMutation,
      routeThreadId,
      threads,
    ],
  );

  const restoreItems = useCallback(
    async (items: ReadonlyArray<ArchiveItem>) => {
      const keys = items.map((item) => item.key);
      setItemBusy(keys, true);
      try {
        for (const item of items) {
          if (item.kind === "thread") {
            await setThreadArchived({ threadId: item.thread.id, archived: false });
          } else {
            await setWorkflowArchived({
              workflowId: item.workflowId,
              workflowType: item.workflowType,
              archived: false,
            });
          }
        }
        removeSelectedKeys(keys);
      } finally {
        setItemBusy(keys, false);
      }
    },
    [removeSelectedKeys, setItemBusy],
  );

  const deleteItems = useCallback(
    async (items: ReadonlyArray<ArchiveItem>, confirm: boolean) => {
      const keys = items.map((item) => item.key);
      if (confirm) {
        const api = readNativeApi();
        if (!api) {
          toastManager.add({ type: "error", title: "Delete actions are unavailable." });
          return;
        }
        const threadCount = items.filter((item) => item.kind === "thread").length;
        const workflowCount = items.length - threadCount;
        const confirmed = await api.dialogs.confirm(
          [
            `Delete ${items.length} archived item${items.length === 1 ? "" : "s"}?`,
            threadCount > 0
              ? `${threadCount} thread${threadCount === 1 ? "" : "s"} will permanently lose conversation history.`
              : null,
            workflowCount > 0
              ? `${workflowCount} workflow record${workflowCount === 1 ? "" : "s"} will be removed; associated threads are kept.`
              : null,
          ]
            .filter(Boolean)
            .join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }

      const deletedThreadIds = new Set(
        items.flatMap((item) => (item.kind === "thread" ? [item.thread.id] : [])),
      );
      setItemBusy(keys, true);
      try {
        for (const item of items) {
          if (item.kind === "thread") {
            await deleteThread(item.thread, deletedThreadIds);
          } else {
            await deleteWorkflow({
              workflowId: item.workflowId,
              workflowType: item.workflowType,
              workflowTitle: item.title,
              confirm: false,
            });
          }
        }
        removeSelectedKeys(keys);
      } finally {
        setItemBusy(keys, false);
      }
    },
    [deleteThread, removeSelectedKeys, setItemBusy],
  );

  const openItem = useCallback(
    (item: ArchiveItem) => {
      if (item.kind === "thread") {
        void navigate({
          to: "/$threadId",
          params: { threadId: item.thread.id },
        });
        return;
      }
      if (item.workflowType === "planning") {
        void navigate({ to: "/workflow/$workflowId", params: { workflowId: item.workflowId } });
      } else if (item.workflowType === "codeReview") {
        void navigate({ to: "/code-review/$workflowId", params: { workflowId: item.workflowId } });
      } else {
        void navigate({
          to: "/investigation/$workflowId",
          params: { workflowId: item.workflowId },
        });
      }
    },
    [navigate],
  );

  const toggleSelectAllFiltered = useCallback(
    (selected: boolean) => {
      setSelectedKeys((current) => {
        const next = new Set(current);
        for (const item of filteredItems) {
          if (selected) {
            next.add(item.key);
          } else {
            next.delete(item.key);
          }
        }
        return next;
      });
    },
    [filteredItems],
  );

  return (
    <section
      className="rounded-2xl border border-border bg-card p-5"
      data-settings-search-target="archive.items"
    >
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-sm font-medium text-foreground">Archive</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Restore or delete archived threads and workflows. Workflow deletion removes the workflow
            record only; its threads are kept.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={selectedFilteredItems.length === 0 || bulkBusy}
            onClick={() => {
              setBulkBusy(true);
              void restoreItems(selectedFilteredItems).finally(() => setBulkBusy(false));
            }}
          >
            <ArchiveRestoreIcon />
            Restore selected
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={selectedFilteredItems.length === 0 || bulkBusy}
            onClick={() => {
              setBulkBusy(true);
              void deleteItems(selectedFilteredItems, settings.confirmThreadDelete).finally(() =>
                setBulkBusy(false),
              );
            }}
          >
            <Trash2Icon />
            Delete selected
          </Button>
        </div>
      </div>

      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search archive</span>
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search archived threads and workflows"
            className="pl-8"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={allFilteredSelected}
            indeterminate={someFilteredSelected}
            disabled={filteredItems.length === 0}
            onCheckedChange={(value) => toggleSelectAllFiltered(value === true)}
            aria-label="Select all filtered archive items"
          />
          Select all filtered ({filteredItems.length})
        </label>
      </div>

      {filteredItems.length === 0 ? (
        <div className="rounded-lg border border-border bg-background px-4 py-8 text-center">
          <p className="text-sm font-medium text-foreground">No archived items</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {allItems.length === 0
              ? "Archived threads and workflows will appear here."
              : "No archived items match the current search."}
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {groupedItems.map((group) => (
            <div key={group.projectId} className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.projectName}
                </h3>
                <span className="text-[11px] text-muted-foreground/70">
                  {group.items.length} item{group.items.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="space-y-2">
                {group.items.map((item) => {
                  const busy = busyKeys.has(item.key) || bulkBusy;
                  return (
                    <div
                      key={item.key}
                      className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2"
                    >
                      <Checkbox
                        checked={selectedKeys.has(item.key)}
                        disabled={busy}
                        onCheckedChange={(value) => {
                          setSelectedKeys((current) => {
                            const next = new Set(current);
                            if (value === true) {
                              next.add(item.key);
                            } else {
                              next.delete(item.key);
                            }
                            return next;
                          });
                        }}
                        aria-label={`Select ${item.title}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <p className="truncate text-sm font-medium text-foreground">
                            {item.title}
                          </p>
                          <Badge
                            variant="secondary"
                            size="sm"
                            className={cn(
                              "shrink-0 rounded-md px-1.5 py-0 text-[10px] uppercase",
                              item.kind === "thread"
                                ? "bg-primary/10 text-primary"
                                : "bg-blue-500/10 text-blue-400",
                            )}
                          >
                            {item.kind === "thread" ? "Thread" : "Workflow"}
                          </Badge>
                        </div>
                        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                          {item.kind === "workflow" ? <WorkflowIcon className="size-3" /> : null}
                          <span className="truncate">{item.subtitle}</span>
                          <span aria-hidden="true">·</span>
                          <span>Archived {formatArchiveDate(item.archivedAt)}</span>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => openItem(item)}
                          aria-label={`Open ${item.title}`}
                        >
                          <ExternalLinkIcon className="size-3.5" />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void restoreItems([item])}
                          aria-label={`Unarchive ${item.title}`}
                        >
                          <ArchiveRestoreIcon className="size-3.5" />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            if (item.kind === "thread") {
                              void deleteItems([item], settings.confirmThreadDelete);
                            } else {
                              void deleteWorkflow({
                                workflowId: item.workflowId,
                                workflowType: item.workflowType,
                                workflowTitle: item.title,
                              });
                            }
                          }}
                          aria-label={`Delete ${item.title}`}
                        >
                          <Trash2Icon className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
