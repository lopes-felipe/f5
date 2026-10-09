import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { isAgentComputerActive, useAgentComputerActivityStore } from "./agentComputerActivityStore";
const threadId = ThreadId.makeUnsafe("computer-thread");
beforeEach(() =>
  useAgentComputerActivityStore.setState({
    appNames: {},
    activity: {},
    grants: {},
    requests: {},
    paused: {},
    lease: { threadId: null },
  }),
);
describe("computer activity", () => {
  it("keeps running actions and held leases visible, then expires completed feedback", () => {
    const store = useAgentComputerActivityStore.getState();
    store.record({ threadId, op: "click", status: "started", backend: "native" });
    let activity = useAgentComputerActivityStore.getState().activity[threadId]!;
    expect(isAgentComputerActive(activity, activity.at + 60000, false)).toBe(true);
    store.record({ threadId, op: "click", status: "completed", backend: "native" });
    activity = useAgentComputerActivityStore.getState().activity[threadId]!;
    expect(isAgentComputerActive(activity, activity.at + 14999, false)).toBe(true);
    expect(isAgentComputerActive(activity, activity.at + 15000, false)).toBe(false);
    expect(isAgentComputerActive(activity, activity.at + 60000, true)).toBe(true);
  });
  it("settles cards without accepting unknown requests and preserves pause state", () => {
    const store = useAgentComputerActivityStore.getState();
    store.request({
      requestId: "r",
      threadId,
      backendIncarnation: "b",
      kind: "apps",
      reason: "Edit",
      apps: [],
    });
    store.settle({ requestId: "missing", threadId, allowed: true });
    store.settle({ requestId: "r", threadId, allowed: false });
    store.setPaused(threadId, true);
    expect(useAgentComputerActivityStore.getState().requests.r).toMatchObject({
      settled: true,
      allowed: false,
    });
    expect(useAgentComputerActivityStore.getState().requests.missing).toBeUndefined();
    expect(useAgentComputerActivityStore.getState().paused[threadId]).toBe(true);
  });
});
