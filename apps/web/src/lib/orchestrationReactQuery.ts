import type {
  OrchestrationCommandExecution,
  OrchestrationCommandExecutionId,
  OrchestrationCommandExecutionSummary,
  OrchestrationEvent,
  OrchestrationGetThreadCommandExecutionResult,
  OrchestrationGetThreadFileChangeResult,
  OrchestrationGetThreadFileChangesResult,
  OrchestrationGetThreadHistoryPageInput,
  OrchestrationThreadHistoryPage,
  OrchestrationThreadTailDetails,
  ThreadId,
  OrchestrationFileChangeSummary,
  OrchestrationFileChangeId,
} from "@t3tools/contracts";
import { type QueryClient, queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect } from "react";

import {
  ensureThreadOpenTrace,
  finishThreadOpenTrace,
  noteThreadOpenTraceStep,
  startThreadOpenTrace,
} from "./threadOpenTrace";
import { ensureNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { ensureThreadHistoryState } from "./threadHistory";
import type { ThreadHistoryState } from "../types";

const THREAD_AUX_QUERY_STALE_TIME_MS = 5_000;

export const orchestrationQueryKeys = {
  all: ["orchestration"] as const,
  threadDetails: (threadId: ThreadId) => ["orchestration", "threadDetails", threadId] as const,
  threadCommandExecutionAll: ["orchestration", "threadCommandExecution"] as const,
  threadCommandExecutionPrefix: (threadId: ThreadId) =>
    [...orchestrationQueryKeys.threadCommandExecutionAll, threadId] as const,
  threadCommandExecution: (
    threadId: ThreadId,
    commandExecutionId: OrchestrationCommandExecutionId,
  ) => [...orchestrationQueryKeys.threadCommandExecutionAll, threadId, commandExecutionId] as const,
  threadFileChanges: (threadId: ThreadId) =>
    ["orchestration", "threadFileChanges", threadId] as const,
  threadFileChangePrefix: (threadId: ThreadId) =>
    ["orchestration", "threadFileChange", threadId] as const,
  threadFileChange: (threadId: ThreadId, fileChangeId: OrchestrationFileChangeId) =>
    ["orchestration", "threadFileChange", threadId, fileChangeId] as const,
};

function hasFreshQueryData(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  staleTimeMs: number,
): boolean {
  const queryState = queryClient.getQueryState(queryKey);
  return Boolean(
    queryState?.data !== undefined &&
    queryState.dataUpdatedAt > 0 &&
    Date.now() - queryState.dataUpdatedAt <= staleTimeMs,
  );
}

export function threadDetailQueryOptions(threadId: ThreadId) {
  return queryOptions({
    queryKey: orchestrationQueryKeys.threadDetails(threadId),
    queryFn: ({ signal }) => fetchThreadTailDetailsRpc(threadId, signal),
    gcTime: 30_000,
    staleTime: Infinity,
  });
}

const PROVISIONAL_THREAD_DETAIL_REFRESH_DELAYS_MS = [
  250, 500, 1_000, 2_000, 4_000, 10_000, 30_000,
] as const;
const provisionalThreadDetailRefreshes = new Map<ThreadId, Promise<void>>();
const inFlightThreadDetailRequests = new Map<string, Promise<OrchestrationThreadTailDetails>>();
const inFlightThreadHistoryPageRequests = new Map<
  string,
  Promise<OrchestrationThreadHistoryPage>
>();
const inFlightThreadHistoryBackfills = new Map<string, Promise<void>>();
const provisionalThreadCommandExecutionRefreshes = new Map<string, Promise<void>>();
const inFlightThreadCommandExecutionDetailRequests = new Map<
  string,
  Promise<OrchestrationGetThreadCommandExecutionResult>
>();
const inFlightThreadFileChangeRequests = new Map<
  string,
  Promise<OrchestrationGetThreadFileChangesResult>
>();

function makeAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function waitForDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => {
      globalThis.setTimeout(resolve, delayMs);
    });
  }
  if (signal.aborted) {
    return Promise.reject(makeAbortError());
  }

  return new Promise((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      globalThis.clearTimeout(timeoutId);
      reject(makeAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function isProvisionalThreadDetail(
  details: Pick<OrchestrationThreadTailDetails, "detailSequence">,
): boolean {
  return details.detailSequence === 0;
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(makeAbortError());
  }

  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(makeAbortError()), { once: true });
  });
}

function getAuxRequestKey(threadId: ThreadId, afterSequenceExclusive?: number): string {
  return `${threadId}:${afterSequenceExclusive ?? "full"}`;
}

function getThreadTailRequestKey(threadId: ThreadId): string {
  return `tail:${threadId}`;
}

function getThreadHistoryPageRequestKey(input: {
  threadId: ThreadId;
  beforeMessageCursor: OrchestrationThreadHistoryPage["oldestLoadedMessageCursor"];
  beforeCheckpointTurnCount: number | null;
  beforeCommandExecutionCursor: OrchestrationThreadHistoryPage["oldestLoadedCommandExecutionCursor"];
}): string {
  const messageCursorKey = input.beforeMessageCursor
    ? `${input.beforeMessageCursor.createdAt}:${input.beforeMessageCursor.messageId}`
    : "null";
  const commandCursorKey = input.beforeCommandExecutionCursor
    ? `${input.beforeCommandExecutionCursor.startedAt}:${input.beforeCommandExecutionCursor.startedSequence}:${input.beforeCommandExecutionCursor.commandExecutionId}`
    : "null";
  return `history:${input.threadId}:${messageCursorKey}:${input.beforeCheckpointTurnCount ?? "null"}:${commandCursorKey}`;
}

function getThreadHistoryBackfillKey(threadId: ThreadId, generation: number): string {
  return `${threadId}:${generation}`;
}

function getOrStartInFlightRequest<T>(
  map: Map<string, Promise<T>>,
  key: string,
  create: () => Promise<T>,
): Promise<T> {
  const existing = map.get(key);
  if (existing) {
    return existing;
  }

  const request = create().finally(() => {
    if (map.get(key) === request) {
      map.delete(key);
    }
  });
  map.set(key, request);
  return request;
}

async function fetchThreadTailDetailsRpc(
  threadId: ThreadId,
  signal?: AbortSignal,
): Promise<OrchestrationThreadTailDetails> {
  const api = ensureNativeApi();
  const request = getOrStartInFlightRequest(
    inFlightThreadDetailRequests,
    getThreadTailRequestKey(threadId),
    () => api.orchestration.getThreadTailDetails({ threadId }),
  );
  if (!signal) {
    return request;
  }

  const details = await Promise.race([request, waitForAbort(signal)]);
  if (signal.aborted) {
    throw makeAbortError();
  }
  return details;
}

async function fetchThreadHistoryPageRpc(
  input: {
    threadId: ThreadId;
    beforeMessageCursor: OrchestrationThreadHistoryPage["oldestLoadedMessageCursor"];
    beforeCheckpointTurnCount: number | null;
    beforeCommandExecutionCursor: OrchestrationThreadHistoryPage["oldestLoadedCommandExecutionCursor"];
  },
  signal?: AbortSignal,
): Promise<OrchestrationThreadHistoryPage> {
  const api = ensureNativeApi();
  const request = getOrStartInFlightRequest(
    inFlightThreadHistoryPageRequests,
    getThreadHistoryPageRequestKey(input),
    () =>
      api.orchestration.getThreadHistoryPage({
        threadId: input.threadId,
        beforeMessageCursor: input.beforeMessageCursor,
        beforeCheckpointTurnCount: input.beforeCheckpointTurnCount,
        beforeCommandExecutionCursor: input.beforeCommandExecutionCursor,
      }),
  );
  if (!signal) {
    return request;
  }

  const page = await Promise.race([request, waitForAbort(signal)]);
  if (signal.aborted) {
    throw makeAbortError();
  }
  return page;
}

async function fetchThreadCommandExecutionRpc(
  input: {
    threadId: ThreadId;
    commandExecutionId: OrchestrationCommandExecutionId;
  },
  signal?: AbortSignal,
): Promise<OrchestrationGetThreadCommandExecutionResult> {
  const api = ensureNativeApi();
  const request = getOrStartInFlightRequest(
    inFlightThreadCommandExecutionDetailRequests,
    `${input.threadId}:${input.commandExecutionId}`,
    () => api.orchestration.getThreadCommandExecution(input),
  );
  if (!signal) {
    return request;
  }

  const result = await Promise.race([request, waitForAbort(signal)]);
  if (signal.aborted) {
    throw makeAbortError();
  }
  return result;
}

function buildThreadCommandExecutionSummaryFromRecordedEvent(
  event: Extract<OrchestrationEvent, { type: "thread.command-execution-recorded" }>,
): OrchestrationCommandExecutionSummary {
  return {
    ...event.payload.commandExecution,
    threadId: event.payload.threadId,
    startedSequence: event.sequence,
    lastUpdatedSequence: event.sequence,
  };
}

function buildThreadCommandExecutionDetailFromSummary(
  summary: OrchestrationCommandExecutionSummary,
  options?: {
    output?: string;
    outputTruncated?: boolean;
    updatedAt?: string;
    lastUpdatedSequence?: number;
  },
): OrchestrationCommandExecution {
  return {
    ...summary,
    output: options?.output ?? "",
    outputTruncated: options?.outputTruncated ?? false,
    updatedAt: options?.updatedAt ?? summary.updatedAt,
    lastUpdatedSequence: options?.lastUpdatedSequence ?? summary.lastUpdatedSequence,
  };
}

function findThreadCommandExecutionSummary(
  threadId: ThreadId,
  commandExecutionId: OrchestrationCommandExecutionId,
): OrchestrationCommandExecutionSummary | null {
  const thread = useStore.getState().threads.find((entry) => entry.id === threadId);
  return thread?.commandExecutions.find((execution) => execution.id === commandExecutionId) ?? null;
}

export function mergeThreadCommandExecutionRecordedDetailResult(
  current: OrchestrationGetThreadCommandExecutionResult | undefined,
  event: Extract<OrchestrationEvent, { type: "thread.command-execution-recorded" }>,
  summary: OrchestrationCommandExecutionSummary | null,
): OrchestrationGetThreadCommandExecutionResult | undefined {
  if (current === undefined) {
    return current;
  }

  const existing = current.commandExecution;
  if (existing && event.sequence <= existing.lastUpdatedSequence) {
    return current;
  }

  const nextSummary = summary ?? buildThreadCommandExecutionSummaryFromRecordedEvent(event);
  if (!existing) {
    return {
      commandExecution: buildThreadCommandExecutionDetailFromSummary(nextSummary),
    };
  }

  return {
    commandExecution: {
      ...existing,
      ...nextSummary,
      output: existing.output,
      outputTruncated: existing.outputTruncated,
    },
  };
}

export function mergeThreadCommandExecutionOutputAppendedDetailResult(
  current: OrchestrationGetThreadCommandExecutionResult | undefined,
  event: Extract<OrchestrationEvent, { type: "thread.command-execution-output-appended" }>,
  summary: OrchestrationCommandExecutionSummary | null,
): OrchestrationGetThreadCommandExecutionResult | undefined {
  if (current === undefined) {
    return current;
  }

  const existing = current.commandExecution;
  if (existing && event.sequence <= existing.lastUpdatedSequence) {
    return current;
  }

  if (!existing) {
    if (!summary) {
      return current;
    }
    return {
      commandExecution: buildThreadCommandExecutionDetailFromSummary(summary, {
        output: event.payload.chunk,
        updatedAt: event.payload.updatedAt,
        lastUpdatedSequence: event.sequence,
      }),
    };
  }

  return {
    commandExecution: {
      ...existing,
      output: `${existing.output}${event.payload.chunk}`,
      updatedAt: event.payload.updatedAt,
      lastUpdatedSequence: event.sequence,
    },
  };
}

export function applyThreadCommandExecutionEventToQueryCache(
  queryClient: QueryClient,
  event: Extract<
    OrchestrationEvent,
    | { type: "thread.deleted" }
    | { type: "thread.reverted" }
    | { type: "thread.command-execution-recorded" }
    | { type: "thread.command-execution-output-appended" }
  >,
): void {
  switch (event.type) {
    case "thread.deleted":
    case "thread.reverted": {
      queryClient.removeQueries({
        queryKey: orchestrationQueryKeys.threadCommandExecutionPrefix(event.payload.threadId),
      });
      return;
    }

    case "thread.command-execution-recorded": {
      const queryKey = orchestrationQueryKeys.threadCommandExecution(
        event.payload.threadId,
        event.payload.commandExecution.id,
      );
      const queryState =
        queryClient.getQueryState<OrchestrationGetThreadCommandExecutionResult>(queryKey);
      if (!queryState) {
        return;
      }
      const summary =
        findThreadCommandExecutionSummary(
          event.payload.threadId,
          event.payload.commandExecution.id,
        ) ?? null;
      queryClient.setQueryData<OrchestrationGetThreadCommandExecutionResult>(queryKey, (current) =>
        mergeThreadCommandExecutionRecordedDetailResult(current, event, summary),
      );
      return;
    }

    case "thread.command-execution-output-appended": {
      const queryKey = orchestrationQueryKeys.threadCommandExecution(
        event.payload.threadId,
        event.payload.commandExecutionId,
      );
      const queryState =
        queryClient.getQueryState<OrchestrationGetThreadCommandExecutionResult>(queryKey);
      if (!queryState) {
        return;
      }
      const summary = findThreadCommandExecutionSummary(
        event.payload.threadId,
        event.payload.commandExecutionId,
      );
      queryClient.setQueryData<OrchestrationGetThreadCommandExecutionResult>(queryKey, (current) =>
        mergeThreadCommandExecutionOutputAppendedDetailResult(current, event, summary),
      );
    }
  }
}

async function fetchThreadFileChangesRpc(
  input: {
    threadId: ThreadId;
    afterSequenceExclusive?: number;
  },
  signal?: AbortSignal,
): Promise<OrchestrationGetThreadFileChangesResult> {
  const api = ensureNativeApi();
  const request = getOrStartInFlightRequest(
    inFlightThreadFileChangeRequests,
    getAuxRequestKey(input.threadId, input.afterSequenceExclusive),
    () => api.orchestration.getThreadFileChanges(input),
  );
  if (!signal) {
    return request;
  }

  const result = await Promise.race([request, waitForAbort(signal)]);
  if (signal.aborted) {
    throw makeAbortError();
  }
  return result;
}

async function fetchThreadDetailInternal(
  queryClient: QueryClient,
  threadId: ThreadId,
  options?: { force?: boolean; signal?: AbortSignal },
): Promise<OrchestrationThreadTailDetails> {
  if (options?.signal) {
    return fetchThreadTailDetailsRpc(threadId, options.signal);
  }

  return queryClient.fetchQuery({
    ...threadDetailQueryOptions(threadId),
    staleTime: options?.force ? 0 : Infinity,
  });
}

export async function fetchAndSyncThreadDetail(
  queryClient: QueryClient,
  threadId: ThreadId,
  options?: { force?: boolean; signal?: AbortSignal; captureLiveEvents?: boolean },
): Promise<OrchestrationThreadTailDetails | null> {
  const stateBeforeFetch = useStore.getState();
  const lastAppliedSequenceBeforeFetch = stateBeforeFetch.lastAppliedSequence;
  const thread = stateBeforeFetch.threads.find((entry) => entry.id === threadId);
  if (!thread) {
    return null;
  }
  const captureLiveEvents = options?.captureLiveEvents ?? true;
  const hasDetailBufferForFetch =
    stateBeforeFetch.detailEventBufferByThreadId.has(threadId) ||
    (captureLiveEvents && !thread.detailsLoaded);
  if (!options?.force && thread.detailsLoaded) {
    return null;
  }
  if (captureLiveEvents && !thread.detailsLoaded) {
    stateBeforeFetch.beginThreadDetailLoad(threadId);
  }

  try {
    const details = await fetchThreadDetailInternal(queryClient, threadId, options);
    if (options?.signal?.aborted) {
      if (captureLiveEvents) {
        useStore.getState().clearThreadDetailBuffer(threadId);
      }
      return null;
    }
    const nextStore = useStore.getState();
    nextStore.syncThreadTailDetails(threadId, details, {
      advanceLastAppliedSequence: captureLiveEvents,
    });
    const shouldCacheDetails =
      hasDetailBufferForFetch || details.detailSequence >= lastAppliedSequenceBeforeFetch;
    if (shouldCacheDetails) {
      queryClient.setQueryData(orchestrationQueryKeys.threadDetails(threadId), details);
    }
    return details;
  } catch (error) {
    if (captureLiveEvents) {
      useStore.getState().clearThreadDetailBuffer(threadId);
    }
    if (isAbortError(error)) {
      return null;
    }
    throw error;
  }
}

export function scheduleThreadDetailRefreshIfProvisional(
  queryClient: QueryClient,
  threadId: ThreadId,
  details: OrchestrationThreadTailDetails | null | undefined,
  options?: { signal?: AbortSignal; captureLiveEvents?: boolean },
): Promise<void> {
  if (!details || !isProvisionalThreadDetail(details) || options?.signal?.aborted) {
    return Promise.resolve();
  }

  const inFlight = provisionalThreadDetailRefreshes.get(threadId);
  if (inFlight) {
    return inFlight;
  }

  let refreshPromise: Promise<void> | undefined;
  refreshPromise = (async () => {
    let latestDetails: OrchestrationThreadTailDetails | null = details;
    for (const delayMs of PROVISIONAL_THREAD_DETAIL_REFRESH_DELAYS_MS) {
      if (!latestDetails || !isProvisionalThreadDetail(latestDetails)) {
        return;
      }
      await waitForDelay(delayMs, options?.signal);
      latestDetails = await fetchAndSyncThreadDetail(queryClient, threadId, {
        force: true,
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.captureLiveEvents !== undefined
          ? { captureLiveEvents: options.captureLiveEvents }
          : {}),
      });
    }
  })().finally(() => {
    if (provisionalThreadDetailRefreshes.get(threadId) === refreshPromise) {
      provisionalThreadDetailRefreshes.delete(threadId);
    }
  });

  provisionalThreadDetailRefreshes.set(threadId, refreshPromise);
  return refreshPromise;
}

export function resetProvisionalThreadDetailRefreshesForTests(): void {
  provisionalThreadDetailRefreshes.clear();
}

type ThreadHistoryBackfillOptions = {
  includeCommandExecutionHistory?: boolean;
  signal?: AbortSignal;
};

export function shouldBackfillThreadHistory(
  history: ThreadHistoryState,
  options?: Pick<ThreadHistoryBackfillOptions, "includeCommandExecutionHistory">,
): boolean {
  return (
    history.hasOlderMessages ||
    history.hasOlderCheckpoints ||
    ((options?.includeCommandExecutionHistory ?? false) && history.hasOlderCommandExecutions)
  );
}

export function buildThreadHistoryBackfillInput(
  threadId: ThreadId,
  history: ThreadHistoryState,
  options?: Pick<ThreadHistoryBackfillOptions, "includeCommandExecutionHistory">,
): OrchestrationGetThreadHistoryPageInput | null {
  if (!shouldBackfillThreadHistory(history, options)) {
    return null;
  }

  return {
    threadId,
    beforeMessageCursor: history.hasOlderMessages ? history.oldestLoadedMessageCursor : null,
    beforeCheckpointTurnCount: history.hasOlderCheckpoints
      ? history.oldestLoadedCheckpointTurnCount
      : null,
    beforeCommandExecutionCursor:
      (options?.includeCommandExecutionHistory ?? false) && history.hasOlderCommandExecutions
        ? history.oldestLoadedCommandExecutionCursor
        : null,
  };
}

function threadHistoryPageHasMore(
  page: OrchestrationThreadHistoryPage,
  options?: Pick<ThreadHistoryBackfillOptions, "includeCommandExecutionHistory">,
): boolean {
  return (
    page.hasOlderMessages ||
    page.hasOlderCheckpoints ||
    ((options?.includeCommandExecutionHistory ?? false) && page.hasOlderCommandExecutions)
  );
}

function threadHistoryPageHasProgress(
  page: OrchestrationThreadHistoryPage,
  options?: Pick<ThreadHistoryBackfillOptions, "includeCommandExecutionHistory">,
): boolean {
  return (
    page.messages.length > 0 ||
    page.checkpoints.length > 0 ||
    ((options?.includeCommandExecutionHistory ?? false) && page.commandExecutions.length > 0)
  );
}

export async function ensureThreadHistoryBackfill(
  queryClient: QueryClient,
  threadId: ThreadId,
  options?: ThreadHistoryBackfillOptions,
): Promise<void> {
  if (options?.signal?.aborted) {
    return;
  }
  const store = useStore.getState();
  const thread = store.threads.find((entry) => entry.id === threadId);
  const threadHistory = ensureThreadHistoryState(thread?.history);
  if (!thread || !thread.detailsLoaded || !shouldBackfillThreadHistory(threadHistory, options)) {
    return;
  }

  const cachedTailDetails = queryClient.getQueryData<OrchestrationThreadTailDetails>(
    orchestrationQueryKeys.threadDetails(threadId),
  );
  if (cachedTailDetails && isProvisionalThreadDetail(cachedTailDetails)) {
    return;
  }

  const expectedGeneration = threadHistory.generation;
  const backfillKey = getThreadHistoryBackfillKey(threadId, expectedGeneration);
  const existing = inFlightThreadHistoryBackfills.get(backfillKey);
  if (existing) {
    return existing;
  }

  const backfillPromise = (async () => {
    store.markThreadHistoryBackfilling(threadId);

    try {
      while (!options?.signal?.aborted) {
        const nextThread = useStore.getState().threads.find((entry) => entry.id === threadId);
        const nextHistory = ensureThreadHistoryState(nextThread?.history);
        if (
          !nextThread ||
          !nextThread.detailsLoaded ||
          nextHistory.generation !== expectedGeneration
        ) {
          return;
        }
        const nextInput = buildThreadHistoryBackfillInput(threadId, nextHistory, options);
        if (nextInput === null) {
          useStore.getState().markThreadHistoryComplete(threadId, expectedGeneration);
          return;
        }

        const page = await fetchThreadHistoryPageRpc(nextInput, options?.signal);
        if (options?.signal?.aborted) {
          return;
        }
        if (
          !threadHistoryPageHasProgress(page, options) &&
          threadHistoryPageHasMore(page, options)
        ) {
          throw new Error("Thread history backfill made no progress.");
        }
        useStore.getState().prependOlderThreadHistoryPage(threadId, page, expectedGeneration);
      }
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      useStore.getState().markThreadHistoryError(threadId, expectedGeneration);
      throw error;
    }
  })().finally(() => {
    if (inFlightThreadHistoryBackfills.get(backfillKey) === backfillPromise) {
      inFlightThreadHistoryBackfills.delete(backfillKey);
    }
  });

  inFlightThreadHistoryBackfills.set(backfillKey, backfillPromise);
  return backfillPromise;
}

export function retryThreadHistoryBackfill(
  queryClient: QueryClient,
  threadId: ThreadId,
  options?: ThreadHistoryBackfillOptions,
): Promise<void> {
  return ensureThreadHistoryBackfill(queryClient, threadId, options);
}

export function clearInFlightOrchestrationRpcRequests(): void {
  inFlightThreadDetailRequests.clear();
  inFlightThreadHistoryPageRequests.clear();
  inFlightThreadHistoryBackfills.clear();
  provisionalThreadCommandExecutionRefreshes.clear();
  inFlightThreadCommandExecutionDetailRequests.clear();
  inFlightThreadFileChangeRequests.clear();
}

export function useThreadDetail(
  threadId: ThreadId | null | undefined,
  options?: Pick<ThreadHistoryBackfillOptions, "includeCommandExecutionHistory">,
) {
  const queryClient = useQueryClient();
  const thread = useStore((store) =>
    threadId ? store.threads.find((entry) => entry.id === threadId) : undefined,
  );
  const threadHistory = ensureThreadHistoryState(thread?.history);
  const beginThreadDetailLoad = useStore((store) => store.beginThreadDetailLoad);
  const clearThreadDetailBuffer = useStore((store) => store.clearThreadDetailBuffer);
  const syncThreadTailDetails = useStore((store) => store.syncThreadTailDetails);
  const detailsLoaded = thread?.detailsLoaded ?? false;
  const hasOlderThreadHistory = shouldBackfillThreadHistory(threadHistory, options);
  const backfillBlockedByError = threadHistory.stage === "error";

  useLayoutEffect(() => {
    if (!threadId || detailsLoaded) {
      return;
    }
    startThreadOpenTrace(threadId, "route");
    beginThreadDetailLoad(threadId);
  }, [beginThreadDetailLoad, detailsLoaded, threadId]);

  useEffect(() => {
    if (!threadId) {
      return;
    }
    return () => {
      finishThreadOpenTrace(threadId, "route-unmounted");
      clearThreadDetailBuffer(threadId);
    };
  }, [clearThreadDetailBuffer, threadId]);

  const query = useQuery<OrchestrationThreadTailDetails>({
    queryKey: threadId
      ? orchestrationQueryKeys.threadDetails(threadId)
      : (["orchestration", "threadDetails", "idle"] as const),
    queryFn: async ({ signal }) => {
      if (!threadId) {
        throw new Error("Thread detail query invoked without a thread id.");
      }
      ensureThreadOpenTrace(threadId, "thread-detail-query");
      noteThreadOpenTraceStep(threadId, "tail-rpc-start");
      const startedAtMs = performance.now();
      const details = await fetchThreadTailDetailsRpc(threadId, signal);
      noteThreadOpenTraceStep(threadId, "tail-rpc-complete", {
        durationMs: Math.round(performance.now() - startedAtMs),
        messageCount: details.messages.length,
        checkpointCount: details.checkpoints.length,
        commandExecutionCount: details.commandExecutions.length,
        hasOlderMessages: details.hasOlderMessages,
        hasOlderCheckpoints: details.hasOlderCheckpoints,
        hasOlderCommandExecutions: details.hasOlderCommandExecutions,
      });
      return details;
    },
    enabled: Boolean(threadId) && !detailsLoaded,
    gcTime: 30_000,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!threadId || !query.data) {
      return;
    }
    const syncStartedAtMs = performance.now();
    syncThreadTailDetails(threadId, query.data);
    noteThreadOpenTraceStep(threadId, "tail-store-sync-complete", {
      durationMs: Math.round(performance.now() - syncStartedAtMs),
      detailSequence: query.data.detailSequence,
      messageCount: query.data.messages.length,
      checkpointCount: query.data.checkpoints.length,
      commandExecutionCount: query.data.commandExecutions.length,
      hasOlderMessages: query.data.hasOlderMessages,
      hasOlderCheckpoints: query.data.hasOlderCheckpoints,
      hasOlderCommandExecutions: query.data.hasOlderCommandExecutions,
    });
    if (!isProvisionalThreadDetail(query.data)) {
      return;
    }
    void scheduleThreadDetailRefreshIfProvisional(queryClient, threadId, query.data).catch(
      (error) => {
        if (isAbortError(error)) {
          return;
        }
        console.warn("Failed to refresh provisional thread details.", { threadId, error });
      },
    );
  }, [query.data, queryClient, syncThreadTailDetails, threadId]);

  useEffect(() => {
    if (!threadId || !query.isError || query.isFetching) {
      return;
    }
    finishThreadOpenTrace(threadId, "tail-rpc-error", {
      error:
        query.error instanceof Error
          ? query.error.message
          : query.error
            ? String(query.error)
            : null,
    });
  }, [query.error, query.isError, query.isFetching, threadId]);

  useEffect(() => {
    if (!threadId || !thread?.detailsLoaded) {
      return;
    }
    if (!hasOlderThreadHistory) {
      return;
    }
    if (backfillBlockedByError) {
      return;
    }
    const controller = new AbortController();
    void ensureThreadHistoryBackfill(queryClient, threadId, {
      signal: controller.signal,
      ...(options?.includeCommandExecutionHistory !== undefined
        ? { includeCommandExecutionHistory: options.includeCommandExecutionHistory }
        : {}),
    }).catch((error) => {
      if (isAbortError(error)) {
        return;
      }
      console.warn("Failed to backfill older thread history.", { threadId, error });
    });
    return () => {
      controller.abort();
    };
  }, [
    backfillBlockedByError,
    hasOlderThreadHistory,
    options?.includeCommandExecutionHistory,
    queryClient,
    thread?.detailsLoaded,
    threadHistory.generation,
    threadId,
  ]);

  return query;
}

export function threadCommandExecutionQueryOptions(input: {
  threadId: ThreadId | null;
  commandExecutionId: OrchestrationCommandExecutionId | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey:
      input.threadId && input.commandExecutionId
        ? orchestrationQueryKeys.threadCommandExecution(input.threadId, input.commandExecutionId)
        : ([...orchestrationQueryKeys.all, "threadCommandExecution", "disabled"] as const),
    queryFn: async ({ signal }) => {
      if (!input.threadId || !input.commandExecutionId) {
        return { commandExecution: null } satisfies OrchestrationGetThreadCommandExecutionResult;
      }
      return fetchThreadCommandExecutionRpc(
        {
          threadId: input.threadId,
          commandExecutionId: input.commandExecutionId,
        },
        signal,
      );
    },
    enabled: Boolean(input.threadId && input.commandExecutionId) && (input.enabled ?? true),
    gcTime: 30_000,
    staleTime: Infinity,
  });
}

const PROVISIONAL_THREAD_COMMAND_EXECUTION_REFRESH_DELAYS_MS = [
  250, 500, 1_000, 2_000, 4_000,
] as const;

export function invalidateThreadCommandExecutionDetailQueries(
  queryClient: QueryClient,
  threadId?: ThreadId,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: threadId
      ? orchestrationQueryKeys.threadCommandExecutionPrefix(threadId)
      : orchestrationQueryKeys.threadCommandExecutionAll,
  });
}

export async function scheduleThreadCommandExecutionRefreshIfMissing(
  queryClient: QueryClient,
  input: {
    threadId: ThreadId;
    commandExecutionId: OrchestrationCommandExecutionId;
  },
  options?: { signal?: AbortSignal },
): Promise<void> {
  if (options?.signal?.aborted) {
    return;
  }

  const queryKey = orchestrationQueryKeys.threadCommandExecution(
    input.threadId,
    input.commandExecutionId,
  );
  const current = queryClient.getQueryData<OrchestrationGetThreadCommandExecutionResult>(queryKey);
  if (current === undefined || current.commandExecution !== null) {
    return;
  }

  const refreshKey = `${input.threadId}:${input.commandExecutionId}`;
  const existing = provisionalThreadCommandExecutionRefreshes.get(refreshKey);
  if (existing) {
    return existing;
  }

  let refreshPromise: Promise<void> | null = null;
  refreshPromise = (async () => {
    try {
      for (const delayMs of PROVISIONAL_THREAD_COMMAND_EXECUTION_REFRESH_DELAYS_MS) {
        if (options?.signal?.aborted) {
          return;
        }
        await waitForDelay(delayMs, options?.signal);
        const latest =
          queryClient.getQueryData<OrchestrationGetThreadCommandExecutionResult>(queryKey);
        if (latest === undefined || latest.commandExecution !== null) {
          return;
        }
        const refreshed = await fetchThreadCommandExecutionRpc(input, options?.signal);
        if (options?.signal?.aborted) {
          return;
        }
        queryClient.setQueryData(queryKey, refreshed);
        if (refreshed.commandExecution !== null) {
          return;
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      throw error;
    } finally {
      if (provisionalThreadCommandExecutionRefreshes.get(refreshKey) === refreshPromise) {
        provisionalThreadCommandExecutionRefreshes.delete(refreshKey);
      }
    }
  })();

  provisionalThreadCommandExecutionRefreshes.set(refreshKey, refreshPromise);
  return refreshPromise;
}

function compareFileChanges(
  left: OrchestrationFileChangeSummary,
  right: OrchestrationFileChangeSummary,
): number {
  return (
    left.startedAt.localeCompare(right.startedAt) ||
    left.startedSequence - right.startedSequence ||
    left.id.localeCompare(right.id)
  );
}

export function fullThreadFileChangesQueryOptions(input: {
  threadId: ThreadId;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: orchestrationQueryKeys.threadFileChanges(input.threadId),
    queryFn: ({ signal }) =>
      fetchThreadFileChangesRpc(
        {
          threadId: input.threadId,
        },
        signal,
      ),
    enabled: input.enabled ?? true,
    gcTime: 30_000,
    staleTime: THREAD_AUX_QUERY_STALE_TIME_MS,
  });
}

export async function warmThreadFileChanges(
  queryClient: QueryClient,
  threadId: ThreadId,
  options?: { force?: boolean; signal?: AbortSignal },
): Promise<OrchestrationGetThreadFileChangesResult | null> {
  const queryKey = orchestrationQueryKeys.threadFileChanges(threadId);
  if (!options?.force && hasFreshQueryData(queryClient, queryKey, THREAD_AUX_QUERY_STALE_TIME_MS)) {
    return queryClient.getQueryData<OrchestrationGetThreadFileChangesResult>(queryKey) ?? null;
  }

  const result = await fetchThreadFileChangesRpc(
    {
      threadId,
    },
    options?.signal,
  );
  if (options?.signal?.aborted) {
    return null;
  }
  queryClient.setQueryData(queryKey, result);
  return result;
}

export async function fetchThreadFileChangesDelta(input: {
  threadId: ThreadId;
  afterSequenceExclusive: number;
}) {
  return fetchThreadFileChangesRpc(input);
}

export function mergeThreadFileChangesResult(
  current: OrchestrationGetThreadFileChangesResult | undefined,
  incoming: OrchestrationGetThreadFileChangesResult,
): OrchestrationGetThreadFileChangesResult {
  if (current && !incoming.isFullSync && incoming.latestSequence < current.latestSequence) {
    return current;
  }
  if (incoming.isFullSync || !current) {
    return {
      ...incoming,
      fileChanges: [...incoming.fileChanges].toSorted(compareFileChanges),
    };
  }

  const byId = new Map(
    current.fileChanges.map((fileChange) => [fileChange.id, fileChange] as const),
  );
  for (const fileChange of incoming.fileChanges) {
    const existing = byId.get(fileChange.id);
    if (!existing || fileChange.lastUpdatedSequence >= existing.lastUpdatedSequence) {
      byId.set(fileChange.id, fileChange);
    }
  }

  return {
    threadId: incoming.threadId,
    fileChanges: [...byId.values()].toSorted(compareFileChanges),
    latestSequence: Math.max(current.latestSequence, incoming.latestSequence),
    isFullSync: true,
  };
}

export function threadFileChangeQueryOptions(input: {
  threadId: ThreadId | null;
  fileChangeId: OrchestrationFileChangeId | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey:
      input.threadId && input.fileChangeId
        ? orchestrationQueryKeys.threadFileChange(input.threadId, input.fileChangeId)
        : ([...orchestrationQueryKeys.all, "threadFileChange", "disabled"] as const),
    queryFn: async () => {
      if (!input.threadId || !input.fileChangeId) {
        return { fileChange: null } satisfies OrchestrationGetThreadFileChangeResult;
      }
      const api = ensureNativeApi();
      return api.orchestration.getThreadFileChange({
        threadId: input.threadId,
        fileChangeId: input.fileChangeId,
      });
    },
    enabled: Boolean(input.threadId && input.fileChangeId) && (input.enabled ?? true),
    gcTime: 30_000,
    staleTime: Infinity,
  });
}
