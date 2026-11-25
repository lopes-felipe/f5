import {
  CodeReviewWorkflowId,
  InvestigationWorkflowId,
  PlanningWorkflowId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  createWorkflowStageThread,
  dispatchWorkflowDeleteCompensationCommand,
  liveThreadById,
} from "./WorkflowThreadCoordinator.ts";

describe("WorkflowThreadCoordinator", () => {
  it("returns only non-deleted threads from liveThreadById", () => {
    const t1 = ThreadId.make("t1");
    const t2 = ThreadId.make("t2");
    const snapshot = {
      threads: [
        { id: t1, deletedAt: null },
        { id: t2, deletedAt: "2026-01-01T00:00:00.000Z" },
      ],
    } as never;

    expect(liveThreadById(snapshot, t1)).toEqual({ id: t1, deletedAt: null });
    expect(liveThreadById(snapshot, t2)).toBeNull();
  });

  it("dispatches thread.create and delete compensation commands across workflow kinds", async () => {
    const dispatch = vi.fn(() => Effect.succeed({ sequence: 1 }));
    const orchestrationEngine = { dispatch } as never;
    const projectId = ProjectId.make("p1");

    await Effect.runPromise(
      createWorkflowStageThread({
        orchestrationEngine,
        threadId: ThreadId.make("t1"),
        projectId,
        title: "Reviewer A",
        model: "gpt-5.3-codex",
        branch: "main",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "thread.create",
        threadId: "t1",
        projectId: "p1",
        title: "Reviewer A",
        worktreePath: null,
      }),
    );

    await Effect.runPromise(
      dispatchWorkflowDeleteCompensationCommand({
        kind: "planning",
        orchestrationEngine,
        workflowId: PlanningWorkflowId.make("wf-1"),
        projectId,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "project.workflow.delete", workflowId: "wf-1" }),
    );

    await Effect.runPromise(
      dispatchWorkflowDeleteCompensationCommand({
        kind: "codeReview",
        orchestrationEngine,
        workflowId: CodeReviewWorkflowId.make("cr-1"),
        projectId,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "project.code-review-workflow.delete", workflowId: "cr-1" }),
    );

    await Effect.runPromise(
      dispatchWorkflowDeleteCompensationCommand({
        kind: "investigation",
        orchestrationEngine,
        workflowId: InvestigationWorkflowId.make("inv-1"),
        projectId,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "project.investigation-workflow.delete",
        workflowId: "inv-1",
      }),
    );
  });
});
