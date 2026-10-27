import {
  UPSTREAM_MAX_PORT_TOPICS,
  type ProjectId,
  type UpstreamDecision,
  type UpstreamOverview,
  type UpstreamPortLinkSummary,
  type UpstreamResolvePublicationInput,
  type UpstreamRunKind,
  type UpstreamRunTriage,
  type UpstreamTopicRow,
  type UpstreamTopicState,
} from "@t3tools/contracts";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { resolveShortcutCommand, useServerKeybindings } from "../../keybindings";
import { formatRelativeTimeLabel } from "../../lib/relativeTime";
import { projectSettingsQueryOptions } from "../../lib/projectSettingsQuery";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import {
  hasStaleTopicPages,
  invalidateUpstreamPorts,
  upstreamOverviewQueryOptions,
  upstreamProjectsQueryOptions,
  upstreamPortsQueryKeys,
  upstreamTopicsQueryOptions,
  type UpstreamTopicFilter,
} from "../../lib/upstreamPortsReactQuery";
import { ensureNativeApi } from "../../nativeApi";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { useUpstreamShortcut } from "./UpstreamActionButton";
import { UpstreamAttention } from "./UpstreamAttention";
import { UpstreamBulkBar } from "./UpstreamBulkBar";
import {
  ConfirmDialog,
  DeclineDialog,
  SkipReasonDialog,
  StartPortDialog,
  type ConfirmRequest,
} from "./UpstreamDialogs";
import { UpstreamConfigEmptyState } from "./UpstreamConfigEmptyState";
import { UpstreamHeader } from "./UpstreamHeader";
import { UpstreamListEmpty } from "./UpstreamListEmpty";
import { UpstreamTopicDetail } from "./UpstreamTopicDetail";
import {
  UpstreamTopicList,
  UpstreamTopicListSkeleton,
  type RowPointerModifiers,
  type UpstreamRowQuickAction,
  type UpstreamTopicListHandle,
} from "./UpstreamTopicList";
import { UpstreamToolbar } from "./UpstreamToolbar";
import {
  actionTargets,
  adjacentList,
  adjustCounts,
  canMoveFocusAfterDecision,
  decisionBatches,
  extendSelection,
  filterFromSearch,
  focusAfterRemoval,
  hasActiveFilters,
  isActivationKey,
  isControlTarget,
  isDialogTarget,
  isEditableTarget,
  moveFocus,
  portableTopicIds,
  predictedState,
  preselectedSkipReason,
  promptLimitError,
  reconcileFocus,
  runDisabledReason,
  selectRange,
  startAllReady,
  toggleId,
  topicCount,
  topicStates,
  unseenNote,
  upstreamPrUrl,
  withoutFilters,
  withoutTopics,
  type UpstreamBulkAction,
  type UpstreamView,
} from "./upstreamPage.logic";
import type { UpstreamSearch } from "./upstreamSearch";

export type { UpstreamSearch };

const EMPTY_ROWS: ReadonlyArray<UpstreamTopicRow> = [];
const EMPTY_SET: ReadonlySet<string> = new Set();

function describeRun(run: UpstreamOverview["lastRun"]): string | null {
  if (!run) return null;
  const parts = [
    `${run.kind === "legacy" ? "Legacy run" : "Last run"} ${run.status}`,
    formatRelativeTimeLabel(run.finishedAt ?? run.startedAt),
    `${run.commitCount} commits`,
    `${run.inboxCount} to review`,
    `${run.autoDecidedCount} automatic`,
  ];
  if (run.remainingCount > 0) parts.push(`${run.remainingCount} remaining`);
  return parts.join(" · ");
}

function PageSkeleton() {
  return (
    <main aria-busy="true" aria-label="Loading upstream tracking" className="flex h-full min-h-0 flex-col">
      <div className="space-y-3 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Skeleton className="h-6 w-28" />
          <Skeleton className="ml-auto h-7 w-48" />
        </div>
        <Skeleton className="h-7 w-96" />
      </div>
      <div className="flex min-h-0 flex-1">
        <section className="w-1/2 min-w-80 border-r">
          <UpstreamTopicListSkeleton />
        </section>
      </div>
    </main>
  );
}

export function UpstreamPage(props: {
  readonly search: UpstreamSearch;
  readonly onSearchChange: (search: UpstreamSearch) => void;
}) {
  const queryClient = useQueryClient();
  const keybindings = useServerKeybindings();
  const shortcutsLabel = useUpstreamShortcut("help.shortcuts");
  const projectsQuery = useQuery(upstreamProjectsQueryOptions());
  const projects = projectsQuery.data?.projects ?? [];
  const projectId = props.search.project ?? projects[0]?.projectId ?? null;
  const list = props.search.list ?? "inbox";
  const sort = props.search.sort ?? null;
  // Keyed by value: the router hands back new arrays for unchanged filters.
  const filterKey = JSON.stringify(filterFromSearch(props.search));
  const filter: UpstreamTopicFilter = useMemo(() => JSON.parse(filterKey) as UpstreamTopicFilter, [filterKey]);
  const filtered = hasActiveFilters(props.search);

  const overviewQuery = useQuery({
    ...upstreamOverviewQueryOptions(projectId ?? ("" as ProjectId)),
    enabled: projectId !== null,
  });
  const overview = overviewQuery.data;
  const topicsQuery = useInfiniteQuery({
    ...upstreamTopicsQueryOptions(projectId ?? ("" as ProjectId), list, filter, sort),
    enabled: projectId !== null && Boolean(overview?.config),
  });
  const firstPage = topicsQuery.data?.pages[0];
  const serverConfig = useQuery(serverConfigQueryOptions());
  const providers = serverConfig.data?.providers ?? [];
  const projectSettings = useQuery({
    ...projectSettingsQueryOptions(projectId ?? ("" as ProjectId)),
    enabled: projectId !== null,
  });

  /** Topics leaving the list while their decision is in flight; refetches cannot bring them back meanwhile. */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(EMPTY_SET);
  const rows = useMemo(() => {
    if (!topicsQuery.data) return EMPTY_ROWS;
    const loaded = topicsQuery.data.pages.flatMap((page) => page.topics);
    return hidden.size === 0 ? loaded : loaded.filter((row) => !hidden.has(row.topic.id));
  }, [topicsQuery.data, hidden]);
  const ids = useMemo(() => rows.map((row) => row.topic.id), [rows]);

  useEffect(() => {
    if (projectId && hasStaleTopicPages(topicsQuery.data))
      void queryClient.resetQueries({ queryKey: upstreamPortsQueryKeys.topics(projectId, list, filter, sort) });
  }, [topicsQuery.data, projectId, list, filter, sort, queryClient]);

  const [selected, setSelected] = useState<ReadonlySet<string>>(EMPTY_SET);
  /**
   * Set after "Select all matching": the selection then reaches past the loaded
   * rows, so actions use it whole. It is only valid for the revision it was read
   * at. A null revision marks the topics a partly failed decision left behind:
   * the user picked them explicitly, so they stay selected for a retry.
   */
  const [matching, setMatching] = useState<{ readonly revision: string | null } | null>(null);
  /** Bumped whenever the selection is reset, so a late "Select all matching" response is dropped. */
  const selectionEpoch = useRef(0);
  /** The view a selection belongs to; set while rendering, before the effect that clears the selection. */
  const scopeRef = useRef("");
  scopeRef.current = JSON.stringify([projectId, list, filterKey, sort]);
  const [selectingAll, setSelectingAll] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  /** Topics with a decision in flight: dimmed, and skipped by further actions. */
  const [pending, setPending] = useState<ReadonlySet<string>>(EMPTY_SET);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  /** Runs, publication, Start port and the other non-decision actions in flight; a count, since they can overlap. */
  const [busyCount, setBusyCount] = useState(0);
  const busy = busyCount > 0;
  const [skipDialog, setSkipDialog] = useState<{ ids: string[]; preselected: string | null; reason?: string } | null>(null);
  const [declineIds, setDeclineIds] = useState<string[] | null>(null);
  const [portRequest, setPortRequest] = useState<{ ids: string[]; note: string | null } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const listRef = useRef<UpstreamTopicListHandle | null>(null);
  const lastIndex = useRef(0);
  /** The range anchor for Shift-click: the last row toggled or clicked. */
  const anchorRef = useRef<string | null>(null);

  const focused = props.search.topic ?? null;
  const { onSearchChange, search } = props;
  // The latest view, for async actions that finish after the user has moved on.
  const searchRef = useRef(search);
  const viewRef = useRef<UpstreamView>({ projectId, list, focused });
  useLayoutEffect(() => {
    searchRef.current = search;
    viewRef.current = { projectId, list, focused };
  });
  /**
   * A topic opened through a related-topic link. It may sit past the loaded
   * pages, so focus reconciliation leaves it alone until the user moves on.
   */
  const requestedRef = useRef<string | null>(null);
  const setFocused = useCallback(
    (topic: string | null) => {
      requestedRef.current = null;
      const { topic: _previous, ...rest } = searchRef.current;
      onSearchChange(topic ? { ...rest, topic } : rest);
    },
    [onSearchChange],
  );
  const openTopic = (topicId: string, state: UpstreamTopicState) => {
    if (!projectId) return;
    requestedRef.current = topicId;
    onSearchChange({ project: projectId, list: state, topic: topicId });
  };

  useEffect(() => {
    if (topicsQuery.isPending) return;
    if (focused !== null && focused === requestedRef.current) return;
    const next = reconcileFocus(ids, focused, lastIndex.current);
    if (next !== focused && (next !== null || focused !== null)) setFocused(next);
    if (next) lastIndex.current = ids.indexOf(next);
  }, [ids, focused, setFocused, topicsQuery.isPending]);

  /** Replaces the selection with loaded rows only. */
  const selectLoaded = useCallback((next: ReadonlySet<string>) => {
    selectionEpoch.current += 1;
    setSelected(next);
    setMatching(null);
  }, []);
  const clearSelection = useCallback(() => {
    selectLoaded(EMPTY_SET);
    anchorRef.current = null;
  }, [selectLoaded]);
  // A filter or sort change can hide selected topics, so it clears the selection too.
  useEffect(clearSelection, [projectId, list, filterKey, sort, clearSelection]);
  // "All matching" was read at one revision; once the list changes it may no longer match.
  // Decisions in flight move the revision themselves, and settle the selection when they end.
  const revision = firstPage?.revision ?? null;
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  useEffect(() => {
    if (matching?.revision && pending.size === 0 && revision !== null && revision !== matching.revision)
      clearSelection();
  }, [matching, revision, pending, clearSelection]);

  const readOnly = overview ? !overview.writer.managedByThisProfile && overview.writer.claimed : false;
  /**
   * Selected visible topics in list order (every selected topic after "Select all
   * matching"), else the focused row; topics with a decision in flight are left out.
   */
  const targets = useCallback(
    () =>
      (matching ? [...selected] : actionTargets(ids, selected, focused)).filter(
        (id) => !pendingRef.current.has(id),
      ),
    [matching, selected, ids, focused],
  );
  const selectedVisible = useMemo(() => new Set(ids.filter((id) => selected.has(id))), [ids, selected]);
  const stateOf = useMemo(() => topicStates(rows, list), [rows, list]);
  const loadedIds = useMemo(() => new Set(ids), [ids]);
  const unloadedCount = (topicIds: ReadonlyArray<string>) => topicIds.filter((id) => !loadedIds.has(id)).length;
  const total = firstPage?.total ?? (overview ? overview.counts[list] : 0);

  const selectAllMatching = async () => {
    if (!projectId) return;
    // A list, filter or sort change resets the selection and bumps the epoch, so this drops a late answer.
    const epoch = selectionEpoch.current;
    const scope = scopeRef.current;
    const current = () => selectionEpoch.current === epoch && scopeRef.current === scope;
    setSelectingAll(true);
    try {
      const result = await ensureNativeApi().upstreamPorts.listTopicIds({
        projectId,
        list,
        ...(filtered ? { filter } : {}),
        ...(sort ? { sort } : {}),
      });
      if (!current()) return;
      // The loaded pages may predate the ledger; reload them so the selection is not dropped as stale at once.
      if (result.revision !== revisionRef.current) {
        const refreshed = await topicsQuery.refetch();
        if (!current()) return;
        if (refreshed.data?.pages[0]?.revision !== result.revision) {
          toastManager.add({ type: "info", title: "The list changed while selecting. Try again." });
          return;
        }
      }
      selectionEpoch.current += 1;
      setSelected(new Set(result.topicIds));
      setMatching({ revision: result.revision });
      if (result.truncated)
        toastManager.add({ type: "warning", title: `Only the first ${result.topicIds.length.toLocaleString()} topics were selected.` });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not select every matching topic",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSelectingAll(false);
    }
  };

  const withBusy = async <T,>(title: string, action: () => Promise<T>): Promise<T | undefined> => {
    setBusyCount((count) => count + 1);
    try {
      return await action();
    } catch (error) {
      toastManager.add({ type: "error", title, description: error instanceof Error ? error.message : String(error) });
      return undefined;
    } finally {
      setBusyCount((count) => count - 1);
    }
  };

  const toggleIds = (current: ReadonlySet<string>, topicIds: Iterable<string>, on: boolean) => {
    const next = new Set(current);
    for (const id of topicIds) {
      if (on) next.add(id);
      else next.delete(id);
    }
    return next;
  };
  const setPendingIds = (topicIds: Iterable<string>, on: boolean) =>
    setPending((current) => toggleIds(current, topicIds, on));
  const setHiddenIds = (topicIds: Iterable<string>, on: boolean) =>
    setHidden((current) => toggleIds(current, topicIds, on));

  const adjustOverviewCounts = (forProject: ProjectId, moves: Parameters<typeof adjustCounts>[1]) =>
    queryClient.setQueryData<UpstreamOverview>(upstreamPortsQueryKeys.overview(forProject), (current) =>
      current ? { ...current, counts: adjustCounts(current.counts, moves) } : current,
    );

  /**
   * Records a decision. Rows that leave the list are hidden at once and the
   * counts move with them. Only topics the server recorded are dropped from
   * the cache; the rest reappear when the call fails, without relying on the
   * refetch, which fails too when the connection is gone.
   */
  const applyDecision = async (topicIds: ReadonlyArray<string>, decision: UpstreamDecision | "accept") => {
    if (!projectId) return;
    const decided = topicIds.filter((id) => !pendingRef.current.has(id));
    if (decided.length === 0) return;
    const order = ids;
    const started = viewRef.current;
    const decidedSet = new Set(decided);
    const allMatching = matching !== null && [...selected].every((id) => decidedSet.has(id) || pendingRef.current.has(id));
    const epoch = selectionEpoch.current;
    const rowsById = new Map(rows.map((row) => [row.topic.id, row]));
    const moves = decided.flatMap((id) => {
      const row = rowsById.get(id);
      const to = row ? predictedState(row, decision) : null;
      return row && to ? [{ id, from: row.state, to }] : [];
    });
    const leaving = new Set(moves.map((move) => move.id));

    setPendingIds(decided, true);
    if (leaving.size > 0) {
      setHiddenIds(leaving, true);
      adjustOverviewCounts(projectId, moves);
      setSelected((current) => new Set([...current].filter((id) => !leaving.has(id))));
      if (canMoveFocusAfterDecision(started, viewRef.current) && started.focused && leaving.has(started.focused))
        setFocused(focusAfterRemoval(order, leaving, started.focused));
    }

    const recorded = new Set<string>();
    /** Recorded, or answered unchanged: either way not worth sending again. */
    const settled = new Set<string>();
    let unchanged = 0;
    let failure: unknown = null;
    try {
      // The server takes a bounded number of topics per call; earlier batches stay recorded if a later one fails.
      for (const batch of decisionBatches(decided)) {
        const result = await (decision === "accept"
          ? ensureNativeApi().upstreamPorts.acceptSuggestions({ projectId, topicIds: batch as never })
          : ensureNativeApi().upstreamPorts.decide({ projectId, topicIds: batch as never, decision }));
        for (const id of result.updated) recorded.add(id);
        for (const id of [...result.updated, ...result.unchanged]) settled.add(id);
        unchanged += result.unchanged.length;
      }
    } catch (error) {
      failure = error;
    } finally {
      const recordedLeaving = new Set([...leaving].filter((id) => recorded.has(id)));
      if (recordedLeaving.size > 0)
        queryClient.setQueriesData<Parameters<typeof withoutTopics>[0]>(
          { queryKey: upstreamPortsQueryKeys.list(projectId, started.list) },
          (data) => withoutTopics(data, recordedLeaving),
        );
      const reverted = moves.filter((move) => !recorded.has(move.id));
      if (reverted.length > 0)
        adjustOverviewCounts(
          projectId,
          reverted.map((move) => ({ from: move.to, to: move.from })),
        );
      setHiddenIds(leaving, false);
      setPendingIds(decided, false);
    }
    const stillHere = viewRef.current.projectId === started.projectId && viewRef.current.list === started.list;
    // Topics the user did not get a decision for; on failure they stay selected for a retry.
    const retry = failure !== null && decided.length > 1 ? decided.filter((id) => !settled.has(id)) : [];
    if (failure !== null) {
      const detail = failure instanceof Error ? failure.message : String(failure);
      toastManager.add({
        type: "error",
        title: "Decision failed",
        description: recorded.size > 0 ? `${recorded.size} of ${decided.length} topics were recorded. ${detail}` : detail,
      });
    }
    if (stillHere && selectionEpoch.current === epoch) {
      if (allMatching) {
        // The decision covered the whole "all matching" selection: what is left is only what to retry.
        if (retry.length === 0) clearSelection();
        else {
          setSelected(new Set(retry));
          setMatching({ revision: null });
        }
      } else
        setSelected((current) => {
          const next = new Set([...current, ...retry]);
          for (const id of settled) next.delete(id);
          return next;
        });
    }
    if (unchanged > 0 && decision === "accept")
      toastManager.add({ type: "info", title: `${unchanged} topic(s) had no suggestion to accept` });
    await invalidateUpstreamPorts(queryClient);
    // Return to the list for the next decision, unless the user moved on or is typing.
    if (stillHere && !isEditableTarget(document.activeElement) && !isDialogTarget(document.activeElement))
      listRef.current?.focus();
  };

  const openSkip = (topicIds: string[], reason?: string) => {
    if (topicIds.length === 0) return;
    const first = rows.find((row) => row.topic.id === topicIds[0]);
    setSkipDialog({ ids: topicIds, preselected: first ? preselectedSkipReason(first.topic) : null, ...(reason ? { reason } : {}) });
  };

  const runNow = (kind: UpstreamRunKind, triage: UpstreamRunTriage) => {
    if (!projectId) return;
    void withBusy("Could not start the run", async () => {
      await ensureNativeApi().upstreamPorts.run({ projectId, kind, triage });
      await invalidateUpstreamPorts(queryClient);
    });
  };

  const resolvePublicationNow = (action: UpstreamResolvePublicationInput["action"]) => {
    if (!projectId) return;
    void withBusy("Publication action failed", async () => {
      await ensureNativeApi().upstreamPorts.resolvePublication({ projectId, action });
      await invalidateUpstreamPorts(queryClient);
    });
  };

  const resolvePublication = (action: UpstreamResolvePublicationInput["action"]) => {
    if (action !== "discard") {
      resolvePublicationNow(action);
      return;
    }
    const count = overview?.publication.unpublishedOps ?? 0;
    setConfirm({
      title: `Discard ${count} unpublished change${count === 1 ? "" : "s"}?`,
      description:
        "These triage decisions were never published to the ledger and cannot be recovered. An open ledger pull request is closed.",
      confirmLabel: "Discard",
      onConfirm: () => resolvePublicationNow(action),
    });
  };

  const takeOver = () => {
    if (!projectId || !overview) return;
    setConfirm({
      title: "Take over this repository?",
      description: `Profile ${overview.writer.profileId ?? "unknown"} stops managing upstream tracking here. Changes it recorded but has not published will not be published.`,
      confirmLabel: "Take over",
      onConfirm: () =>
        void withBusy("Could not take over", async () => {
          await ensureNativeApi().upstreamPorts.takeOverWriter({ projectId });
          await invalidateUpstreamPorts(queryClient);
        }),
    });
  };

  const addRemote = () => {
    if (!projectId) return;
    void withBusy("Could not add the remote", async () => {
      await ensureNativeApi().upstreamPorts.addRemote({ projectId });
      await invalidateUpstreamPorts(queryClient);
    });
  };

  const copyPrompt = (topicIds: string[]) => {
    if (!projectId) return;
    const limit = promptLimitError(topicIds.length);
    if (limit) {
      toastManager.add({ type: "warning", title: limit });
      return;
    }
    void withBusy("Could not copy the port prompt", async () => {
      const { prompt } = await ensureNativeApi().upstreamPorts.getPortPrompt({ projectId, topicIds: topicIds as never });
      await writeTextToClipboard(prompt);
      toastManager.add({ type: "success", title: "Port prompt copied" });
    });
  };

  /** Opens Start port for the Ready and In progress targets; the dialog enforces the count limits. */
  const openStartPort = (topicIds: string[], note: string | null = null) => {
    const portable = portableTopicIds(stateOf, topicIds);
    if (portable.length === 0) {
      toastManager.add({ type: "warning", title: "Only Ready or In progress topics can be ported." });
      return;
    }
    if (portable.length < topicIds.length)
      toastManager.add({
        type: "info",
        title: `${topicIds.length - portable.length} selected topic(s) are not Ready or In progress and were left out.`,
      });
    setPortRequest({ ids: portable, note });
  };

  const unlink = (link: UpstreamPortLinkSummary) => {
    if (!projectId || !focused) return;
    const topicId = focused;
    setConfirm({
      title: "Unlink this port thread?",
      description:
        "The thread keeps running, but it no longer counts as this topic's port, so the topic moves back to Ready.",
      confirmLabel: "Unlink",
      onConfirm: () =>
        void withBusy("Could not unlink", async () => {
          await ensureNativeApi().upstreamPorts.unlinkPort({ projectId, topicId: topicId as never, threadId: link.threadId });
          await invalidateUpstreamPorts(queryClient);
        }),
    });
  };

  const changeList = (next: UpstreamTopicState) => {
    if (projectId) onSearchChange({ project: projectId, list: next });
  };

  /** Reopening bumps the epoch, so running port threads stop counting; ask first when any is In progress. */
  const reopen = (topicIds: string[]) => {
    const inProgress = topicIds.filter((id) => stateOf(id) === "in-progress").length;
    const unseen = unloadedCount(topicIds);
    if (inProgress === 0 && unseen === 0) {
      void applyDecision(topicIds, { kind: "inbox" });
      return;
    }
    setConfirm({
      title: `Reopen ${topicCount(topicIds.length)}?`,
      description: [
        inProgress > 0
          ? `${inProgress.toLocaleString()} ${inProgress === 1 ? "has a port thread" : "have port threads"} in progress. The threads keep running, but they no longer count as these topics' ports.`
          : null,
        unseen > 0 ? unseenNote(unseen) : null,
      ]
        .filter(Boolean)
        .join(" "),
      confirmLabel: "Reopen",
      onConfirm: () => void applyDecision(topicIds, { kind: "inbox" }),
    });
  };

  /** One-key decisions reach every topic of "Select all matching"; ask first when that goes past the loaded rows. */
  const decideSeen = (topicIds: string[], decision: UpstreamDecision | "accept", title: string, confirmLabel: string) => {
    const unseen = unloadedCount(topicIds);
    if (unseen === 0) {
      void applyDecision(topicIds, decision);
      return;
    }
    setConfirm({
      title,
      description: unseenNote(unseen),
      confirmLabel,
      onConfirm: () => void applyDecision(topicIds, decision),
    });
  };

  const runBulkAction = (action: UpstreamBulkAction, topicIds: string[]) => {
    if (topicIds.length === 0) return;
    const count = topicCount(topicIds.length);
    switch (action) {
      case "accept":
        return decideSeen(topicIds, "accept", `Accept the suggestions for ${count}?`, "Accept");
      case "port":
        return decideSeen(topicIds, { kind: "port" }, `Mark ${count} ready to port?`, "Mark ready");
      case "skip":
        return openSkip(topicIds);
      case "watch":
        return decideSeen(topicIds, { kind: "watch" }, `Watch ${count}?`, "Watch");
      case "decline":
        return setDeclineIds(topicIds);
      case "equivalent":
        return decideSeen(topicIds, { kind: "equivalent" }, `Mark ${count} as already in f5?`, "Already in f5");
      case "reopen":
        return reopen(topicIds);
      case "startPort":
        return openStartPort(topicIds);
      case "copyPrompt":
        return copyPrompt(topicIds);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    // Let a focused button, link or checkbox in the header or empty state activate itself.
    if (isActivationKey(event.key) && isControlTarget(event.target)) return;
    const command = resolveShortcutCommand(event.nativeEvent, keybindings, {
      context: {
        upstreamListFocus: true,
        editableFocus: isEditableTarget(event.target),
        dialogFocus: isDialogTarget(event.target),
      },
    });
    if (!command?.startsWith("upstream.")) return;
    event.preventDefault();
    const focusedRow = rows.find((row) => row.topic.id === focused);
    const canDecide = !readOnly;
    switch (command) {
      case "upstream.next":
      case "upstream.previous": {
        const next = moveFocus(ids, focused, command === "upstream.next" ? 1 : -1);
        if (next) {
          lastIndex.current = ids.indexOf(next);
          setFocused(next);
        }
        if (command === "upstream.next" && topicsQuery.hasNextPage && ids.indexOf(next ?? "") > ids.length - 5)
          void topicsQuery.fetchNextPage();
        return;
      }
      case "upstream.extendNext":
      case "upstream.extendPrevious": {
        const result = extendSelection(ids, selected, focused, command === "upstream.extendNext" ? 1 : -1);
        setSelected(result.selected);
        anchorRef.current = focused;
        if (result.focused) {
          lastIndex.current = ids.indexOf(result.focused);
          setFocused(result.focused);
        }
        return;
      }
      case "upstream.toggleSelect":
        if (!focused) return;
        anchorRef.current = focused;
        setSelected((current) => toggleId(current, focused));
        return;
      case "upstream.selectAll":
        selectLoaded(ids.every((id) => selected.has(id)) ? EMPTY_SET : new Set(ids));
        return;
      case "upstream.clearSelection":
        clearSelection();
        return;
      case "upstream.focusSearch":
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      case "upstream.nextList":
      case "upstream.previousList":
        changeList(adjacentList(list, command === "upstream.nextList" ? 1 : -1));
        return;
      case "upstream.acceptSuggestion":
        if (canDecide) runBulkAction("accept", targets());
        return;
      case "upstream.port":
        if (canDecide) runBulkAction("port", targets());
        return;
      case "upstream.skip":
        if (canDecide) runBulkAction("skip", targets());
        return;
      case "upstream.watch":
        if (canDecide) runBulkAction("watch", targets());
        return;
      case "upstream.decline":
        if (canDecide) runBulkAction("decline", targets());
        return;
      case "upstream.equivalent":
        if (canDecide) runBulkAction("equivalent", targets());
        return;
      case "upstream.reopen":
        if (canDecide) runBulkAction("reopen", targets());
        return;
      case "upstream.openDetail":
        if (focused) document.getElementById("upstream-topic-detail")?.focus();
        return;
      case "upstream.openUpstreamPr": {
        const pr = focusedRow?.topic.upstreamPrs[0];
        if (pr && overview?.config) window.open(upstreamPrUrl(overview.config.repository, pr), "_blank", "noopener");
        return;
      }
      case "upstream.startPort":
        if (canDecide && !busy) runBulkAction("startPort", targets());
        return;
    }
  };

  const onClickRow = useCallback(
    (id: string, modifiers: RowPointerModifiers) => {
      if (modifiers.shift) setSelected((current) => selectRange(ids, current, anchorRef.current ?? focused, id));
      else if (modifiers.mod) {
        setSelected((current) => toggleId(current, id));
        anchorRef.current = id;
      } else anchorRef.current = id;
      lastIndex.current = ids.indexOf(id);
      setFocused(id);
    },
    [ids, focused, setFocused],
  );
  const onToggleRow = useCallback(
    (id: string, modifiers: RowPointerModifiers) => {
      if (modifiers.shift) setSelected((current) => selectRange(ids, current, anchorRef.current ?? focused, id));
      else setSelected((current) => toggleId(current, id));
      anchorRef.current = id;
    },
    [ids, focused],
  );
  const onOpenRow = useCallback(
    (id: string) => {
      setFocused(id);
      document.getElementById("upstream-topic-detail")?.focus();
    },
    [setFocused],
  );
  // Quick actions read the latest handlers through a ref so the list's row renderer stays stable.
  const quickActionRef = useRef<(id: string, action: UpstreamRowQuickAction) => void>(() => {});
  quickActionRef.current = (id, action) => {
    if (readOnly) return;
    if (action === "accept") void applyDecision([id], "accept");
    else if (action === "skip") openSkip([id]);
    else void applyDecision([id], { kind: "watch" });
  };
  const onQuickAction = useCallback(
    (id: string, action: UpstreamRowQuickAction) => quickActionRef.current(id, action),
    [],
  );

  const loadError = (error: unknown, retry: () => void) => (
    <div role="alert" className="space-y-2 p-6 text-sm">
      <p className="text-destructive-foreground">
        Could not load upstream tracking: {error instanceof Error ? error.message : String(error)}
      </p>
      <Button size="sm" variant="outline" onClick={retry}>
        Retry
      </Button>
    </div>
  );
  // Cached data stays on screen through background refetch errors; only a first load fails here.
  if (projectsQuery.isPending) return <PageSkeleton />;
  if (projectsQuery.isError && !projectsQuery.data)
    return loadError(projectsQuery.error, () => void projectsQuery.refetch());
  if (projects.length === 0 || !projectId) return <UpstreamConfigEmptyState />;
  if (!overview) {
    if (overviewQuery.isError) return loadError(overviewQuery.error, () => void overviewQuery.refetch());
    return <PageSkeleton />;
  }
  if (!overview.config) return <UpstreamConfigEmptyState diagnostics={overview.diagnostics} />;

  const defaultRuntimeMode = projectSettings.data?.settings.defaultRuntimeMode ?? "full-access";
  const runTriage: UpstreamRunTriage = overview.triageModelAvailable ? "llm" : "rules-only";
  const runBlocked = runDisabledReason({ readOnly, busy, overview }) !== null;
  const readyIds = list === "ready" ? portableTopicIds(stateOf, ids) : [];

  return (
    <main className="flex h-full min-h-0 flex-col">
      <header className="space-y-2 border-b px-4 py-3">
        <UpstreamHeader
          projects={projects}
          projectId={projectId}
          onProjectChange={(project) => onSearchChange({ project, list: "inbox" })}
          overview={overview}
          providers={providers}
          readOnly={readOnly}
          busy={busy}
          refreshing={overviewQuery.isFetching}
          onRun={runNow}
          onRefresh={() => void invalidateUpstreamPorts(queryClient)}
          onResolvePublication={resolvePublication}
        />
        <UpstreamAttention
          overview={overview}
          readOnly={readOnly}
          busy={busy}
          onTakeOver={takeOver}
          onAddRemote={addRemote}
          onResolvePublication={resolvePublication}
        />
        <UpstreamToolbar
          ref={searchInputRef}
          list={list}
          counts={overview.counts}
          onListChange={changeList}
          search={search}
          onSearchChange={(next) => onSearchChange({ ...next, project: projectId, list })}
          facets={firstPage?.facets ?? null}
          onSearchEscape={() => listRef.current?.focus()}
          startAll={
            list === "ready"
              ? {
                  count: overview.counts.ready,
                  disabled: busy || readOnly || readyIds.length === 0,
                  onStart: () => {
                    const all = startAllReady(readyIds);
                    openStartPort(
                      all.ids,
                      all.capped ? `Only the first ${UPSTREAM_MAX_PORT_TOPICS} Ready topics are used.` : null,
                    );
                  },
                }
              : null
          }
        />
      </header>
      <div className="flex min-h-0 flex-1">
        <section className="flex min-h-0 w-1/2 min-w-80 flex-col border-r">
          {/* Loaded rows stay through a failed background refetch. */}
          {topicsQuery.error && !topicsQuery.data ? (
            <div role="alert" className="space-y-2 p-4 text-sm">
              <p className="text-destructive-foreground">{String(topicsQuery.error)}</p>
              <Button size="sm" variant="outline" onClick={() => void topicsQuery.refetch()}>
                Retry
              </Button>
            </div>
          ) : topicsQuery.isPending ? (
            <UpstreamTopicListSkeleton />
          ) : (
            <UpstreamTopicList
              ref={listRef}
              rows={rows}
              repository={overview.config.repository}
              reasonLabels={overview.reasonLabels}
              focusedId={focused}
              selected={selected}
              pending={pending}
              quickActions={list === "inbox" && !readOnly}
              hasMore={Boolean(topicsQuery.hasNextPage)}
              loadingMore={topicsQuery.isFetchingNextPage}
              header={
                <UpstreamBulkBar
                  list={list}
                  ids={ids}
                  selected={selectedVisible}
                  selectedCount={matching ? selected.size : selectedVisible.size}
                  total={total}
                  readOnly={readOnly}
                  busy={busy}
                  onSelectAll={(select) => selectLoaded(select ? new Set(ids) : EMPTY_SET)}
                  onClear={clearSelection}
                  onAction={(action) => runBulkAction(action, targets())}
                  selectionNote={
                    matching ? (
                      <span className="text-muted-foreground">
                        {matching.revision === null
                          ? "Topics that were not recorded stay selected"
                          : "All matching topics selected"}
                      </span>
                    ) : selectedVisible.size === ids.length && total > ids.length ? (
                      <Button size="xs" variant="link" disabled={selectingAll} onClick={() => void selectAllMatching()}>
                        Select all {total.toLocaleString()} matching
                      </Button>
                    ) : null
                  }
                />
              }
              empty={
                <UpstreamListEmpty
                  list={list}
                  filtered={filtered}
                  lastRun={describeRun(overview.lastRun)}
                  runDisabled={runBlocked}
                  onRun={() => runNow("upstream", runTriage)}
                  onClearFilters={() => onSearchChange({ ...withoutFilters(search), project: projectId, list })}
                />
              }
              onLoadMore={() => void topicsQuery.fetchNextPage()}
              onClickRow={onClickRow}
              onToggleRow={onToggleRow}
              onOpenRow={onOpenRow}
              onQuickAction={onQuickAction}
              onKeyDown={handleKeyDown}
            />
          )}
        </section>
        <section
          id="upstream-topic-detail"
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-y-auto outline-none"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            if (isEditableTarget(event.target) || isDialogTarget(event.target)) return;
            event.preventDefault();
            listRef.current?.focus();
          }}
        >
          {focused ? (
            <UpstreamTopicDetail
              projectId={projectId}
              topicId={focused}
              overview={overview}
              readOnly={readOnly}
              busy={busy}
              pending={pending.has(focused)}
              onAccept={() => void applyDecision([focused], "accept")}
              onDecide={(decision) =>
                decision.kind === "inbox" ? reopen([focused]) : void applyDecision([focused], decision)
              }
              onSkip={(options) => openSkip([focused], options?.reason)}
              onDecline={() => setDeclineIds([focused])}
              onStartPort={() => openStartPort([focused])}
              onCopyPrompt={() => copyPrompt([focused])}
              onUnlink={unlink}
              onOpenTopic={openTopic}
            />
          ) : (
            <p className="p-6 text-sm text-muted-foreground">
              Select a topic. Use <Kbd>j</Kbd> and <Kbd>k</Kbd> to move
              {shortcutsLabel ? (
                <>
                  , <Kbd>{shortcutsLabel}</Kbd> for every shortcut
                </>
              ) : null}
              .
            </p>
          )}
        </section>
      </div>
      <SkipReasonDialog
        open={skipDialog !== null}
        count={skipDialog?.ids.length ?? 0}
        reasonKeys={overview.reasonKeys}
        reasonLabels={overview.reasonLabels}
        upstreamOnlySubsystems={overview.upstreamOnlySubsystems}
        preselected={skipDialog?.preselected ?? null}
        {...(skipDialog?.reason ? { defaultReason: skipDialog.reason } : {})}
        onClose={() => {
          setSkipDialog(null);
          listRef.current?.focus();
        }}
        onConfirm={(input) => {
          const topicIds = skipDialog?.ids ?? [];
          setSkipDialog(null);
          void applyDecision(topicIds, { kind: "skip", ...input });
        }}
      />
      <DeclineDialog
        open={declineIds !== null}
        count={declineIds?.length ?? 0}
        onClose={() => {
          setDeclineIds(null);
          listRef.current?.focus();
        }}
        onConfirm={(reason) => {
          const topicIds = declineIds ?? [];
          setDeclineIds(null);
          void applyDecision(topicIds, { kind: "declined", reason });
        }}
      />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      <StartPortDialog
        open={portRequest !== null}
        projectId={projectId}
        topicIds={portRequest?.ids ?? []}
        note={portRequest?.note ?? null}
        providers={providers}
        savedModel={projectSettings.data?.settings.upstreamPorts?.portModelSelection ?? null}
        defaultRuntimeMode={defaultRuntimeMode}
        overview={overview}
        busy={busy}
        onClose={() => setPortRequest(null)}
        onRunFirst={() => {
          setPortRequest(null);
          runNow("upstream", runTriage);
        }}
        onStart={(input) => {
          const topicIds = portRequest?.ids ?? [];
          void withBusy("Could not start the port", async () => {
            const result = await ensureNativeApi().upstreamPorts.startPort({
              projectId,
              topicIds: topicIds as never,
              ...input,
            });
            setPortRequest(null);
            const rejected = result.groups.filter((group) => group.status === "rejected");
            const pendingGroups = result.groups.filter((group) => group.status === "pending");
            toastManager.add({
              type: rejected.length ? "warning" : "success",
              title: `Started ${result.groups.length - rejected.length} port thread(s)`,
              ...(rejected.length || pendingGroups.length
                ? {
                    description: [
                      ...rejected.map((group) => `Rejected: ${group.reason ?? group.topicIds.join(", ")}`),
                      ...(pendingGroups.length ? [`${pendingGroups.length} will be retried automatically.`] : []),
                    ].join("\n"),
                  }
                : {}),
            });
            await invalidateUpstreamPorts(queryClient);
          });
        }}
      />
    </main>
  );
}
