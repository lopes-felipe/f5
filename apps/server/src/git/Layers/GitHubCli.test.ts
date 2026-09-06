import { assert, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { afterEach, expect, vi } from "vitest";

vi.mock("../../processRunner", () => ({
  runProcess: vi.fn(),
}));

import { runProcess } from "../../processRunner";
import { GitHubCli } from "../Services/GitHubCli.ts";
import { GitHubCliLive } from "./GitHubCli.ts";

const mockedRunProcess = vi.mocked(runProcess);
const layer = it.layer(GitHubCliLive);

afterEach(() => {
  mockedRunProcess.mockReset();
});

layer("GitHubCliLive", (it) => {
  it.effect("sends long multiline non-ASCII review bodies only through stdin", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValue({
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
      const gh = yield* GitHubCli;
      const body = "Review: caf\u00e9\n" + "x".repeat(65_536);
      yield* gh.reviewPullRequest({
        cwd: "/repo",
        url: "https://github.com/octo/repo/pull/1",
        body,
      });
      const [, args, options] = mockedRunProcess.mock.calls[0]!;
      expect(args).toContain("--body-file");
      expect(args.join(" ")).not.toContain(body);
      expect(options?.stdin).toBe(body);
    }),
  );

  it.effect("rejects oversized request bodies before spawning", () =>
    Effect.gen(function* () {
      const gh = yield* GitHubCli;
      const result = yield* Effect.exit(
        gh.runGraphql({ cwd: "/repo", query: "x".repeat(1_048_577) }),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(mockedRunProcess).not.toHaveBeenCalled();
    }),
  );

  it.effect("never decodes truncated or interrupted responses as success", () =>
    Effect.gen(function* () {
      const gh = yield* GitHubCli;
      for (const extra of [
        { stdoutTruncated: true },
        { aborted: true },
        { signal: "SIGTERM" as const },
      ]) {
        mockedRunProcess.mockResolvedValueOnce({
          stdout: '{"data":{}}',
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
          ...extra,
        });
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              gh.runGraphql({ cwd: "/repo", query: "query { viewer { login } }" }),
            ),
          ),
        ).toBe(true);
      }
    }),
  );

  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          title: "Add PR thread creation",
          url: "https://github.com/pingdotgg/codething-mvp/pull/42",
          baseRefName: "main",
          headRefName: "feature/pr-threads",
          headRefOid: "abc123",
          state: "OPEN",
          mergedAt: null,
          isCrossRepository: true,
          headRepository: {
            nameWithOwner: "octocat/codething-mvp",
          },
          headRepositoryOwner: {
            login: "octocat",
          },
        }),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequest({
          cwd: "/repo",
          reference: "#42",
        });
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add PR thread creation",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        headRefOid: "abc123",
        state: "open",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/codething-mvp",
        headRepositoryOwnerLogin: "octocat",
      });
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        [
          "pr",
          "view",
          "#42",
          "--json",
          "number,title,url,baseRefName,headRefName,headRefOid,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          nameWithOwner: "octocat/codething-mvp",
          url: "https://github.com/octocat/codething-mvp",
          sshUrl: "git@github.com:octocat/codething-mvp.git",
        }),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "octocat/codething-mvp",
        });
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
    }),
  );

  it.effect("reads paginated viewer team slugs from jq line output", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: "wolt\tplatform\nwolt\tcode-review\n",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getViewerTeams({ cwd: "/home/me" });
      });

      assert.deepStrictEqual(result, ["wolt/code-review", "wolt/platform"]);
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        ["api", "user/teams", "--paginate", "--jq", ".[] | [.organization.login, .slug] | @tsv"],
        expect.objectContaining({ cwd: "/home/me" }),
      );
    }),
  );

  it.effect("passes GraphQL documents and typed variables through JSON stdin", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({ data: { ok: true } }),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.runGraphql({
          cwd: "/home/me",
          query:
            "query($q:String!,$ids:[ID!]!,$number:Int!,$flag:Boolean!,$empty:String){viewer{login}}",
          variables: {
            q: "is:pr is:open author:me",
            ids: ["PR_kw1", "PR_kw2"],
            number: 123,
            flag: true,
            empty: null,
          },
        });
      });

      assert.deepStrictEqual(result, { data: { ok: true } });
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        ["api", "graphql", "--hostname", "github.com", "--input", "-"],
        expect.objectContaining({
          cwd: "/home/me",
          timeoutMs: 45_000,
          allowNonZeroExit: true,
          stdin: JSON.stringify({
            query:
              "query($q:String!,$ids:[ID!]!,$number:Int!,$flag:Boolean!,$empty:String){viewer{login}}",
            variables: {
              q: "is:pr is:open author:me",
              ids: ["PR_kw1", "PR_kw2"],
              number: 123,
              flag: true,
              empty: null,
            },
          }),
        }),
      );
    }),
  );

  it.effect(
    "routes GitHub Enterprise detail reads and mutations through explicit CLI arguments",
    () =>
      Effect.gen(function* () {
        mockedRunProcess
          .mockResolvedValueOnce({
            stdout: JSON.stringify({ data: { ok: true } }),
            stderr: "",
            code: 0,
            signal: null,
            timedOut: false,
          })
          .mockResolvedValue({
            stdout: "",
            stderr: "",
            code: 0,
            signal: null,
            timedOut: false,
          });

        const gh = yield* GitHubCli;
        yield* gh.runGraphql({
          cwd: "/repo",
          host: "github.example.com",
          query: "query { viewer { login } }",
        });
        yield* gh.changePullRequestReviewers({
          cwd: "/repo",
          url: "https://github.example.com/octo/repo/pull/7",
          add: ["alice"],
          remove: ["bob"],
        });
        yield* gh.updatePullRequestBranch({
          cwd: "/repo",
          url: "https://github.example.com/octo/repo/pull/7",
          method: "rebase",
        });
        yield* gh.updatePullRequestComment({
          cwd: "/repo",
          host: "github.example.com",
          repository: "octo/repo",
          commentId: "123",
          kind: "review-comment",
          body: "Updated",
        });

        expect(mockedRunProcess).toHaveBeenNthCalledWith(
          1,
          "gh",
          ["api", "graphql", "--hostname", "github.example.com", "--input", "-"],
          expect.objectContaining({ cwd: "/repo" }),
        );
        expect(mockedRunProcess).toHaveBeenNthCalledWith(
          2,
          "gh",
          [
            "pr",
            "edit",
            "https://github.example.com/octo/repo/pull/7",
            "--add-reviewer",
            "alice",
            "--remove-reviewer",
            "bob",
          ],
          expect.objectContaining({ cwd: "/repo" }),
        );
        expect(mockedRunProcess).toHaveBeenNthCalledWith(
          3,
          "gh",
          ["pr", "update-branch", "https://github.example.com/octo/repo/pull/7", "--rebase"],
          expect.objectContaining({ cwd: "/repo" }),
        );
        expect(mockedRunProcess).toHaveBeenNthCalledWith(
          4,
          "gh",
          [
            "api",
            "repos/octo/repo/pulls/comments/123",
            "--hostname",
            "github.example.com",
            "--method",
            "PATCH",
            "--input",
            "-",
          ],
          expect.objectContaining({ cwd: "/repo" }),
        );
      }),
  );

  it.effect("normalizes GitHub HTTP failures without leaking the full command", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockRejectedValueOnce(
        new Error(
          "gh api graphql -f query=query PrHub($rr:String!){viewer{login}} failed (code=1, signal=null). gh: HTTP 502",
        ),
      );

      const exit = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.runGraphql({
          cwd: "/home/me",
          query: "query PrHub($rr:String!){viewer{login}}",
          variables: { rr: "is:pr is:open review-requested:me" },
        });
      }).pipe(Effect.exit);

      assert.equal(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause) as { kind?: string; detail: string };
        assert.equal(error.kind, "network");
        assert.equal(error.detail, "GitHub API returned HTTP 502.");
        assert.equal(error.detail.includes("query PrHub"), false);
      }
    }),
  );

  it.effect("classifies non-zero GraphQL results returned by the process runner", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: "",
        stderr: "gh: HTTP 429: rate limit exceeded",
        code: 1,
        signal: null,
        timedOut: false,
      });

      const exit = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.runGraphql({ cwd: "/repo", query: "query { viewer { login } }" });
      }).pipe(Effect.exit);

      assert.equal(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause) as { kind?: string; detail: string };
        assert.equal(error.kind, "rate_limited");
        assert.equal(error.detail.includes("query { viewer"), false);
      }
    }),
  );

  it.effect("preserves partial GraphQL data so the domain decoder can reject it", () =>
    Effect.gen(function* () {
      const partial = {
        data: { repository: { pullRequest: null } },
        errors: [{ message: "field unavailable" }],
      };
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify(partial),
        stderr: "GraphQL returned partial data",
        code: 1,
        signal: null,
        timedOut: false,
      });

      const gh = yield* GitHubCli;
      assert.deepStrictEqual(
        yield* gh.runGraphql({ cwd: "/repo", query: "query { viewer { login } }" }),
        partial,
      );
    }),
  );

  it.effect("surfaces a friendly error when the pull request is not found", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockRejectedValueOnce(
        new Error(
          "GraphQL: Could not resolve to a PullRequest with the number of 4888. (repository.pullRequest)",
        ),
      );

      const error = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequest({
          cwd: "/repo",
          reference: "4888",
        });
      }).pipe(Effect.flip);

      assert.equal(error.message.includes("Pull request not found"), true);
    }),
  );
});
