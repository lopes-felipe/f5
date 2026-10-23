import { afterEach, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { makeGitHubCli } from "./Layers/GitHubCli.ts";
import { deleteGitHubPullRequestBranch } from "./githubBranchDeletion.ts";
import { makeGitHubRequestScheduler } from "./githubRequestScheduler.ts";
import { GitHubRequestPolicy } from "./githubRequestPolicy.ts";
import { GitHubCliError } from "./Errors.ts";
vi.mock("../outboundHttp.ts", async (importOriginal) =>
  (await import("../testUtils/undiciFetchThroughGlobal.ts")).undiciFetchThroughGlobal(
    importOriginal,
  ),
);
const sha = "a".repeat(40),
  other = "b".repeat(40);
const input = { cwd: "/repo", url: "https://github.com/team/repo/pull/7", expectedHeadOid: sha };
function fixture() {
  const state = {
    lifecycle: "MERGED",
    branch: "topic",
    prHead: sha,
    sourceHead: sha,
    absent: false,
    sourceDefault: "main",
    permission: "WRITE",
    archived: false,
    stack: false,
    partial: false,
    now: Date.now(),
    renameOnRead: false,
    loseResponse: false,
    invalidated: false,
  };
  const mutations: Record<string, unknown>[] = [];
  let sourceReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(target));
      if (url.pathname.endsWith("/user")) return Response.json({ id: 42, login: "alice" });
      if (url.pathname.endsWith("/stacks"))
        return Response.json(state.stack ? [{ number: 1 }] : []);
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (body.query.includes("F5BranchToDelete"))
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                state: state.lifecycle,
                headRefName: state.branch,
                baseRefName: "main",
                headRefOid: state.prHead,
                headRepository: { id: "source-id", nameWithOwner: "fork/repo" },
              },
            },
          },
        });
      if (body.query.includes("F5SourceBranch")) {
        sourceReads++;
        const result = {
          data: {
            node: {
              id: "source-id",
              nameWithOwner: "fork/repo",
              isArchived: state.archived,
              viewerPermission: state.permission,
              defaultBranchRef: { name: state.sourceDefault },
              ref: state.absent ? null : { target: { oid: state.sourceHead } },
            },
          },
        };
        if (state.renameOnRead && sourceReads === 1) state.branch = "renamed";
        return Response.json(state.partial ? { data: { node: {} } } : result);
      }
      if (body.query.includes("F5DeleteSourceBranch")) {
        mutations.push(body.variables);
        state.absent = true;
        if (state.loseResponse) throw new Error("Response lost");
        return Response.json({ data: { updateRefs: { clientMutationId: null } } });
      }
      throw new Error("Unexpected fixture request");
    }),
  );
  return {
    state,
    mutations,
    make: makeGitHubCli({
      resolveToken: () => Effect.succeed("private-token"),
      scheduler: makeGitHubRequestScheduler(() => state.now),
    }),
  };
}
afterEach(() => vi.unstubAllGlobals());
it("atomically deletes the reviewed source-repository ref with the captured head", async () => {
  const f = fixture();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const github = yield* f.make;
      return yield* deleteGitHubPullRequestBranch(github, input);
    }),
  );
  expect(result).toMatchObject({
    host: "github.com",
    repository: "fork/repo",
    branch: "topic",
    headOid: sha,
    absent: true,
  });
  expect(f.mutations).toEqual([
    {
      input: {
        repositoryId: "source-id",
        refUpdates: [{ name: "refs/heads/topic", beforeOid: sha, afterOid: "0".repeat(40) }],
      },
    },
  ]);
});
it.each([
  { lifecycle: "OPEN" },
  { prHead: other },
  { sourceHead: other },
  { sourceDefault: "topic" },
  { permission: "READ" },
  { archived: true },
  { stack: true },
  { partial: true },
  { renameOnRead: true },
])("refuses unsafe, changed, unwritable or incomplete branch targets: %j", async (patch) => {
  const f = fixture();
  Object.assign(f.state, patch);
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const github = yield* f.make;
      return yield* deleteGitHubPullRequestBranch(github, input).pipe(Effect.result);
    }),
  );
  expect(result._tag).toBe("Failure");
  expect(f.mutations).toEqual([]);
});
it("inspects an already absent source branch without a mutation", async () => {
  const f = fixture();
  f.state.absent = true;
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const github = yield* f.make;
      return yield* deleteGitHubPullRequestBranch(github, input);
    }),
  );
  expect(result.absent).toBe(true);
  expect(f.mutations).toEqual([]);
});
it("lost deletion responses are never retried and read-only recovery can prove absence", async () => {
  const f = fixture();
  f.state.loseResponse = true;
  await Effect.runPromise(
    Effect.gen(function* () {
      const github = yield* f.make;
      const result = yield* deleteGitHubPullRequestBranch(github, input).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.requestDispatched).toBe(true);
      f.state.now += 60_000;
      expect(
        (yield* deleteGitHubPullRequestBranch(github, { ...input, inspectOnly: true })).absent,
      ).toBe(true);
    }),
  );
  expect(f.mutations).toHaveLength(1);
});
it("retains parent account/exclusion guards while replacing the open-PR write precondition", async () => {
  const f = fixture();
  const beforeSend = vi.fn((write: boolean) =>
    write
      ? Effect.fail(new GitHubCliError({ operation: "parent", detail: "PR must be open" }))
      : Effect.void,
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const github = yield* f.make;
      yield* deleteGitHubPullRequestBranch(github, input);
    }).pipe(
      Effect.provideService(GitHubRequestPolicy, { beforeSend, readInvalidated: Effect.never }),
    ),
  );
  expect(f.mutations).toHaveLength(1);
  expect(beforeSend.mock.calls.every(([write]) => !write)).toBe(true);
});
it("an excluded account scope prevents every branch request", async () => {
  const f = fixture();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const github = yield* f.make;
      return yield* deleteGitHubPullRequestBranch(github, input).pipe(Effect.result);
    }).pipe(
      Effect.provideService(GitHubRequestPolicy, {
        beforeSend: () =>
          Effect.fail(new GitHubCliError({ operation: "parent", detail: "Excluded repository" })),
        readInvalidated: Effect.never,
      }),
    ),
  );
  expect(result._tag).toBe("Failure");
  expect(f.mutations).toEqual([]);
});
