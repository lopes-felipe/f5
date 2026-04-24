import {
  EventId,
  MessageId,
  type OrchestrationGetThreadCommandExecutionsResult,
  type OrchestrationGetThreadHistoryPageInput,
  type OrchestrationThreadHistoryPage,
  ProjectId,
  ThreadId,
  TurnId,
  type CodeReviewWorkflow,
  type NativeApi,
  type OrchestrationEvent,
  type OrchestrationGetThreadFileChangesResult,
  type OrchestrationThreadTailDetails,
  type PlanningWorkflow,
} from "@t3tools/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as nativeApi from "../nativeApi";
import { useStore, type AppState } from "../store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "../types";
import {
  getLiveThreadWarmThreadIdForDomainEvent,
  LIVE_THREAD_WARM_CONCURRENCY,
  RECENT_THREAD_PRELOAD_CONCURRENCY,
  RECENT_THREAD_PRELOAD_COUNT,
  preloadRecentThreadDetails,
  resetLiveThreadWarmSchedulerForTests,
  scheduleLiveThreadWarmForDomainEvent,
  warmThreadBundle,
} from "./threadPreload";
import {
  clearInFlightOrchestrationRpcRequests,
  ensureThreadHistoryBackfill,
  orchestrationQueryKeys,
  threadDetailQueryOptions,
  resetProvisionalThreadDetailRefreshesForTests,
} from "./orchestrationReactQuery";
import { createEmptyThreadHistoryState } from "./threadHistory";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
type OrchestrationGetThreadDetailsResult = OrchestrationThreadTailDetails;

function makeThread(overrides: Partial<Thread> & Pick<Thread, "id">): Thread {
  return {
    codexThreadId: null,
    projectId: PROJECT_ID,
    title: "Thread",
    model: "gpt-5-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    commandExecutions: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    lastInteractionAt: "2026-03-01T00:00:00.000Z",
    estimatedContextTokens: null,
    modelContextWindowTokens: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    detailsLoaded: false,
    history: createEmptyThreadHistoryState(),
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    sessionNotes: null,
    threadReferences: [],
    ...overrides,
  };
}

function makeDetails(
  threadId: ThreadId,
  overrides: Partial<OrchestrationThreadTailDetails> = {},
): OrchestrationThreadTailDetails {
  return {
    threadId,
    messages: [],
    checkpoints: [],
    activities: [],
    commandExecutions: [],
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    sessionNotes: null,
    threadReferences: [],
    hasOlderMessages: false,
    hasOlderCheckpoints: false,
    hasOlderCommandExecutions: false,
    oldestLoadedMessageCursor: null,
    oldestLoadedCheckpointTurnCount: null,
    oldestLoadedCommandExecutionCursor: null,
    detailSequence: 1,
    ...overrides,
  };
}

function seedStore(partial: Partial<AppState>): void {
  useStore.setState({
    projects: [],
    threads: [],
    planningWorkflows: [],
    codeReviewWorkflows: [],
    threadsHydrated: true,
    lastAppliedSequence: 0,
    detailEventBufferByThreadId: new Map(),
    changedFilesExpandedByThreadId: {},
    ...partial,
  } as AppState);
}

function createThreadList(count: number): Thread[] {
  return Array.from({ length: count }, (_, i) =>
    makeThread({
      id: ThreadId.makeUnsafe(`thread-${String(i).padStart(2, "0")}`),
      title: `Thread ${i}`,
      // Newer index → newer lastInteractionAt so sort-descending puts it first.
      lastInteractionAt: new Date(Date.UTC(2026, 2, 1, 0, i)).toISOString(),
    }),
  );
}

function mockGetThreadDetails(
  impl: (args: { threadId: ThreadId }) => Promise<OrchestrationThreadTailDetails>,
): ReturnType<typeof vi.fn> {
  return mockOrchestrationQueries({ getThreadTailDetails: impl }).getThreadTailDetails;
}

function makeThreadCommandExecutionsResult(
  threadId: ThreadId,
): OrchestrationGetThreadCommandExecutionsResult {
  return {
    threadId,
    executions: [],
    latestSequence: 1,
    isFullSync: true,
  };
}

function makeThreadFileChangesResult(threadId: ThreadId): OrchestrationGetThreadFileChangesResult {
  return {
    threadId,
    fileChanges: [],
    latestSequence: 1,
    isFullSync: true,
  };
}

function mockOrchestrationQueries(options?: {
  getThreadTailDetails?: (args: { threadId: ThreadId }) => Promise<OrchestrationThreadTailDetails>;
  getThreadDetails?: (args: { threadId: ThreadId }) => Promise<OrchestrationThreadTailDetails>;
  getThreadHistoryPage?: (
    args: OrchestrationGetThreadHistoryPageInput,
  ) => Promise<OrchestrationThreadHistoryPage>;
  getThreadCommandExecutions?: (args: {
    threadId: ThreadId;
    afterSequenceExclusive?: number;
  }) => Promise<OrchestrationGetThreadCommandExecutionsResult>;
  getThreadFileChanges?: (args: {
    threadId: ThreadId;
    afterSequenceExclusive?: number;
  }) => Promise<OrchestrationGetThreadFileChangesResult>;
}) {
  const getThreadTailDetails = vi.fn(
    options?.getThreadTailDetails ??
      options?.getThreadDetails ??
      (async ({ threadId }) => makeDetails(threadId)),
  );
  const getThreadHistoryPage = vi.fn(
    options?.getThreadHistoryPage ??
      (async ({ threadId }) => ({
        threadId,
        messages: [],
        checkpoints: [],
        commandExecutions: [],
        hasOlderMessages: false,
        hasOlderCheckpoints: false,
        hasOlderCommandExecutions: false,
        oldestLoadedMessageCursor: null,
        oldestLoadedCheckpointTurnCount: null,
        oldestLoadedCommandExecutionCursor: null,
        detailSequence: 1,
      })),
  );
  const getThreadCommandExecutions = vi.fn(
    options?.getThreadCommandExecutions ??
      (async ({ threadId }) => makeThreadCommandExecutionsResult(threadId)),
  );
  const getThreadFileChanges = vi.fn(
    options?.getThreadFileChanges ??
      (async ({ threadId }) => makeThreadFileChangesResult(threadId)),
  );
  vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
    orchestration: {
      getThreadTailDetails,
      getThreadHistoryPage,
      getThreadCommandExecutions,
      getThreadFileChanges,
    },
  } as unknown as NativeApi);
  return {
    getThreadTailDetails,
    getThreadDetails: getThreadTailDetails,
    getThreadHistoryPage,
    getThreadCommandExecutions,
    getThreadFileChanges,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeLiveMessageEvent(
  threadId: ThreadId,
  options?: { sequence?: number; streaming?: boolean; text?: string },
): Extract<OrchestrationEvent, { type: "thread.message-sent" }> {
  const sequence = options?.sequence ?? 1;
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-live-${threadId}-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-03-01T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.message-sent",
    payload: {
      threadId,
      messageId: MessageId.makeUnsafe(`assistant-live-${threadId}-${sequence}`),
      role: "assistant",
      text: options?.text ?? `live update for ${threadId}`,
      reasoningText: undefined,
      attachments: undefined,
      turnId: TurnId.makeUnsafe(`turn-live-${threadId}-${sequence}`),
      streaming: options?.streaming ?? true,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:01.000Z",
    },
  };
}

function makeGatedThreadEvent(
  type:
    | "thread.reverted"
    | "thread.turn-diff-completed"
    | "thread.tasks.updated"
    | "thread.session-notes-recorded",
  threadId: ThreadId,
): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: EventId.makeUnsafe(`event-${type}-${threadId}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-03-01T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload: { threadId },
  } as OrchestrationEvent;
}

describe("preloadRecentThreadDetails", () => {
  beforeEach(() => {
    seedStore({});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetProvisionalThreadDetailRefreshesForTests();
    resetLiveThreadWarmSchedulerForTests();
    clearInFlightOrchestrationRpcRequests();
    seedStore({});
  });

  it("constants are bounded and sensible", () => {
    expect(RECENT_THREAD_PRELOAD_COUNT).toBeGreaterThan(0);
    expect(RECENT_THREAD_PRELOAD_COUNT).toBeLessThanOrEqual(25);
    expect(RECENT_THREAD_PRELOAD_CONCURRENCY).toBeGreaterThan(0);
    expect(RECENT_THREAD_PRELOAD_CONCURRENCY).toBeLessThanOrEqual(RECENT_THREAD_PRELOAD_COUNT);
  });

  it("resolves the thread id for every gated live-warm event type", () => {
    const threadId = ThreadId.makeUnsafe("thread-gated");

    expect(getLiveThreadWarmThreadIdForDomainEvent(makeLiveMessageEvent(threadId))).toBe(threadId);
    expect(
      getLiveThreadWarmThreadIdForDomainEvent(makeGatedThreadEvent("thread.reverted", threadId)),
    ).toBe(threadId);
    expect(
      getLiveThreadWarmThreadIdForDomainEvent(
        makeGatedThreadEvent("thread.turn-diff-completed", threadId),
      ),
    ).toBe(threadId);
    expect(
      getLiveThreadWarmThreadIdForDomainEvent(
        makeGatedThreadEvent("thread.tasks.updated", threadId),
      ),
    ).toBe(threadId);
    expect(
      getLiveThreadWarmThreadIdForDomainEvent(
        makeGatedThreadEvent("thread.session-notes-recorded", threadId),
      ),
    ).toBe(threadId);
  });

  it("fetches the top N most-recent threads and writes through to the store", async () => {
    const threads = createThreadList(15);
    seedStore({ threads });
    const getThreadDetails = mockGetThreadDetails(async ({ threadId }) => makeDetails(threadId));
    const queryClient = new QueryClient();

    await preloadRecentThreadDetails(queryClient, { limit: 5, concurrency: 2 });

    expect(getThreadDetails).toHaveBeenCalledTimes(5);
    const fetchedIds = getThreadDetails.mock.calls.map(([args]) => args.threadId);
    // Threads are sorted descending by lastInteractionAt; the 5 most recent
    // in the seed list are thread-14 .. thread-10.
    expect(fetchedIds).toEqual(["thread-14", "thread-13", "thread-12", "thread-11", "thread-10"]);

    const state = useStore.getState();
    for (const id of fetchedIds) {
      const thread = state.threads.find((t) => t.id === id);
      expect(thread?.detailsLoaded).toBe(true);
    }
  });

  it("retries provisional thread details in the background", async () => {
    vi.useFakeTimers();
    const threadId = ThreadId.makeUnsafe("thread-00");
    seedStore({ threads: [makeThread({ id: threadId })] });

    const getThreadDetails = mockGetThreadDetails(async ({ threadId: requestedThreadId }) => {
      const callCount = getThreadDetails.mock.calls.length;
      return makeDetails(requestedThreadId, {
        detailSequence: callCount === 1 ? 0 : 3,
      });
    });

    await preloadRecentThreadDetails(new QueryClient(), { limit: 1, concurrency: 1 });
    await vi.runAllTimersAsync();

    expect(getThreadDetails).toHaveBeenCalledTimes(2);
  });

  it("dedupes an in-flight background detail warm with a foreground detail query", async () => {
    const threadId = ThreadId.makeUnsafe("thread-00");
    seedStore({ threads: [makeThread({ id: threadId })] });

    const deferred = createDeferred<OrchestrationGetThreadDetailsResult>();
    const { getThreadDetails } = mockOrchestrationQueries({
      getThreadDetails: async () => deferred.promise,
    });
    const queryClient = new QueryClient();
    const controller = new AbortController();

    const warmPromise = warmThreadBundle(queryClient, threadId, {
      signal: controller.signal,
    });

    await vi.waitFor(() => {
      expect(getThreadDetails).toHaveBeenCalledTimes(1);
    });

    const routeQueryPromise = queryClient.fetchQuery(threadDetailQueryOptions(threadId));
    deferred.resolve(makeDetails(threadId));

    await Promise.all([warmPromise, routeQueryPromise]);

    expect(getThreadDetails).toHaveBeenCalledTimes(1);
  });

  it("creates one live-warm buffer per thread and dedupes repeated live events", async () => {
    const threadId = ThreadId.makeUnsafe("thread-00");
    seedStore({
      threads: [makeThread({ id: threadId })],
      lastAppliedSequence: 1,
    });

    const deferred = createDeferred<OrchestrationGetThreadDetailsResult>();
    const { getThreadDetails } = mockOrchestrationQueries({
      getThreadDetails: async () => deferred.promise,
    });
    const queryClient = new QueryClient();

    const firstPromise = scheduleLiveThreadWarmForDomainEvent(
      queryClient,
      makeLiveMessageEvent(threadId, { sequence: 1 }),
    );
    const secondPromise = scheduleLiveThreadWarmForDomainEvent(
      queryClient,
      makeLiveMessageEvent(threadId, { sequence: 1, text: "duplicate" }),
    );

    expect(firstPromise).toBeTruthy();
    expect(secondPromise).toBe(firstPromise);
    expect(useStore.getState().detailEventBufferByThreadId.get(threadId)?.retainers).toBe(1);

    await vi.waitFor(() => {
      expect(getThreadDetails).toHaveBeenCalledTimes(1);
    });

    deferred.resolve(makeDetails(threadId));
    await Promise.all([firstPromise, secondPromise]);

    expect(useStore.getState().detailEventBufferByThreadId.has(threadId)).toBe(false);
  });

  it("waits for the caller's commit callback before starting the live warm", async () => {
    const threadId = ThreadId.makeUnsafe("thread-commit-gated");
    seedStore({
      threads: [makeThread({ id: threadId })],
      lastAppliedSequence: 1,
    });

    const deferredDetails = createDeferred<OrchestrationGetThreadDetailsResult>();
    const { getThreadDetails } = mockOrchestrationQueries({
      getThreadDetails: async () => deferredDetails.promise,
    });
    const commitReady = createDeferred<void>();
    const waitUntilSequenceCommitted = vi.fn(() => commitReady.promise);
    const queryClient = new QueryClient();

    const warmPromise = scheduleLiveThreadWarmForDomainEvent(
      queryClient,
      makeLiveMessageEvent(threadId, { sequence: 2 }),
      { waitUntilSequenceCommitted },
    );

    expect(warmPromise).toBeTruthy();
    expect(getThreadDetails).not.toHaveBeenCalled();

    commitReady.resolve();

    await vi.waitFor(() => {
      expect(getThreadDetails).toHaveBeenCalledTimes(1);
    });

    deferredDetails.resolve(makeDetails(threadId));
    await warmPromise;
    expect(waitUntilSequenceCommitted).toHaveBeenCalledWith(2, undefined);
  });

  it("falls back to the commit-wait timeout when the router never signals a commit", async () => {
    vi.useFakeTimers();
    const threadId = ThreadId.makeUnsafe("thread-timeout");
    seedStore({
      threads: [makeThread({ id: threadId })],
      lastAppliedSequence: 1,
    });

    const deferredDetails = createDeferred<OrchestrationGetThreadDetailsResult>();
    const { getThreadDetails } = mockOrchestrationQueries({
      getThreadDetails: async () => deferredDetails.promise,
    });
    const queryClient = new QueryClient();

    const warmPromise = scheduleLiveThreadWarmForDomainEvent(
      queryClient,
      makeLiveMessageEvent(threadId, { sequence: 2 }),
      { waitUntilSequenceCommitted: () => new Promise<void>(() => {}) },
    );

    expect(warmPromise).toBeTruthy();
    expect(getThreadDetails).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(119);
    expect(getThreadDetails).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(getThreadDetails).toHaveBeenCalledTimes(1);
    });

    deferredDetails.resolve(makeDetails(threadId));
    await warmPromise;
  });

  it("clears the live buffer and rejects when a background warm fails", async () => {
    const threadId = ThreadId.makeUnsafe("thread-live-error");
    seedStore({
      threads: [makeThread({ id: threadId })],
      lastAppliedSequence: 1,
    });

    const expectedError = new Error("tail rpc failed");
    mockOrchestrationQueries({
      getThreadDetails: async () => {
        throw expectedError;
      },
    });

    const warmPromise = scheduleLiveThreadWarmForDomainEvent(
      new QueryClient(),
      makeLiveMessageEvent(threadId, { sequence: 2 }),
    );

    await expect(warmPromise).rejects.toThrow("tail rpc failed");
    expect(useStore.getState().detailEventBufferByThreadId.has(threadId)).toBe(false);
  });

  it("bounds concurrent live warms while buffering every scheduled thread immediately", async () => {
    const threadIds = Array.from({ length: 4 }, (_, index) =>
      ThreadId.makeUnsafe(`thread-live-${index}`),
    );
    seedStore({
      threads: threadIds.map((threadId) => makeThread({ id: threadId })),
      lastAppliedSequence: 1,
    });

    const deferredByThreadId = new Map(
      threadIds.map((threadId) => [
        threadId,
        createDeferred<OrchestrationGetThreadDetailsResult>(),
      ]),
    );
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const { getThreadDetails } = mockOrchestrationQueries({
      getThreadDetails: async ({ threadId }) => {
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        try {
          const deferred = deferredByThreadId.get(threadId);
          if (!deferred) {
            throw new Error(`Missing deferred thread details for ${threadId}`);
          }
          return await deferred.promise;
        } finally {
          activeRequests -= 1;
        }
      },
    });
    const queryClient = new QueryClient();

    const warmPromises = threadIds.map((threadId) =>
      scheduleLiveThreadWarmForDomainEvent(
        queryClient,
        makeLiveMessageEvent(threadId, { sequence: 1 }),
      ),
    );

    expect(useStore.getState().detailEventBufferByThreadId.size).toBe(threadIds.length);

    await vi.waitFor(() => {
      expect(getThreadDetails).toHaveBeenCalledTimes(LIVE_THREAD_WARM_CONCURRENCY);
    });

    deferredByThreadId.get(threadIds[0]!)?.resolve(makeDetails(threadIds[0]!));

    await vi.waitFor(() => {
      expect(getThreadDetails).toHaveBeenCalledTimes(threadIds.length);
    });

    for (const threadId of threadIds.slice(1)) {
      deferredByThreadId.get(threadId)?.resolve(makeDetails(threadId));
    }
    await Promise.all(warmPromises);

    expect(maxActiveRequests).toBe(LIVE_THREAD_WARM_CONCURRENCY);
    expect(useStore.getState().detailEventBufferByThreadId.size).toBe(0);
  });

  it("starts a fresh history backfill after the tail generation changes", async () => {
    const threadId = ThreadId.makeUnsafe("thread-00");
    const deferredFirstPage = createDeferred<OrchestrationThreadHistoryPage>();
    const firstTailMessageId = MessageId.makeUnsafe("assistant-tail-1");
    const secondTailMessageId = MessageId.makeUnsafe("assistant-tail-2");

    seedStore({
      threads: [
        makeThread({
          id: threadId,
          detailsLoaded: true,
          messages: [
            {
              id: firstTailMessageId,
              role: "assistant",
              text: "tail 1",
              createdAt: "2026-03-01T00:04:00.000Z",
              completedAt: "2026-03-01T00:04:01.000Z",
              streaming: false,
            },
          ],
          history: {
            stage: "tail",
            hasOlderMessages: true,
            hasOlderCheckpoints: false,
            hasOlderCommandExecutions: false,
            oldestLoadedMessageCursor: {
              createdAt: "2026-03-01T00:04:00.000Z",
              messageId: firstTailMessageId,
            },
            oldestLoadedCheckpointTurnCount: null,
            oldestLoadedCommandExecutionCursor: null,
            generation: 1,
          },
        }),
      ],
    });

    const { getThreadHistoryPage } = mockOrchestrationQueries({
      getThreadHistoryPage: async ({ beforeMessageCursor, threadId: requestedThreadId }) => {
        if (
          beforeMessageCursor?.messageId === firstTailMessageId ||
          beforeMessageCursor?.messageId === secondTailMessageId
        ) {
          return deferredFirstPage.promise;
        }
        return {
          threadId: requestedThreadId,
          messages: [],
          checkpoints: [],
          commandExecutions: [],
          hasOlderMessages: false,
          hasOlderCheckpoints: false,
          hasOlderCommandExecutions: false,
          oldestLoadedMessageCursor: null,
          oldestLoadedCheckpointTurnCount: null,
          oldestLoadedCommandExecutionCursor: null,
          detailSequence: 1,
        };
      },
    });
    const queryClient = new QueryClient();
    const firstController = new AbortController();

    const firstBackfillPromise = ensureThreadHistoryBackfill(queryClient, threadId, {
      signal: firstController.signal,
    });
    await vi.waitFor(() => {
      expect(getThreadHistoryPage).toHaveBeenCalledTimes(1);
    });

    useStore.getState().syncThreadTailDetails(
      threadId,
      makeDetails(threadId, {
        messages: [
          {
            id: secondTailMessageId,
            role: "assistant",
            text: "tail 2",
            turnId: null,
            streaming: false,
            createdAt: "2026-03-01T00:05:00.000Z",
            updatedAt: "2026-03-01T00:05:01.000Z",
          },
        ],
        hasOlderMessages: true,
        hasOlderCheckpoints: false,
        hasOlderCommandExecutions: false,
        oldestLoadedMessageCursor: {
          createdAt: "2026-03-01T00:05:00.000Z",
          messageId: secondTailMessageId,
        },
        oldestLoadedCheckpointTurnCount: null,
        oldestLoadedCommandExecutionCursor: null,
        detailSequence: 2,
      }),
    );
    firstController.abort();

    const secondBackfillPromise = ensureThreadHistoryBackfill(queryClient, threadId);
    expect(secondBackfillPromise).not.toBe(firstBackfillPromise);

    deferredFirstPage.resolve({
      threadId,
      messages: [],
      checkpoints: [],
      commandExecutions: [],
      hasOlderMessages: false,
      hasOlderCheckpoints: false,
      hasOlderCommandExecutions: false,
      oldestLoadedMessageCursor: null,
      oldestLoadedCheckpointTurnCount: null,
      oldestLoadedCommandExecutionCursor: null,
      detailSequence: 3,
    });

    await Promise.all([firstBackfillPromise, secondBackfillPromise]);
    expect(getThreadHistoryPage).toHaveBeenCalledTimes(1);
    expect(useStore.getState().threads[0]?.history?.stage).toBe("complete");
    expect(useStore.getState().threads[0]?.history?.generation).toBe(2);
  });

  it("does not warm command execution summaries during recent thread preload", async () => {
    const threadId = ThreadId.makeUnsafe("thread-00");
    seedStore({ threads: [makeThread({ id: threadId })] });
    const { getThreadCommandExecutions, getThreadFileChanges } = mockOrchestrationQueries();

    await preloadRecentThreadDetails(new QueryClient(), {
      limit: 1,
      warmProfile: {
        includeFileChanges: false,
      },
    });

    expect(getThreadCommandExecutions).not.toHaveBeenCalled();
    expect(getThreadFileChanges).not.toHaveBeenCalled();
  });

  it("warms file-change summaries only when enabled in the warm profile", async () => {
    const threadId = ThreadId.makeUnsafe("thread-00");
    seedStore({ threads: [makeThread({ id: threadId })] });
    const { getThreadCommandExecutions, getThreadFileChanges } = mockOrchestrationQueries();

    await preloadRecentThreadDetails(new QueryClient(), {
      limit: 1,
      warmProfile: {
        includeFileChanges: true,
      },
    });

    expect(getThreadCommandExecutions).not.toHaveBeenCalled();
    expect(getThreadFileChanges).toHaveBeenCalledTimes(1);
    expect(getThreadFileChanges).toHaveBeenCalledWith({ threadId });
  });

  it("filters out already-loaded threads", async () => {
    // Mark the two newest threads (highest lastInteractionAt) as already
    // loaded so the preload only has to fetch the remaining three older
    // threads.
    const threads = createThreadList(5);
    for (let i = 3; i < threads.length; i++) {
      const thread = threads[i];
      if (thread) threads[i] = { ...thread, detailsLoaded: true };
    }
    seedStore({ threads });
    const getThreadDetails = mockGetThreadDetails(async ({ threadId }) => makeDetails(threadId));

    await preloadRecentThreadDetails(new QueryClient(), { limit: 10 });

    expect(getThreadDetails).toHaveBeenCalledTimes(3);
    const fetchedIds = getThreadDetails.mock.calls.map(([args]) => args.threadId);
    expect(new Set(fetchedIds)).toEqual(new Set(["thread-00", "thread-01", "thread-02"]));
  });

  it("filters out archived threads", async () => {
    const threads = createThreadList(4);
    threads[3] = { ...threads[3]!, archivedAt: "2026-03-01T01:00:00.000Z" };
    seedStore({ threads });
    const getThreadDetails = mockGetThreadDetails(async ({ threadId }) => makeDetails(threadId));

    await preloadRecentThreadDetails(new QueryClient(), { limit: 10 });

    const fetchedIds = getThreadDetails.mock.calls.map(([args]) => args.threadId);
    expect(fetchedIds).not.toContain("thread-03");
    expect(getThreadDetails).toHaveBeenCalledTimes(3);
  });

  it("excludes children of archived workflows", async () => {
    const hiddenChildId = ThreadId.makeUnsafe("workflow-author-hidden");
    const threads = [
      makeThread({
        id: ThreadId.makeUnsafe("thread-visible"),
        lastInteractionAt: "2026-03-10T00:00:00.000Z",
      }),
      makeThread({
        id: hiddenChildId,
        lastInteractionAt: "2026-03-11T00:00:00.000Z",
      }),
    ];
    const planningWorkflow: PlanningWorkflow = {
      id: "planning-1" as unknown as PlanningWorkflow["id"],
      projectId: PROJECT_ID,
      title: "Workflow",
      slug: "workflow",
      requirementPrompt: "",
      plansDirectory: "plans",
      selfReviewEnabled: true,
      branchA: {
        branchId: "a",
        authorSlot: { provider: "codex", model: "gpt-5-codex" },
        authorThreadId: hiddenChildId,
        planFilePath: null,
        planTurnId: null,
        revisionTurnId: null,
        reviews: [],
        status: "pending",
        error: null,
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
      branchB: {
        branchId: "b",
        authorSlot: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
        authorThreadId: null,
        planFilePath: null,
        planTurnId: null,
        revisionTurnId: null,
        reviews: [],
        status: "pending",
        error: null,
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
      merge: {
        mergeSlot: { provider: "codex", model: "gpt-5-codex" },
        threadId: null,
        outputFilePath: null,
        turnId: null,
        approvedPlanId: null,
        status: "not_started",
        error: null,
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
      implementation: null,
      totalCostUsd: 0,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      archivedAt: "2026-03-05T00:00:00.000Z",
      deletedAt: null,
    } as unknown as PlanningWorkflow;
    seedStore({
      threads,
      planningWorkflows: [planningWorkflow],
      codeReviewWorkflows: [] as CodeReviewWorkflow[],
    });
    const getThreadDetails = mockGetThreadDetails(async ({ threadId }) => makeDetails(threadId));

    await preloadRecentThreadDetails(new QueryClient(), { limit: 10 });

    const fetchedIds = getThreadDetails.mock.calls.map(([args]) => args.threadId);
    expect(fetchedIds).toEqual(["thread-visible"]);
  });

  it("includes children of non-archived workflows", async () => {
    // Positive counterpart to the archived-workflow test: if the parent
    // workflow is live (archivedAt === null), its author thread should be
    // eligible for preloading just like any other sidebar-visible thread.
    const activeChildId = ThreadId.makeUnsafe("workflow-author-active");
    const threads = [
      makeThread({
        id: ThreadId.makeUnsafe("thread-visible"),
        lastInteractionAt: "2026-03-10T00:00:00.000Z",
      }),
      makeThread({
        id: activeChildId,
        lastInteractionAt: "2026-03-11T00:00:00.000Z",
      }),
    ];
    const planningWorkflow: PlanningWorkflow = {
      id: "planning-1" as unknown as PlanningWorkflow["id"],
      projectId: PROJECT_ID,
      title: "Workflow",
      slug: "workflow",
      requirementPrompt: "",
      plansDirectory: "plans",
      selfReviewEnabled: true,
      branchA: {
        branchId: "a",
        authorSlot: { provider: "codex", model: "gpt-5-codex" },
        authorThreadId: activeChildId,
        planFilePath: null,
        planTurnId: null,
        revisionTurnId: null,
        reviews: [],
        status: "pending",
        error: null,
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
      branchB: {
        branchId: "b",
        authorSlot: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
        authorThreadId: null,
        planFilePath: null,
        planTurnId: null,
        revisionTurnId: null,
        reviews: [],
        status: "pending",
        error: null,
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
      merge: {
        mergeSlot: { provider: "codex", model: "gpt-5-codex" },
        threadId: null,
        outputFilePath: null,
        turnId: null,
        approvedPlanId: null,
        status: "not_started",
        error: null,
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
      implementation: null,
      totalCostUsd: 0,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      archivedAt: null,
      deletedAt: null,
    } as unknown as PlanningWorkflow;
    seedStore({
      threads,
      planningWorkflows: [planningWorkflow],
      codeReviewWorkflows: [] as CodeReviewWorkflow[],
    });
    const getThreadDetails = mockGetThreadDetails(async ({ threadId }) => makeDetails(threadId));

    await preloadRecentThreadDetails(new QueryClient(), { limit: 10 });

    const fetchedIds = new Set(getThreadDetails.mock.calls.map(([args]) => args.threadId));
    expect(fetchedIds).toEqual(new Set([activeChildId, "thread-visible"]));
  });

  it("skips threads passed via excludeThreadIds", async () => {
    // The caller force-prefetches the visible thread before firing the
    // warmth pass. Excluding it from the candidate list prevents the helper
    // from racing the in-flight prefetch and double-counting against the
    // shared RECENT_THREAD_PRELOAD_COUNT budget.
    const threads = createThreadList(4);
    seedStore({ threads });
    const getThreadDetails = mockGetThreadDetails(async ({ threadId }) => makeDetails(threadId));

    await preloadRecentThreadDetails(new QueryClient(), {
      limit: 10,
      excludeThreadIds: [ThreadId.makeUnsafe("thread-03"), ThreadId.makeUnsafe("thread-02")],
    });

    const fetchedIds = new Set(getThreadDetails.mock.calls.map(([args]) => args.threadId));
    expect(fetchedIds).toEqual(new Set(["thread-00", "thread-01"]));
  });

  it("caps concurrency to the configured limit", async () => {
    const threads = createThreadList(8);
    seedStore({ threads });

    let inFlight = 0;
    let maxInFlight = 0;
    const deferreds = Array.from({ length: 8 }, () => createDeferred<void>());
    let callCount = 0;
    const getThreadDetails = mockGetThreadDetails(async ({ threadId }) => {
      const deferred = deferreds.at(callCount);
      if (!deferred) {
        throw new Error("Missing deferred resolver for preload test.");
      }
      callCount += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await deferred.promise;
      inFlight -= 1;
      return makeDetails(threadId);
    });

    const preloadPromise = preloadRecentThreadDetails(new QueryClient(), {
      limit: 8,
      concurrency: 3,
    });

    await vi.waitFor(() => {
      expect(maxInFlight).toBe(3);
    });
    for (const deferred of deferreds) {
      deferred.resolve();
    }
    await preloadPromise;

    expect(getThreadDetails).toHaveBeenCalledTimes(8);
    expect(maxInFlight).toBe(3);
  });

  it("stops starting new fetches when the abort signal fires", async () => {
    const threads = createThreadList(10);
    seedStore({ threads });

    const controller = new AbortController();
    let callCount = 0;
    const getThreadDetails = mockGetThreadDetails(async ({ threadId }) => {
      callCount += 1;
      if (callCount === 1) {
        // Fire abort before returning the first response.
        controller.abort();
      }
      return makeDetails(threadId);
    });

    await preloadRecentThreadDetails(new QueryClient(), {
      limit: 10,
      concurrency: 1,
      signal: controller.signal,
    });

    // First fetch kicked off before abort; no additional fetches after.
    expect(getThreadDetails).toHaveBeenCalledTimes(1);
  });

  it("does not repopulate file-change cache after abort", async () => {
    const threadId = ThreadId.makeUnsafe("thread-00");
    seedStore({ threads: [makeThread({ id: threadId, detailsLoaded: true })] });

    const controller = new AbortController();
    const deferred = createDeferred<OrchestrationGetThreadFileChangesResult>();
    mockOrchestrationQueries({
      getThreadFileChanges: async () => deferred.promise,
    });
    const queryClient = new QueryClient();

    const warmPromise = warmThreadBundle(queryClient, threadId, {
      initialDetails: makeDetails(threadId),
      signal: controller.signal,
      warmProfile: {
        includeFileChanges: true,
      },
    });
    controller.abort();
    deferred.resolve(makeThreadFileChangesResult(threadId));
    await expect(warmPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(
      queryClient.getQueryData(orchestrationQueryKeys.threadFileChanges(threadId)),
    ).toBeUndefined();
  });

  it("is a no-op when the signal is aborted before starting", async () => {
    const threads = createThreadList(4);
    seedStore({ threads });
    const controller = new AbortController();
    controller.abort();
    const getThreadDetails = mockGetThreadDetails(async ({ threadId }) => makeDetails(threadId));

    await preloadRecentThreadDetails(new QueryClient(), {
      signal: controller.signal,
    });
    expect(getThreadDetails).not.toHaveBeenCalled();
  });

  it("does not clear a visible thread's live-event buffer when a preload aborts", async () => {
    const threadId = ThreadId.makeUnsafe("thread-00");
    const threads = [createThreadList(1)[0]!];
    const bufferedEvent: OrchestrationEvent = {
      sequence: 7,
      eventId: EventId.makeUnsafe("event-thread-message"),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: "2026-04-01T09:05:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.message-sent",
      payload: {
        threadId,
        messageId: MessageId.makeUnsafe("assistant-live"),
        role: "assistant",
        text: "live",
        reasoningText: undefined,
        attachments: undefined,
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: false,
        createdAt: "2026-04-01T09:04:00.000Z",
        updatedAt: "2026-04-01T09:04:01.000Z",
      },
    } as OrchestrationEvent;
    seedStore({
      threads,
      detailEventBufferByThreadId: new Map([
        [
          threadId,
          {
            retainers: 1,
            events: [
              {
                sequence: 7,
                eventId: EventId.makeUnsafe("event-thread-message"),
                aggregateKind: "thread",
                aggregateId: threadId,
                occurredAt: "2026-04-01T09:05:00.000Z",
                commandId: null,
                causationEventId: null,
                correlationId: null,
                metadata: {},
                type: "thread.message-sent",
                payload: {
                  threadId,
                  messageId: MessageId.makeUnsafe("assistant-live"),
                  role: "assistant",
                  text: "live",
                  reasoningText: undefined,
                  attachments: undefined,
                  turnId: TurnId.makeUnsafe("turn-1"),
                  streaming: false,
                  createdAt: "2026-04-01T09:04:00.000Z",
                  updatedAt: "2026-04-01T09:04:01.000Z",
                },
              },
            ],
          },
        ],
      ]),
    });
    const controller = new AbortController();
    const getThreadDetails = mockGetThreadDetails(async ({ threadId }) => {
      controller.abort();
      return makeDetails(threadId);
    });

    await preloadRecentThreadDetails(new QueryClient(), {
      limit: 1,
      concurrency: 1,
      signal: controller.signal,
    });

    expect(getThreadDetails).toHaveBeenCalledTimes(1);
    expect(useStore.getState().detailEventBufferByThreadId.get(threadId)).toEqual({
      retainers: 1,
      events: [bufferedEvent],
    });
  });

  it("is a no-op when limit is 0 or negative", async () => {
    const threads = createThreadList(4);
    seedStore({ threads });
    const getThreadDetails = mockGetThreadDetails(async ({ threadId }) => makeDetails(threadId));

    await preloadRecentThreadDetails(new QueryClient(), { limit: 0 });
    await preloadRecentThreadDetails(new QueryClient(), { limit: -3 });

    expect(getThreadDetails).not.toHaveBeenCalled();
  });

  it("is a no-op when all candidates are already loaded", async () => {
    const threads = createThreadList(3);
    for (let i = 0; i < threads.length; i++) {
      const thread = threads[i];
      if (thread) threads[i] = { ...thread, detailsLoaded: true };
    }
    seedStore({ threads });
    const getThreadDetails = mockGetThreadDetails(async ({ threadId }) => makeDetails(threadId));

    await preloadRecentThreadDetails(new QueryClient(), { limit: 10 });
    expect(getThreadDetails).not.toHaveBeenCalled();
  });

  it("isolates per-thread failures and logs via console.warn", async () => {
    const threads = createThreadList(4);
    seedStore({ threads });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const getThreadDetails = mockGetThreadDetails(async ({ threadId }) => {
      if (threadId === "thread-02") {
        throw new Error("boom");
      }
      return makeDetails(threadId);
    });

    await preloadRecentThreadDetails(new QueryClient(), { limit: 4, concurrency: 2 });

    expect(getThreadDetails).toHaveBeenCalledTimes(4);
    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to preload thread bundle.",
      expect.objectContaining({ threadId: "thread-02" }),
    );
    // Other threads still completed successfully.
    const state = useStore.getState();
    for (const id of ["thread-00", "thread-01", "thread-03"] as const) {
      expect(state.threads.find((t) => t.id === id)?.detailsLoaded).toBe(true);
    }
  });
});
