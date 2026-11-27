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

  it("counts steps without a thread yet, so a half-started phase isn't done", () => {
    const [crossReview] = groupWorkflowThreadsByPhase(
      [
        // A's thread finished; B's thread hasn't been created yet.
        phase("cross-review", "Cross-review", "active", [
          step("Cross-review A", "completed", "a"),
          step("Cross-review B", "pending", null),
        ]),
      ],
      [thread("a")],
      () => "unused",
    );
    expect(crossReview).toMatchObject({ kind: "phase", state: "active" });

    const [reviews] = groupWorkflowThreadsByPhase(
      [
        phase("reviews", "Reviews", "pending", [
          step("Review A Cross", "completed", "rac"),
          step("Review B Cross", "completed", "rbc"),
          step("Review A Self", "pending", null),
        ]),
      ],
      [thread("rac"), thread("rbc")],
      () => "unused",
    );
    expect(reviews).toMatchObject({ kind: "phase", state: "pending" });
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
        queued: [],
      },
    ]);
  });

  it("lists steps that haven't started yet as queued, after the rows", () => {
    // Three authors with self-review: 4 reviews running, 5 waiting for a review slot. Two
    // have pre-allocated thread ids whose threads don't exist yet; three are placeholders.
    const [reviews] = groupWorkflowThreadsByPhase(
      [
        phase("reviews", "Reviews", "active", [
          step("Review A by B", "active", "rab"),
          step("Review A by C", "active", "rac"),
          step("Review B by A", "completed", "rba"),
          step("Review B by C", "pending", "rbc"),
          step("Review C by A", "pending", null),
          step("Review C by B", "pending", null),
          step("Review A Self", "active", "ras"),
          step("Review B Self", "pending", "rbs"),
          step("Review C Self", "pending", null),
        ]),
      ],
      ["rab", "rac", "rba", "ras"].map((value) => thread(value)),
      () => "unused",
    );
    expect(reviews?.kind).toBe("phase");
    if (reviews?.kind !== "phase") return;
    expect(reviews.state).toBe("active");
    expect(reviews.rows.map((row) => row.label)).toEqual(["A by B", "A by C", "B by A", "A Self"]);
    expect(reviews.queued.map((entry) => entry.label)).toEqual([
      "B by C",
      "C by A",
      "C by B",
      "B Self",
      "C Self",
    ]);
    expect(reviews.queued[0]).toMatchObject({ fullLabel: "Review B by C", modelSlot: null });
    expect(new Set(reviews.queued.map((entry) => entry.id)).size).toBe(5);
  });

  it("doesn't list a snoozed thread's started step as queued", () => {
    const [reviews] = groupWorkflowThreadsByPhase(
      [
        phase("reviews", "Reviews", "completed", [
          step("Review A Cross", "completed", "rac"),
          step("Review B Cross", "completed", "snoozed"),
        ]),
      ],
      [thread("rac")],
      () => "unused",
    );
    expect(reviews).toMatchObject({ kind: "phase", state: "completed", queued: [] });
    expect(reviews?.kind === "phase" && reviews.rows.length).toBe(1);
  });

  it("keeps a phase with one started thread and queued steps as a group", () => {
    const [codeReview] = groupWorkflowThreadsByPhase(
      [
        phase("code-review", "Code Review", "active", [
          step("Code Review A", "active", "cra"),
          step("Code Review B", "pending", null),
        ]),
      ],
      [thread("cra")],
      () => "unused",
    );
    expect(codeReview).toMatchObject({ kind: "phase", id: "code-review" });
    expect(codeReview?.kind === "phase" && codeReview.queued.map((entry) => entry.label)).toEqual([
      "Code Review B",
    ]);
  });

  it("counts every review of a three-author run, started or queued", () => {
    const base = createPlanningWorkflow();
    const review = (
      slot: "cross" | "self",
      reviewerBranchId: "a" | "b" | "c",
      reviewed: string,
      status: "running" | "completed" | "pending",
    ) => ({
      slot,
      reviewerBranchId,
      threadId: id(`review-${reviewed}-${slot}-${reviewerBranchId}`),
      outputFilePath: null,
      status,
      error: null,
      retryCount: 0,
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      lastRetryAt: null,
      updatedAt: base.updatedAt,
    });
    const workflow = {
      ...base,
      branchA: {
        ...base.branchA,
        authorThreadId: id("a"),
        status: "reviews_requested" as const,
        reviews: [
          review("cross", "b", "a", "running"),
          review("cross", "c", "a", "running"),
          review("self", "a", "a", "completed"),
        ],
      },
      branchB: {
        ...base.branchB,
        authorThreadId: id("b"),
        status: "reviews_requested" as const,
        reviews: [
          review("cross", "a", "b", "completed"),
          review("cross", "c", "b", "pending"),
          review("self", "b", "b", "pending"),
        ],
      },
      additionalBranches: [
        {
          ...base.branchA,
          branchId: "c" as const,
          authorThreadId: id("c"),
          status: "reviews_requested" as const,
          reviews: [
            review("cross", "a", "c", "pending"),
            review("cross", "b", "c", "pending"),
            review("self", "c", "c", "pending"),
          ],
        },
      ],
    };
    const meta = deriveSidebarWorkflowMeta({ type: "planning", workflow });
    const started = ["review-a-cross-b", "review-a-cross-c", "review-a-self-a", "review-b-cross-a"];
    const groups = groupWorkflowThreadsByPhase(
      meta.phases,
      ["a", "b", "c", ...started].map((value) => thread(value)),
      () => "unused",
    );
    const reviews = groups.find((group) => group.id === "reviews");
    expect(reviews?.kind).toBe("phase");
    if (reviews?.kind !== "phase") return;
    expect(reviews.rows).toHaveLength(4);
    expect(reviews.queued).toHaveLength(5);
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
  const bumped = "2026-11-13T00:00:00.000Z";
  const threads = [
    thread("a", "2026-10-19T00:00:00.000Z"),
    thread("b", "2026-10-20T00:00:00.000Z"),
  ];

  it("ignores a fresher updatedAt once the workflow is finished", () => {
    expect(workflowActivityAt({ updatedAt: bumped, threads, finished: true })).toBe(
      "2026-10-20T00:00:00.000Z",
    );
  });

  it("counts updatedAt while unfinished, e.g. waiting on a step with no thread yet", () => {
    expect(workflowActivityAt({ updatedAt: bumped, threads, finished: false })).toBe(bumped);
    expect(
      workflowActivityAt({ updatedAt: "2026-10-01T00:00:00.000Z", threads, finished: false }),
    ).toBe("2026-10-20T00:00:00.000Z");
  });

  it("reads each thread's time through activityOf, for live activity", () => {
    // The summary keeps a stale lastInteractionAt while the activity order holds.
    const live = "2026-11-12T23:00:00.000Z";
    expect(
      workflowActivityAt({
        updatedAt: bumped,
        threads,
        finished: true,
        activityOf: (entry) => (entry.id === "a" ? live : entry.lastInteractionAt),
      }),
    ).toBe(live);
  });

  it("falls back to updatedAt before the workflow has threads", () => {
    expect(workflowActivityAt({ updatedAt: bumped, threads: [], finished: true })).toBe(bumped);
  });
});
