import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { GitCommandError } from "../git/Errors.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import { isPossiblyStaleWorktreeBase, resolveWorktreeBase } from "./worktreeBase.ts";

const LOCAL = "1111111111111111111111111111111111111111";
const REMOTE = "2222222222222222222222222222222222222222";

const gitError = (detail: string) =>
  new GitCommandError({ operation: "test", command: "git", cwd: "/repo", detail });

type FakeGit = Pick<
  GitCoreShape,
  "hasRemote" | "fetchRemoteBranchCommit" | "resolveCommit" | "isAncestor"
>;

const makeGit = (options: {
  hasRemote?: boolean;
  remote?: string | null | "error";
  /** `refs/heads/feature`. */
  local?: string | null;
  /** The bare name `feature`, which git resolves to a same-named tag first. Defaults to `local`. */
  bareName?: string | null;
  /** Pairs of `ancestor>descendant` that are reachable; "error" fails every check. */
  ancestry?: ReadonlyArray<string> | "error";
}): FakeGit => ({
  hasRemote: () => Effect.succeed(options.hasRemote ?? true),
  fetchRemoteBranchCommit: vi.fn((input) =>
    options.remote === "error"
      ? Effect.fail(gitError("network down"))
      : Effect.succeed(
          options.remote === undefined || options.remote === null
            ? null
            : {
                remoteName: "origin",
                branch: input.branch,
                refName: `origin/${input.branch}`,
                commit: options.remote,
              },
        ),
  ),
  resolveCommit: (_cwd, revision) => {
    const local = options.local === undefined ? LOCAL : options.local;
    return Effect.succeed(
      revision.startsWith("refs/heads/")
        ? local
        : options.bareName === undefined
          ? local
          : options.bareName,
    );
  },
  isAncestor: (_cwd, ancestor, descendant) =>
    options.ancestry === "error"
      ? Effect.fail(gitError("merge-base failed"))
      : Effect.succeed((options.ancestry ?? []).includes(`${ancestor}>${descendant}`)),
});

const resolve = (git: FakeGit) =>
  Effect.runPromise(resolveWorktreeBase(git, { projectCwd: "/repo", baseBranch: "feature" }));

describe("resolveWorktreeBase", () => {
  it("uses the local branch without fetching when there is no remote", async () => {
    const git = makeGit({ hasRemote: false });
    expect(await resolve(git)).toEqual({
      baseRef: "feature",
      baseSha: LOCAL,
      outcome: "no-remote",
      detail: "no remote",
    });
    expect(git.fetchRemoteBranchCommit).not.toHaveBeenCalled();
  });

  it("treats a branch missing on the remote as a normal local-only base", async () => {
    expect(await resolve(makeGit({ remote: null }))).toEqual({
      baseRef: "feature",
      baseSha: LOCAL,
      outcome: "local-only",
      detail: "Using local feature (not on the remote)",
    });
  });

  it("falls back to the local branch when the remote is unreachable", async () => {
    expect(await resolve(makeGit({ remote: "error" }))).toEqual({
      baseRef: "feature",
      baseSha: LOCAL,
      outcome: "unreachable",
      detail: "Couldn't reach the remote; using local feature",
    });
  });

  it("uses the remote when it equals the local branch", async () => {
    expect(await resolve(makeGit({ remote: LOCAL }))).toMatchObject({
      baseRef: LOCAL,
      baseSha: LOCAL,
      outcome: "remote",
      detail: "origin/feature at 1111111",
    });
  });

  it("uses the remote when the local branch is behind", async () => {
    expect(
      await resolve(makeGit({ remote: REMOTE, ancestry: [`${LOCAL}>${REMOTE}`] })),
    ).toMatchObject({ baseRef: REMOTE, baseSha: REMOTE, outcome: "remote" });
  });

  it("uses the remote when there is no local branch", async () => {
    expect(await resolve(makeGit({ remote: REMOTE, local: null }))).toMatchObject({
      baseRef: REMOTE,
      baseSha: REMOTE,
      outcome: "remote",
    });
  });

  it("keeps unpushed local commits when the local branch is ahead", async () => {
    expect(await resolve(makeGit({ remote: REMOTE, ancestry: [`${REMOTE}>${LOCAL}`] }))).toEqual({
      baseRef: "feature",
      baseSha: LOCAL,
      outcome: "local-ahead",
      detail: "Using local feature (ahead of origin/feature)",
    });
  });

  it("keeps the local branch when it has diverged from the remote", async () => {
    expect(await resolve(makeGit({ remote: REMOTE }))).toEqual({
      baseRef: "feature",
      baseSha: LOCAL,
      outcome: "local-diverged",
      detail: "Using local feature (diverged from origin/feature)",
    });
  });

  it("reports unknown ancestry separately and keeps the local branch", async () => {
    expect(await resolve(makeGit({ remote: REMOTE, ancestry: "error" }))).toEqual({
      baseRef: "feature",
      baseSha: LOCAL,
      outcome: "ancestry-unknown",
      detail: "Couldn't compare with origin/feature; using local feature",
    });
  });

  it("compares the local branch, not a same-named tag", async () => {
    const TAG = "3333333333333333333333333333333333333333";
    expect(
      await resolve(makeGit({ remote: REMOTE, bareName: TAG, ancestry: [`${LOCAL}>${REMOTE}`] })),
    ).toMatchObject({ baseSha: REMOTE, outcome: "remote" });
  });

  it("falls back to the bare name for remote-qualified selections", async () => {
    expect(await resolve(makeGit({ remote: null, local: null, bareName: LOCAL }))).toMatchObject({
      baseSha: LOCAL,
      outcome: "local-only",
    });
  });

  it("flags only bases that may lack upstream work as stale", () => {
    expect(
      (
        [
          "remote",
          "local-only",
          "local-ahead",
          "local-diverged",
          "ancestry-unknown",
          "no-remote",
          "unreachable",
        ] as const
      ).filter(isPossiblyStaleWorktreeBase),
    ).toEqual(["local-diverged", "ancestry-unknown", "unreachable"]);
  });

  it("reports no commit when the local-only branch does not resolve", async () => {
    expect(await resolve(makeGit({ remote: null, local: null }))).toMatchObject({
      baseSha: null,
      outcome: "local-only",
    });
  });
});
