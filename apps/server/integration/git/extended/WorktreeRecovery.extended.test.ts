import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "vitest";
import { GitCoreLive } from "../../../src/git/Layers/GitCore.ts";
import { GitServiceLive } from "../../../src/git/Layers/GitService.ts";
import { GitCore } from "../../../src/git/Services/GitCore.ts";
import { ServerConfig } from "../../../src/config.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const layer = GitCoreLive.pipe(
  Layer.provide(GitServiceLive),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "f5-worktree-recovery-" })),
  Layer.provide(NodeServices.layer),
);
const run = <A, E>(operation: Effect.Effect<A, E, GitCore>) =>
  Effect.runPromise(operation.pipe(Effect.provide(layer)));

it("recreates a missing worktree once for concurrent callers without moving its branch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f5-recovery-"));
  const repo = path.join(root, "repo"),
    target = path.join(root, "worktree");
  try {
    fs.mkdirSync(repo);
    git(repo, "init", "--initial-branch=main");
    git(
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "base",
    );
    git(repo, "worktree", "add", "-b", "feature", target);
    const before = git(repo, "rev-parse", "feature");
    fs.rmSync(target, { recursive: true });
    await run(
      Effect.gen(function* () {
        const core = yield* GitCore;
        yield* Effect.all(
          [
            core.ensureWorktree({ cwd: repo, path: target, branch: "feature" }),
            core.ensureWorktree({ cwd: repo, path: target, branch: "feature" }),
          ],
          { concurrency: 2 },
        );
      }),
    );
    expect(git(target, "rev-parse", "HEAD")).toBe(before);
    expect(git(target, "branch", "--show-current")).toBe("feature");
    fs.rmSync(target, { recursive: true });
    git(repo, "worktree", "prune");
    const elsewhere = path.join(root, "elsewhere");
    git(repo, "worktree", "add", elsewhere, "feature");
    await expect(
      run(
        Effect.gen(function* () {
          const core = yield* GitCore;
          yield* core.ensureWorktree({ cwd: repo, path: target, branch: "feature" });
        }),
      ),
    ).rejects.toThrow(/checked out at/);
    expect(fs.existsSync(target)).toBe(false);
    expect(git(elsewhere, "rev-parse", "HEAD")).toBe(before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
