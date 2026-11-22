import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "vitest";
import {
  inspectNestedWorktreeDestination,
  externalRepositoryPath,
  selectNestedWorktreeRepositories,
} from "./worktreeRepositoryPaths.ts";
import { ServerConfig } from "../config.ts";
import { GitCore } from "../git/Services/GitCore.ts";
import { GitServiceLive } from "../git/Layers/GitService.ts";
import { GitCoreTestLive } from "../git/testLayers.ts";
import { assertWorktreeReady } from "./worktreeReadiness.ts";

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const init = async (directory: string, file: string, contents: string) => {
  run(directory, "init", "-q", "-b", "main");
  await writeFile(path.join(directory, file), contents);
  run(directory, "add", "--", file);
  run(
    directory,
    "-c",
    "user.name=F5 Test",
    "-c",
    "user.email=f5@example.test",
    "commit",
    "-qm",
    "base",
  );
};

it("defaults to eight checkouts and keeps the root checkout available above the limit", async () => {
  const repositories = Array.from({ length: 9 }, (_, i) => ({
    path: "/project/repo-" + i,
    relativePath: "repo-" + i,
  }));
  expect(
    await Effect.runPromise(
      selectNestedWorktreeRepositories(repositories.slice(0, 8), undefined, false),
    ),
  ).toHaveLength(8);
  await expect(
    Effect.runPromise(selectNestedWorktreeRepositories(repositories, undefined, false)),
  ).rejects.toThrow("Select the repositories");
  await expect(
    Effect.runPromise(selectNestedWorktreeRepositories(repositories, undefined)),
  ).resolves.toEqual([]);
  expect(
    await Effect.runPromise(selectNestedWorktreeRepositories(repositories, ["repo-8"], false)),
  ).toEqual([repositories[8]]);
});

it("prepares and resumes an isolated workspace for a plain project folder", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "f5-plain-worktree-project-"));
  const external = await mkdtemp(path.join(tmpdir(), "f5-ext-"));
  try {
    const repositoryPaths = ["api", "web"].map((name) => path.join(project, name));
    for (const directory of repositoryPaths) {
      await mkdir(directory);
      await init(directory, "app.txt", "original");
    }
    await writeFile(path.join(project, "README.md"), "shared");
    await symlink(repositoryPaths[0]!, path.join(project, "api-alias"), "junction");
    await writeFile(path.join(repositoryPaths[1]!, ".gitignore"), ".env\n");
    run(repositoryPaths[1]!, "add", ".gitignore");
    run(
      repositoryPaths[1]!,
      "-c",
      "user.name=F5 Test",
      "-c",
      "user.email=f5@example.test",
      "commit",
      "-qm",
      "ignore env",
    );
    await init(external, "external.txt", "external");
    await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* GitCore;
        const worktree = yield* git.allocateWorktreePath({
          cwd: repositoryPaths[0]!,
          branch: "feature",
        });
        const input = {
          projectId: "project",
          threadId: "thread",
          projectRoot: project,
          path: worktree,
          branch: "feature",
          baseBranch: "missing",
          repositories: repositoryPaths,
          selected: repositoryPaths,
        };
        yield* git.prepareWorktreeGroup!(input);
        yield* git.prepareWorktreeGroup!(input);
        yield* assertWorktreeReady(git, {
          projectCwd: project,
          worktreePath: worktree,
          branch: "feature",
        });
        expect(run(path.join(worktree, "api"), "branch", "--show-current")).toBe("feature");
        expect(run(path.join(worktree, "web"), "branch", "--show-current")).toBe("feature");
        expect(
          yield* Effect.promise(() => readFile(path.join(worktree, "README.md"), "utf8")),
        ).toBe("shared");
        yield* Effect.promise(() =>
          expect(readFile(path.join(worktree, "api-alias", "app.txt"), "utf8")).rejects.toThrow(),
        );
        expect(
          yield* git.ensureWorktree({
            cwd: project,
            path: worktree,
            branch: "feature",
            owner: "thread:thread",
          }),
        ).toEqual({ recreated: false });
        const apiCheckout = path.join(worktree, "api");
        yield* git.removeWorktree({ cwd: repositoryPaths[0]!, path: apiCheckout });
        expect(
          yield* git.ensureWorktree({
            cwd: project,
            path: worktree,
            branch: "feature",
            owner: "thread:thread",
          }),
        ).toEqual({ recreated: true });
        expect(run(apiCheckout, "branch", "--show-current")).toBe("feature");
        const webCheckout = path.join(worktree, "web");
        run(webCheckout, "switch", "-c", "web-feature");
        yield* assertWorktreeReady(git, {
          projectCwd: project,
          worktreePath: worktree,
          branch: "feature",
        });
        yield* Effect.promise(() => writeFile(path.join(webCheckout, "app.txt"), "dirty"));
        const refused = yield* git
          .removeWorktree({ cwd: project, path: worktree })
          .pipe(Effect.result);
        expect(refused._tag).toBe("Failure");
        expect(run(apiCheckout, "branch", "--show-current")).toBe("feature");
        yield* Effect.promise(() => writeFile(path.join(webCheckout, "app.txt"), "original"));
        yield* Effect.promise(() => writeFile(path.join(webCheckout, ".env"), "keep"));
        expect(
          yield* Effect.result(git.removeWorktree({ cwd: project, path: worktree })),
        ).toMatchObject({
          _tag: "Failure",
        });
        yield* git.removeWorktree({
          cwd: project,
          path: worktree,
          ignoredFiles: { kind: "manual", approvedEntries: ["web/.env"] },
        });
        expect(yield* git.readWorktreeGroup!(worktree)).toBeNull();
        yield* git.prepareWorktreeGroup!({ ...input, threadId: "next-thread", branch: "next" });
        expect(yield* git.readWorktreeGroup!(worktree)).toMatchObject({ threadId: "next-thread" });
        yield* Effect.promise(() => rename(repositoryPaths[1]!, path.join(project, "moved")));
        expect(
          yield* git.inspectWorktreeGroup!({
            path: worktree,
            projectRoot: project,
            branch: "next",
            threadId: "next-thread",
          }),
        ).toEqual({ ready: false, recoverable: false });
        yield* Effect.promise(() => rename(path.join(project, "moved"), repositoryPaths[1]!));
        yield* git.removeWorktree({ cwd: project, path: worktree });

        for (const [invalidPath, message] of [
          ["relative", "absolute repository folder"],
          [repositoryPaths[0]!, "outside the project"],
          [path.dirname(project), "outside the project"],
        ]) {
          const result = yield* Effect.result(
            git.setProjectRepositoryRoot!({
              projectId: "project",
              projectRoot: project,
              path: invalidPath!,
              tracked: true,
            }),
          );
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { detail: expect.stringContaining(message!) },
          });
        }
        yield* git.setProjectRepositoryRoot!({
          projectId: "project",
          projectRoot: project,
          path: external,
          tracked: true,
        });
        const customPath = yield* git.allocateWorktreePath({ cwd: external, branch: "custom" });
        const custom = {
          ...input,
          path: customPath,
          threadId: "custom-thread",
          branch: "custom",
          repositories: [external],
          selected: [external],
          layoutCreate: `"${process.execPath}" -e "require('node:fs').appendFileSync(require('node:path').join(process.env.T3_WORKTREE_PROJECT_PATH, 'stamp'), 'once')"`,
        };
        yield* git.prepareWorktreeGroup!(custom);
        yield* git.prepareWorktreeGroup!(custom);
        expect(yield* Effect.promise(() => readFile(path.join(customPath, "stamp"), "utf8"))).toBe(
          "once",
        );
        const [registered] = yield* git.listProjectRepositoryRoots!("project");
        expect(
          run(
            path.join(customPath, externalRepositoryPath(registered!)),
            "branch",
            "--show-current",
          ),
        ).toBe("custom");
        const displaced = customPath + "-displaced";
        yield* Effect.promise(() => rename(customPath, displaced));
        expect(
          yield* git.inspectWorktreeGroup!({
            path: customPath,
            projectRoot: project,
            branch: "custom",
            threadId: "custom-thread",
          }),
        ).toEqual({ ready: false, recoverable: false });
        yield* Effect.promise(() => rename(displaced, customPath));
        yield* git.removeWorktree({
          cwd: project,
          path: customPath,
          layoutRemove: `"${process.execPath}" -e "require('node:fs').unlinkSync(require('node:path').join(process.env.T3_WORKTREE_PROJECT_PATH, 'stamp'))"`,
        });
      }).pipe(
        Effect.provide(
          GitCoreTestLive.pipe(
            Layer.provide(ServerConfig.layerTest(project, { prefix: "f5-wt-" })),
            Layer.provide(GitServiceLive),
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    );
  } finally {
    await rm(external, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

it("leaves checkout-hook links untouched even when they point at empty folders", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "f5-worktree-repository-"));
  try {
    const root = path.join(temp, "workspace");
    const outside = path.join(temp, "original");
    await mkdir(root);
    await mkdir(outside);
    await mkdir(path.join(root, "empty"));
    await symlink(outside, path.join(root, "vendor"), "junction");

    const inspect = (repository: string) =>
      Effect.runPromise(inspectNestedWorktreeDestination(root, repository));
    expect((await inspect("vendor")).kind).toBe("occupied");
    expect((await inspect("vendor/clone")).kind).toBe("occupied");
    expect((await inspect("empty")).kind).toBe("empty");
    expect((await inspect("packages/clone")).kind).toBe("missing");
    await expect(inspect("../original")).rejects.toThrow("outside the worktree");
    expect(await readdir(outside)).toEqual([]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it("keeps the contents and branch created by a primary checkout hook", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "f5-hook-"));
  const service = path.join(project, "service");
  const other = path.join(project, "other");
  try {
    await init(project, "README.md", "primary");
    for (const repo of [service, other]) {
      await mkdir(repo);
      await init(repo, "app.txt", "nested");
    }
    const main = run(other, "rev-parse", "HEAD");
    run(other, "update-ref", "refs/remotes/origin/release", main);
    await writeFile(path.join(other, "app.txt"), "new main");
    run(
      other,
      "-c",
      "user.name=F5 Test",
      "-c",
      "user.email=f5@example.test",
      "commit",
      "-qam",
      "new main",
    );
    const hook = path.join(project, ".git", "hooks", "post-checkout");
    await writeFile(
      hook,
      '#!/bin/sh\nset -eu\ncommon=$(git rev-parse --path-format=absolute --git-common-dir)\ngit -C "$common/../service" branch feature\nmkdir -p service\nprintf hook > service/stamp\n',
    );
    await chmod(hook, 0o755);
    await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* GitCore;
        const { worktree } = yield* git.createWorktree({
          cwd: project,
          branch: "main",
          newBranch: "feature",
          path: null,
          preparation: { owner: "thread:thread", runSetupScript: false, setupIdentity: null },
        });
        const plan = {
          projectId: "project",
          threadId: "thread",
          projectRoot: project,
          path: worktree.path,
          rooted: true,
          branch: "feature",
          baseBranch: "origin/release",
          repositories: [service, other],
          selected: [service, other],
          layoutCreate: `"${process.execPath}" -e "const fs = require('node:fs'); const root = process.env.T3_WORKTREE_PROJECT_PATH; if (fs.readFileSync(require('node:path').join(root, 'README.md'), 'utf8') !== 'primary') process.exit(1)"`,
        };
        yield* git.prepareWorktreeGroup!(plan);
        yield* assertWorktreeReady(git, {
          projectCwd: project,
          worktreePath: worktree.path,
          branch: "feature",
        });
        expect(
          yield* Effect.promise(() =>
            readFile(path.join(worktree.path, "service", "stamp"), "utf8"),
          ),
        ).toBe("hook");
        expect(run(path.join(worktree.path, "other"), "rev-parse", "HEAD")).toBe(main);
      }).pipe(
        Effect.provide(
          GitCoreTestLive.pipe(
            Layer.provide(ServerConfig.layerTest(project, { prefix: "f5-wt-" })),
            Layer.provide(GitServiceLive),
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

it("checks out a nested repository on the thread branch and preserves dirty nested work", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "f5-worktree-project-"));
  const repo = path.join(project, "service");
  const second = path.join(project, "web");
  try {
    await init(project, "README.md", "primary");
    for (const directory of [repo, second]) {
      await mkdir(directory);
      await init(directory, "app.txt", "committed\n");
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* GitCore;
        const { worktree } = yield* git.createWorktree({
          cwd: project,
          branch: "main",
          newBranch: "feature",
          path: null,
          preparation: {
            owner: "thread:rooted-thread",
            runSetupScript: false,
            setupIdentity: null,
          },
        });
        yield* git.prepareWorktreeGroup!({
          projectId: "project",
          threadId: "rooted-thread",
          projectRoot: project,
          rooted: true,
          path: worktree.path,
          repositories: [repo, second],
          selected: [repo, second],
          branch: "feature",
          baseBranch: "main",
        });
        const checkout = path.join(worktree.path, "service");
        expect(run(checkout, "branch", "--show-current")).toBe("feature");
        expect(run(repo, "branch", "--show-current")).toBe("main");
        const dirty = path.join(worktree.path, "web");
        yield* Effect.promise(() => writeFile(path.join(dirty, "app.txt"), "local edit\n"));
        const rejected = yield* git
          .removeWorktree({ cwd: project, path: worktree.path })
          .pipe(Effect.result);
        expect(rejected._tag).toBe("Failure");
        expect(run(checkout, "branch", "--show-current")).toBe("feature");
        expect(run(dirty, "status", "--short")).toContain("M app.txt");
        yield* Effect.promise(() => writeFile(path.join(dirty, "app.txt"), "committed\n"));
        const failedLayout = yield* Effect.result(
          git.removeWorktree({
            cwd: project,
            path: worktree.path,
            layoutRemove: `"${process.execPath}" -e "console.error('layout cleanup failed'); process.exit(4)"`,
          }),
        );
        expect(failedLayout).toMatchObject({
          _tag: "Failure",
          failure: { detail: expect.stringContaining("layout cleanup failed") },
        });
        expect(run(checkout, "branch", "--show-current")).toBe("feature");
        yield* git.removeWorktree({ cwd: project, path: worktree.path });
        expect(run(repo, "worktree", "list", "--porcelain")).not.toContain("refs/heads/feature");
        expect(run(repo, "show-ref", "--verify", "refs/heads/feature")).toContain(
          "refs/heads/feature",
        );
        expect(yield* git.readWorktreeGroup!(worktree.path)).toBeNull();
      }).pipe(
        Effect.provide(
          GitCoreTestLive.pipe(
            Layer.provide(
              ServerConfig.layerTest(project, { prefix: "f5-worktree-project-config-" }),
            ),
            Layer.provide(GitServiceLive),
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
