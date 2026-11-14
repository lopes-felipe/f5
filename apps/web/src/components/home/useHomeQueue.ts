import type { OrchestrationThreadPeek, ThreadId } from "@t3tools/contracts";
import { isActiveWorkflow } from "@t3tools/shared/workflowArchive";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { buildHomeQueue, type HomeQueue } from "../../lib/homeQueue";
import { rpcQueryContext, rpcQueryMeta } from "../../lib/rpcQueryContext";
import {
  selectStandaloneThreadsByActivity,
  selectVisibleWorkflowThreads,
} from "../../lib/threadAttentionBuckets";
import { ensureNativeApi } from "../../nativeApi";
import { useNextTurnQueueStore } from "../../nextTurnQueueStore";
import { useStore } from "../../store";
import { orderedPinnedThreadIds } from "../../threadPinSnooze";
import { selectThreadById, type ThreadSummary, useThreadSummaries } from "../../threadSelectors";
import {
  deriveSidebarWorkflowMeta,
  type SidebarWorkflowEntry,
  workflowEntryKey,
  workflowTypeLabel,
} from "../sidebar/sidebarLists";
import { workflowActivityAt } from "../sidebar/sidebarWorkflowGroups";
import type { HomeWorkflowRow } from "./homeItems";

/** Threads whose next-turn queue is paused: they wait on the user without a status of their own. */
function usePausedQueueThreadIds(): ReadonlySet<ThreadId> {
  const queueSummary = useNextTurnQueueStore((state) => state.summary);
  return useMemo(
    () =>
      new Set(
        (queueSummary?.threads ?? [])
          .filter((entry) => entry.paused)
          .map((entry) => entry.threadId),
      ),
    [queueSummary],
  );
}

/** Home's triage queue, built from the thread, workflow and next-turn queue stores. */
export function useHomeQueue(): HomeQueue<ThreadSummary, HomeWorkflowRow> {
  const threads = useThreadSummaries();
  const planningWorkflows = useStore((state) => state.planningWorkflows);
  const codeReviewWorkflows = useStore((state) => state.codeReviewWorkflows);
  const investigationWorkflows = useStore((state) => state.investigationWorkflows);
  const pausedQueueThreadIds = usePausedQueueThreadIds();

  // Phases depend on the workflows alone, so thread activity does not re-derive them.
  const activeWorkflowEntries = useMemo(() => {
    const entries: SidebarWorkflowEntry[] = [
      ...planningWorkflows.map((workflow) => ({ type: "planning" as const, workflow })),
      ...codeReviewWorkflows.map((workflow) => ({ type: "codeReview" as const, workflow })),
      ...investigationWorkflows.map((workflow) => ({ type: "investigation" as const, workflow })),
    ];
    return entries
      .filter((entry) => isActiveWorkflow(entry.workflow))
      .map((entry) => ({ entry, meta: deriveSidebarWorkflowMeta(entry) }))
      .filter(({ meta }) => meta.overallState === "active");
  }, [codeReviewWorkflows, investigationWorkflows, planningWorkflows]);

  return useMemo(() => {
    const workflowInput = {
      threads,
      planningWorkflows,
      codeReviewWorkflows,
      investigationWorkflows,
    };
    const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));
    const workflows = activeWorkflowEntries.map(({ entry, meta }): HomeWorkflowRow => {
      const workflowThreads = meta.threadOrder.flatMap((threadId) => {
        const thread = threadById.get(threadId);
        return thread ? [thread] : [];
      });
      return {
        key: workflowEntryKey(entry),
        active: true,
        startedAt: entry.workflow.createdAt,
        activityAt: workflowActivityAt({
          updatedAt: entry.workflow.updatedAt,
          threads: workflowThreads,
          finished: false,
        }),
        entry,
        projectId: entry.workflow.projectId,
        title: entry.workflow.title,
        typeLabel: workflowTypeLabel(entry.type, entry.workflow),
        meta,
      };
    });
    return buildHomeQueue({
      threads: selectStandaloneThreadsByActivity(workflowInput),
      workflowThreads: selectVisibleWorkflowThreads(workflowInput),
      pausedQueueThreadIds,
      pinnedThreadIds: orderedPinnedThreadIds(threads),
      workflows,
    });
  }, [
    activeWorkflowEntries,
    codeReviewWorkflows,
    investigationWorkflows,
    pausedQueueThreadIds,
    planningWorkflows,
    threads,
  ]);
}

/** Rows past this many read no peek: their second line stays empty until they move up. */
export const HOME_PEEK_THREAD_LIMIT = 100;
const PEEKS_PER_REQUEST = 50;

/**
 * Last prompt, reply snippet and diff totals for the queue's rows, read in one request per
 * 50 threads. The key holds each thread's latest turn, so a finished or new turn refetches
 * while streaming output does not. The ids are sorted first: the key names the set of
 * threads, so rows that only trade places in the queue read nothing.
 */
export function useHomeThreadPeeks(
  threadIds: ReadonlyArray<ThreadId>,
): ReadonlyMap<ThreadId, OrchestrationThreadPeek> {
  const ids = useMemo(() => threadIds.slice(0, HOME_PEEK_THREAD_LIMIT).toSorted(), [threadIds]);
  const signature = useStore((state) =>
    ids
      .map((threadId) => {
        const latestTurn = selectThreadById(state, threadId)?.latestTurn;
        return `${threadId}:${latestTurn?.turnId ?? ""}:${latestTurn?.state ?? ""}`;
      })
      .join("|"),
  );
  const query = useQuery({
    queryKey: ["home-thread-peeks", signature] as const,
    queryFn: async (context) => {
      const api = ensureNativeApi();
      const peeks: OrchestrationThreadPeek[] = [];
      for (let start = 0; start < ids.length; start += PEEKS_PER_REQUEST) {
        const result = await api.orchestration.getThreadPeeks(
          { threadIds: ids.slice(start, start + PEEKS_PER_REQUEST) },
          rpcQueryContext(context),
        );
        peeks.push(...result.peeks);
      }
      return peeks;
    },
    enabled: ids.length > 0,
    staleTime: 30_000,
    // A changed key (one thread's turn ended) keeps the other rows' text while it loads.
    placeholderData: keepPreviousData,
    meta: rpcQueryMeta("refresh-background"),
  });
  return useMemo(
    () => new Map((query.data ?? []).map((peek) => [peek.threadId, peek] as const)),
    [query.data],
  );
}
