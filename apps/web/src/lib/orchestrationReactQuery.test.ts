import {
  EventId,
  OrchestrationCommandExecutionId,
  ThreadId,
  TurnId,
  type OrchestrationCommandExecution,
  type OrchestrationCommandExecutionSummary,
  type OrchestrationGetThreadCommandExecutionResult,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as nativeApi from "../nativeApi";
import {
  applyThreadCommandExecutionEventToQueryCache,
  buildThreadHistoryBackfillInput,
  clearInFlightOrchestrationRpcRequests,
  invalidateThreadCommandExecutionDetailQueries,
  isProvisionalThreadDetail,
  mergeThreadCommandExecutionOutputAppendedDetailResult,
  mergeThreadCommandExecutionRecordedDetailResult,
  orchestrationQueryKeys,
  scheduleThreadCommandExecutionRefreshIfMissing,
  shouldBackfillThreadHistory,
  threadCommandExecutionQueryOptions,
} from "./orchestrationReactQuery";

const threadId = ThreadId.makeUnsafe("thread-1");
const turnId = TurnId.makeUnsafe("turn-1");
const commandExecutionId = OrchestrationCommandExecutionId.makeUnsafe("cmd-1");
type RecordedEvent = Extract<OrchestrationEvent, { type: "thread.command-execution-recorded" }>;
type OutputAppendedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.command-execution-output-appended" }
>;

function makeSummary(
  overrides: Partial<OrchestrationCommandExecutionSummary> = {},
): OrchestrationCommandExecutionSummary {
  return {
    id: commandExecutionId,
    threadId,
    turnId,
    providerItemId: null,
    command: "bun run lint",
    title: "bash",
    status: "running",
    detail: null,
    exitCode: null,
    startedAt: "2026-03-20T10:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-03-20T10:00:00.000Z",
    startedSequence: 1,
    lastUpdatedSequence: 1,
    ...overrides,
  };
}

function makeExecution(
  overrides: Partial<OrchestrationCommandExecution> = {},
): OrchestrationCommandExecution {
  const summary = makeSummary();
  return {
    ...summary,
    output: "",
    outputTruncated: false,
    ...overrides,
  };
}

function makeRecordedEvent(overrides: Partial<RecordedEvent> = {}): RecordedEvent {
  return {
    sequence: 2,
    eventId: EventId.makeUnsafe("event-command-recorded"),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-03-20T10:00:01.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.command-execution-recorded",
    payload: {
      threadId,
      commandExecution: {
        id: commandExecutionId,
        turnId,
        providerItemId: null,
        command: "bun run lint",
        title: "bash",
        status: "running",
        detail: null,
        exitCode: null,
        startedAt: "2026-03-20T10:00:00.000Z",
        completedAt: null,
        updatedAt: "2026-03-20T10:00:01.000Z",
      },
    },
    ...overrides,
  };
}

function makeOutputAppendedEvent(
  overrides: Partial<OutputAppendedEvent> = {},
): OutputAppendedEvent {
  return {
    sequence: 3,
    eventId: EventId.makeUnsafe("event-command-output"),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-03-20T10:00:02.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.command-execution-output-appended",
    payload: {
      threadId,
      commandExecutionId,
      chunk: "hello\n",
      updatedAt: "2026-03-20T10:00:02.000Z",
    },
    ...overrides,
  };
}

afterEach(() => {
  clearInFlightOrchestrationRpcRequests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("command execution detail cache helpers", () => {
  it("hydrates a missing detail result from a recorded summary", () => {
    const result = mergeThreadCommandExecutionRecordedDetailResult(
      { commandExecution: null },
      makeRecordedEvent(),
      makeSummary({
        updatedAt: "2026-03-20T10:00:01.000Z",
        lastUpdatedSequence: 2,
      }),
    );

    expect(result).toEqual({
      commandExecution: makeExecution({
        updatedAt: "2026-03-20T10:00:01.000Z",
        lastUpdatedSequence: 2,
      }),
    });
  });

  it("ignores stale recorded events for an already-loaded detail result", () => {
    const current = {
      commandExecution: makeExecution({
        status: "completed",
        exitCode: 0,
        completedAt: "2026-03-20T10:00:05.000Z",
        updatedAt: "2026-03-20T10:00:05.000Z",
        output: "done\n",
        lastUpdatedSequence: 5,
      }),
    } satisfies OrchestrationGetThreadCommandExecutionResult;

    expect(
      mergeThreadCommandExecutionRecordedDetailResult(
        current,
        makeRecordedEvent({ sequence: 4 }),
        makeSummary({
          status: "running",
          updatedAt: "2026-03-20T10:00:04.000Z",
          lastUpdatedSequence: 4,
        }),
      ),
    ).toBe(current);
  });

  it("ignores replayed output chunks and preserves newer output", () => {
    const current = {
      commandExecution: makeExecution({
        output: "hello\n",
        updatedAt: "2026-03-20T10:00:02.000Z",
        lastUpdatedSequence: 3,
      }),
    } satisfies OrchestrationGetThreadCommandExecutionResult;

    expect(
      mergeThreadCommandExecutionOutputAppendedDetailResult(
        current,
        makeOutputAppendedEvent({ sequence: 3 }),
        makeSummary({ lastUpdatedSequence: 3 }),
      ),
    ).toBe(current);
  });

  it("hydrates output chunks into a missing detail result while projection catches up", () => {
    const result = mergeThreadCommandExecutionOutputAppendedDetailResult(
      { commandExecution: null },
      makeOutputAppendedEvent(),
      makeSummary({
        updatedAt: "2026-03-20T10:00:01.000Z",
        lastUpdatedSequence: 2,
      }),
    );

    expect(result).toEqual({
      commandExecution: makeExecution({
        updatedAt: "2026-03-20T10:00:02.000Z",
        lastUpdatedSequence: 3,
        output: "hello\n",
      }),
    });
  });
});

describe("command execution detail query cache", () => {
  it("removes per-thread command detail queries on thread.reverted", async () => {
    const queryClient = new QueryClient();
    const queryKey = orchestrationQueryKeys.threadCommandExecution(threadId, commandExecutionId);
    queryClient.setQueryData(queryKey, {
      commandExecution: makeExecution({ output: "hello\n" }),
    } satisfies OrchestrationGetThreadCommandExecutionResult);

    applyThreadCommandExecutionEventToQueryCache(queryClient, {
      sequence: 4,
      eventId: EventId.makeUnsafe("event-thread-reverted"),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: "2026-03-20T10:00:03.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.reverted",
      payload: {
        threadId,
        turnCount: 0,
      },
    });

    expect(queryClient.getQueryState(queryKey)).toBeUndefined();
  });

  it("refetches only the reconciled command's detail after a verified output repair", async () => {
    const queryClient = new QueryClient();
    const queryKey = orchestrationQueryKeys.threadCommandExecution(threadId, commandExecutionId);
    const otherKey = orchestrationQueryKeys.threadCommandExecution(
      threadId,
      OrchestrationCommandExecutionId.makeUnsafe("cmd-2"),
    );
    for (const key of [queryKey, otherKey])
      queryClient.setQueryData(key, {
        commandExecution: makeExecution({ output: "hello\n" }),
      } satisfies OrchestrationGetThreadCommandExecutionResult);

    applyThreadCommandExecutionEventToQueryCache(queryClient, {
      sequence: 6,
      eventId: EventId.makeUnsafe("event-command-output-reconciled"),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: "2026-03-20T10:00:06.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.command-execution-output-reconciled",
      payload: {
        threadId,
        commandExecutionId,
        expectedLastUpdatedSequence: 5,
        output: "hello\nworld\n",
        outputTruncated: false,
        updatedAt: "2026-03-20T10:00:06.000Z",
      },
    });

    await vi.waitFor(() => expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true));
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
  });

  it("refetches a repaired command's detail even while an older read is in flight", async () => {
    const queryClient = new QueryClient();
    let finishOld: (value: OrchestrationGetThreadCommandExecutionResult) => void = () => {};
    const repaired = makeExecution({ output: "hello\nworld\n", lastUpdatedSequence: 6 });
    const getThreadCommandExecution = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<OrchestrationGetThreadCommandExecutionResult>((resolve) => {
          finishOld = resolve;
        }),
      )
      .mockResolvedValueOnce({ commandExecution: repaired });
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      orchestration: { getThreadCommandExecution },
    } as unknown as ReturnType<typeof nativeApi.ensureNativeApi>);
    const observer = new QueryObserver(
      queryClient,
      threadCommandExecutionQueryOptions({ threadId, commandExecutionId }),
    );
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(getThreadCommandExecution).toHaveBeenCalledTimes(1));
      applyThreadCommandExecutionEventToQueryCache(queryClient, {
        sequence: 6,
        eventId: EventId.makeUnsafe("event-command-output-reconciled-in-flight"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-03-20T10:00:06.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.command-execution-output-reconciled",
        payload: {
          threadId,
          commandExecutionId,
          expectedLastUpdatedSequence: 5,
          output: "hello\nworld\n",
          outputTruncated: false,
          updatedAt: "2026-03-20T10:00:06.000Z",
        },
      });
      // The pre-repair read answers late with the old output.
      finishOld({ commandExecution: makeExecution({ output: "hello\n" }) });
      await vi.waitFor(() =>
        expect(
          queryClient.getQueryData(
            orchestrationQueryKeys.threadCommandExecution(threadId, commandExecutionId),
          ),
        ).toEqual({ commandExecution: repaired }),
      );
      expect(getThreadCommandExecution).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it("invalidates command detail queries across reconnect recovery", async () => {
    const queryClient = new QueryClient();
    const queryKey = orchestrationQueryKeys.threadCommandExecution(threadId, commandExecutionId);
    queryClient.setQueryData(queryKey, {
      commandExecution: makeExecution({ output: "hello\n" }),
    } satisfies OrchestrationGetThreadCommandExecutionResult);

    await invalidateThreadCommandExecutionDetailQueries(queryClient);

    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
  });

  it("retries provisional null details until the projection-backed RPC resolves", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const queryKey = orchestrationQueryKeys.threadCommandExecution(threadId, commandExecutionId);
    queryClient.setQueryData(queryKey, {
      commandExecution: null,
    } satisfies OrchestrationGetThreadCommandExecutionResult);

    const getThreadCommandExecution = vi
      .fn()
      .mockResolvedValueOnce({ commandExecution: null })
      .mockResolvedValueOnce({
        commandExecution: makeExecution({
          status: "completed",
          exitCode: 0,
          completedAt: "2026-03-20T10:00:05.000Z",
          updatedAt: "2026-03-20T10:00:05.000Z",
          output: "done\n",
          lastUpdatedSequence: 5,
        }),
      } satisfies OrchestrationGetThreadCommandExecutionResult);
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      orchestration: {
        getThreadCommandExecution,
      },
    } as unknown as ReturnType<typeof nativeApi.ensureNativeApi>);

    const refreshPromise = scheduleThreadCommandExecutionRefreshIfMissing(queryClient, {
      threadId,
      commandExecutionId,
    });
    await vi.runAllTimersAsync();
    await refreshPromise;

    expect(getThreadCommandExecution).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(queryKey)).toEqual({
      commandExecution: makeExecution({
        status: "completed",
        exitCode: 0,
        completedAt: "2026-03-20T10:00:05.000Z",
        updatedAt: "2026-03-20T10:00:05.000Z",
        output: "done\n",
        lastUpdatedSequence: 5,
      }),
    });
  });
});

describe("thread history backfill helpers", () => {
  it("ignores older command history when transcripts are hidden", () => {
    const history = {
      stage: "tail",
      hasOlderMessages: false,
      hasOlderCheckpoints: false,
      hasOlderActivities: false,
      hasOlderCommandExecutions: true,
      oldestLoadedMessageCursor: null,
      oldestLoadedCheckpointTurnCount: null,
      oldestLoadedActivityCursor: null,
      oldestLoadedCommandExecutionCursor: {
        startedAt: "2026-03-20T10:00:00.000Z",
        startedSequence: 1,
        commandExecutionId,
      },
      generation: 1,
    } as const;

    expect(shouldBackfillThreadHistory(history)).toBe(false);
    expect(buildThreadHistoryBackfillInput(threadId, history)).toBeNull();
  });

  it("includes older command history cursors when transcripts are enabled", () => {
    const history = {
      stage: "tail",
      hasOlderMessages: false,
      hasOlderCheckpoints: false,
      hasOlderActivities: false,
      hasOlderCommandExecutions: true,
      oldestLoadedMessageCursor: null,
      oldestLoadedCheckpointTurnCount: null,
      oldestLoadedActivityCursor: null,
      oldestLoadedCommandExecutionCursor: {
        startedAt: "2026-03-20T10:00:00.000Z",
        startedSequence: 1,
        commandExecutionId,
      },
      generation: 1,
    } as const;

    expect(
      buildThreadHistoryBackfillInput(threadId, history, {
        includeCommandExecutionHistory: true,
      }),
    ).toEqual({
      threadId,
      beforeMessageCursor: null,
      beforeCheckpointTurnCount: null,
      activityCursor: null,
      beforeCommandExecutionCursor: history.oldestLoadedCommandExecutionCursor,
    });
  });
});

describe("isProvisionalThreadDetail", () => {
  it("flags zero-sequence detail payloads as provisional", () => {
    expect(isProvisionalThreadDetail({ detailSequence: 0 })).toBe(true);
    expect(isProvisionalThreadDetail({ detailSequence: 12 })).toBe(false);
  });
});
