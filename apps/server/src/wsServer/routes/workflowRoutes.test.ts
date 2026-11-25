import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import { Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { BUILTIN_WORKFLOW_TEMPLATES } from "../../workflowPlatform.ts";
import { workflowRoutes } from "./workflowRoutes.ts";

const fakeWs = {} as WebSocket;

describe("workflowRoutes", () => {
  it("lists built-in workflow templates without requiring orchestration runtime", async () => {
    const routes = workflowRoutes({
      runtime: Effect.die("runtime should not be awaited"),
    });

    const result = await Effect.runPromise(
      routes[WS_METHODS.workflowPlatformListTemplates](
        { _tag: WS_METHODS.workflowPlatformListTemplates },
        fakeWs,
      ),
    );
    expect(result).toEqual({ templates: BUILTIN_WORKFLOW_TEMPLATES });
  });

  it("creates planning workflows and wraps service failures as RouteRequestError", async () => {
    const createWorkflow = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed("wf-123"))
      .mockReturnValueOnce(Effect.fail(new Error("boom")));

    const routes = workflowRoutes({
      runtime: Effect.succeed({
        orchestrationEngine: { getReadModel: () => Effect.die("unused") },
        workflowService: { createWorkflow } as never,
        codeReviewWorkflowService: {} as never,
        investigationWorkflowService: {} as never,
      }),
    });

    const created = await Effect.runPromise(
      routes[ORCHESTRATION_WS_METHODS.createWorkflow](
        { _tag: ORCHESTRATION_WS_METHODS.createWorkflow, projectId: "p1" } as never,
        fakeWs,
      ),
    );
    expect(created).toEqual({ workflowId: "wf-123" });

    const failed = await Effect.runPromiseExit(
      routes[ORCHESTRATION_WS_METHODS.createWorkflow](
        { _tag: ORCHESTRATION_WS_METHODS.createWorkflow, projectId: "p1" } as never,
        fakeWs,
      ),
    );
    expect(Exit.isFailure(failed)).toBe(true);
  });
});
