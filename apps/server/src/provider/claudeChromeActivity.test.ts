import { describe, expect, it } from "vitest";
import {
  CLAUDE_CHROME_IDLE_MS,
  CLAUDE_CHROME_RELEASED,
  CLAUDE_CHROME_STOPPED_IDLE,
  ClaudeChromeActivity,
  claudeSessionBackgroundBusy,
} from "./claudeChromeActivity";

function harness(options: { busy?: () => boolean; accept?: () => boolean } = {}) {
  let timer: (() => void) | undefined;
  const reports: boolean[] = [];
  const stops: string[] = [];
  const activity = new ClaudeChromeActivity({
    reportCalls: (running) => reports.push(running),
    stop: async (reason) => {
      stops.push(reason);
      return options.accept?.() ?? true;
    },
    ...(options.busy ? { busy: options.busy } : {}),
    setTimeout: (run, ms) => {
      expect(ms).toBe(CLAUDE_CHROME_IDLE_MS);
      timer = run;
      return run;
    },
    clearTimeout: () => {
      timer = undefined;
    },
  });
  return {
    activity,
    reports,
    stops,
    armed: () => timer !== undefined,
    fire: async () => {
      timer?.();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("ClaudeChromeActivity", () => {
  it("reports idle and arms the idle stop as soon as the session holds Chrome", async () => {
    const h = harness();
    expect(h.reports).toEqual([false]);
    expect(h.activity.idle).toBe(true);
    expect(h.armed()).toBe(true);
    await h.fire();
    expect(h.stops).toEqual([CLAUDE_CHROME_STOPPED_IDLE]);
    expect(h.activity.idle).toBe(false);
  });

  it("never idle-stops during a turn or a Chrome call", () => {
    const h = harness();
    h.activity.turnStarted();
    expect(h.armed()).toBe(false);
    expect(h.activity.idle).toBe(false);
    h.activity.callStarted("call-1");
    h.activity.callStarted("call-1");
    expect(h.reports).toEqual([false, true]);
    h.activity.turnEnded();
    // The turn's end ends its calls.
    expect(h.reports).toEqual([false, true, false]);
    expect(h.armed()).toBe(true);
    h.activity.callStarted("call-2");
    expect(h.armed()).toBe(false);
    h.activity.callEnded("unrelated");
    expect(h.armed()).toBe(false);
    h.activity.callEnded("call-2");
    expect(h.reports.at(-1)).toBe(false);
    expect(h.armed()).toBe(true);
    expect(h.stops).toEqual([]);
  });

  it("is never idle while background work runs, and looks again after another window", async () => {
    let busy = true;
    const h = harness({ busy: () => busy });
    expect(h.activity.idle).toBe(false);
    expect(h.activity.release()).toBe(false);
    await h.fire();
    expect(h.stops).toEqual([]);
    // No end event for background work: the timer re-arms instead of giving up.
    expect(h.armed()).toBe(true);
    busy = false;
    await h.fire();
    expect(h.stops).toEqual([CLAUDE_CHROME_STOPPED_IDLE]);
  });

  it("gives Chrome up on request only while idle, once", async () => {
    const h = harness();
    h.activity.turnStarted();
    expect(h.activity.release()).toBe(false);
    h.activity.turnEnded();
    expect(await h.activity.release()).toBe(true);
    expect(h.stops).toEqual([CLAUDE_CHROME_RELEASED]);
    expect(h.armed()).toBe(false);
    expect(h.activity.release()).toBe(false);
  });

  it("keeps tracking when the session refuses the stop under its lock", async () => {
    // A turn started between the idle check and the session's lock.
    const h = harness({ accept: () => false });
    const pending = h.activity.release();
    // While the stop is in flight nothing else may start one.
    expect(h.activity.idle).toBe(false);
    expect(h.activity.release()).toBe(false);
    expect(await pending).toBe(false);
    expect(h.stops).toEqual([CLAUDE_CHROME_RELEASED]);
    // Tracking resumes: calls are reported, the idle stop re-arms, release works again.
    h.activity.callStarted("call-1");
    expect(h.reports.at(-1)).toBe(true);
    h.activity.callEnded("call-1");
    expect(h.reports.at(-1)).toBe(false);
    expect(h.armed()).toBe(true);
    expect(h.activity.idle).toBe(true);
  });

  it("stops nothing after it is disposed", () => {
    const h = harness();
    h.activity.dispose();
    expect(h.armed()).toBe(false);
    expect(h.activity.release()).toBe(false);
    h.activity.turnEnded();
    expect(h.armed()).toBe(false);
    expect(h.stops).toEqual([]);
  });
});

describe("claudeSessionBackgroundBusy", () => {
  const quiet = {
    lifecycle: { backgroundTasks: new Set<string>() },
    taskStates: new Map<string, unknown>(),
  };
  it("counts compaction, background agents, live tasks and scheduled work", () => {
    expect(claudeSessionBackgroundBusy(quiet)).toBe(false);
    expect(claudeSessionBackgroundBusy({ ...quiet, nativeControl: { operationId: "c" } })).toBe(
      true,
    );
    expect(
      claudeSessionBackgroundBusy({ ...quiet, lifecycle: { backgroundTasks: new Set(["t"]) } }),
    ).toBe(true);
    expect(claudeSessionBackgroundBusy({ ...quiet, taskStates: new Map([["shell", {}]]) })).toBe(
      true,
    );
    expect(claudeSessionBackgroundBusy({ ...quiet, chromeScheduledWork: true })).toBe(true);
  });
});
