import { expect, it } from "vitest";
import { PiTurnState, type PiTurnAction } from "./PiTurnState.ts";

const probe = (actions: readonly PiTurnAction[]) => {
  const action = actions.find((action) => action.type === "send");
  expect(action).toBeDefined();
  if (action?.type !== "send") throw new Error("Expected an idle probe.");
  return String(action.record.id);
};
const idle = (id: string, data: unknown = { isStreaming: false, pendingMessageCount: 0 }) => ({
  type: "response",
  id,
  success: true,
  command: "get_state",
  data,
});
const admit = (state: PiTurnState, commandOnly = false) =>
  state.admit({ turnId: "turn-1", command: "prompt", commandOnly });

it("requires the owned prompt acknowledgement and a stream-ordered idle response before completion", () => {
  const state = new PiTurnState();
  const id = admit(state);
  state.observe({ type: "agent_start" });
  expect(state.observe({ type: "agent_end" })).toEqual([]);
  expect(state.observe({ type: "agent_settled" })).toEqual([]);
  const barrier = probe(state.observe({ type: "response", id, command: "prompt", success: true }));
  expect(state.activeTurnId).toBe("turn-1");
  expect(state.observe(idle(barrier))).toEqual([
    { type: "terminal", turnId: "turn-1", state: "completed" },
  ]);
  expect(state.observe(idle(barrier))).toEqual([]);
});
it("settles a command-only slash prompt without waiting for nonexistent agent events", () => {
  const state = new PiTurnState();
  const id = admit(state, true);
  const barrier = probe(state.observe({ type: "response", id, command: "prompt", success: true }));
  expect(state.observe(idle(barrier))).toMatchObject([{ type: "terminal", state: "completed" }]);
});
it("does not let a late idle response complete work that began after its probe", () => {
  const state = new PiTurnState();
  const id = admit(state, true);
  const old = probe(state.observe({ type: "response", id, command: "prompt", success: true }));
  state.observe({ type: "agent_start" });
  expect(state.observe(idle(old))).toEqual([]);
  const current = probe(state.observe({ type: "agent_settled" }));
  expect(state.observe(idle(current))).toMatchObject([{ type: "terminal", state: "completed" }]);
});
it.each([
  { isStreaming: true, pendingMessageCount: 0 },
  { isStreaming: false, pendingMessageCount: 1 },
  { isStreaming: false, isCompacting: true, pendingMessageCount: 0 },
])("retries while Pi reports native work: %j", (data) => {
  const state = new PiTurnState();
  const id = admit(state, true);
  const barrier = probe(state.observe({ type: "response", id, command: "prompt", success: true }));
  const retry = state.observe(idle(barrier, data))[0];
  expect(retry?.type).toBe("retry-probe");
  if (retry?.type !== "retry-probe") return;
  const next = probe(state.retryProbe(retry.turnId, retry.revision));
  expect(state.observe(idle(next))).toMatchObject([{ type: "terminal", state: "completed" }]);
});
it.each([{}, { isStreaming: false }, { isStreaming: false, pendingMessageCount: -1 }])(
  "stops on invalid idle evidence: %j",
  (data) => {
    const state = new PiTurnState();
    const id = admit(state, true);
    const barrier = probe(
      state.observe({ type: "response", id, command: "prompt", success: true }),
    );
    expect(state.observe(idle(barrier, data))).toEqual([
      { type: "stop-session", reason: "invalid-idle-state" },
    ]);
  },
);
it("does not substitute success when a native abort was not initiated in F5", () => {
  const state = new PiTurnState();
  const id = admit(state);
  state.observe({ type: "response", id, command: "prompt", success: true });
  const barrier = probe(state.observe({ type: "agent_settled", aborted: true }));
  expect(state.observe(idle(barrier))).toMatchObject([{ type: "terminal", state: "interrupted" }]);
});
it.each([false, true])("clears model errors only when native retries recover: %s", (success) => {
  const state = new PiTurnState();
  const id = admit(state);
  state.observe({ type: "response", id, command: "prompt", success: true });
  state.observe({ type: "message_end", message: { role: "assistant", stopReason: "error" } });
  state.observe({ type: "auto_retry_end", success });
  const barrier = probe(state.observe({ type: "agent_settled" }));
  expect(state.observe(idle(barrier))).toMatchObject([
    { type: "terminal", state: success ? "completed" : "failed" },
  ]);
});
it("rejects overlapping turns, stale acknowledgements and expired probes", () => {
  const state = new PiTurnState();
  const id = admit(state, true);
  expect(() => admit(state)).toThrow();
  expect(state.observe({ type: "response", id: "old", command: "prompt", success: true })).toEqual(
    [],
  );
  expect(state.observe({ type: "response", command: "extension", success: true })).toEqual([]);
  const barrier = probe(state.observe({ type: "response", id, command: "prompt", success: true }));
  expect(state.expireProbe("old")).toEqual([]);
  expect(state.expireProbe(barrier)).toEqual([
    { type: "stop-session", reason: "idle-probe-timeout" },
  ]);
  expect(() => admit(state)).toThrow();
});
it("refuses unowned native activity instead of attributing it to the last completed turn", () => {
  const state = new PiTurnState();
  expect(state.observe({ type: "agent_start" })).toEqual([
    { type: "stop-session", reason: "unowned-work" },
  ]);
  expect(() => admit(state)).toThrow();
});

it("waits for manual compaction to finish before probing and ignores duplicate acknowledgements", () => {
  const state = new PiTurnState();
  const id = state.admit({ turnId: "compact-1", command: "compact", commandOnly: true });
  state.observe({ type: "compaction_start" });
  expect(state.observe({ type: "response", id, command: "compact", success: true })).toEqual([]);
  const barrier = probe(state.observe({ type: "compaction_end", result: { summary: "Done" } }));
  expect(state.observe({ type: "response", id, command: "compact", success: false })).toEqual([]);
  expect(state.observe(idle(barrier))).toEqual([
    { type: "terminal", turnId: "compact-1", state: "completed" },
  ]);
});
it("retains an explicit stop through idle verification and rejects uncorrelated parse failures", () => {
  const state = new PiTurnState();
  const id = admit(state);
  state.observe({ type: "response", id, command: "prompt", success: true });
  expect(state.interrupt()).toEqual({ type: "abort" });
  const barrier = probe(state.observe({ type: "agent_settled" }));
  expect(state.observe(idle(barrier))).toMatchObject([{ type: "terminal", state: "interrupted" }]);
  expect(state.observe({ type: "response", command: "parse", success: false })).toEqual([
    { type: "stop-session", reason: "native-protocol-error" },
  ]);
});

it("owns a queued native continuation without waiting for or manufacturing a prompt acknowledgement", () => {
  const state = new PiTurnState();
  state.admitContinuation("native-1");
  state.observe({ type: "agent_start" });
  const barrier = probe(state.observe({ type: "agent_settled" }));
  expect(state.observe(idle(barrier))).toEqual([
    { type: "terminal", turnId: "native-1", state: "completed" },
  ]);
});
