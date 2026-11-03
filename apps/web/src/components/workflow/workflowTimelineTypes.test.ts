import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  currentStepFromPhases,
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
        phase("Plan", "completed", []),
        phase("Optional", "skipped", []),
        phase("Merge", "pending", []),
      ]),
    ).toEqual([
      { label: "Plan", state: "completed" },
      { label: "Merge", state: "pending" },
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
    ).toEqual({ label: "Review B", state: "running", threadId: "rb", modelSlot: null });
  });

  it("falls back to the first unfinished step of the active phase", () => {
    expect(
      currentStepFromPhases([
        phase("Review", "active", [
          step("Review A", "completed", "ra"),
          step("Review B", "pending"),
        ]),
      ]),
    ).toMatchObject({ label: "Review B", state: "running", threadId: null });
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

  it("reports Completed once every phase is done", () => {
    expect(
      currentStepFromPhases([
        phase("Plan", "completed", [step("Branch A", "completed", "a")]),
        phase("Optional", "skipped", []),
      ]),
    ).toEqual({ label: "Completed", state: "completed", threadId: null, modelSlot: null });
  });

  it("names the next pending step as waiting, even before it has a thread", () => {
    expect(
      currentStepFromPhases([
        phase("Plan", "completed", [step("Branch A", "completed", "a")]),
        phase("Merge", "pending", [step("Merge", "pending")]),
      ]),
    ).toEqual({ label: "Merge", state: "waiting", threadId: null, modelSlot: null });
  });

  it("returns null without phases", () => {
    expect(currentStepFromPhases([])).toBeNull();
  });
});
