import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_BROWSER_ACTIVE_WINDOW_MS,
  describeAgentBrowserAction,
  isAgentBrowserActive,
  useAgentBrowserActivityStore,
} from "./agentBrowserActivityStore";

const THREAD = ThreadId.makeUnsafe("thread-agent-browser");

describe("agentBrowserActivityStore", () => {
  beforeEach(() => useAgentBrowserActivityStore.setState({ byThreadId: {} }));

  it("tracks the running action, its geometry, and the active window", () => {
    const store = useAgentBrowserActivityStore.getState();
    store.start(THREAD, "click");
    let activity = useAgentBrowserActivityStore.getState().byThreadId[THREAD];
    expect(describeAgentBrowserAction(activity!)).toBe("Clicking…");
    expect(isAgentBrowserActive(activity, Date.now())).toBe(true);
    store.finish(THREAD, "succeeded", { geometry: { point: { x: 10, y: 20 } } });
    activity = useAgentBrowserActivityStore.getState().byThreadId[THREAD];
    expect(activity?.geometry?.point).toEqual({ x: 10, y: 20 });
    expect(isAgentBrowserActive(activity, activity!.completedAt! + 1)).toBe(true);
    expect(
      isAgentBrowserActive(activity, activity!.completedAt! + AGENT_BROWSER_ACTIVE_WINDOW_MS),
    ).toBe(false);
  });

  it("stays active while the user holds control and survives the next action", () => {
    const store = useAgentBrowserActivityStore.getState();
    store.setPaused(THREAD, true);
    store.start(THREAD, "type");
    store.finish(THREAD, "interrupted", { error: "user took over" });
    const activity = useAgentBrowserActivityStore.getState().byThreadId[THREAD];
    expect(activity?.paused).toBe(true);
    expect(isAgentBrowserActive(activity, Date.now() + 10 * AGENT_BROWSER_ACTIVE_WINDOW_MS)).toBe(
      true,
    );
    expect(describeAgentBrowserAction(activity!)).toBe("You have control of the browser");
  });
});
