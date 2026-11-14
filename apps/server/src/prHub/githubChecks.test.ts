import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  GITHUB_CHECKS_MAX_PAGES,
  failedGitHubWorkflowRuns,
  gitHubCheckRunOf,
  readGitHubChecks,
} from "./githubChecks.ts";

const job = (overrides: Record<string, unknown> = {}) => ({
  __typename: "CheckRun",
  databaseId: 501,
  name: "static",
  status: "COMPLETED",
  conclusion: "FAILURE",
  detailsUrl: "https://github.example/team/repo/actions/runs/9/job/501",
  startedAt: "2026-11-14T06:54:26Z",
  completedAt: "2026-11-14T06:59:44Z",
  isRequired: true,
  checkSuite: {
    app: { slug: "github-actions" },
    workflowRun: { databaseId: 9, workflow: { name: "CI" } },
  },
  ...overrides,
});
const page = (
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
  headRefOid = "head-1",
) => ({
  data: {
    repository: {
      pullRequest: {
        headRefOid,
        commits: {
          nodes: [{ commit: { statusCheckRollup: { contexts: { nodes, pageInfo } } } }],
        },
      },
    },
  },
});

describe("gitHubCheckRunOf", () => {
  it("maps a GitHub Actions job to a check with a readable log", () => {
    expect(gitHubCheckRunOf(job(), 0)).toEqual({
      required: true,
      name: "static",
      status: "failure",
      description: null,
      url: "https://github.example/team/repo/actions/runs/9/job/501",
      id: "501",
      workflow: "CI",
      workflowRunId: "9",
      startedAt: "2026-11-14T06:54:26.000Z",
      completedAt: "2026-11-14T06:59:44.000Z",
      logAvailable: true,
    });
  });

  it("offers no log for a running job, another app's check run or a commit status", () => {
    expect(
      gitHubCheckRunOf(job({ status: "IN_PROGRESS", conclusion: null, completedAt: null }), 0),
    ).toMatchObject({ status: "pending", logAvailable: false, completedAt: null });
    expect(
      gitHubCheckRunOf(job({ checkSuite: { app: { slug: "vercel" }, workflowRun: null } }), 0),
    ).toMatchObject({ id: "501", workflow: null, workflowRunId: null, logAvailable: false });
    expect(
      gitHubCheckRunOf(
        {
          __typename: "StatusContext",
          context: "ci/external",
          state: "FAILURE",
          description: "Build failed",
          targetUrl: "https://ci.example/1",
          createdAt: "2026-11-14T06:54:26Z",
        },
        3,
      ),
    ).toEqual({
      name: "ci/external",
      status: "failure",
      description: "Build failed",
      url: "https://ci.example/1",
      id: "status:ci/external",
      workflow: null,
      workflowRunId: null,
      startedAt: "2026-11-14T06:54:26.000Z",
      completedAt: null,
      logAvailable: false,
    });
    expect(gitHubCheckRunOf({ __typename: "Other" }, 0)).toBeNull();
  });
});

describe("readGitHubChecks", () => {
  it("follows the cursor until the last page", async () => {
    const cursors: Array<string | null> = [];
    const pages = [
      page([job()], { hasNextPage: true, endCursor: "c1" }),
      page([job({ databaseId: 502, name: "test", conclusion: "SUCCESS" })], {
        hasNextPage: false,
        endCursor: null,
      }),
    ];
    const result = await Effect.runPromise(
      readGitHubChecks((cursor) => {
        cursors.push(cursor);
        return Effect.succeed(pages.shift());
      }),
    );
    expect(cursors).toEqual([null, "c1"]);
    expect(result.headOid).toBe("head-1");
    expect(result.truncated).toBe(false);
    expect(result.checks.map((check) => [check.id, check.status])).toEqual([
      ["501", "failure"],
      ["502", "success"],
    ]);
  });

  it("stops at the page limit and says the list is incomplete", async () => {
    let reads = 0;
    const result = await Effect.runPromise(
      readGitHubChecks(() =>
        Effect.succeed(
          page([job({ databaseId: 600 + reads })], {
            hasNextPage: true,
            endCursor: `c${++reads}`,
          }),
        ),
      ),
    );
    expect(reads).toBe(GITHUB_CHECKS_MAX_PAGES);
    expect(result.truncated).toBe(true);
    expect(result.checks).toHaveLength(GITHUB_CHECKS_MAX_PAGES);
  });

  it("fails when the head moves between pages, on errors and on a missing pull request", async () => {
    const pages = [
      page([job()], { hasNextPage: true, endCursor: "c1" }),
      page([job()], { hasNextPage: false, endCursor: null }, "head-2"),
    ];
    const read = (body: () => unknown) =>
      Effect.runPromise(readGitHubChecks(() => Effect.succeed(body())).pipe(Effect.result));
    expect((await read(() => pages.shift()))._tag).toBe("Failure");
    expect((await read(() => ({ errors: [{ message: "nope" }] })))._tag).toBe("Failure");
    expect((await read(() => ({ data: { repository: { pullRequest: null } } })))._tag).toBe(
      "Failure",
    );
    expect((await read(() => page([job()], { hasNextPage: true, endCursor: null })))._tag).toBe(
      "Failure",
    );
  });

  it("reads a pull request whose head commit has no checks", async () => {
    const result = await Effect.runPromise(
      readGitHubChecks(() =>
        Effect.succeed({
          data: {
            repository: {
              pullRequest: {
                headRefOid: "head-1",
                commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
              },
            },
          },
        }),
      ),
    );
    expect(result).toEqual({ headOid: "head-1", checks: [], truncated: false });
  });
});

describe("failedGitHubWorkflowRuns", () => {
  const run = (id: number, status: string, conclusion: string | null, head_sha = "head-1") => ({
    id,
    status,
    conclusion,
    head_sha,
  });

  it("picks finished runs of the commit that failed, were cancelled or timed out", () => {
    expect(
      failedGitHubWorkflowRuns(
        {
          total_count: 6,
          workflow_runs: [
            run(1, "completed", "failure"),
            run(2, "completed", "success"),
            run(3, "in_progress", null),
            run(4, "completed", "cancelled"),
            run(5, "completed", "timed_out"),
            run(6, "completed", "failure", "other-head"),
          ],
        },
        "head-1",
      ),
    ).toEqual({ ids: [1, 4, 5], total: 6, complete: true });
  });

  it("reports an incomplete listing instead of re-running part of it", () => {
    expect(
      failedGitHubWorkflowRuns(
        { total_count: 101, workflow_runs: [run(1, "completed", "failure")] },
        "head-1",
      ).complete,
    ).toBe(false);
    expect(failedGitHubWorkflowRuns({ message: "Not Found" }, "head-1")).toEqual({
      ids: [],
      total: 0,
      complete: false,
    });
    expect(
      failedGitHubWorkflowRuns(
        { total_count: 1, workflow_runs: [{ ...run(0, "completed", "failure"), id: "x" }] },
        "head-1",
      ).complete,
    ).toBe(false);
  });
});
