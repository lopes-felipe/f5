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
function fixture(responses: unknown[] = []) {
  const calls: GitHubApiRequest[] = [];
  const queries: Array<{ query: string; variables: unknown }> = [];
  const github = makeFakeGitHubCli().service;
  const scoped = {
    ...github,
    getCredentialContext: () =>
      Effect.succeed({ host: ref.host, viewerId: 42, login: "reader", generation: "a" }),
    request: (input: GitHubApiRequest) => {
      calls.push(input);
      return Effect.succeed({
        status: 200,
        body: responses.shift() ?? pr,
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
  return { provider: makeGitHubForge(scoped, "/repo"), calls, queries };
}
describe("typed GitHub forge", () => {
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
