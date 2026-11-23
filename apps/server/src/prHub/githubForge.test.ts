import { makeGitHubHttpOperations } from "../git/githubHttpOperations.ts";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makeFakeGitHubCli } from "../git/testDoubles.ts";
import type { GitHubApiRequest } from "../git/githubApi.ts";
import { makeGitHubForge } from "./githubForge.ts";

const ref = {
  provider: "github" as const,
  host: "github.example",
  repository: "team/repo",
  number: 7,
};
const pr = {
  number: 7,
  title: "Scoped pull request",
  node_id: "PR_node",
  head: {
    ref: "feature",
    sha: "head-sha",
    repo: { full_name: "fork/repo", owner: { login: "fork" } },
  },
  base: { ref: "main", repo: { full_name: "team/repo" } },
  requested_reviewers: [],
};
function fixture(
  responses: unknown[] = [],
  mergeMessage?: Record<string, unknown>,
  autoMerge = {
    autoMergeAllowed: true,
    viewerPermission: "WRITE",
    state: "OPEN",
    mergeStateStatus: "BLOCKED",
  },
) {
  const calls: GitHubApiRequest[] = [];
  const queries: Array<{ query: string; variables: unknown }> = [];
  const github = makeFakeGitHubCli().service;
  const scoped = {
    ...github,
    getCredentialContext: () =>
      Effect.succeed({ host: ref.host, viewerId: 42, login: "reader", generation: "a" }),
    request: (input: GitHubApiRequest) => {
      calls.push(input);
      const next = (responses.shift() ?? pr) as { httpStatus?: number };
      return Effect.succeed({
        // A response that names its status is an error answer from GitHub.
        status: typeof next.httpStatus === "number" ? next.httpStatus : 200,
        body: next,
        graphqlErrors: [],
        links: {},
        etag: null,
        lastModified: null,
        rateLimit: {},
        rateLimitResource: null,
      });
    },
    runGraphql: (input: Parameters<typeof github.runGraphql>[0]) => {
      queries.push({ query: input.query, variables: input.variables });
      if (input.query.includes("F5AutoMergeAvailability"))
        return Effect.succeed({
          data: {
            repository: {
              ...autoMerge,
              pullRequest: { ...autoMerge, headRefOid: "head-sha" },
            },
          },
        });
      if (input.query.includes("F5PullRequestMergeMessage"))
        return Effect.succeed({ data: { repository: { pullRequest: mergeMessage } } });
      if (input.query.startsWith("mutation")) {
        const field = /\{\s*([A-Za-z0-9_]+)\s*\(/.exec(input.query)?.[1] ?? "mutation";
        return Effect.succeed({
          data: {
            [field]: {
              pullRequest: { id: "PR_node" },
              revertPullRequest: { id: "reverted" },
              thread: { id: "thread" },
            },
          },
        });
      }
      return Effect.succeed({
        data: {
          repository: {
            pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } },
          },
        },
      });
    },
  };
  const http = makeGitHubHttpOperations(scoped, () => Effect.succeed(""));
  return {
    provider: makeGitHubForge({ ...scoped, mergePullRequest: http.mergePullRequest }, "/repo"),
    calls,
    queries,
  };
}
describe("typed GitHub forge", () => {
  it("sends inline comments with the verdict in one GitHub review write", async () => {
    const { provider, calls } = fixture();
    await Effect.runPromise(
      provider.submitReview({
        ref,
        body: "Review",
        verdict: "request-changes",
        headSha: "head-sha",
        comments: [{ path: "src/test.ts", line: 5, side: "old", body: "Fix this" }],
      }),
    );
    expect(calls).toMatchObject([
      {
        endpoint: "repos/team/repo/pulls/7/reviews",
        method: "POST",
        body: {
          event: "REQUEST_CHANGES",
          commit_id: "head-sha",
          comments: [{ path: "src/test.ts", line: 5, side: "LEFT", body: "Fix this" }],
        },
      },
    ]);
  });
  it("opens a draft from a pushed branch and returns an existing PR without another write", async () => {
    const { provider, calls } = fixture([[], { default_branch: "main" }, pr, [pr]]);
    const open = () =>
      Effect.runPromise(
        provider.openChangeRequest!({
          ref,
          head: "feature",
          title: "Scoped pull request",
          body: "Description",
          draft: true,
        }),
      );
    expect((await open()).number).toBe(7);
    expect((await open()).number).toBe(7);
    expect(calls.filter((call) => call.method === "POST")).toEqual([
      expect.objectContaining({
        endpoint: "repos/team/repo/pulls",
        body: {
          base: "main",
          head: "feature",
          title: "Scoped pull request",
          body: "Description",
          draft: true,
        },
      }),
    ]);
    expect(calls[0]?.query).toMatchObject({ state: "open", head: "team:feature" });
  });
  it("looks up an exact issue number and keeps search qualifiers repository-scoped", async () => {
    const { provider, calls, queries } = fixture([{ number: 123, title: "Exact issue" }]);
    expect(
      await Effect.runPromise(provider.completions!(ref, { sigil: "#", query: "123" })),
    ).toEqual([{ token: "#123", label: "#123", detail: "Exact issue" }]);
    expect(calls[0]?.endpoint).toBe("repos/team/repo/issues/123");
    expect(queries[0]?.variables).toEqual({ query: 'repo:team/repo "123" sort:updated-desc' });
    expect(await Effect.runPromise(provider.completions!(ref, { sigil: "!", query: "" }))).toEqual(
      [],
    );
  });
  it("preserves GitHub update time separately from creation time", async () => {
    const created = "2026-01-01T12:00:00Z";
    const updated = "2026-11-03T12:00:00Z";
    const { provider } = fixture([{ ...pr, created_at: created, updated_at: updated }]);
    const detail = await Effect.runPromise(provider.getDetail(ref));
    expect(detail.updatedAt).toBe(updated);
    expect(detail.raw.created_at).toBe(created);
  });
  it("updates branches with the prepared head revision in the mutation", async () => {
    const { provider, queries } = fixture();
    await Effect.runPromise(
      provider.performAction({
        ref,
        action: "update-branch",
        method: "rebase",
        expectedHeadOid: "head-sha",
      }),
    );
    expect(queries[0]?.query).toContain("expectedHeadOid:$head,updateMethod:$method");
    expect(queries[0]?.variables).toEqual({ id: "PR_node", head: "head-sha", method: "REBASE" });
  });
  it("rejects a changed or missing prepared head before updating a branch", async () => {
    const { provider, queries } = fixture();
    for (const expectedHeadOid of ["old-sha", undefined]) {
      const result = await Effect.runPromise(
        provider
          .performAction({
            ref,
            action: "update-branch",
            ...(expectedHeadOid ? { expectedHeadOid } : {}),
          })
          .pipe(Effect.result),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.requestDispatched).toBe(false);
    }
    expect(queries).toHaveLength(0);
  });
  it("treats HTTP200 merged:false as a failed dispatched mutation", async () => {
    const { provider, calls } = fixture([{ merged: false, message: "Merge blocked" }]);
    const result = await Effect.runPromise(
      provider.performAction({ ref, action: "merge", expectedHeadOid: "sha" }).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.requestDispatched).toBe(true);
    expect(calls[0]?.body).toMatchObject({ sha: "sha", merge_method: "merge" });
  });
  it("uses captured host/account for comments, replies and edited review remarks", async () => {
    const { provider, calls } = fixture();
    await Effect.runPromise(provider.writeComment({ ref, body: "Reply", replyTo: "123" }));
    await Effect.runPromise(
      provider.editComment({ ref, commentId: "456", body: "Edit", kind: "review-comment" }),
    );
    expect(calls.map((call) => call.endpoint)).toEqual([
      "repos/team/repo/pulls/7/comments/123/replies",
      "repos/team/repo/pulls/comments/456",
    ]);
    expect(
      calls.every((call) => call.context.host === "github.example" && call.context.viewerId === 42),
    ).toBe(true);
  });
  it("implements native review body, labels and reviewer removal", async () => {
    const { provider, calls } = fixture([
      {},
      { ...pr, requested_reviewers: [{ login: "old" }] },
      {},
      {},
      {},
    ]);
    await Effect.runPromise(
      provider.submitReview({ ref, body: "Review text", verdict: "approve", headSha: "head-sha" }),
    );
    await Effect.runPromise(provider.setReviewers({ ref, reviewers: ["new"] }));
    await Effect.runPromise(provider.setLabels({ ref, labels: ["ready"] }));
    expect(calls[0]?.body).toMatchObject({
      body: "Review text",
      event: "APPROVE",
      commit_id: "head-sha",
    });
    expect(calls[2]).toMatchObject({ method: "DELETE", body: { reviewers: ["old"] } });
    expect(calls[3]).toMatchObject({ method: "POST", body: { reviewers: ["new"] } });
    expect(calls[4]?.body).toEqual({ labels: ["ready"] });
  });
  it("sends the upstream revert mutation with the pull request node ID", async () => {
    const { provider, queries } = fixture();
    await Effect.runPromise(provider.performAction({ ref, action: "revert" }));
    expect(queries[0]?.query).toContain("revertPullRequest(input:{pullRequestId:$id})");
    expect(queries[0]?.variables).toEqual({ id: "PR_node" });
  });
  it("never approves a workflow run for a different branch or event", async () => {
    const { provider, calls } = fixture([
      pr,
      [pr],
      {
        total_count: 2,
        workflow_runs: [
          {
            id: 1,
            head_sha: "other",
            head_branch: "feature",
            event: "pull_request",
            status: "action_required",
            head_repository: { owner: { login: "fork" } },
          },
          {
            id: 2,
            head_sha: "head-sha",
            head_branch: "feature",
            event: "pull_request_target",
            status: "action_required",
            head_repository: { owner: { login: "fork" } },
          },
        ],
      },
    ]);
    await Effect.runPromise(
      provider.performAction({ ref, action: "approve-workflows", expectedHeadOid: "head-sha" }),
    );
    expect(calls.some((call) => call.endpoint.endsWith("/approve"))).toBe(false);
  });
  it("rejects a fork head shared by multiple open pull requests", async () => {
    const { provider, calls } = fixture([pr, [pr, { ...pr, number: 8 }]]);
    expect(
      (await Effect.runPromiseExit(provider.performAction({ ref, action: "approve-workflows" })))
        ._tag,
    ).toBe("Failure");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });
  it("revalidates the fork head and workflow before each approval", async () => {
    const run = {
      id: 1,
      head_sha: "head-sha",
      head_branch: "feature",
      event: "pull_request",
      status: "action_required",
      head_repository: { owner: { login: "fork" } },
    };
    const { provider, calls } = fixture([
      pr,
      [pr],
      { total_count: 1, workflow_runs: [run] },
      pr,
      [pr],
      run,
      {},
    ]);
    await Effect.runPromise(
      provider.performAction({ ref, action: "approve-workflows", expectedHeadOid: "head-sha" }),
    );
    expect(calls.at(-1)).toMatchObject({
      method: "POST",
      endpoint: "repos/team/repo/actions/runs/1/approve",
    });
    const changed = fixture([
      pr,
      [pr],
      { total_count: 1, workflow_runs: [run] },
      { ...pr, head: { ...pr.head, sha: "changed" } },
    ]);
    expect(
      (
        await Effect.runPromiseExit(
          changed.provider.performAction({ ref, action: "approve-workflows" }),
        )
      )._tag,
    ).toBe("Failure");
    expect(changed.calls.some((call) => call.method === "POST")).toBe(false);
  });
});

it("reads diff text through the captured HTTP request without gh", async () => {
  const f = fixture(["diff --git a/a b/a\n+hello\n"]);
  expect(await Effect.runPromise(f.provider.getDiff(ref))).toBe("diff --git a/a b/a\n+hello\n");
  expect(f.calls[0]).toMatchObject({
    endpoint: "repos/team/repo/pulls/7",
    method: "GET",
    accept: "application/vnd.github.diff",
  });
});

it("auto-merge preserves the prepared head and cleaned body, including an explicitly empty body", async () => {
  const { provider, queries } = fixture([], {
    isMergeQueueEnabled: false,
    headRefOid: "head-sha",
    viewerMergeBodyText: "Co-authored-by: Claude <noreply@anthropic.com>",
  });
  await Effect.runPromise(
    provider.performAction({
      ref,
      action: "enable-auto-merge",
      method: "squash",
      expectedHeadOid: "head-sha",
      removeAgentCreditsOnMerge: true,
    }),
  );
  expect(queries[1]?.variables).toMatchObject({ method: "SQUASH" });
  expect(queries[2]?.query).toContain("expectedHeadOid:$head");
  expect(queries[2]?.query).toContain("commitBody:$body");
  expect(queries[2]?.variables).toMatchObject({ head: "head-sha", method: "SQUASH", body: "" });
});
it("keeps the host auto-merge message for a merge queue and rebase", async () => {
  for (const method of ["merge", "rebase"] as const) {
    const { provider, queries } = fixture([], {
      isMergeQueueEnabled: true,
      headRefOid: "head-sha",
      viewerMergeBodyText: "Co-authored-by: Claude <noreply@anthropic.com>",
    });
    await Effect.runPromise(
      provider.performAction({
        ref,
        action: "enable-auto-merge",
        method,
        expectedHeadOid: "head-sha",
        removeAgentCreditsOnMerge: true,
      }),
    );
    const mutation = queries.at(-1)!;
    expect(mutation.query).not.toContain("commitBody");
    expect(mutation.variables).not.toHaveProperty("body");
    expect(mutation.variables).toMatchObject({ head: "head-sha" });
    if (method === "rebase") expect(queries).toHaveLength(2);
  }
});

it.each([
  { autoMergeAllowed: false, mergeStateStatus: "BLOCKED" },
  { autoMergeAllowed: true, mergeStateStatus: "CLEAN" },
  { autoMergeAllowed: true, mergeStateStatus: "HAS_HOOKS" },
  { autoMergeAllowed: true, mergeStateStatus: "UNSTABLE" },
])("refuses unsafe auto-merge availability %j before sending a mutation", async (availability) => {
  const { provider, queries } = fixture([], undefined, {
    ...availability,
    viewerPermission: "WRITE",
    state: "OPEN",
  });
  const result = await Effect.runPromise(
    provider
      .performAction({
        ref,
        action: "enable-auto-merge",
        expectedHeadOid: "head-sha",
      })
      .pipe(Effect.result),
  );
  expect(result._tag).toBe("Failure");
  expect(queries.some((query) => query.query.startsWith("mutation"))).toBe(false);
});
it("does not activate auto-merge after the prepared head changes", async () => {
  const { provider, queries } = fixture([], {
    isMergeQueueEnabled: false,
    headRefOid: "new-head",
    viewerMergeBodyText: "Co-authored-by: Claude <noreply@anthropic.com>",
  });
  const result = await Effect.runPromise(
    provider
      .performAction({
        ref,
        action: "enable-auto-merge",
        expectedHeadOid: "head-sha",
        removeAgentCreditsOnMerge: true,
      })
      .pipe(Effect.result),
  );
  expect(result._tag).toBe("Failure");
  expect(queries.some((entry) => entry.query.startsWith("mutation"))).toBe(false);
});

it("sends query parameters apart from the endpoint, which may not hold a query string", async () => {
  const { provider, calls } = fixture([[{ login: "alice" }]]);
  await Effect.runPromise(provider.listReviewerCandidates(ref));
  expect(calls[0]).toMatchObject({
    method: "GET",
    endpoint: "repos/team/repo/collaborators",
    query: { per_page: "100" },
  });
  const files = fixture([[]]);
  await Effect.runPromise(files.provider.getFiles(ref));
  expect(files.calls[0]).toMatchObject({
    endpoint: "repos/team/repo/pulls/7/files",
    query: { per_page: "100", page: "1" },
  });
  expect([...calls, ...files.calls].every((call) => !call.endpoint.includes("?"))).toBe(true);
});

describe("re-running failed checks", () => {
  const run = (id: number, conclusion: string, status = "completed") => ({
    id,
    status,
    conclusion,
    head_sha: "head-sha",
  });

  it("re-runs the failed jobs of every failed workflow run at the prepared head", async () => {
    const { provider, calls } = fixture([
      pr,
      {
        total_count: 4,
        workflow_runs: [
          run(11, "failure"),
          run(12, "success"),
          run(13, "cancelled"),
          run(14, "", "in_progress"),
        ],
      },
      {},
      {},
    ]);
    await Effect.runPromise(
      provider.performAction({ ref, action: "rerun-failed-checks", expectedHeadOid: "head-sha" }),
    );
    expect(calls[1]).toMatchObject({
      method: "GET",
      endpoint: "repos/team/repo/actions/runs",
      query: { head_sha: "head-sha", per_page: "100" },
    });
    expect(calls.slice(2).map((call) => [call.method, call.endpoint])).toEqual([
      ["POST", "repos/team/repo/actions/runs/11/rerun-failed-jobs"],
      ["POST", "repos/team/repo/actions/runs/13/rerun-failed-jobs"],
    ]);
  });

  it("restarts one run at a time and says when GitHub refuses or cannot confirm", async () => {
    const superseded = fixture([
      pr,
      {
        total_count: 2,
        workflow_runs: [
          { ...run(11, "cancelled"), workflow_id: 70, event: "pull_request", run_number: 4 },
          {
            ...run(12, "", "in_progress"),
            workflow_id: 70,
            event: "pull_request",
            run_number: 5,
          },
        ],
      },
    ]);
    // An old cancelled run next to the run that replaced it leaves nothing to restart.
    const none = await Effect.runPromise(
      superseded.provider
        .workflowRuns!.listFailed({ ref, expectedHeadOid: "head-sha" })
        .pipe(Effect.result),
    );
    expect(none._tag).toBe("Failure");
    expect(superseded.calls.some((call) => call.method === "POST")).toBe(false);

    const accepted = fixture([{}]);
    expect(
      await Effect.runPromise(accepted.provider.workflowRuns!.rerunFailedJobs({ ref, runId: 11 })),
    ).toBeNull();
    expect(accepted.calls[0]).toMatchObject({
      method: "POST",
      endpoint: "repos/team/repo/actions/runs/11/rerun-failed-jobs",
    });

    const refused = fixture([{ httpStatus: 403, message: "This workflow is disabled." }]);
    expect(
      await Effect.runPromise(refused.provider.workflowRuns!.rerunFailedJobs({ ref, runId: 11 })),
    ).toBe("GitHub refused to re-run a workflow run (403): This workflow is disabled.");

    const unconfirmed = await Effect.runPromise(
      fixture([{ httpStatus: 502 }])
        .provider.workflowRuns!.rerunFailedJobs({ ref, runId: 11 })
        .pipe(Effect.result),
    );
    expect(unconfirmed._tag).toBe("Failure");
    if (unconfirmed._tag === "Failure") expect(unconfirmed.failure.requestDispatched).toBe(true);

    const read = fixture([{ id: 11, status: "queued", run_attempt: 3 }]);
    expect(await Effect.runPromise(read.provider.workflowRuns!.get({ ref, runId: 11 }))).toEqual({
      id: 11,
      attempt: 3,
      completed: false,
    });
    expect(read.calls[0]).toMatchObject({
      method: "GET",
      endpoint: "repos/team/repo/actions/runs/11",
    });
  });

  it("sends nothing without a prepared head, after a push, or when no run failed", async () => {
    const attempts = [
      { responses: [pr], expectedHeadOid: undefined },
      { responses: [pr], expectedHeadOid: "old-sha" },
      {
        responses: [pr, { total_count: 1, workflow_runs: [run(12, "success")] }],
        expectedHeadOid: "head-sha",
      },
      {
        responses: [pr, { total_count: 250, workflow_runs: [run(11, "failure")] }],
        expectedHeadOid: "head-sha",
      },
    ];
    for (const attempt of attempts) {
      const { provider, calls } = fixture(attempt.responses);
      const result = await Effect.runPromise(
        provider
          .performAction({
            ref,
            action: "rerun-failed-checks",
            ...(attempt.expectedHeadOid ? { expectedHeadOid: attempt.expectedHeadOid } : {}),
          })
          .pipe(Effect.result),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.requestDispatched).toBe(false);
      expect(calls.some((call) => call.method === "POST")).toBe(false);
    }
  });
});
