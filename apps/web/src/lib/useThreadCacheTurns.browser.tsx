import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type UsageThreadTurn,
  type UsageThreadTurns,
  type UsageTurnFact,
} from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const api = vi.hoisted(() => ({
  getThreadTurns: vi.fn(),
  listeners: [] as Array<(event: OrchestrationEvent) => void>,
}));
vi.mock("../nativeApi", () => ({
  ensureNativeApi: () => ({
    usage: { getThreadTurns: api.getThreadTurns },
    orchestration: {
      onDomainEvent: (listener: (event: OrchestrationEvent) => void) => {
        api.listeners.push(listener);
        return () => {
          api.listeners = api.listeners.filter((entry) => entry !== listener);
        };
      },
    },
  }),
}));
vi.mock("../wsConnectionState", () => ({
  useWsConnectionState: () => ({ phase: "connected", connectedAt: "2026-11-13T10:00:00.000Z" }),
}));

import type { ChatMessage } from "../types";
import { turnBoundaryKey, useThreadCacheTurns } from "./useThreadCacheTurns";

const threadId = ThreadId.makeUnsafe("thread-1");

const turn = (id: string, cacheReadTokens: number): UsageThreadTurn => ({
  turnId: TurnId.makeUnsafe(id),
  provider: "claudeAgent",
  model: "claude-opus-5-5",
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens,
  cacheWriteTokens: 5,
  completedAt: `2026-11-13T10:0${id.slice(1)}:00.000Z`,
});

const fact = (id: string, thread: ThreadId): UsageTurnFact => ({
  ...turn(id, 777),
  threadId: thread,
  projectId: ProjectId.makeUnsafe("project"),
  providerInstanceId: null,
  totalTokens: 812,
  providerReportedCostUsd: null,
  tokenProvenance: "provider-reported",
  costProvenance: "unreported",
  sourceEventId: EventId.makeUnsafe(`event-${id}`),
});

function usageRecorded(usageFact: UsageTurnFact): OrchestrationEvent {
  return {
    type: "thread.usage-recorded",
    payload: { threadId: usageFact.threadId, usageFact },
  } as OrchestrationEvent;
}

const response = (...turns: UsageThreadTurn[]): UsageThreadTurns => ({
  turns,
  firstTurnId: turns[0]?.turnId ?? null,
  earlierTurnCount: 0,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const emit = (event: OrchestrationEvent) => {
  for (const listener of api.listeners) listener(event);
};

let latest: UsageThreadTurns | null = null;
const loadedTurns = () => latest?.turns.map((entry) => [entry.turnId, entry.cacheReadTokens]);
function Probe(props: { enabled: boolean }) {
  latest = useThreadCacheTurns(threadId, props.enabled);
  return null;
}

describe("turnBoundaryKey", () => {
  const message = (id: string, role: ChatMessage["role"], turn: string | null): ChatMessage => ({
    id: MessageId.makeUnsafe(id),
    role,
    text: "",
    turnId: turn ? TurnId.makeUnsafe(turn) : null,
    createdAt: "2026-11-13T10:00:00.000Z",
    streaming: true,
  });

  it("ignores streamed text and changes when a turn starts or a reply lands", () => {
    const user = message("u1", "user", null);
    const reply = message("a1", "assistant", "t1");
    const key = turnBoundaryKey([user, reply]);
    expect(turnBoundaryKey([user, { ...reply, text: "more streamed text" }])).toBe(key);
    expect(turnBoundaryKey([user, reply, message("u2", "user", null)])).not.toBe(key);
    expect(turnBoundaryKey([user, { ...reply, turnId: TurnId.makeUnsafe("t2") }])).not.toBe(key);
  });
});

describe("useThreadCacheTurns", () => {
  let client: QueryClient;
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.getThreadTurns.mockReset();
    api.listeners = [];
    latest = null;
  });
  afterEach(() => {
    client.clear();
  });

  it("makes no request while the setting is off", async () => {
    api.getThreadTurns.mockResolvedValue(response(turn("t1", 900)));
    const screen = await render(
      <QueryClientProvider client={client}>
        <Probe enabled={false} />
      </QueryClientProvider>,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(api.getThreadTurns).not.toHaveBeenCalled();
      expect(api.listeners).toHaveLength(0);
      expect(latest).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("loads once and merges this thread's live turns without refetching", async () => {
    api.getThreadTurns.mockResolvedValue(response(turn("t1", 900)));
    const screen = await render(
      <QueryClientProvider client={client}>
        <Probe enabled />
      </QueryClientProvider>,
    );
    try {
      await vi.waitFor(() => expect(loadedTurns()).toEqual([["t1", 900]]));
      expect(api.getThreadTurns).toHaveBeenCalledWith({ threadId }, expect.anything());

      emit(usageRecorded(fact("t2", ThreadId.makeUnsafe("other-thread"))));
      emit(usageRecorded(fact("aside:event-9", threadId)));
      emit(usageRecorded(fact("t2", threadId)));
      await vi.waitFor(() =>
        expect(loadedTurns()).toEqual([
          ["t1", 900],
          ["t2", 777],
        ]),
      );
      expect(api.getThreadTurns).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps facts that land while the first load or a refetch is in flight", async () => {
    // Both responses were read before the projector wrote the live fact.
    const first = deferred<UsageThreadTurns>();
    const second = deferred<UsageThreadTurns>();
    api.getThreadTurns.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const screen = await render(
      <QueryClientProvider client={client}>
        <Probe enabled />
      </QueryClientProvider>,
    );
    try {
      await vi.waitFor(() => expect(api.getThreadTurns).toHaveBeenCalledTimes(1));
      emit(usageRecorded(fact("t2", threadId)));
      first.resolve(response(turn("t1", 900)));
      await vi.waitFor(() =>
        expect(loadedTurns()).toEqual([
          ["t1", 900],
          ["t2", 777],
        ]),
      );

      void client.invalidateQueries({ queryKey: ["usage", "thread-turns", threadId] });
      await vi.waitFor(() => expect(api.getThreadTurns).toHaveBeenCalledTimes(2));
      emit(usageRecorded(fact("t3", threadId)));
      second.resolve(response(turn("t1", 900), turn("t2", 777)));
      await vi.waitFor(() =>
        expect(loadedTurns()).toEqual([
          ["t1", 900],
          ["t2", 777],
          ["t3", 777],
        ]),
      );
    } finally {
      await screen.unmount();
    }
  });
});
