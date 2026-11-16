import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { lookupBranchPullRequest } from "./branchPullRequestLookup.ts";
const sha = "a".repeat(40),
  other = "b".repeat(40);
function fixture() {
  const state = {
    local: sha as string | null,
    tracking: {} as Record<string, string>,
    remote: null as string | null,
    merge: null as string | null,
    url: "https://github.com/team/repo.git",
    branch: "topic",
    defaultBranch: "main",
    valid: true,
  };
  const git = {
    isValidBranchName: () => Effect.succeed(state.valid),
    listRemotes: () =>
      Effect.succeed([
        { name: "origin", url: state.url },
        { name: "fork", url: "https://github.com/fork/repo.git" },
      ]),
    readConfigValue: (_cwd: string, key: string) =>
      Effect.succeed(key.endsWith(".remote") ? state.remote : state.merge),
    resolveCommit: (_cwd: string, ref: string) =>
      Effect.succeed(
        ref === `refs/heads/${state.branch}` ? state.local : (state.tracking[ref] ?? null),
      ),
    readDefaultBranch: () => Effect.succeed(state.defaultBranch),
  };
  const summary = {
    number: 7,
    title: "PR",
    url: "https://github.com/team/repo/pull/7",
    baseRefName: "main",
    headRefName: "topic",
    headRefOid: sha,
    state: "merged" as const,
  };
  const lookup = vi.fn(() => Effect.succeed(summary));
  return {
    state,
    git,
    summary,
    lookup,
    run: () =>
      Effect.runPromise(
        lookupBranchPullRequest(git, { cwd: "/repo", branch: state.branch }, lookup).pipe(
          Effect.result,
        ),
      ),
  };
}
it("queries the saved branch without a worktree status or HEAD dependency", async () => {
  const f = fixture();
  const result = await f.run();
  expect(result._tag).toBe("Success");
  if (result._tag === "Success") expect(result.success).toEqual(f.summary);
  expect(f.lookup).toHaveBeenCalledExactlyOnceWith({ branch: "topic", upstreamRef: null });
});
it("uses a surviving remote-tracking branch after the local branch was removed", async () => {
  const f = fixture();
  f.state.local = null;
  f.state.tracking["refs/remotes/fork/topic"] = sha;
  expect((await f.run())._tag).toBe("Success");
  expect(f.lookup).toHaveBeenCalledWith({
    branch: "topic",
    upstreamRef: "fork/topic",
    remoteName: "fork",
  });
});
it("preserves an explicit fork's remote branch rather than querying its local alias", async () => {
  const f = fixture();
  f.state.remote = "fork";
  f.state.merge = "refs/heads/original-topic";
  expect((await f.run())._tag).toBe("Success");
  expect(f.lookup).toHaveBeenCalledWith({
    branch: "topic",
    upstreamRef: "fork/original-topic",
    remoteName: "fork",
  });
});
it("rejects ambiguous remote-tracking refs before any host lookup", async () => {
  const f = fixture();
  f.state.local = null;
  f.state.tracking = { "refs/remotes/origin/topic": sha, "refs/remotes/fork/topic": other };
  expect((await f.run())._tag).toBe("Failure");
  expect(f.lookup).not.toHaveBeenCalled();
});
it.each([
  { remote: "missing", merge: "refs/heads/topic" },
  { remote: "fork" },
  { merge: "refs/heads/topic" },
  { remote: ".", merge: "refs/heads/topic" },
  { remote: "", merge: "refs/heads/topic" },
  { remote: "origin", merge: "refs/heads/" },
  { valid: false },
])("rejects incomplete, local-only or invalid branch context: %j", async (patch) => {
  const f = fixture();
  Object.assign(f.state, patch);
  expect((await f.run())._tag).toBe("Failure");
  expect(f.lookup).not.toHaveBeenCalled();
});
it.each(["url", "local", "merge"] as const)(
  "rejects a changed %s while the host lookup was running",
  async (field) => {
    const f = fixture();
    f.lookup.mockImplementation(() =>
      Effect.sync(() => {
        if (field === "url") f.state.url = "https://github.com/replacement/repo.git";
        else if (field === "local") f.state.local = other;
        else f.state.merge = "refs/heads/replaced";
        return f.summary;
      }),
    );
    expect((await f.run())._tag).toBe("Failure");
  },
);
it("does not use an old terminal PR for the default branch", async () => {
  const f = fixture();
  f.state.branch = "main";
  const result = await f.run();
  expect(result._tag).toBe("Success");
  if (result._tag === "Success") expect(result.success).toBeNull();
});
it("rejects a terminal PR whose head no longer matches the branch", async () => {
  const f = fixture();
  f.state.local = other;
  expect((await f.run())._tag).toBe("Failure");
});
it("refuses a response without a known PR state even when its head matches", async () => {
  const f = fixture();
  Reflect.deleteProperty(f.summary, "state");
  expect((await f.run())._tag).toBe("Failure");
});
it("skips repositories without remotes before any host lookup", async () => {
  const f = fixture();
  f.git.listRemotes = () => Effect.succeed([]);
  const result = await f.run();
  expect(result._tag).toBe("Success");
  if (result._tag === "Success") expect(result.success).toBeNull();
  expect(f.lookup).not.toHaveBeenCalled();
});
