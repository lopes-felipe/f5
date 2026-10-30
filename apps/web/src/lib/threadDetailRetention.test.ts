import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
  type OrchestrationThreadTailDetails,
} from "@t3tools/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useNextTurnQueueStore } from "../nextTurnQueueStore";
import { useStore, type AppState } from "../store";
import { selectThreadSummaryById } from "../threadSelectors";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "../types";
import { orchestrationQueryKeys } from "./orchestrationReactQuery";
import {
  enforceThreadDetailRetention,
  estimateThreadDetailBytes,
  isThreadDetailPrefetchOverBudget,
  planThreadDetailRetention,
  resetThreadDetailRetentionForTests,
  retainThreadDetail,
} from "./threadDetailRetention";
import { createEmptyThreadHistoryState } from "./threadHistory";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const threadIdAt = (index: number) =>
  ThreadId.makeUnsafe(`thread-${String(index).padStart(2, "0")}`);

function makeThread(index: number, overrides: Partial<Thread> = {}): Thread {
  return {
    id: threadIdAt(index),
    codexThreadId: null,
    projectId: PROJECT_ID,
    title: `Thread ${index}`,
    model: "gpt-5",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    commandExecutions: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    lastInteractionAt: new Date(Date.UTC(2026, 2, 1, 0, index)).toISOString(),
    estimatedContextTokens: null,
    estimatedThinkingTokens: null,
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

function makeTailDetails(threadId: ThreadId, text: string): OrchestrationThreadTailDetails {
  return {
    threadId,
    messages: [
      {
        id: MessageId.makeUnsafe(`${threadId}-assistant`),
        role: "assistant",
        text,
        turnId: null,
        streaming: false,
        createdAt: "2026-03-10T09:00:00.000Z",
        updatedAt: "2026-03-10T09:00:01.000Z",
      },
    ],
    checkpoints: [],
    activities: [],
    commandExecutions: [],
    proposedPlans: [],
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    sessionNotes: null,
    threadReferences: [],
    hasOlderMessages: false,
    hasOlderCheckpoints: false,
    hasOlderActivities: false,
    hasOlderCommandExecutions: false,
    oldestLoadedMessageCursor: null,
    oldestLoadedCheckpointTurnCount: null,
    oldestLoadedActivityCursor: null,
    oldestLoadedCommandExecutionCursor: null,
    detailSequence: 1,
  };
}

function seedStore(threads: Thread[]): void {
  useStore.setState({
    projects: [],
    threads,
    planningWorkflows: [],
    codeReviewWorkflows: [],
    investigationWorkflows: [],
    threadsHydrated: true,
    lastAppliedSequence: 0,
    detailEventBufferByThreadId: new Map(),
    changedFilesExpandedByThreadId: {},
  } as Partial<AppState>);
}

/** Opens a thread the way the route does: retain, then hydrate if needed. */
function openThread(threadId: ThreadId, text: string): () => void {
  const release = retainThreadDetail(threadId);
  const thread = useStore.getState().threads.find((entry) => entry.id === threadId);
  if (!thread?.detailsLoaded) {
    useStore.getState().syncThreadTailDetails(threadId, makeTailDetails(threadId, text));
  }
  return release;
}

function hydratedThreadIds(): ThreadId[] {
  return useStore
    .getState()
    .threads.filter((thread) => thread.detailsLoaded)
    .map((thread) => thread.id);
}

beforeEach(() => {
  resetThreadDetailRetentionForTests();
  useNextTurnQueueStore.setState({ byThreadId: {} });
});

afterEach(() => {
  resetThreadDetailRetentionForTests();
  seedStore([]);
});

describe("planThreadDetailRetention", () => {
  const loaded = (index: number) => makeThread(index, { detailsLoaded: true });

  it("evicts the least recently used threads beyond the thread limit", () => {
    const threads = [0, 1, 2, 3, 4].map(loaded);
    const plan = planThreadDetailRetention({
      threads,
      pinnedThreadIds: new Set(),
      lastUsedAtByThreadId: new Map(threads.map((thread, index) => [thread.id, 10 - index])),
      limits: { maxThreads: 3, maxBytes: Number.POSITIVE_INFINITY },
      estimateBytes: () => 1,
    });
    expect(plan.evictThreadIds).toEqual([threadIdAt(4), threadIdAt(3)]);
  });

  it("evicts by size, never touches pinned or unloaded threads, and reports pinned bytes", () => {
    const threads = [loaded(0), loaded(1), loaded(2), makeThread(3)];
    const plan = planThreadDetailRetention({
      threads,
      pinnedThreadIds: new Set([threadIdAt(0)]),
      lastUsedAtByThreadId: new Map([
        [threadIdAt(0), 1],
        [threadIdAt(1), 2],
        [threadIdAt(2), 3],
      ]),
      limits: { maxThreads: 10, maxBytes: 150 },
      estimateBytes: () => 100,
    });
    // Pinned thread 0 alone exceeds nothing; 300 bytes need two evictions.
    expect(plan.evictThreadIds).toEqual([threadIdAt(1), threadIdAt(2)]);
    expect(plan.pinnedBytes).toBe(100);
  });

  it("keeps pinned threads even when they alone exceed the limits", () => {
    const threads = [loaded(0), loaded(1)];
    const plan = planThreadDetailRetention({
      threads,
      pinnedThreadIds: new Set(threads.map((thread) => thread.id)),
      lastUsedAtByThreadId: new Map(),
      limits: { maxThreads: 1, maxBytes: 1 },
      estimateBytes: () => 100,
    });
    expect(plan.evictThreadIds).toEqual([]);
    expect(plan.pinnedBytes).toBe(200);
  });
});

describe("enforceThreadDetailRetention", () => {
  it("drops detail bodies and cached tails but keeps summaries and activities", () => {
    const activity: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("activity-1"),
      tone: "info",
      kind: "tool.completed",
      summary: "Ran a tool",
      payload: {},
      turnId: TurnId.makeUnsafe("turn-1"),
      createdAt: "2026-03-01T00:00:00.000Z",
    };
    seedStore([0, 1, 2].map((index) => makeThread(index)));
    const releases = [0, 1, 2].map((index) => openThread(threadIdAt(index), `body ${index}`));
    releases.forEach((release) => release());
    useStore.setState((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === threadIdAt(0) ? { ...thread, activities: [activity] } : thread,
      ),
    }));
    const queryClient = new QueryClient();
    queryClient.setQueryData(orchestrationQueryKeys.threadDetails(threadIdAt(0)), {});
    queryClient.setQueryData(orchestrationQueryKeys.threadFileChanges(threadIdAt(0)), {});
    queryClient.setQueryData(orchestrationQueryKeys.threadDetails(threadIdAt(2)), {});
    const summaryBefore = selectThreadSummaryById(useStore.getState()).get(threadIdAt(0));
    const generationBefore = useStore
      .getState()
      .threads.find((entry) => entry.id === threadIdAt(0))!.history!.generation;

    const evicted = enforceThreadDetailRetention(queryClient, {
      maxThreads: 2,
      maxBytes: Number.POSITIVE_INFINITY,
    });

    expect(evicted).toEqual([threadIdAt(0)]);
    const thread = useStore.getState().threads.find((entry) => entry.id === threadIdAt(0))!;
    expect(thread).toMatchObject({ detailsLoaded: false, messages: [], activities: [activity] });
    // In-flight backfills for the old generation discard their results.
    expect(thread.history?.generation).toBe(generationBefore + 1);
    expect(selectThreadSummaryById(useStore.getState()).get(threadIdAt(0))).toBe(summaryBefore);
    expect(
      queryClient.getQueryData(orchestrationQueryKeys.threadDetails(threadIdAt(0))),
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(orchestrationQueryKeys.threadFileChanges(threadIdAt(0))),
    ).toBeUndefined();
    expect(queryClient.getQueryData(orchestrationQueryKeys.threadDetails(threadIdAt(2)))).toEqual(
      {},
    );
  });

  it("pins visible threads, in-flight loads, running turns and optimistic sends", () => {
    seedStore([0, 1, 2, 3, 4].map((index) => makeThread(index)));
    const releases = [0, 1, 2, 3, 4].map((index) => openThread(threadIdAt(index), "body"));
    releases.slice(1).forEach((release) => release());
    useStore.setState((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === threadIdAt(1)
          ? {
              ...thread,
              latestTurn: {
                turnId: TurnId.makeUnsafe("turn-running"),
                state: "running",
                requestedAt: "2026-03-01T00:00:00.000Z",
                startedAt: "2026-03-01T00:00:00.000Z",
                completedAt: null,
                assistantMessageId: null,
              },
            }
          : thread,
      ),
      detailEventBufferByThreadId: new Map([[threadIdAt(2), { events: [], retainers: 1 }]]),
    }));
    useNextTurnQueueStore.setState({
      byThreadId: {
        [threadIdAt(3)]: {
          optimistic: [{ threadId: threadIdAt(3) } as never],
        } as never,
      },
    });

    const evicted = enforceThreadDetailRetention(new QueryClient(), {
      maxThreads: 0,
      maxBytes: 0,
    });

    expect(evicted).toEqual([threadIdAt(4)]);
    expect(hydratedThreadIds()).toEqual([0, 1, 2, 3].map(threadIdAt));
    releases[0]!();
  });

  it("stays within budget across repeated large-thread switching and rehydrates correctly", () => {
    const threadCount = 16;
    seedStore(Array.from({ length: threadCount }, (_, index) => makeThread(index)));
    const queryClient = new QueryClient();
    const bodyFor = (index: number) => `thread ${index} `.repeat(20_000);
    const bodyBytes = estimateThreadDetailBytes({
      messages: [{ text: bodyFor(10) } as never],
      commandExecutions: [],
      turnDiffSummaries: [],
    });
    const limits = { maxThreads: 10, maxBytes: bodyBytes * 4.5 };

    let releaseCurrent: (() => void) | null = null;
    for (let step = 0; step < 64; step += 1) {
      const index = (step * 7) % threadCount;
      releaseCurrent?.();
      releaseCurrent = openThread(threadIdAt(index), bodyFor(index));
      enforceThreadDetailRetention(queryClient, limits);

      const current = useStore
        .getState()
        .threads.find((thread) => thread.id === threadIdAt(index))!;
      expect(current.detailsLoaded).toBe(true);
      expect(current.messages.map((message) => message.text)).toEqual([bodyFor(index)]);
      expect(hydratedThreadIds().length).toBeLessThanOrEqual(4);
    }
    releaseCurrent?.();
    expect(isThreadDetailPrefetchOverBudget()).toBe(false);
  });

  it("reports when pinned threads alone exceed the byte budget", () => {
    seedStore([makeThread(0)]);
    const release = openThread(threadIdAt(0), "x".repeat(10_000));
    enforceThreadDetailRetention(new QueryClient(), { maxThreads: 10, maxBytes: 1 });
    expect(isThreadDetailPrefetchOverBudget()).toBe(true);
    release();
    enforceThreadDetailRetention(new QueryClient(), { maxThreads: 10, maxBytes: 1 });
    expect(isThreadDetailPrefetchOverBudget()).toBe(false);
  });
});
