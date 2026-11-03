import { describe, expect, it } from "vitest";

import {
  cardActivity,
  COMPUTER_TIER_LABEL,
  computerBackendLabel,
  computerGrantLabel,
  computerStatusTone,
  describeComputerAction,
} from "./AgentComputerLiveCard.logic";

const done = (op: string) => ({ op, status: "completed" as const });

describe("computer live card text", () => {
  it("maps every known operation to ongoing and finished wording", () => {
    const ops = [
      "screenshot",
      "zoom",
      "inspect",
      "click",
      "move",
      "drag",
      "scroll",
      "type",
      "key",
      "elementAction",
      "openApp",
      "activateApp",
      "listApps",
      "resolveApps",
      "status",
      "requestAccess",
    ];
    expect(ops.map((op) => describeComputerAction({ op, status: "started" }, {}))).toEqual([
      "Taking a screenshot…",
      "Zooming in…",
      "Reading the screen…",
      "Clicking…",
      "Moving the pointer…",
      "Dragging…",
      "Scrolling…",
      "Typing…",
      "Pressing a key…",
      "Using a control…",
      "Opening app…",
      "Switching app…",
      "Listing apps…",
      "Finding apps…",
      "Checking status…",
      "Requesting access…",
    ]);
    expect(ops.map((op) => describeComputerAction(done(op), {}))).toEqual([
      "Took a screenshot",
      "Zoomed in",
      "Read the screen",
      "Clicked",
      "Moved the pointer",
      "Dragged",
      "Scrolled",
      "Typed",
      "Pressed a key",
      "Used a control",
      "Opened app",
      "Switched app",
      "Listed apps",
      "Found apps",
      "Checked status",
      "Requested access",
    ]);
  });

  it("humanizes unknown operations", () => {
    expect(describeComputerAction({ op: "captureWindowRegion", status: "started" }, {})).toBe(
      "Capture window region…",
    );
    expect(describeComputerAction(done("captureWindowRegion"), {})).toBe(
      "Finished capture window region",
    );
  });

  it("adds a suffix for each status", () => {
    const text = (status: "started" | "completed" | "failed" | "interrupted") =>
      describeComputerAction({ op: "activateApp", status }, {});
    expect(text("started")).toBe("Switching app…");
    expect(text("completed")).toBe("Switched app");
    expect(text("failed")).toBe("Switching app failed");
    expect(text("interrupted")).toBe("Switching app was interrupted");
  });

  it("describes paused, held and idle states", () => {
    expect(describeComputerAction(done("click"), { paused: true })).toBe("You have control");
    expect(describeComputerAction(undefined, { held: true })).toBe(
      "Agent is controlling this computer",
    );
    expect(describeComputerAction(undefined, {})).toBe("Idle");
  });

  it("describes a held Chrome lease by whether a browser call is running", () => {
    expect(describeComputerAction(undefined, { held: true, chrome: "idle" })).toBe(
      "Chrome ready · not in use",
    );
    expect(describeComputerAction(undefined, { held: true, chrome: "working" })).toBe(
      "Agent is using Chrome",
    );
    expect(describeComputerAction(undefined, { held: true, chrome: "unknown" })).toBe(
      "Agent can use Chrome",
    );
    expect(computerStatusTone(undefined, { held: true, chrome: "idle" })).toBe("ok");
    expect(computerStatusTone(undefined, { held: true, chrome: "working" })).toBe("pending");
  });

  it("shows the Chrome state over a finished native action from before the lease", () => {
    const failed = { op: "click", status: "failed" as const };
    for (const old of [done("click"), failed]) {
      expect(cardActivity(old, "idle")).toBeUndefined();
      expect(describeComputerAction(old, { held: true, chrome: "idle" })).toBe(
        "Chrome ready · not in use",
      );
      expect(describeComputerAction(old, { held: true, chrome: "working" })).toBe(
        "Agent is using Chrome",
      );
      expect(computerStatusTone(old, { held: true, chrome: "idle" })).toBe("ok");
    }
    // A running native action still shows, and without Chrome nothing changes.
    const running = { op: "click", status: "started" as const };
    expect(cardActivity(running, "idle")).toBe(running);
    expect(cardActivity(failed, undefined)).toBe(failed);
    expect(computerStatusTone(failed, { held: true })).toBe("error");
  });

  it("labels every tier", () => {
    expect(COMPUTER_TIER_LABEL).toEqual({
      view: "View only",
      click: "Click",
      full: "Full control",
      blocked: "Blocked",
    });
  });

  it("shows when a click grant also allows typing", () => {
    expect(computerGrantLabel("click", true)).toBe("Click + typing");
    expect(computerGrantLabel("click", false)).toBe("Click");
    expect(computerGrantLabel("full", true)).toBe("Full control");
  });

  it("names only built-in backends", () => {
    expect(computerBackendLabel("claude-builtin")).toBe("via Claude");
    expect(computerBackendLabel("codex-builtin")).toBe("via Codex");
    expect(computerBackendLabel("native")).toBeUndefined();
    expect(computerBackendLabel(undefined)).toBeUndefined();
  });
});

describe("computer status tone", () => {
  it("picks a tone for each state", () => {
    expect(computerStatusTone(done("click"), { paused: true })).toBe("warning");
    expect(computerStatusTone({ op: "click", status: "failed" }, {})).toBe("error");
    expect(computerStatusTone({ op: "click", status: "interrupted" }, {})).toBe("warning");
    expect(computerStatusTone({ op: "click", status: "started" }, {})).toBe("pending");
    expect(computerStatusTone(undefined, { held: true })).toBe("pending");
    expect(computerStatusTone(done("click"), {})).toBe("ok");
    expect(computerStatusTone(undefined, {})).toBe("off");
  });
});
