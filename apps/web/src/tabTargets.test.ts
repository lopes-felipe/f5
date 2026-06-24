import { describe, expect, it } from "vitest";

import { parseTabTargetKey, resolveTabTargetFromRoute } from "./tabTargets";

describe("tabTargets", () => {
  it("resolves Pull Requests routes to a switchable tab target", () => {
    expect(
      resolveTabTargetFromRoute({
        pathname: "/pull-requests",
        routeId: "/_chat/pull-requests",
        params: {},
        search: {},
      }),
    ).toMatchObject({
      key: "pullRequests",
      kind: "pullRequests",
    });

    expect(parseTabTargetKey("pullRequests")).toMatchObject({
      key: "pullRequests",
      kind: "pullRequests",
    });
  });

  it("resolves investigation workflow routes and legacy debug aliases to investigation targets", () => {
    expect(
      resolveTabTargetFromRoute({
        pathname: "/investigation/workflow-1",
        routeId: "/_chat/investigation/$workflowId",
        params: { workflowId: "workflow-1" },
        search: {},
      }),
    ).toMatchObject({
      key: "investigationWorkflow:workflow-1",
      kind: "investigationWorkflow",
      workflowId: "workflow-1",
    });

    expect(
      resolveTabTargetFromRoute({
        pathname: "/debug/workflow-1",
        routeId: "/_chat/debug/$workflowId",
        params: { workflowId: "workflow-1" },
        search: {},
      }),
    ).toMatchObject({
      key: "investigationWorkflow:workflow-1",
      kind: "investigationWorkflow",
      workflowId: "workflow-1",
    });

    expect(parseTabTargetKey("debugWorkflow:workflow-1")).toMatchObject({
      key: "investigationWorkflow:workflow-1",
      kind: "investigationWorkflow",
      workflowId: "workflow-1",
    });
  });
});
