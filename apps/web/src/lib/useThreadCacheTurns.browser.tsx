import {
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type UsageThreadTurn,
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

import { useThreadCacheTurns } from "./useThreadCacheTurns";

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

let latest: ReadonlyArray<UsageThreadTurn> | null = null;
function Probe(props: { enabled: boolean }) {
  latest = useThreadCacheTurns(threadId, props.enabled);
  return null;
}

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
    api.getThreadTurns.mockResolvedValue({ turns: [turn("t1", 900)] });
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

  it("loads once and merges this thread's live facts without refetching", async () => {
    api.getThreadTurns.mockResolvedValue({ turns: [turn("t1", 900)] });
    const screen = await render(
      <QueryClientProvider client={client}>
        <Probe enabled />
      </QueryClientProvider>,
    );
    try {
      await vi.waitFor(() => expect(latest?.map((entry) => entry.turnId)).toEqual(["t1"]));
      expect(api.getThreadTurns).toHaveBeenCalledWith({ threadId }, expect.anything());

      for (const listener of api.listeners) {
        listener(usageRecorded(fact("t2", ThreadId.makeUnsafe("other-thread"))));
        listener(usageRecorded(fact("t2", threadId)));
      }
      await vi.waitFor(() =>
        expect(latest?.map((entry) => [entry.turnId, entry.cacheReadTokens])).toEqual([
          ["t1", 900],
          ["t2", 777],
        ]),
      );
      expect(api.getThreadTurns).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });
});
