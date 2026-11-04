import { describe, expect, it } from "vitest";
import {
  CLAUDE_CHROME_IDLE_MS,
  CLAUDE_CHROME_RELEASED,
  CLAUDE_CHROME_STOPPED_IDLE,
  ClaudeChromeActivity,
} from "./claudeChromeActivity";

function harness() {
  let timer: (() => void) | undefined;
  const reports: boolean[] = [];
  const stops: string[] = [];
  const activity = new ClaudeChromeActivity({
    reportCalls: (running) => reports.push(running),
    stop: (reason) => stops.push(reason),
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
    fire: () => timer?.(),
  };
}

describe("ClaudeChromeActivity", () => {
  it("reports idle and arms the idle stop as soon as the session holds Chrome", () => {
    const h = harness();
    expect(h.reports).toEqual([false]);
    expect(h.activity.idle).toBe(true);
    expect(h.armed()).toBe(true);
    h.fire();
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

  it("gives Chrome up on request only while idle, once", () => {
    const h = harness();
    h.activity.turnStarted();
    expect(h.activity.release()).toBe(false);
    h.activity.turnEnded();
    expect(h.activity.release()).toBe(true);
    expect(h.stops).toEqual([CLAUDE_CHROME_RELEASED]);
    expect(h.armed()).toBe(false);
    expect(h.activity.release()).toBe(false);
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
