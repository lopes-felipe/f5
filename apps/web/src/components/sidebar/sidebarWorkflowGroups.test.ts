import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { createPlanningWorkflow } from "../../test/workflowFixtures";
import type { WorkflowPhaseSummary } from "../workflow/workflowTimelineTypes";
import { deriveSidebarWorkflowMeta } from "./sidebarLists";
import {
  groupWorkflowThreadsByPhase,
  shortWorkflowStepLabel,
  workflowActivityAt,
  workflowGroupState,
} from "./sidebarWorkflowGroups";

const id = (value: string) => ThreadId.makeUnsafe(value);
const thread = (value: string, lastInteractionAt = "2026-11-01T00:00:00.000Z") => ({
  id: id(value),
  lastInteractionAt,
});

type Step = WorkflowPhaseSummary["steps"][number];
const step = (label: string, state: Step["state"], threadId: string | null): Step => ({
  label,
  state,
  threadId: threadId === null ? null : id(threadId),
  modelSlot: null,
});
const phase = (
  phaseId: string,
  label: string,
  state: WorkflowPhaseSummary["state"],
  steps: Step[],
): WorkflowPhaseSummary => ({ id: phaseId, label, state, steps });

/** A planning workflow in code review: Revision reran the authors, Code Review B not started. */
const planningPhases: WorkflowPhaseSummary[] = [
  phase("authoring", "Authoring", "completed", [
    step("Branch A", "completed", "a"),
    step("Branch B", "completed", "b"),
  ]),
  phase("reviews", "Reviews", "completed", [
    step("Review A Cross", "completed", "rac"),
    step("Review B Cross", "completed", "rbc"),
    step("Review A Self", "completed", "ras"),
    step("Review B Self", "completed", "rbs"),
  ]),
  phase("revision", "Revision", "active", [
    step("Branch A", "active", "a"),
    step("Branch B", "completed", "b"),
  ]),
  phase("merge", "Merge", "pending", [step("Merge", "pending", null)]),
  phase("implementation", "Implementation", "pending", [step("Implementation", "pending", null)]),
  phase("code-review", "Code Review", "pending", [
    step("Code Review A", "pending", null),
    step("Code Review B", "pending", null),
  ]),
];

describe("groupWorkflowThreadsByPhase", () => {
  const threads = ["a", "b", "rac", "rbc", "ras", "rbs"].map((value) => thread(value));

  it("groups threads under the phase that first names them, with no group for reruns", () => {
    const groups = groupWorkflowThreadsByPhase(planningPhases, threads, () => "unused");
    expect(
      groups.map((group) =>
        group.kind === "phase"
          ? `${group.id}:${group.rows.length}`
          : `${group.id}:pending:${group.stepCount}`,
      ),
    ).toEqual([
      "authoring:2",
      "reviews:4",
      "merge:pending:1",
      "implementation:pending:1",
      "code-review:pending:2",
    ]);
  });

  it("gives each thread its latest started step's state, and the group the aggregate", () => {
    const [authoring, reviews] = groupWorkflowThreadsByPhase(
      planningPhases,
      threads,
      () => "unused",
    );
    expect(authoring?.kind === "phase" && authoring.rows.map((row) => row.stepState)).toEqual([
      "active",
      "completed",
    ]);
    expect(authoring?.state).toBe("active");
    expect(reviews?.state).toBe("completed");
  });

  it("keeps an earlier state when the later step naming the thread is still pending", () => {
    const [group] = groupWorkflowThreadsByPhase(
      [
        phase("authoring", "Authoring", "error", [step("Branch A", "error", "a")]),
        phase("revision", "Revision", "pending", [step("Branch A", "pending", "a")]),
      ],
      [thread("a")],
      () => "unused",
    );
    expect(group?.kind === "phase" && group.rows[0]?.stepState).toBe("error");
  });

  it("shortens step labels inside a group and keeps the full label", () => {
    const [, reviews] = groupWorkflowThreadsByPhase(planningPhases, threads, () => "unused");
    expect(reviews?.kind === "phase" && reviews.rows.map((row) => row.label)).toEqual([
      "A Cross",
      "B Cross",
      "A Self",
      "B Self",
    ]);
    expect(reviews?.kind === "phase" && reviews.rows[0]?.fullLabel).toBe("Review A Cross");
  });

  it("appends threads no phase names, and skips snoozed threads a phase names", () => {
    const groups = groupWorkflowThreadsByPhase(
      [phase("merge", "Merge", "completed", [step("Merge", "completed", "merge")])],
      [thread("stray")],
      (entry) => `Stray ${entry.id}`,
    );
    expect(groups).toEqual([
      {
        kind: "phase",
        id: "thread:stray",
        label: "Stray stray",
        state: "completed",
        rows: [
          {
            thread: thread("stray"),
            label: "Stray stray",
            fullLabel: "Stray stray",
            stepState: null,
          },
        ],
      },
    ]);
  });

  it("groups a real planning workflow the same way", () => {
    const workflow = createPlanningWorkflow({
      branchAThreadId: id("a"),
      branchBThreadId: id("b"),
    });
    const meta = deriveSidebarWorkflowMeta({ type: "planning", workflow });
    const groups = groupWorkflowThreadsByPhase(
      meta.phases,
      [thread("a"), thread("b")],
      () => "unused",
    );
    expect(groups[0]).toMatchObject({ kind: "phase", id: "authoring", label: "Authoring" });
    expect(groups[0]?.kind === "phase" && groups[0].rows.map((row) => row.label)).toEqual([
      "Branch A",
      "Branch B",
    ]);
    // Revision reuses the authors' threads, so it never gets a group of its own.
    expect(groups.some((group) => group.id === "revision")).toBe(false);
  });
});

describe("shortWorkflowStepLabel", () => {
  it("drops the repeated phase word only when more than one word is left", () => {
    expect(shortWorkflowStepLabel("Reviews", "Review A Cross")).toBe("A Cross");
    expect(shortWorkflowStepLabel("Code Review", "Code Review A")).toBe("Code Review A");
    expect(shortWorkflowStepLabel("Authoring", "Branch A")).toBe("Branch A");
  });
});

describe("workflowGroupState", () => {
  it("lets an error win, then a running step, then all done", () => {
    expect(workflowGroupState(["completed", "error", "active"])).toBe("error");
    expect(workflowGroupState(["completed", "active", "pending"])).toBe("active");
    expect(workflowGroupState(["completed", null])).toBe("completed");
    expect(workflowGroupState(["completed", "pending"])).toBe("pending");
  });
});

describe("workflowActivityAt", () => {
  it("uses the newest thread activity over a fresher updatedAt", () => {
    expect(
      workflowActivityAt({ updatedAt: "2026-11-13T00:00:00.000Z" }, [
        thread("a", "2026-10-19T00:00:00.000Z"),
        thread("b", "2026-10-20T00:00:00.000Z"),
      ]),
    ).toBe("2026-10-20T00:00:00.000Z");
  });

  it("falls back to updatedAt before the workflow has threads", () => {
    expect(workflowActivityAt({ updatedAt: "2026-11-13T00:00:00.000Z" }, [])).toBe(
      "2026-11-13T00:00:00.000Z",
    );
  });
});
