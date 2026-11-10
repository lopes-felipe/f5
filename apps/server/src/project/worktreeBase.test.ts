import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { GitCommandError } from "../git/Errors.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import { resolveWorktreeBase } from "./worktreeBase.ts";

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
  local?: string | null;
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
  resolveCommit: () => Effect.succeed(options.local === undefined ? LOCAL : options.local),
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

  it("keeps the local branch when ancestry cannot be checked", async () => {
    expect(await resolve(makeGit({ remote: REMOTE, ancestry: "error" }))).toMatchObject({
      baseSha: LOCAL,
      outcome: "local-diverged",
    });
  });

  it("reports no commit when the local-only branch does not resolve", async () => {
    expect(await resolve(makeGit({ remote: null, local: null }))).toMatchObject({
      baseSha: null,
      outcome: "local-only",
    });
  });
});
