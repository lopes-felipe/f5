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
  const projectId = ProjectId.makeUnsafe("project-sort");
  const at = "2026-10-19T00:00:00.000Z";
  const slot = { provider: "codex", model: "gpt-5-codex" } as const;
  const projectThread = (id: string, lastInteractionAt: string) =>
    ({ ...thread(id, lastInteractionAt), projectId, snoozedUntil: null }) as ThreadListItem;
  /** A planning workflow whose four threads last ran at `threadsAt`, updated at `updatedAt`. */
  const workflowWithThreads = (input: {
    id: string;
    finished: boolean;
    updatedAt: string;
    threadsAt: string;
  }) => {
    const threadId = (role: string) => ThreadId.makeUnsafe(`${input.id}-${role}`);
    const workflow = createPlanningWorkflow({
      id: input.id,
      projectId,
      branchAThreadId: threadId("a"),
      branchBThreadId: threadId("b"),
      ...(input.finished
        ? {
            branchA: { status: "revised" as const },
            branchB: { status: "revised" as const },
            merge: { status: "merged" as const, threadId: threadId("merge") },
            implementation: {
              implementationSlot: slot,
              threadId: threadId("impl"),
              implementationTurnId: null,
              revisionTurnId: null,
              codeReviewEnabled: true,
              codeReviews: [
                {
                  reviewerLabel: "Reviewer",
                  reviewerSlot: slot,
                  threadId: threadId("review"),
                  status: "completed" as const,
                  error: null,
                  retryCount: 0,
                  lastRetryAt: null,
                  updatedAt: at,
                },
              ],
              status: "completed" as const,
              error: null,
              retryCount: 0,
              lastRetryAt: null,
              updatedAt: at,
            },
          }
        : {}),
    });
    return {
      workflow: { ...workflow, updatedAt: input.updatedAt },
      threads: ["a", "b", "merge", "impl"].map((role) =>
        projectThread(`${input.id}-${role}`, input.threadsAt),
      ),
    };
  };
  const order = (entries: ReadonlyArray<ReturnType<typeof workflowWithThreads>>) =>
    buildProjectSidebarLists({
      project: { id: projectId, model: null } as unknown as Project,
      threads: entries.flatMap((entry) => entry.threads),
      planningWorkflows: entries.map((entry) => entry.workflow),
      codeReviewWorkflows: [],
      investigationWorkflows: [],
      draftThread: null,
    }).projectWorkflows.map((entry) => entry.workflow.id);
  const recent = workflowWithThreads({
    id: "recent",
    finished: false,
    updatedAt: "2026-10-01T00:00:00.000Z",
    threadsAt: "2026-11-12T00:00:00.000Z",
  });

  it("orders a finished workflow by its threads' activity, not a bumped updatedAt", () => {
    // Finished weeks ago, but a bookkeeping write bumped updatedAt to now.
    const bumped = workflowWithThreads({
      id: "bumped",
      finished: true,
      updatedAt: "2026-11-13T00:00:00.000Z",
      threadsAt: at,
    });
    expect(order([bumped, recent])).toEqual(["recent", "bumped"]);
  });

  it("counts updatedAt for an unfinished workflow advancing to a step with no thread", () => {
    const advanced = workflowWithThreads({
      id: "advanced",
      finished: false,
      updatedAt: "2026-11-13T00:00:00.000Z",
      threadsAt: at,
    });
    expect(order([recent, advanced])).toEqual(["advanced", "recent"]);
  });
});
