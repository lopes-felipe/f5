import { describe, expect, it } from "vitest";
import type { ThreadId, WorkflowParticipantId } from "@t3tools/contracts";
import {
  WorkflowParticipantInvariantError,
  codeReviewReviewers,
  expectedPlanReviewEdges,
  findInvestigationCrossReview,
  findPlanningBranch,
  initialInvestigationCrossReview,
  investigationCrossReviews,
  investigationCrossReviewsError,
  investigationCrossReviewsOf,
  investigationInvestigators,
  planReviewEdgesError,
  planReviewReviewerBranchId,
  planningBranchIds,
  planningBranches,
  requireCodeReviewReviewer,
  requireInvestigator,
  requirePlanningBranch,
  updateCodeReviewReviewer,
  updateInvestigationCrossReview,
  updateInvestigator,
  updatePlanningBranch,
  workflowMaxParticipants,
  workflowModelSlotsHaveDuplicate,
  workflowParticipantIds,
  workflowTurnEstimate,
  workflowUsesMesh,
  type InvestigatorCrossReviewFields,
} from "./workflowParticipants";

const AT = "2026-11-23T00:00:00.000Z";

describe("workflow participant ids and limits", () => {
  it("names actors a to f and uses the mesh above two", () => {
    expect(workflowParticipantIds(4)).toEqual(["a", "b", "c", "d"]);
    expect(() => workflowParticipantIds(7)).toThrow(WorkflowParticipantInvariantError);
    expect(workflowUsesMesh(2)).toBe(false);
    expect(workflowUsesMesh(3)).toBe(true);
    expect(workflowMaxParticipants("planning")).toBe(4);
    expect(workflowMaxParticipants("document")).toBe(4);
    expect(workflowMaxParticipants("investigation")).toBe(4);
    expect(workflowMaxParticipants("codeReview")).toBe(6);
  });

  it("finds a duplicate model anywhere in the roster", () => {
    const codex = { provider: "codex", model: "gpt-5.5" } as const;
    const claude = { provider: "claudeAgent", model: "opus" } as const;
    const gemini = { provider: "antigravity", model: "neon" } as const;
    expect(workflowModelSlotsHaveDuplicate([codex, claude, gemini])).toBe(false);
    expect(workflowModelSlotsHaveDuplicate([codex, claude, codex])).toBe(true);
  });

  it("estimates the turns each workflow type starts", () => {
    expect(workflowTurnEstimate("planning", 3, true)).toEqual({
      actors: 3,
      crossReviews: 6,
      ownModelReviews: 3,
      revisions: 3,
      finalTurns: 1,
    });
    expect(workflowTurnEstimate("investigation", 4, false)).toEqual({
      actors: 4,
      crossReviews: 12,
      ownModelReviews: 0,
      revisions: 0,
      finalTurns: 1,
    });
    expect(workflowTurnEstimate("codeReview", 6, true)).toMatchObject({
      actors: 6,
      crossReviews: 0,
      finalTurns: 1,
    });
  });
});

interface Branch {
  readonly branchId: WorkflowParticipantId;
  readonly reviews: ReadonlyArray<{
    readonly slot: "cross" | "self";
    readonly reviewerBranchId?: WorkflowParticipantId;
  }>;
  readonly note?: string;
}
const branch = (branchId: WorkflowParticipantId, reviews: Branch["reviews"] = []): Branch => ({
  branchId,
  reviews,
});

describe("planning roster", () => {
  const three = {
    branchA: branch("a"),
    branchB: branch("b"),
    additionalBranches: [branch("c")],
  };

  it("reads and writes every branch by id, keeping the pair fields for A and B", () => {
    expect(planningBranches(three).map((entry) => entry.branchId)).toEqual(["a", "b", "c"]);
    expect(planningBranchIds(three)).toEqual(["a", "b", "c"]);
    expect(requirePlanningBranch(three, "c").branchId).toBe("c");
    expect(findPlanningBranch(three, "d")).toBeUndefined();
    expect(() => requirePlanningBranch(three, "d")).toThrow("Workflow has no author 'D'.");
    const updatedB = updatePlanningBranch(three, "b", (entry) => ({ ...entry, note: "b" }));
    expect(updatedB.branchB.note).toBe("b");
    expect(updatedB.additionalBranches).toBe(three.additionalBranches);
    const updatedC = updatePlanningBranch(three, "c", (entry) => ({ ...entry, note: "c" }));
    expect(updatedC.additionalBranches?.[0]?.note).toBe("c");
    expect(updatedC.branchA).toBe(three.branchA);
  });

  it("does not add an additional array to a two-author record", () => {
    const two = { branchA: branch("a"), branchB: branch("b") };
    const updated = updatePlanningBranch(two, "a", (entry) => ({ ...entry, note: "a" }));
    expect("additionalBranches" in updated).toBe(false);
  });

  it("expects one cross review per other author, then the own-model review", () => {
    expect(expectedPlanReviewEdges(three, "b")).toEqual([
      { slot: "cross", reviewerBranchId: "a" },
      { slot: "cross", reviewerBranchId: "c" },
      { slot: "self", reviewerBranchId: "b" },
    ]);
    expect(expectedPlanReviewEdges({ ...three, selfReviewEnabled: false }, "a")).toEqual([
      { slot: "cross", reviewerBranchId: "b" },
      { slot: "cross", reviewerBranchId: "c" },
    ]);
  });

  it("infers the reviewer only for legacy two-author cross reviews", () => {
    const two = { branchA: branch("a"), branchB: branch("b") };
    expect(planReviewReviewerBranchId(two, "a", { slot: "cross" })).toBe("b");
    expect(planReviewReviewerBranchId(two, "a", { slot: "self" })).toBe("a");
    expect(planReviewReviewerBranchId(three, "a", { slot: "cross", reviewerBranchId: "c" })).toBe(
      "c",
    );
    expect(() => planReviewReviewerBranchId(three, "a", { slot: "cross" })).toThrow(
      WorkflowParticipantInvariantError,
    );
  });

  it("validates branch ids and complete review edge sets", () => {
    expect(planReviewEdgesError(three)).toBeNull();
    expect(planReviewEdgesError({ ...three, additionalBranches: [branch("d")] })).toBe(
      "Workflow branch 3 must have id 'c'.",
    );
    const partial = {
      ...three,
      branchA: branch("a", [{ slot: "cross", reviewerBranchId: "b" }]),
    };
    expect(planReviewEdgesError(partial)).toBe("Plan A must hold all 3 expected reviews.");
    const duplicated = {
      ...three,
      branchA: branch("a", [
        { slot: "cross", reviewerBranchId: "b" },
        { slot: "cross", reviewerBranchId: "b" },
        { slot: "self", reviewerBranchId: "a" },
      ]),
    };
    expect(planReviewEdgesError(duplicated)).toBe(
      "Plan A must hold exactly one cross review by B.",
    );
  });

  it("checks stored reviewer ids on two-author records", () => {
    const two = (reviews: Parameters<typeof branch>[1]) => ({
      branchA: branch("a", reviews),
      branchB: branch("b"),
    });
    expect(planReviewEdgesError(two([{ slot: "cross" }, { slot: "self" }]))).toBeNull();
    expect(
      planReviewEdgesError(
        two([
          { slot: "cross", reviewerBranchId: "b" },
          { slot: "self", reviewerBranchId: "a" },
        ]),
      ),
    ).toBeNull();
    expect(planReviewEdgesError(two([{ slot: "cross", reviewerBranchId: "a" }]))).toBe(
      "Plan A has a cross review by an invalid reviewer.",
    );
    expect(planReviewEdgesError(two([{ slot: "self", reviewerBranchId: "b" }]))).toBe(
      "Plan A has a self review by an invalid reviewer.",
    );
  });
});

describe("code review roster", () => {
  const reviewer = (label: string) => ({ label, status: "pending" });
  const six = {
    reviewerA: reviewer("A"),
    reviewerB: reviewer("B"),
    additionalReviewers: ["C", "D", "E", "F"].map(reviewer),
  };

  it("lists reviewers in roster order with their ids", () => {
    expect(codeReviewReviewers(six).map(({ id, reviewer }) => `${id}:${reviewer.label}`)).toEqual([
      "a:A",
      "b:B",
      "c:C",
      "d:D",
      "e:E",
      "f:F",
    ]);
    expect(requireCodeReviewReviewer(six, "f").label).toBe("F");
    expect(() =>
      requireCodeReviewReviewer({ reviewerA: six.reviewerA, reviewerB: six.reviewerB }, "c"),
    ).toThrow("Workflow has no reviewer 'C'.");
  });

  it("updates one reviewer without touching the others", () => {
    const next = updateCodeReviewReviewer(six, "e", (entry) => ({ ...entry, status: "running" }));
    expect(next.additionalReviewers.map((entry) => entry.status)).toEqual([
      "pending",
      "pending",
      "running",
      "pending",
    ]);
    expect(next.reviewerA).toBe(six.reviewerA);
  });
});

type Investigator = InvestigatorCrossReviewFields & { readonly label: string };
const investigator = (label: string, mesh: ReadonlyArray<WorkflowParticipantId> | null) =>
  ({
    label,
    investigationStatus: "completed",
    selfReviewStatus: "not_started",
    crossReviewThreadId: null,
    crossReviewStatus: "not_started",
    crossReviewTurnId: null,
    crossReviewMessageId: null,
    crossReviewRetryCount: 0,
    crossReviewDispatchCommandId: null,
    error: null,
    ...(mesh ? { crossReviews: mesh.map((id) => initialInvestigationCrossReview(id, AT)) } : {}),
  }) satisfies Investigator as Investigator;

describe("investigation roster and cross-reviews", () => {
  const two = { investigatorA: investigator("A", null), investigatorB: investigator("B", null) };
  const three = {
    investigatorA: investigator("A", ["b", "c"]),
    investigatorB: investigator("B", ["a", "c"]),
    additionalInvestigators: [investigator("C", ["a", "b"])],
  };

  it("reads and updates investigators by id", () => {
    expect(investigationInvestigators(three).map(({ id }) => id)).toEqual(["a", "b", "c"]);
    expect(requireInvestigator(three, "c").label).toBe("C");
    expect(() => requireInvestigator(two, "c")).toThrow("Workflow has no investigator 'C'.");
    const next = updateInvestigator(three, "c", (entry) => ({ ...entry, label: "C2" }));
    expect(next.additionalInvestigators[0]?.label).toBe("C2");
  });

  it("views a two-investigator record's legacy fields as the reviewer's single edge", () => {
    const thread = "thread-a" as ThreadId;
    const started = updateInvestigationCrossReview(
      two,
      { reviewerId: "a", revieweeId: "b" },
      { threadId: thread, status: "running" },
      AT,
    );
    expect(started.investigatorA.crossReviewThreadId).toBe(thread);
    expect(started.investigatorA.crossReviewStatus).toBe("running");
    expect(started.investigatorA.crossReviews).toBeUndefined();
    expect(
      investigationCrossReviews(started).map((view) => [view.reviewerId, view.revieweeId]),
    ).toEqual([
      ["a", "b"],
      ["b", "a"],
    ]);
    expect(
      findInvestigationCrossReview(started, { reviewerId: "a", revieweeId: "b" }),
    ).toMatchObject({
      threadId: thread,
      status: "running",
    });
    expect(investigationCrossReviewsError(started)).toBeNull();
    const reverse = updateInvestigationCrossReview(
      started,
      { reviewerId: "b", revieweeId: "a" },
      { status: "running" },
      AT,
    );
    expect(reverse.investigatorB.crossReviewStatus).toBe("running");
    for (const revieweeId of ["a", "c"] as const) {
      expect(() =>
        updateInvestigationCrossReview(two, { reviewerId: "a", revieweeId }, {}, AT),
      ).toThrow(WorkflowParticipantInvariantError);
    }
  });

  it("keeps a legacy investigator error while another phase still failed", () => {
    const failed = {
      ...two,
      investigatorA: {
        ...two.investigatorA,
        selfReviewStatus: "error",
        crossReviewStatus: "error" as const,
        error: "boom",
      },
    };
    const cleared = updateInvestigationCrossReview(
      failed,
      { reviewerId: "a", revieweeId: "b" },
      { status: "running", error: null },
      AT,
    );
    expect(cleared.investigatorA.error).toBe("boom");
  });

  it("stores mesh edges in crossReviews and leaves the legacy fields alone", () => {
    expect(investigationCrossReviews(three)).toHaveLength(6);
    const failed = updateInvestigationCrossReview(
      three,
      { reviewerId: "c", revieweeId: "a" },
      { status: "error", error: "C could not review A." },
      AT,
    );
    const edge = findInvestigationCrossReview(failed, { reviewerId: "c", revieweeId: "a" });
    expect(edge).toMatchObject({ status: "error", error: "C could not review A." });
    expect(failed.additionalInvestigators[0]?.crossReviewStatus).toBe("not_started");
    expect(failed.additionalInvestigators[0]?.error).toBeNull();
    expect(investigationCrossReviewsOf(failed, "a").map((view) => view.reviewerId)).toEqual([
      "b",
      "c",
    ]);
    expect(() =>
      updateInvestigationCrossReview(three, { reviewerId: "c", revieweeId: "c" }, {}, AT),
    ).toThrow(WorkflowParticipantInvariantError);
  });

  it("rejects incomplete or misplaced cross-review storage", () => {
    expect(investigationCrossReviewsError(three)).toBeNull();
    expect(
      investigationCrossReviewsError({
        ...three,
        additionalInvestigators: [investigator("C", ["a"])],
      }),
    ).toBe("Investigator C needs exactly one cross-review per other investigator.");
    expect(
      investigationCrossReviewsError({ ...two, investigatorA: investigator("A", ["b"]) }),
    ).toBe("Investigator A must keep its cross-review in the single cross-review fields.");
  });
});
