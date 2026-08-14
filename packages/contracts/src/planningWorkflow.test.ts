import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { PlanningWorkflow, PlanningWorkflowId } from "./planningWorkflow";
import { ProjectId, ThreadId } from "./baseSchemas";

function makeWorkflowRecord(now: string) {
  return {
    id: PlanningWorkflowId.makeUnsafe("workflow-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Planning workflow",
    slug: "planning-workflow",
    requirementPrompt: "Ship the workflow feature",
    plansDirectory: "plans",
    selfReviewEnabled: true,
    branchA: {
      branchId: "a",
      authorSlot: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      authorThreadId: ThreadId.makeUnsafe("thread-a"),
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [],
      status: "pending",
      error: null,
      errorStage: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: now,
    },
    branchB: {
      branchId: "b",
      authorSlot: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-5",
        providerOptions: {
          claudeAgent: { subagentsEnabled: false },
        },
      },
      authorThreadId: ThreadId.makeUnsafe("thread-b"),
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [],
      status: "pending",
      error: null,
      errorStage: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: now,
    },
    merge: {
      mergeSlot: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      threadId: null,
      outputFilePath: null,
      turnId: null,
      approvedPlanId: null,
      status: "not_started",
      error: null,
      updatedAt: now,
    },
    implementation: null,
    totalCostUsd: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
  };
}

describe("planningWorkflow contracts", () => {
  it("decodes a workflow snapshot record", () => {
    const now = new Date().toISOString();
    const workflow = Schema.decodeUnknownSync(PlanningWorkflow)(makeWorkflowRecord(now));

    expect(workflow.id).toBe("workflow-1");
    expect(workflow.branchA.authorSlot.provider).toBe("codex");
    expect(workflow.selfReviewEnabled).toBe(true);
    expect(workflow.branchB.authorSlot.providerOptions).toEqual({
      claudeAgent: { subagentsEnabled: false },
    });
    expect(workflow.merge.approvedPlanId).toBeNull();
    expect(workflow.implementation).toBeNull();
  });

  it("defaults selfReviewEnabled to true when omitted", () => {
    const now = new Date().toISOString();
    const record = makeWorkflowRecord(now);
    const { selfReviewEnabled: _, ...legacyRecord } = record;
    const workflow = Schema.decodeUnknownSync(PlanningWorkflow)(legacyRecord);

    expect(workflow.selfReviewEnabled).toBe(true);
  });

  it("defaults implementation to null when omitted for older records", () => {
    const now = new Date().toISOString();
    const record = makeWorkflowRecord(now);
    const { implementation: _, ...legacyRecord } = record;

    const workflow = Schema.decodeUnknownSync(PlanningWorkflow)(legacyRecord);

    expect(workflow.implementation).toBeNull();
  });

  it("defaults retry metadata and totalCostUsd for older records", () => {
    const now = new Date().toISOString();
    const record = makeWorkflowRecord(now);
    const {
      errorStage: _branchAErrorStage,
      retryCount: _branchARetryCount,
      lastRetryAt: _branchALastRetryAt,
      ...legacyBranchA
    } = record.branchA;
    const {
      errorStage: _branchBErrorStage,
      retryCount: _branchBRetryCount,
      lastRetryAt: _branchBLastRetryAt,
      ...legacyBranchB
    } = record.branchB;
    const { totalCostUsd: _totalCostUsd, ...legacyRecord } = record;

    const workflow = Schema.decodeUnknownSync(PlanningWorkflow)({
      ...legacyRecord,
      branchA: legacyBranchA,
      branchB: legacyBranchB,
    });

    expect(workflow.branchA.retryCount).toBe(0);
    expect(workflow.branchA.lastRetryAt).toBeNull();
    expect(workflow.branchA.errorStage).toBeNull();
    expect(workflow.branchB.retryCount).toBe(0);
    expect(workflow.branchB.lastRetryAt).toBeNull();
    expect(workflow.branchB.errorStage).toBeNull();
    expect(workflow.totalCostUsd).toBe(0);
  });

  it("defaults legacy planning review retry metadata and round-trips new failure fields", () => {
    const now = new Date().toISOString();
    const record = makeWorkflowRecord(now);
    const legacyReview = {
      slot: "cross" as const,
      threadId: ThreadId.makeUnsafe("review-a"),
      outputFilePath: null,
      status: "error" as const,
      error: "connection reset",
      updatedAt: now,
    };
    const decoded = Schema.decodeUnknownSync(PlanningWorkflow)({
      ...record,
      branchA: {
        ...record.branchA,
        reviews: [legacyReview],
      },
    });

    expect(decoded.branchA.reviews[0]?.retryCount).toBe(0);
    expect(decoded.branchA.reviews[0]?.lastRetryAt).toBeNull();

    const withRetryMetadata = {
      ...decoded,
      branchA: {
        ...decoded.branchA,
        errorStage: "revision" as const,
        reviews: decoded.branchA.reviews.map((review) => ({
          ...review,
          retryCount: 2,
          lastRetryAt: now,
        })),
      },
    };
    const encoded = Schema.encodeSync(PlanningWorkflow)(withRetryMetadata);
    const roundTripped = Schema.decodeUnknownSync(PlanningWorkflow)(encoded);

    expect(roundTripped.branchA.errorStage).toBe("revision");
    expect(roundTripped.branchA.reviews[0]?.retryCount).toBe(2);
    expect(roundTripped.branchA.reviews[0]?.lastRetryAt).toBe(now);
  });

  it("defaults archivedAt to null when omitted for older records", () => {
    const now = new Date().toISOString();
    const record = makeWorkflowRecord(now);
    const { archivedAt: _, ...legacyRecord } = record;

    const workflow = Schema.decodeUnknownSync(PlanningWorkflow)(legacyRecord);

    expect(workflow.archivedAt).toBeNull();
  });

  it("defaults merge.approvedPlanId to null when omitted for older records", () => {
    const now = new Date().toISOString();
    const record = makeWorkflowRecord(now);
    const { approvedPlanId: _, ...legacyMerge } = record.merge;

    const workflow = Schema.decodeUnknownSync(PlanningWorkflow)({
      ...record,
      merge: legacyMerge,
    });

    expect(workflow.merge.approvedPlanId).toBeNull();
  });
});
