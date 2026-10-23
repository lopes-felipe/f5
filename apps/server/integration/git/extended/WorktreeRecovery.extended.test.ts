import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "vitest";
import { GitCoreTestLive as GitCoreLive } from "../../../src/git/testLayers.ts";
import { GitServiceLive } from "../../../src/git/Layers/GitService.ts";
import { GitCore } from "../../../src/git/Services/GitCore.ts";
import { ServerConfig } from "../../../src/config.ts";
import { parseWorktreeListPorcelain } from "../../../src/git/worktreeList.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const worktreePaths = (cwd: string) =>
  parseWorktreeListPorcelain(git(cwd, "worktree", "list", "--porcelain", "-z")).map((entry) =>
    path.normalize(entry.path),
  );
it.each(["directory", "symlink"])(
  "recreates a missing worktree through a %s root once for concurrent callers without moving its branch",
  async (rootKind) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "f5-recovery-"));
    const repo = path.join(root, "repo"),
      target = path.join(root, "worktrees", "worktree");
    const layer = GitCoreLive.pipe(
      Layer.provide(GitServiceLive),
      Layer.provide(ServerConfig.layerTest(process.cwd(), path.join(root, "userdata"))),
      Layer.provide(NodeServices.layer),
    );
    const run = <A, E>(operation: Effect.Effect<A, E, GitCore>) =>
      Effect.runPromise(operation.pipe(Effect.provide(layer)));
    try {
      if (rootKind === "symlink") {
        fs.mkdirSync(path.join(root, "physical"));
        fs.symlinkSync(path.join(root, "physical"), path.join(root, "worktrees"), "junction");
      }
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
      const other = path.join(root, "unmounted");
      git(repo, "worktree", "add", "-b", "other", other);
      const otherAdmin = git(other, "rev-parse", "--absolute-git-dir");
      const otherIndex = fs.readFileSync(path.join(otherAdmin, "index"));
      fs.rmSync(other, { recursive: true });
      const registeredTarget = fs.realpathSync(target);
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
      expect(worktreePaths(repo)).toContain(other);
      expect(fs.readFileSync(path.join(otherAdmin, "index"))).toEqual(otherIndex);
      await expect(
        run(
          Effect.flatMap(Effect.service(GitCore), (core) =>
            core.ensureWorktree({ cwd: repo, path: path.join(root, "outside"), branch: "other" }),
          ),
        ),
      ).rejects.toThrow(/managed worktrees/);
      expect(fs.existsSync(path.join(root, "outside"))).toBe(false);
      await expect(
        run(
          Effect.flatMap(Effect.service(GitCore), (core) =>
            core.ensureWorktree({
              cwd: repo,
              path: path.relative(process.cwd(), path.join(root, "worktrees", "relative")),
              branch: "other",
            }),
          ),
        ),
      ).rejects.toThrow(/managed worktrees/);
      expect(git(target, "rev-parse", "HEAD")).toBe(before);
      expect(git(target, "branch", "--show-current")).toBe("feature");
      fs.rmSync(target, { recursive: true });
      const elsewhere = path.join(root, "elsewhere");
      git(repo, "worktree", "add", "--force", elsewhere, "feature");
      await expect(
        run(
          Effect.gen(function* () {
            const core = yield* GitCore;
            yield* core.ensureWorktree({ cwd: repo, path: target, branch: "feature" });
          }),
        ),
      ).rejects.toThrow(/checked out at/);
      expect(fs.existsSync(target)).toBe(false);
      expect(worktreePaths(repo)).toContain(registeredTarget);
      expect(fs.readFileSync(path.join(otherAdmin, "index"))).toEqual(otherIndex);
      expect(git(elsewhere, "rev-parse", "HEAD")).toBe(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

it("allocates by canonical repository and exact branch identity and preserves occupied paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f5-allocation-"));
  const first = path.join(root, "one", "repo");
  const second = path.join(root, "two", "repo");
  const alias = path.join(root, "alias");
  const initialize = (repo: string) => {
    fs.mkdirSync(repo, { recursive: true });
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
  };
  const layer = GitCoreLive.pipe(
    Layer.provide(GitServiceLive),
    Layer.provide(ServerConfig.layerTest(process.cwd(), path.join(root, "userdata"))),
    Layer.provide(NodeServices.layer),
  );
  try {
    initialize(first);
    initialize(second);
    fs.symlinkSync(first, alias, "junction");
    await Effect.runPromise(
      Effect.gen(function* () {
        const core = yield* GitCore;
        const slash = yield* core.allocateWorktreePath({ cwd: first, branch: "fix/login" });
        const dash = yield* core.allocateWorktreePath({ cwd: first, branch: "fix-login" });
        const other = yield* core.allocateWorktreePath({ cwd: second, branch: "fix/login" });
        expect(new Set([slash, dash, other]).size).toBe(3);
        expect(slash).toMatch(/repo-[0-9a-f]{12}[/\\]fix-login-[0-9a-f]{8}$/);
        expect(yield* core.allocateWorktreePath({ cwd: alias, branch: "fix/login" })).toBe(slash);
        fs.mkdirSync(slash, { recursive: true });
        fs.writeFileSync(path.join(slash, ".env"), "SECRET=kept");
        expect(
          (yield* core
            .createWorktree({ cwd: first, branch: "main", newBranch: "fix/login", path: null })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(fs.readFileSync(path.join(slash, ".env"), "utf8")).toBe("SECRET=kept");
        expect(yield* core.branchExists(first, "fix/login")).toBe(false);
        const created = yield* core.createWorktree({
          cwd: first,
          branch: "main",
          newBranch: "fix-login",
          path: null,
        });
        expect(created.worktree.path).toBe(dash);
        expect(yield* core.readWorktreePreparation(dash)).toMatchObject({
          phase: "skipped",
          createdCheckout: true,
          branch: "fix-login",
        });
        // A verified add failure releases its reservation without claiming any checkout.
        const failedPath = path.join(path.dirname(dash), "failed-add");
        expect(
          (yield* core
            .createWorktree({
              cwd: first,
              branch: "main",
              newBranch: "fix-login",
              path: failedPath,
            })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(yield* core.readWorktreePreparation(failedPath)).toMatchObject({
          phase: "skipped",
          createdCheckout: false,
        });
        yield* core.createWorktree({
          cwd: first,
          branch: "main",
          newBranch: "fixed-add",
          path: failedPath,
        });
        expect(yield* core.readWorktreePreparation(failedPath)).toMatchObject({
          phase: "skipped",
          createdCheckout: true,
          branch: "fixed-add",
        });
      }).pipe(Effect.provide(layer)),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
