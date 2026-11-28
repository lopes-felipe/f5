import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { placeholderBranchFor, resolvePlaceholderBranchAcross } from "./placeholderBranch.ts";

/** Each repository holds a set of branches; a name is free when no branch has it. */
function fakeRepos(repos: Record<string, ReadonlyArray<string>>) {
  return {
    branchExists: (cwd: string, branch: string) =>
      Effect.succeed((repos[cwd] ?? []).includes(branch)),
    resolveAvailableBranchName: (cwd: string, branch: string) => {
      const taken = repos[cwd] ?? [];
      let candidate = branch;
      for (let suffix = 1; taken.includes(candidate); suffix += 1)
        candidate = `${branch}-${suffix}`;
      return Effect.succeed(candidate);
    },
  };
}

describe("resolvePlaceholderBranchAcross", () => {
  it("keeps a free placeholder as-is", async () => {
    const git = fakeRepos({ a: [], b: [] });
    await expect(
      Effect.runPromise(resolvePlaceholderBranchAcross(git, ["a", "b"], "f5/wip/fix-login")),
    ).resolves.toBe("f5/wip/fix-login");
  });

  it("takes the first suffix free in every repository", async () => {
    const git = fakeRepos({
      a: ["f5/wip/fix-login"],
      b: ["f5/wip/fix-login-1"],
    });
    await expect(
      Effect.runPromise(resolvePlaceholderBranchAcross(git, ["a", "b"], "f5/wip/fix-login")),
    ).resolves.toBe("f5/wip/fix-login-2");
  });

  it("fails with a pointer to the setting when an ancestor branch blocks the name", async () => {
    const git = fakeRepos({ a: [], b: ["f5"] });
    await expect(
      Effect.runPromise(resolvePlaceholderBranchAcross(git, ["a", "b"], "f5/wip/fix-login")),
    ).rejects.toThrow(/Branch 'f5' blocks new branches named 'f5\/wip\/fix-login'/);
  });

  it("keeps the flattening fallback for legacy placeholders", async () => {
    const git = fakeRepos({ a: ["t3code"] });
    await expect(
      Effect.runPromise(resolvePlaceholderBranchAcross(git, ["a"], "t3code/1a2b3c4d")),
    ).resolves.toBe("t3code-1a2b3c4d");
  });
});

describe("placeholderBranchFor", () => {
  it("builds a placeholder when the request has no branch or a legacy one", () => {
    for (const requested of [undefined, null, "", "t3code/1a2b3c4d"]) {
      expect(
        placeholderBranchFor({ requested, prefix: "team", sourceText: "Fix the login redirect" }),
      ).toEqual({ branch: "team/wip/fix-login-redirect", automatic: true });
    }
  });

  it("keeps a branch the user chose", () => {
    expect(
      placeholderBranchFor({ requested: "me/spike", prefix: "f5", sourceText: "whatever" }),
    ).toEqual({ branch: "me/spike", automatic: false });
  });
});
