import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { fetchGitHubPrFiles, normalizeGitHubFile } from "./githubPrFiles.ts";
import type { GitHubApiResponse } from "../git/githubApi.ts";

const pull = {
  base: { ref: "main", sha: "base", repo: { full_name: "org/repo" } },
  head: { ref: "feature", sha: "head", repo: { full_name: "fork/repo" } },
  changed_files: 1,
};
const file = {
  filename: "new name.ts",
  previous_filename: "old name.ts",
  sha: "blob",
  status: "renamed",
  additions: 1,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-old\n+new",
};
function response(body: unknown, next = false): GitHubApiResponse {
  return {
    status: 200,
    body,
    links: next ? { next: "https://api.github.com/next" } : {},
    graphqlErrors: [],
    etag: null,
    lastModified: null,
    rateLimitResource: "core",
    rateLimit: { remaining: 100, limit: 5000, resetAt: null },
  };
}
function load(
  responses: GitHubApiResponse[],
  cursor?: string,
  account = "account",
  reviewedHeadOid?: string,
) {
  const calls: string[] = [];
  return {
    calls,
    effect: fetchGitHubPrFiles({
      account,
      ...(reviewedHeadOid ? { reviewedHeadOid } : {}),
      key: "pr",
      host: "github.com",
      repository: "org/repo",
      number: 1,
      ...(cursor ? { cursor } : {}),
      request: (endpoint) => {
        calls.push(endpoint);
        const next = responses.shift();
        if (!next) throw new Error("Unexpected request");
        return Effect.succeed(next);
      },
    }),
  };
}
const compare = response({ merge_base_commit: { sha: "merge-base" } });

it.effect("pins paginated files to the account and full comparison", () =>
  Effect.gen(function* () {
    const first = yield* load([response(pull), compare, response([file], true), response(pull)])
      .effect;
    assert.equal(first.files[0]?.previousPath, "old name.ts");
    assert.equal(first.files[0]?.patchStatus, "available");
    assert.equal(first.comparison?.headRepository, "fork/repo");
    assert.equal(first.comparison?.mergeBaseOid, "merge-base");
    const wrongAccount = load([], first.pageInfo.endCursor!, "other");
    assert.equal((yield* Effect.exit(wrongAccount.effect))._tag, "Failure");
    assert.equal(wrongAccount.calls.length, 0);
    const retargeted = { ...pull, base: { ...pull.base, ref: "release" } };
    const second = load([response(retargeted), compare], first.pageInfo.endCursor!);
    assert.equal((yield* Effect.exit(second.effect))._tag, "Failure");
    assert.equal(second.calls.length, 2);
  }),
);

it.effect("discards a page when the base moves during the request", () =>
  Effect.gen(function* () {
    const moved = { ...pull, base: { ...pull.base, sha: "new-base" } };
    const result = yield* Effect.exit(
      load([response(pull), compare, response([file]), response(moved)]).effect,
    );
    assert.equal(result._tag, "Failure");
  }),
);

it.effect("reports provider caps and missing binary patches", () =>
  Effect.gen(function* () {
    const capped = { ...pull, changed_files: 3001 };
    const { patch: _, ...binary } = file;
    const result = yield* load([response(capped), compare, response([binary]), response(capped)])
      .effect;
    assert.equal(result.providerCapped, true);
    assert.equal(result.pageInfo.truncated, true);
    assert.equal(result.files[0]?.patch, null);
    assert.equal(result.files[0]?.patchStatus, "unavailable");
    assert.equal(normalizeGitHubFile(file).patch?.includes('--- "a/old name.ts"'), true);
    assert.equal(normalizeGitHubFile({ ...file, additions: 2 }).patchStatus, "truncated");
  }),
);

it.effect(
  "pins changes since review and reports the comparison file cap without paginating commits as files",
  () =>
    Effect.gen(function* () {
      const comparison = response(
        {
          merge_base_commit: { sha: "review-base" },
          files: Array.from({ length: 300 }, () => file),
        },
        true,
      );
      const result = load(
        [response(pull), comparison, response(pull)],
        undefined,
        "account",
        "reviewed",
      );
      const page = yield* result.effect;
      assert.equal(result.calls[1], "repos/org/repo/compare/reviewed...head");
      assert.equal(page.comparison?.mode, "changes_since_review");
      assert.equal(page.comparison?.reviewedHeadOid, "reviewed");
      assert.equal(page.comparison?.baseOid, "base");
      assert.equal(page.pageInfo.hasNextPage, false);
      assert.equal(page.providerCapped, true);
      assert.include(page.warning!, "read-only");
    }),
);
