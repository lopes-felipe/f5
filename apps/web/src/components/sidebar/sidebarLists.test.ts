import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { resolveThreadPullRequests } from "../../lib/threadPullRequests";
import { createPlanningWorkflow } from "../../test/workflowFixtures";
import type { Project, ThreadListItem } from "../../types";
import {
  buildProjectSidebarLists,
  orderThreadsByPipeline,
  prStatusIndicator,
  type ThreadPr,
  workflowPrLabel,
} from "./sidebarLists";

const thread = (id: string, lastInteractionAt: string) =>
  ({
    id: ThreadId.makeUnsafe(id),
    title: id,
    createdAt: lastInteractionAt,
    lastInteractionAt,
    archivedAt: null,
  }) as unknown as ThreadListItem;

describe("prStatusIndicator", () => {
  const pr = (state: "open" | "closed" | "merged", number = 462): ThreadPr =>
    ({
      number,
      title: "Sidebar redesign",
      url: `https://github.com/acme/repo/pull/${number}`,
      baseBranch: "main",
      headBranch: "feature",
      state,
    }) as ThreadPr;
  const items = (branchPr: ThreadPr) =>
    resolveThreadPullRequests({ branchPr, links: [], linkState: () => undefined });

  it("carries the PR number with each state", () => {
    expect(prStatusIndicator(items(pr("open")))).toMatchObject({
      state: "open",
      label: "PR open",
      number: 462,
    });
    expect(prStatusIndicator(items(pr("merged")))).toMatchObject({
      state: "merged",
      label: "PR merged",
      number: 462,
    });
    expect(prStatusIndicator(items(pr("closed")))).toMatchObject({
      state: "closed",
      label: "PR closed",
      number: 462,
    });
    expect(prStatusIndicator(items(null))).toBeNull();
  });

  it("labels a finished workflow's PR status tooltip by PR state", () => {
    expect(workflowPrLabel(prStatusIndicator(items(pr("open")))!)).toBe("PR #462 open");
    expect(workflowPrLabel(prStatusIndicator(items(pr("merged")))!)).toBe("Merged #462");
    expect(workflowPrLabel(prStatusIndicator(items(pr("closed")))!)).toBe("PR #462 closed");
  });

  it("colors several PRs by the most actionable one and lists each in the tooltip", () => {
    const indicator = prStatusIndicator(
      resolveThreadPullRequests({
        branchPr: pr("merged", 10),
        links: [
          {
            provider: "github",
            host: "github.com",
            repository: "acme/repo",
            number: 11,
            title: "Linked",
            url: "https://github.com/acme/repo/pull/11",
          },
        ],
        linkState: () => ({ state: "open", title: "Linked fix" }),
      }),
    );
    expect(indicator).toMatchObject({ state: "open", label: "PR open", number: 11 });
    expect(indicator?.items.map((item) => item.number)).toEqual([11, 10]);
    expect(indicator?.tooltip).toBe("#11 open · Linked fix\n#10 merged · Sidebar redesign");
  });
});

describe("orderThreadsByPipeline", () => {
  it("orders a workflow's threads by pipeline, then unmatched ones by activity", () => {
    const threads = [
      thread("implementation", "2026-11-03T12:00:00.000Z"),
      thread("review-b", "2026-10-22T12:00:00.000Z"),
      thread("stray-old", "2026-10-01T12:00:00.000Z"),
      thread("branch-a", "2026-10-20T12:00:00.000Z"),
      thread("stray-new", "2026-11-02T12:00:00.000Z"),
      thread("branch-b", "2026-10-21T12:00:00.000Z"),
    ];
    const order = ["branch-a", "branch-b", "review-b", "implementation", "not-loaded"].map((id) =>
      ThreadId.makeUnsafe(id),
    );
    expect(orderThreadsByPipeline(order, threads).map((entry) => entry.id)).toEqual([
      "branch-a",
      "branch-b",
      "review-b",
      "implementation",
      "stray-new",
      "stray-old",
    ]);
  });
});

describe("buildProjectSidebarLists", () => {
  it("orders workflows by their threads' activity, not a bumped updatedAt", () => {
    const projectId = ProjectId.makeUnsafe("project-sort");
    const projectThread = (id: string, lastInteractionAt: string) =>
      ({ ...thread(id, lastInteractionAt), projectId, snoozedUntil: null }) as ThreadListItem;
    // Finished weeks ago, but a bookkeeping write bumped updatedAt to now.
    const bumped = {
      ...createPlanningWorkflow({
        id: "workflow-bumped",
        projectId,
        branchAThreadId: ThreadId.makeUnsafe("bumped-a"),
        branchBThreadId: ThreadId.makeUnsafe("bumped-b"),
      }),
      updatedAt: "2026-11-13T00:00:00.000Z",
    };
    const recent = {
      ...createPlanningWorkflow({
        id: "workflow-recent",
        projectId,
        branchAThreadId: ThreadId.makeUnsafe("recent-a"),
        branchBThreadId: ThreadId.makeUnsafe("recent-b"),
      }),
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const lists = buildProjectSidebarLists({
      project: { id: projectId, model: null } as unknown as Project,
      threads: [
        projectThread("bumped-a", "2026-10-19T00:00:00.000Z"),
        projectThread("bumped-b", "2026-10-19T00:00:00.000Z"),
        projectThread("recent-a", "2026-11-12T00:00:00.000Z"),
        projectThread("recent-b", "2026-11-12T00:00:00.000Z"),
      ],
      planningWorkflows: [bumped, recent],
      codeReviewWorkflows: [],
      investigationWorkflows: [],
      draftThread: null,
    });
    expect(lists.projectWorkflows.map((entry) => entry.workflow.id)).toEqual([
      "workflow-recent",
      "workflow-bumped",
    ]);
  });
});
