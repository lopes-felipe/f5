import { ThreadId, type AgentTranscriptPage } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useAgentTranscript } from "./useAgentTranscript";
import { useAgentTranscriptStore } from "../lib/agentTranscriptStore";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../nativeApi", () => ({
  ensureNativeApi: () => ({ agents: { readTranscript: mocks.read } }),
}));
vi.mock("../wsConnectionState", () => ({
  useWsConnectionState: () => ({ phase: "connected" }),
}));
const key = "parent\u0000agent";
const empty: AgentTranscriptPage = {
  availability: "ok",
  items: [],
  nextCursor: null,
  earlierCursor: null,
  tailCursor: "tail",
  pendingTail: false,
  reset: false,
};
function Harness({ live = false, visible = true }: { live?: boolean; visible?: boolean }) {
  const { refresh } = useAgentTranscript({
    threadId: ThreadId.makeUnsafe("parent"),
    nativeWorkItemId: "agent",
    workItemIds: ["agent"],
    live,
    visible,
    revision: "",
  });
  return <button onClick={() => void refresh()}>Refresh transcript</button>;
}
const state = () => useAgentTranscriptStore.getState().entries[key];
afterEach(() => {
  vi.useRealTimers();
  useAgentTranscriptStore.setState({ entries: {}, order: [] });
  mocks.read.mockReset();
});
describe("transcript refresh scheduling", () => {
  it.each([false, true])(
    "resumes settlement across tab switches (settles before unmount: %s)",
    async (settleBeforeUnmount) => {
      mocks.read.mockResolvedValue(empty);
      const first = await render(<Harness live />);
      await vi.waitFor(() => expect(state()?.observedLive).toBe(true));
      if (settleBeforeUnmount) {
        await first.rerender(<Harness />);
        await vi.waitFor(() => expect(state()?.settlement).toBe("pending"));
      }
      await first.unmount();
      expect(state()?.observedLive).toBe(!settleBeforeUnmount);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const second = await render(<Harness />);
      try {
        await vi.waitFor(() => expect(state()?.settlement).toBe("pending"));
        const beforeRetry = mocks.read.mock.calls.length;
        await vi.advanceTimersByTimeAsync(1000);
        expect(mocks.read.mock.calls.length).toBeGreaterThan(beforeRetry);
        await vi.advanceTimersByTimeAsync(14000);
        await vi.waitFor(() => expect(state()?.settlement).toBe("complete"));
        const settledCalls = mocks.read.mock.calls.length;
        await second.unmount();
        await vi.advanceTimersByTimeAsync(20000);
        expect(mocks.read.mock.calls.length).toBe(settledCalls);
      } finally {
        await second.unmount();
      }
    },
  );
  it("recovers session-not-running automatically without losing its tail", async () => {
    mocks.read.mockResolvedValue({
      ...empty,
      availability: "unavailable",
      reason: "session-not-running",
    });
    const screen = await render(<Harness live />);
    try {
      await vi.waitFor(() => expect(state()?.reason).toBe("session-not-running"));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      // Changing visibility re-arms the timers under the fake clock.
      await screen.rerender(<Harness live visible={false} />);
      mocks.read.mockResolvedValue(empty);
      await screen.rerender(<Harness live />);
      await vi.waitFor(() => expect(state()?.availability).toBe("ok"));
      mocks.read.mockResolvedValue({
        ...empty,
        availability: "unavailable",
        reason: "session-not-running",
      });
      await vi.advanceTimersByTimeAsync(2000);
      await vi.waitFor(() => expect(state()?.reason).toBe("session-not-running"));
      mocks.read.mockResolvedValue(empty);
      await vi.advanceTimersByTimeAsync(10000);
      await vi.waitFor(() => expect(state()?.availability).toBe("ok"));
      expect(mocks.read.mock.lastCall?.[0].cursor).toBe("tail");
    } finally {
      await screen.unmount();
    }
  });
  it("bounds a live poll to four requests and keeps the catch-up cursor", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    mocks.read.mockResolvedValue(empty);
    const screen = await render(<Harness live />);
    try {
      await vi.waitFor(() => expect(state()?.inFlight).toBe(false));
      mocks.read.mockClear();
      mocks.read.mockImplementation(async () => ({
        ...empty,
        nextCursor: "page:" + mocks.read.mock.calls.length,
      }));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(state()?.inFlight).toBe(false));
      expect(mocks.read).toHaveBeenCalledTimes(4);
      expect(state()?.nextCursor).toBe("page:4");
    } finally {
      await screen.unmount();
    }
  });
});
