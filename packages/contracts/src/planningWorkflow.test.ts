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
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: now,
    },
    branchB: {
      branchId: "b",
      authorSlot: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-5",
      },
      authorThreadId: ThreadId.makeUnsafe("thread-b"),
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [],
      status: "pending",
      error: null,
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
      retryCount: _branchARetryCount,
      lastRetryAt: _branchALastRetryAt,
      ...legacyBranchA
    } = record.branchA;
    const {
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
    expect(workflow.branchB.retryCount).toBe(0);
    expect(workflow.branchB.lastRetryAt).toBeNull();
    expect(workflow.totalCostUsd).toBe(0);
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
