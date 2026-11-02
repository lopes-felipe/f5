import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAgentComputerActive, useAgentComputerActivityStore } from "./agentComputerActivityStore";
import {
  computerUseBannerTargets,
  computerUseBannerText,
  primaryComputerHolder,
} from "./components/ComputerUseBanner";
const threadId = ThreadId.makeUnsafe("computer-thread");
beforeEach(() => useAgentComputerActivityStore.getState().resetConnection());
describe("computer activity", () => {
  it("clears the last capture when a later action starts or completes without one", () => {
    const store = useAgentComputerActivityStore.getState();
    store.record({
      threadId,
      op: "activateApp",
      status: "completed",
      backend: "native",
      appName: "Fixture",
      thumbnailDataUrl: "SYNTHETIC_CAPTURE",
    });
    store.record({ threadId, op: "type", status: "started", backend: "native" });
    store.record({ threadId, op: "type", status: "completed", backend: "native" });
    const state = useAgentComputerActivityStore.getState();
    expect(state.activity[threadId]).toMatchObject({ op: "type", status: "completed" });
    expect(state.activity[threadId]?.thumbnailDataUrl).toBeUndefined();
    expect(state.lastCapture[threadId]).toBeUndefined();
    expect(state.lastCapture.otherThread).toBeUndefined();
  });
  it("discards capture content on grant changes, backend switches and reconnect", () => {
    const store = useAgentComputerActivityStore.getState();
    const captured = {
      threadId,
      op: "click",
      status: "completed" as const,
      backend: "native" as const,
      thumbnailDataUrl: "SYNTHETIC_CAPTURE",
    };
    store.record(captured);
    store.setGrants(threadId, []);
    expect(useAgentComputerActivityStore.getState().lastCapture[threadId]).toBeUndefined();
    expect(JSON.stringify(useAgentComputerActivityStore.getState())).not.toContain(
      "SYNTHETIC_CAPTURE",
    );
    store.record(captured);
    store.record({ threadId, op: "computer", status: "started", backend: "codex-builtin" });
    expect(useAgentComputerActivityStore.getState().lastCapture[threadId]).toBeUndefined();
    store.record(captured);
    store.resetConnection();
    expect(useAgentComputerActivityStore.getState().lastCapture).toEqual({});
  });
  it("keeps controls visible for 15 seconds after lease release even when the last action is older", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100000);
    try {
      const store = useAgentComputerActivityStore.getState();
      store.record({ threadId, op: "type", status: "completed", backend: "native" });
      store.setLeases({
        holders: [{ threadId, backend: "native", delivery: "foreground", state: "active" }],
      });
      clock.mockReturnValue(130000);
      store.setLeases({ holders: [] });
      const state = useAgentComputerActivityStore.getState();
      expect(state.lastLeaseAt[threadId]).toBe(130000);
      expect(
        isAgentComputerActive(state.activity[threadId], 144999, false, state.lastLeaseAt[threadId]),
      ).toBe(true);
      expect(
        isAgentComputerActive(state.activity[threadId], 145000, false, state.lastLeaseAt[threadId]),
      ).toBe(false);
      store.resetConnection();
      expect(useAgentComputerActivityStore.getState().lastLeaseAt).toEqual({});
    } finally {
      clock.mockRestore();
    }
  });
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
  it("discards missed consent settlements before replaying a reconnect snapshot", () => {
    const store = useAgentComputerActivityStore.getState();
    store.request({
      requestId: "expired",
      threadId,
      backendIncarnation: "old",
      kind: "apps",
      reason: "Old",
      apps: [],
    });
    store.setPaused(threadId, true);
    store.resetConnection();
    store.request({
      requestId: "current",
      threadId,
      backendIncarnation: "new",
      kind: "apps",
      reason: "New",
      apps: [],
    });
    store.settle({ requestId: "expired", threadId, allowed: true });
    expect(Object.keys(useAgentComputerActivityStore.getState().requests)).toEqual(["current"]);
    expect(useAgentComputerActivityStore.getState().requests.current?.settled).toBeUndefined();
    expect(useAgentComputerActivityStore.getState().paused[threadId]).toBeUndefined();
    store.resetConnection();
    expect(useAgentComputerActivityStore.getState().requests).toEqual({});
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
  it("tracks several holders and stamps only the removed ones", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(5000);
    try {
      const other = ThreadId.makeUnsafe("other-thread");
      const store = useAgentComputerActivityStore.getState();
      store.setLeases({
        holders: [
          {
            threadId,
            backend: "native",
            delivery: "background",
            appId: "com.apple.TextEdit",
            appName: "TextEdit",
            state: "active",
          },
          { threadId: other, backend: "native", delivery: "background", state: "active" },
        ],
      });
      expect(useAgentComputerActivityStore.getState().appNames["com.apple.TextEdit"]).toBe(
        "TextEdit",
      );
      store.setLeases({
        holders: [{ threadId: other, backend: "native", delivery: "background", state: "active" }],
      });
      expect(useAgentComputerActivityStore.getState().lastLeaseAt).toEqual({ [threadId]: 5000 });
    } finally {
      clock.mockRestore();
    }
  });
});
describe("computer use banner text", () => {
  const holder = {
    threadId,
    backend: "native" as const,
    delivery: "background" as const,
    appId: "com.apple.TextEdit",
    appName: "TextEdit",
    state: "active" as const,
  };
  it("names the app for background control and counts several agents", () => {
    expect(computerUseBannerText({ holders: [holder] }, false)).toBe(
      "An agent is working in TextEdit in the background",
    );
    expect(
      computerUseBannerText(
        {
          holders: [
            holder,
            { ...holder, threadId: ThreadId.makeUnsafe("b"), appId: "n", appName: "Notes" },
          ],
        },
        false,
      ),
    ).toBe("2 agents are working in the background in TextEdit, Notes");
    expect(
      computerUseBannerTargets({
        holders: [holder, { ...holder, threadId: ThreadId.makeUnsafe("b") }],
      }),
    ).toEqual([threadId, "b"]);
  });
  it("prefers foreground control, pending takeover and explains pauses", () => {
    expect(
      computerUseBannerText(
        { holders: [holder, { ...holder, delivery: "foreground", appId: undefined }] },
        false,
      ),
    ).toBe("An agent is controlling this computer");
    expect(
      computerUseBannerText(
        {
          holders: [holder],
          pendingTakeover: { threadId, appId: "x", appName: "Notes", state: "waiting-idle" },
        },
        false,
      ),
    ).toBe("An agent will take over Notes when you stop using the mouse and keyboard");
    expect(
      computerUseBannerText(
        { holders: [{ ...holder, state: "paused", pauseCause: "target-active" }] },
        false,
      ),
    ).toBe("Computer control paused · you are using that app");
    expect(
      computerUseBannerText(
        { holders: [{ ...holder, state: "recovery", pauseCause: "outcome-unknown" }] },
        false,
      ),
    ).toBe(
      "Computer control stopped · check TextEdit before resuming · last action's result is unknown",
    );
    expect(computerUseBannerText({ holders: [], otherProfile: true }, false)).toBe(
      "An agent in another F5 profile is controlling this computer",
    );
    expect(computerUseBannerText({ holders: [] }, false)).toBeNull();
  });
  it("says whether an agent is using Chrome, not that it controls the computer", () => {
    const chrome = { threadId, delivery: "foreground" as const, state: "active" as const };
    expect(computerUseBannerText({ holders: [{ ...chrome, browser: "idle" }] }, false)).toBe(
      "An agent can use Chrome",
    );
    expect(computerUseBannerText({ holders: [{ ...chrome, browser: "working" }] }, false)).toBe(
      "An agent is using Chrome",
    );
    expect(computerUseBannerText({ holders: [chrome] }, false)).toBe("An agent can use Chrome");
    // An idle Chrome runtime doesn't outrank an agent working in an app.
    const idle = { ...chrome, threadId: ThreadId.makeUnsafe("b"), browser: "idle" as const };
    expect(primaryComputerHolder({ holders: [idle, holder] })).toBe(holder);
    expect(computerUseBannerText({ holders: [idle, holder] }, false)).toBe(
      "An agent is working in TextEdit in the background",
    );
    expect(computerUseBannerText({ holders: [{ ...chrome, state: "paused" }] }, false)).toBe(
      "Computer control paused",
    );
  });
});

it("bounds settled access requests per thread and globally while retaining unsettled requests and stable unrelated indexes", () => {
  const store = useAgentComputerActivityStore.getState();
  store.request({
    requestId: "pending",
    threadId: "pending-thread",
    backendIncarnation: "b",
    kind: "apps",
    reason: "Test",
    apps: [],
  });
  const stable = useAgentComputerActivityStore.getState().requestsByThread["pending-thread"];
  for (let t = 0; t < 15; t++)
    for (let i = 0; i < 25; i++) {
      const id = `${t}-${i}`;
      store.request({
        requestId: id,
        threadId: `t${t}`,
        backendIncarnation: "b",
        kind: "apps",
        reason: "Test",
        apps: [],
      });
      store.settle({ requestId: id, threadId: `t${t}`, allowed: true });
    }
  const state = useAgentComputerActivityStore.getState();
  expect(Object.values(state.requests).filter((request) => request?.settled)).toHaveLength(200);
  expect(
    Object.values(state.requestsByThread).every(
      (requests) => (requests?.filter((request) => request.settled).length ?? 0) <= 20,
    ),
  ).toBe(true);
  expect(state.requestsByThread["pending-thread"]).toBe(stable);
  expect(state.requests.pending?.settled).toBeUndefined();
});
it("records only tool history, preserves captures on tool completion and caps history at thirty", () => {
  const store = useAgentComputerActivityStore.getState();
  store.record({
    threadId,
    backend: "native",
    op: "type",
    status: "completed",
    thumbnailDataUrl: "capture",
  });
  const capture = useAgentComputerActivityStore.getState().lastCapture[threadId];
  const activity = useAgentComputerActivityStore.getState().activity[threadId];
  store.record({ threadId, source: "tool", backend: "native", op: "type", status: "completed" });
  expect(useAgentComputerActivityStore.getState().lastCapture[threadId]).toBe(capture);
  expect(useAgentComputerActivityStore.getState().activity[threadId]).toBe(activity);
  store.record({ threadId, backend: "native", op: "type", status: "interrupted" });
  store.record({
    threadId,
    source: "tool",
    backend: "native",
    op: "type",
    status: "failed",
    outcome: "OutcomeUnknown",
  });
  expect(useAgentComputerActivityStore.getState().history[threadId]).toHaveLength(2);
  for (let i = 0; i < 50; i++)
    store.record({ threadId, source: "tool", backend: "native", op: "wait", status: "completed" });
  expect(useAgentComputerActivityStore.getState().history[threadId]).toHaveLength(30);
  store.resetConnection();
  expect(useAgentComputerActivityStore.getState().history).toEqual({});
});
it("keeps Stop unconfirmed until a host lease update confirms release", () => {
  const store = useAgentComputerActivityStore.getState();
  store.markStopUnconfirmed(threadId);
  store.setLeases({ holders: [{ threadId, delivery: "foreground", state: "paused" }] });
  expect(useAgentComputerActivityStore.getState().stopUnconfirmed[threadId]).toBe(true);
  store.setLeases({ holders: [] });
  expect(useAgentComputerActivityStore.getState().stopUnconfirmed[threadId]).toBeUndefined();
});

it("preserves the last capture through aggregate wait events", () => {
  const store = useAgentComputerActivityStore;
  store.getState().resetConnection();
  store.getState().record({
    threadId: "wait",
    backend: "native",
    op: "screenshot",
    status: "completed",
    thumbnailDataUrl: "data:image/png;base64,a",
  });
  const capture = store.getState().lastCapture.wait;
  store.getState().record({ threadId: "wait", backend: "native", op: "wait", status: "started" });
  store.getState().record({ threadId: "wait", backend: "native", op: "wait", status: "completed" });
  expect(store.getState().lastCapture.wait).toBe(capture);
});
