import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { GitHubCliError } from "../git/Errors.ts";
import type { GitHubApiRequest } from "../git/githubApi.ts";
import { makeFakeGitHubCli } from "../git/testDoubles.ts";
import { makeUpstreamGitHub } from "./github.ts";

const context = { host: "github.com", viewerId: 1, login: "me", generation: "g" };
const fork = { owner: "me", name: "f5" };

function harness(
  respond: (request: GitHubApiRequest) => { status: number; body: unknown },
  credential: GitHubCliError | null = null,
) {
  const requests: GitHubApiRequest[] = [];
  const github = makeUpstreamGitHub({
    ...makeFakeGitHubCli().service,
    getCredentialContext: () => (credential ? Effect.fail(credential) : Effect.succeed(context)),
    request: (request) =>
      Effect.sync(() => {
        requests.push(request);
        return {
          ...respond(request),
          graphqlErrors: [],
          links: {},
          etag: null,
          lastModified: null,
          rateLimit: {},
          rateLimitResource: null,
        };
      }),
  });
  return { github, requests };
}

const pr = { number: 7, html_url: "https://github.com/me/f5/pull/7", state: "open" };

it.effect("finds and opens the ledger PR on the named repository, not the cwd's remotes", () =>
  Effect.gen(function* () {
    const { github, requests } = harness((request) =>
      request.method === "POST"
        ? { status: 201, body: pr }
        : request.endpoint.endsWith("/pulls")
          ? { status: 200, body: [] }
          : { status: 200, body: { ...pr, state: "closed", merged_at: "2026-10-22T00:00:00Z" } },
    );
    assert.isNull(
      yield* github.findPullRequestForBranch({ cwd: "/repo", repo: fork, branch: "f5/ledger" }),
    );
    const created = yield* github.createPullRequest({
      cwd: "/repo",
      repo: fork,
      base: "main",
      head: "f5/ledger",
      title: "Title",
      body: "Body",
    });
    assert.deepStrictEqual(created, { number: 7, url: pr.html_url, state: "open" });
    assert.strictEqual(
      (yield* github.findPullRequest({ cwd: "/repo", repo: fork, number: 7 }))?.state,
      "merged",
    );
    assert.deepStrictEqual(
      requests.map((request) => [request.method, request.endpoint, request.query?.head]),
      [
        ["GET", "repos/me/f5/pulls", "me:f5/ledger"],
        ["POST", "repos/me/f5/pulls", undefined],
        ["GET", "repos/me/f5/pulls/7", undefined],
      ],
    );
    assert.deepStrictEqual(requests[1]!.body, {
      title: "Title",
      head: "f5/ledger",
      base: "main",
      body: "Body",
    });
    assert.ok(requests.every((request) => request.context === context));
  }),
);

it.effect("classifies server and rate-limit failures as transient, others as not", () =>
  Effect.gen(function* () {
    let status = 502;
    const { github } = harness(() => ({ status, body: { message: "Bad gateway" } }));
    const find = github.findPullRequest({ cwd: "/repo", repo: fork, number: 7 });
    const transient = yield* Effect.flip(find);
    assert.isTrue(transient.transient);
    assert.match(transient.detail, /502\): Bad gateway/u);
    status = 422;
    assert.isFalse((yield* Effect.flip(find)).transient);
    status = 404;
    assert.isNull(yield* find);
  }),
);

it.effect("gates availability on the profile credential", () =>
  Effect.gen(function* () {
    const missing = new GitHubCliError({
      operation: "credentials",
      kind: "unauthenticated",
      detail: "GitHub is not connected.",
    });
    assert.isFalse(
      yield* harness(() => ({ status: 200, body: null }), missing).github.available("/repo"),
    );
    const offline = new GitHubCliError({
      operation: "credentials",
      kind: "network",
      detail: "offline",
    });
    const failure = yield* Effect.flip(
      harness(() => ({ status: 200, body: null }), offline).github.available("/repo"),
    );
    assert.isTrue(failure.transient);
    assert.isTrue(yield* harness(() => ({ status: 200, body: null })).github.available("/repo"));
  }),
);
