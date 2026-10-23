import { ServerSettingsService } from "../serverSettings.ts";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeGitHubCli } from "./Layers/GitHubCli.ts";
import { GitHubCredentialScope } from "./githubApi.ts";
import { makeGitHubRequestScheduler } from "./githubRequestScheduler.ts";
import { runProcess } from "../processRunner.ts";
vi.mock("../processRunner.ts", () => ({ runProcess: vi.fn() }));
vi.mock("../outboundHttp.ts", async (importOriginal) =>
  (await import("../testUtils/undiciFetchThroughGlobal.ts")).undiciFetchThroughGlobal(
    importOriginal,
  ),
);
const processMock = vi.mocked(runProcess);
const url = "https://github.com/octo/repo/pull/7";
const pr = {
  number: 7,
  title: "A change",
  html_url: url,
  state: "open",
  node_id: "PR_7",
  updated_at: "2026-10-01T00:00:00Z",
  base: { ref: "main", repo: { full_name: "octo/repo" } },
  head: {
    ref: "feature",
    sha: "abc123",
    repo: { full_name: "fork/repo", owner: { login: "fork" } },
  },
};
type Call = { url: URL; method: string; body: Record<string, unknown>; headers: Headers };
function fixture(reply: (call: Call) => unknown | Response = () => ({})) {
  const calls: Call[] = [];
  const http = vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>(
    async (target, init) => {
      const call = {
        url: new URL(String(target)),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : {},
        headers: new Headers(init?.headers),
      };
      calls.push(call);
      if (call.url.pathname.endsWith("/user")) return Response.json({ id: 123, login: "alice" });
      const value = reply(call);
      return value instanceof Response ? value : Response.json(value);
    },
  );
  vi.stubGlobal("fetch", http);
  processMock.mockResolvedValue({
    stdout: "remote.origin.url git@github.com:octo/repo.git\n",
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
  });
  const make = makeGitHubCli({
    resolveToken: () => Effect.succeed("private-token"),
    scheduler: makeGitHubRequestScheduler(),
  });
  return { calls, make, http };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  processMock.mockReset();
});

describe("GitHub HTTP operations", () => {
  it("reads fork pull requests without a gh or git process for explicit URLs", async () => {
    const f = fixture(() => pr);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const gh = yield* f.make;
        return yield* gh.getPullRequest({ cwd: "/repo", reference: url });
      }),
    );
    expect(result).toMatchObject({
      number: 7,
      url,
      state: "open",
      isCrossRepository: true,
      headRepositoryNameWithOwner: "fork/repo",
      headRepositoryOwnerLogin: "fork",
      headRefOid: "abc123",
    });
    expect(processMock).not.toHaveBeenCalled();
    expect(f.calls.map((c) => c.url.pathname)).toEqual(["/user", "/repos/octo/repo/pulls/7"]);
    expect(f.calls.every((c) => c.headers.get("authorization") === "Bearer private-token")).toBe(
      true,
    );
  });
  it("keeps multiline non-ASCII review bodies in bounded HTTP JSON", async () => {
    const f = fixture();
    const body = "Review: café\n" + "x".repeat(65_536);
    await Effect.runPromise(
      Effect.gen(function* () {
        const gh = yield* f.make;
        yield* gh.reviewPullRequest({ cwd: "/repo", url, body });
        yield* gh.requestChanges({ cwd: "/repo", url, body });
        yield* gh.commentPullRequest({ cwd: "/repo", url, body });
      }),
    );
    expect(f.calls.slice(1).map((c) => [c.url.pathname, c.body])).toEqual([
      ["/repos/octo/repo/pulls/7/reviews", { event: "APPROVE", body }],
      ["/repos/octo/repo/pulls/7/reviews", { event: "REQUEST_CHANGES", body }],
      ["/repos/octo/repo/issues/7/comments", { body }],
    ]);
    expect(processMock).not.toHaveBeenCalled();
  });
  it("rejects oversized GraphQL before any credential lookup, HTTP or process", async () => {
    const f = fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        const gh = yield* f.make;
        const error = yield* gh.runGraphql({ cwd: "/repo", query: "x".repeat(1_048_577) }).pipe(
          Effect.flip,
          Effect.mapError(() => new Error("Expected GitHub request to fail.")),
        );
        expect(error.kind).toBe("invalid_json");
      }),
    );
    expect(f.calls).toHaveLength(0);
    expect(processMock).not.toHaveBeenCalled();
  });
  it("rejects truncated, interrupted or invalid JSON instead of empty successes", async () => {
    const f = fixture(() => new Response('{"data":', { status: 200 }));
    await Effect.runPromise(
      Effect.gen(function* () {
        const gh = yield* f.make;
        const error = yield* gh
          .runGraphql({ cwd: "/repo", query: "query { viewer { login } }" })
          .pipe(
            Effect.flip,
            Effect.mapError(() => new Error("Expected GitHub request to fail.")),
          );
        expect(error.kind).toBe("invalid_json");
      }),
    );
  });
  it("retains partial GraphQL data for domain decoders", async () => {
    const partial = { data: { repository: null }, errors: [{ message: "field unavailable" }] };
    const f = fixture(() => partial);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const gh = yield* f.make;
        return yield* gh.runGraphql({
          cwd: "/repo",
          query: "query { viewer { login } }",
          variables: { ids: ["PR_7"], count: 3, flag: true, empty: null },
        });
      }),
    );
    expect(result).toEqual(partial);
    expect(f.calls[1]!.body.variables).toEqual({
      ids: ["PR_7"],
      count: 3,
      flag: true,
      empty: null,
    });
    expect(processMock).not.toHaveBeenCalled();
  });
  it("returns safe HTTP failure details and rate-limit metadata", async () => {
    for (const [status, kind, headers] of [
      [502, "network", {}],
      [429, "rate_limited", { "retry-after": "30" }],
      [404, "not_found", {}],
    ] as const) {
      const f = fixture(() => new Response("private body", { status, headers }));
      await Effect.runPromise(
        Effect.gen(function* () {
          const gh = yield* f.make;
          const error = yield* gh.getPullRequest({ cwd: "/repo", reference: url }).pipe(
            Effect.flip,
            Effect.mapError(() => new Error("Expected GitHub request to fail.")),
          );
          expect(error.kind).toBe(kind);
          expect(error.detail).not.toMatch(/private|query/);
          if (status === 429) expect(error.rateLimit?.retryAfterSeconds).toBe(30);
        }),
      );
    }
  });
  it("reads clone metadata and paginated viewer teams through HTTP", async () => {
    const f = fixture((call) =>
      call.url.pathname.endsWith("/teams")
        ? [{ organization: { login: "octo" }, slug: "reviewers" }]
        : {
            full_name: "octo/repo",
            html_url: "https://github.com/octo/repo",
            ssh_url: "git@github.com:octo/repo.git",
          },
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const gh = yield* f.make;
        expect(yield* gh.getRepositoryCloneUrls({ cwd: "/repo", repository: "octo/repo" })).toEqual(
          {
            nameWithOwner: "octo/repo",
            url: "https://github.com/octo/repo",
            sshUrl: "git@github.com:octo/repo.git",
          },
        );
        expect(yield* gh.getViewerTeams({ cwd: "/repo" })).toEqual(["octo/reviewers"]);
      }),
    );
    expect(processMock).not.toHaveBeenCalled();
  });
  it("routes Enterprise reads, teams, ready and branch updates to their explicit host", async () => {
    const enterprise = url.replace("github.com", "github.example.com");
    const f = fixture((call) =>
      call.method === "GET"
        ? pr
        : call.url.pathname.endsWith("/graphql")
          ? {
              data: call.body.query?.toString().includes("markPullRequestReady")
                ? { markPullRequestReadyForReview: { pullRequest: { id: "PR_7" } } }
                : { updatePullRequestBranch: { pullRequest: { id: "PR_7" } } },
            }
          : {},
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const gh = yield* f.make;
        yield* gh.changePullRequestReviewers({
          cwd: "/repo",
          url: enterprise,
          add: ["alice", "octo/reviewers"],
          remove: ["bob"],
        });
        yield* gh.markPullRequestReady({ cwd: "/repo", url: enterprise });
        yield* gh.updatePullRequestBranch({ cwd: "/repo", url: enterprise, method: "rebase" });
        yield* gh.updatePullRequestComment({
          cwd: "/repo",
          host: "github.example.com",
          repository: "octo/repo",
          commentId: "12",
          kind: "review-comment",
          body: "Updated",
        });
      }),
    );
    expect(f.calls.every((c) => c.url.host === "github.example.com")).toBe(true);
    expect(f.calls[1]!.body).toEqual({ reviewers: ["alice"], team_reviewers: ["reviewers"] });
    expect(
      f.calls.find((c) => c.body.variables && (c.body.variables as Record<string, unknown>).head)
        ?.body.variables,
    ).toEqual({ id: "PR_7", head: "abc123", method: "REBASE" });
    expect(f.calls.at(-1)?.url.pathname).toBe("/api/v3/repos/octo/repo/pulls/comments/12");
    expect(processMock).not.toHaveBeenCalled();
  });
  it("rejects another captured host before sending the mutation", async () => {
    const f = fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        const gh = yield* f.make;
        const context = yield* gh.getCredentialContext({ cwd: "/repo", host: "github.com" });
        const error = yield* gh
          .commentPullRequest({
            cwd: "/repo",
            url: url.replace("github.com", "other.example.com"),
            body: "hello",
          })
          .pipe(Effect.provideService(GitHubCredentialScope, context), Effect.flip);
        expect(error.kind).toBe("forbidden");
      }),
    );
    expect(f.calls).toHaveLength(1);
  });
  it("keeps expected merge SHA and refuses a successful HTTP response with merged=false", async () => {
    const f = fixture(() => ({ merged: false }));
    await Effect.runPromise(
      Effect.gen(function* () {
        const gh = yield* f.make;
        const error = yield* gh
          .mergePullRequest({ cwd: "/repo", url, method: "squash", expectedHeadOid: "abc123" })
          .pipe(
            Effect.flip,
            Effect.mapError(() => new Error("Expected GitHub request to fail.")),
          );
        expect(error.requestDispatched).toBe(true);
      }),
    );
    expect(f.calls[1]?.body).toEqual({ merge_method: "squash", sha: "abc123" });
  });
  it("batches concurrent branch reads per repository and caches remote routing", async () => {
    const f = fixture((call) => {
      const variables = call.body.variables as Record<string, unknown>;
      return {
        data: {
          repository: Object.fromEntries(
            Object.keys(variables)
              .filter((key) => /^h\d+$/.test(key))
              .map((key) => [
                key,
                {
                  nodes: [
                    {
                      number: 7,
                      title: "A change",
                      url,
                      baseRefName: "main",
                      headRefName: variables[key],
                      headRefOid: "abc123",
                      state: "OPEN",
                      isCrossRepository: true,
                      headRepository: { nameWithOwner: "fork/repo" },
                      headRepositoryOwner: { login: "fork" },
                    },
                  ],
                },
              ]),
          ),
        },
      };
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const gh = yield* f.make;
        const values = yield* Effect.all(
          ["one", "two", "three"].map((head) =>
            gh.listOpenPullRequests({ cwd: "/repo", headSelector: `fork:${head}` }),
          ),
          { concurrency: "unbounded" },
        );
        expect(values.map((v) => v[0]?.headRefName)).toEqual(["one", "two", "three"]);
        expect(f.calls.filter((c) => c.url.pathname === "/graphql")).toHaveLength(1);
        expect(processMock).toHaveBeenCalledTimes(1);
        yield* gh.listOpenPullRequests({ cwd: "/repo", headSelector: "again" });
        expect(processMock).toHaveBeenCalledTimes(1);
      }),
    );
  });
  it("translates search qualifiers and rejects incomplete results", async () => {
    const f = fixture((call) => ({
      items: [
        {
          number: 7,
          title: "A change",
          state: "open",
          repository_url: "https://api.github.com/repos/octo/repo",
          pull_request: { html_url: url },
          user: { login: "alice" },
        },
      ],
      incomplete_results: call.url.searchParams.get("q")?.includes("closed"),
    }));
    await Effect.runPromise(
      Effect.gen(function* () {
        const gh = yield* f.make;
        const rows = yield* gh.searchPullRequests({
          cwd: "/repo",
          args: ["--author", "@me", "--state", "open"],
        });
        expect(rows).toMatchObject([
          { number: 7, repository: { nameWithOwner: "octo/repo" }, author: { login: "alice" } },
        ]);
        expect(f.calls.at(-1)?.url.searchParams.get("q")).toBe("is:pr author:alice is:open");
        const error = yield* gh
          .searchPullRequests({ cwd: "/repo", args: ["--state", "closed"] })
          .pipe(
            Effect.flip,
            Effect.mapError(() => new Error("Expected GitHub request to fail.")),
          );
        expect(error.kind).toBe("invalid_json");
      }),
    );
  });
});

describe("opt-in merge message attribution", () => {
  const response = (body: string, queued = false, head = "abc123") => ({
    data: {
      repository: {
        pullRequest: {
          isMergeQueueEnabled: queued,
          headRefOid: head,
          viewerMergeBodyText: body,
        },
      },
    },
  });
  it.each(["merge", "squash"] as const)(
    "uses the configured policy for %s and keeps human credits",
    async (method) => {
      const f = fixture((call) =>
        call.url.pathname === "/graphql"
          ? response(
              "Details\n\nCo-authored-by: Alice <alice@example.com>\nCo-authored-by: Claude <noreply@anthropic.com>",
            )
          : { merged: true },
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const gh = yield* f.make;
          yield* gh.mergePullRequest({ cwd: "/repo", url, method, expectedHeadOid: "abc123" });
        }).pipe(
          Effect.provide(ServerSettingsService.layerTest({ removeAgentCreditsOnMerge: true })),
        ),
      );
      expect(
        f.calls.filter((call) => call.url.pathname === "/graphql")[0]?.body.variables,
      ).toMatchObject({ method: method.toUpperCase() });
      expect(f.calls.at(-1)?.body).toEqual({
        merge_method: method,
        sha: "abc123",
        commit_message: "Details\n\nCo-authored-by: Alice <alice@example.com>",
      });
    },
  );
  it.each([
    { body: "Human text", queued: false, expected: undefined },
    { body: "Co-authored-by: Claude <noreply@anthropic.com>", queued: true, expected: undefined },
    { body: "Co-authored-by: Claude <noreply@anthropic.com>", queued: false, expected: "" },
  ])("only overrides a changed non-queue body: %j", async ({ body, queued, expected }) => {
    const f = fixture((call) =>
      call.url.pathname === "/graphql" ? response(body, queued) : { merged: true },
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const gh = yield* f.make;
        yield* gh.mergePullRequest({
          cwd: "/repo",
          url,
          method: "merge",
          expectedHeadOid: "abc123",
          removeAgentCreditsOnMerge: true,
        });
      }),
    );
    if (expected === undefined) expect(f.calls.at(-1)?.body).not.toHaveProperty("commit_message");
    else expect(f.calls.at(-1)?.body.commit_message).toBe("");
  });
  it.each([false, true])(
    "does not read or override for disabled policy or rebase: %j",
    async (rebase) => {
      const f = fixture(() => ({ merged: true }));
      await Effect.runPromise(
        Effect.gen(function* () {
          const gh = yield* f.make;
          yield* gh.mergePullRequest({
            cwd: "/repo",
            url,
            method: rebase ? "rebase" : "merge",
            removeAgentCreditsOnMerge: rebase,
          });
        }),
      );
      expect(f.calls.some((call) => call.url.pathname === "/graphql")).toBe(false);
      expect(f.calls.at(-1)?.body).not.toHaveProperty("commit_message");
    },
  );
  it.each([
    response("Agent", false, "new-head"),
    { data: { repository: { pullRequest: null } } },
    { errors: [{ message: "Incomplete" }] },
  ])("fails before a merge write for stale or incomplete proposed messages", async (body) => {
    const f = fixture(() => body);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const gh = yield* f.make;
        return yield* gh
          .mergePullRequest({
            cwd: "/repo",
            url,
            method: "merge",
            expectedHeadOid: "abc123",
            removeAgentCreditsOnMerge: true,
          })
          .pipe(Effect.result);
      }),
    );
    expect(result._tag).toBe("Failure");
    expect(f.calls.some((call) => call.method === "PUT")).toBe(false);
  });
});
