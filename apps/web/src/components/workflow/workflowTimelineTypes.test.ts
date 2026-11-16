import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  currentStepFromPhases,
  overallStateFromPhases,
  phaseSummariesFromPhases,
  threadOrderFromPhases,
  type WorkflowTimelinePhase,
  type WorkflowTimelineStep,
} from "./workflowTimelineTypes";

const step = (
  label: string,
  state: WorkflowTimelineStep["state"],
  threadId: string | null = null,
): WorkflowTimelineStep => ({
  key: label,
  label,
  state,
  threadId: threadId === null ? null : ThreadId.makeUnsafe(threadId),
  modelSlot: null,
});

const phase = (
  label: string,
  state: WorkflowTimelinePhase["state"],
  steps: WorkflowTimelineStep[],
): WorkflowTimelinePhase => ({ id: label, label, state, steps });

describe("threadOrderFromPhases", () => {
  it("lists threads in the order they first appear across phases", () => {
    expect(
      threadOrderFromPhases([
        phase("Plan", "completed", [
          step("Branch A", "completed", "a"),
          step("Branch B", "completed", "b"),
        ]),
        phase("Review", "completed", [
          step("Review A", "completed", "a"),
          step("Cross", "completed", "c"),
        ]),
        phase("Implement", "active", [
          step("Implementation", "active", "d"),
          step("Next", "pending"),
        ]),
      ]),
    ).toEqual(["a", "b", "c", "d"]);
  });
});

describe("phaseSummariesFromPhases", () => {
  it("drops skipped phases", () => {
    expect(
      phaseSummariesFromPhases([
        phase("Plan", "completed", [step("Draft", "completed", "a"), step("Extra", "skipped")]),
        phase("Optional", "skipped", []),
        phase("Merge", "pending", []),
      ]),
    ).toEqual([
      {
        id: "Plan",
        label: "Plan",
        state: "completed",
        steps: [{ label: "Draft", state: "completed", threadId: "a", modelSlot: null }],
      },
      { id: "Merge", label: "Merge", state: "pending", steps: [] },
    ]);
  });
});

describe("currentStepFromPhases", () => {
  it("names the running step of the active phase, preferring one with a thread", () => {
    expect(
      currentStepFromPhases([
        phase("Plan", "completed", [step("Branch A", "completed", "a")]),
        phase("Review", "active", [
          step("Review A", "active"),
          step("Review B", "active", "rb"),
          step("Review C", "pending"),
        ]),
      ]),
    ).toEqual({
      label: "Review B",
      state: "running",
      threadId: "rb",
      targetThreadId: "rb",
      modelSlot: null,
    });
  });

  it("falls back to the first unfinished step of the active phase", () => {
    expect(
      currentStepFromPhases([
        phase("Review", "active", [
          step("Review A", "completed", "ra"),
          step("Review B", "pending"),
        ]),
      ]),
    ).toMatchObject({
      label: "Review B",
      state: "running",
      threadId: null,
      // No thread yet: the line opens the newest thread so far.
      targetThreadId: "ra",
    });
  });

  it("targets the newest earlier thread for a failed step without one", () => {
    expect(
      currentStepFromPhases([
        phase("Plan", "completed", [step("Branch A", "completed", "a")]),
        phase("Implement", "completed", [step("Implementation", "completed", "impl")]),
        phase("Code Review", "error", []),
      ]),
    ).toMatchObject({ label: "Code Review", state: "needs-attention", targetThreadId: "impl" });
  });

  it("targets nothing when the workflow has no thread yet", () => {
    expect(
      currentStepFromPhases([phase("Plan", "active", [step("Branch A", "active")])]),
    ).toMatchObject({ label: "Branch A", threadId: null, targetThreadId: null });
  });

  it("names the failed step when nothing is running", () => {
    expect(
      currentStepFromPhases([
        phase("Plan", "completed", [step("Branch A", "completed", "a")]),
        phase("Merge", "error", [step("Merge", "error", "m")]),
        phase("Implement", "pending", [step("Implementation", "pending")]),
      ]),
    ).toMatchObject({ label: "Merge", state: "needs-attention", threadId: "m" });
  });

  it("names a failed branch over a running one, matching the overall state", () => {
    const phases = [
      phase("Branch A", "error", [step("Branch A", "error", "a")]),
      phase("Branch B", "active", [step("Branch B", "active", "b")]),
    ];
    expect(overallStateFromPhases(phases)).toBe("error");
    expect(currentStepFromPhases(phases)).toMatchObject({
      label: "Branch A",
      state: "needs-attention",
      threadId: "a",
    });
  });

  it("reports Completed once every phase is done, targeting the last thread", () => {
    expect(
      currentStepFromPhases([
        phase("Plan", "completed", [step("Branch A", "completed", "a")]),
        phase("Implement", "completed", [step("Implementation", "completed", "impl")]),
        phase("Apply Reviews", "completed", [
          step("Apply Reviews", "completed", "impl"),
          step("Unused", "skipped", "skipped-thread"),
        ]),
        phase("Optional", "skipped", [step("Optional", "skipped", "optional")]),
      ]),
    ).toEqual({
      label: "Completed",
      state: "completed",
      threadId: null,
      targetThreadId: "impl",
      modelSlot: null,
    });
  });

  it("names the next pending step as waiting, even before it has a thread", () => {
    expect(
      currentStepFromPhases([
        phase("Plan", "completed", [step("Branch A", "completed", "a")]),
        phase("Merge", "pending", [step("Merge", "pending")]),
      ]),
    ).toEqual({
      label: "Merge",
      state: "waiting",
      threadId: null,
      targetThreadId: "a",
      modelSlot: null,
    });
  });

  it("returns null without phases", () => {
    expect(currentStepFromPhases([])).toBeNull();
  });
});
