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

  it.effect(
    "passes GraphQL string variables with raw flags and typed variables with typed flags",
    () =>
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
          [
            "api",
            "graphql",
            "-f",
            "query=query($q:String!,$ids:[ID!]!,$number:Int!,$flag:Boolean!,$empty:String){viewer{login}}",
            "-f",
            "q=is:pr is:open author:me",
            "-F",
            "ids[]=PR_kw1",
            "-F",
            "ids[]=PR_kw2",
            "-F",
            "number=123",
            "-F",
            "flag=true",
            "-F",
            "empty=null",
          ],
          expect.objectContaining({ cwd: "/home/me", timeoutMs: 45_000 }),
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
