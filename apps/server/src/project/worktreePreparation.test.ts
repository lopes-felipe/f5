import * as Path from "node:path";
import { createLargeIgnoredDependencyTree } from "../git/ignoredPaths.testUtils.ts";
import { GitCore } from "../git/Services/GitCore.ts";
import { canonicalWorktreePath } from "../git/worktreePaths.ts";
import {
  automationLayer,
  git as runGit,
  makeClonedRepo,
  makeWorld,
} from "../storage/storageAutomation.testHarness.ts";
import { makeFakeGitCore } from "../git/testDoubles.ts";
import { makeMemoryWorktreePreparations } from "../persistence/worktreePreparations.testUtils.ts";
import { ThreadId, type GitPrepareWorktreeInput } from "@t3tools/contracts";
import { Effect, Exit, Fiber, Scope } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectSetupScriptRunnerShape } from "./Services/ProjectSetupScriptRunner.ts";
import { makeWorktreePreparation } from "./worktreePreparation.ts";

const projectRoot = Path.resolve("/repo");
const input: GitPrepareWorktreeInput = {
  cwd: Path.join(projectRoot, "old-worktree"),
  projectCwd: projectRoot,
  threadId: ThreadId.makeUnsafe("draft-1"),
  branch: "origin/feature",
  newBranch: "t3code/12345678",
};
const result = {
  worktree: { branch: input.newBranch, path: Path.join(projectRoot, "new-worktree") },
};
const scopes: Scope.Closeable[] = [];
afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void));
});

async function harness() {
  const scope = await Effect.runPromise(Scope.make());
  scopes.push(scope);
  const receipts = makeMemoryWorktreePreparations();
  const git = makeFakeGitCore({
    resolveCommonDir: () => Effect.succeed(Path.join(projectRoot, ".git")),
    resolveCommit: () => Effect.succeed("base-oid"),
    allocateWorktreePath: () => Effect.succeed(result.worktree.path),
    inspectCheckout: (path) =>
      makeFakeGitCore()
        .service.inspectCheckout(path)
        .pipe(
          Effect.map((inspection) => ({
            ...inspection,
            canonicalRoot: result.worktree.path,
            commonDir: Path.join(projectRoot, ".git"),
            branch: input.newBranch,
            headSha: "base-oid",
            registration: {
              path: result.worktree.path,
              canonicalPath: result.worktree.path,
              branch: input.newBranch,
              headSha: "base-oid",
              bare: false,
              detached: false,
              locked: null,
              prunable: null,
              isMain: false,
            },
          })),
        ),
  }).service;
  const createWorktree = vi.fn((request: GitPrepareWorktreeInput & { operationId: string }) =>
    Effect.gen(function* () {
      const receipt = yield* receipts.allocate({
        operationId: request.operationId,
        repositoryIdentity: Path.join(projectRoot, ".git"),
        projectIdentity: projectRoot,
        owner: `thread:${request.threadId}`,
        requestedBase: request.branch,
        baseOid: "base-oid",
        path: result.worktree.path,
        branch: request.newBranch,
        namingIntent: "temporary",
        runSetupScript: true,
        setupIdentity: null,
      });
      yield* receipts.update(receipt, { phase: "checkout_created", createdCheckout: true });
      return result;
    }),
  );
  const runSetup = vi.fn<ProjectSetupScriptRunnerShape["runForThread"]>(() =>
    Effect.succeed({ status: "no-script" } as const),
  );
  const prepare = await Effect.runPromise(
    makeWorktreePreparation({ scope, git, receipts, createWorktree, runSetup }),
  );
  return { scope, git, receipts, createWorktree, runSetup, prepare };
}

describe("worktree preparation", () => {
  it("launches project setup in the prepared cwd for draft and established threads", async () => {
    for (const threadId of [input.threadId, ThreadId.makeUnsafe("server-1")]) {
      const { prepare, runSetup } = await harness();
      await Effect.runPromise(prepare({ ...input, threadId, newBranch: `t3code/${threadId}` }));
      expect(runSetup).toHaveBeenLastCalledWith({
        threadId,
        projectCwd: projectRoot,
        worktreePath: result.worktree.path,
        preferredTerminalId: `setup-t3code-${threadId}`,
      });
    }
  });

  it("replays completed setup with more than a megabyte of ignored dependency paths", async () => {
    const repo = await makeClonedRepo("f5-preparation-dependencies-");
    try {
      const worktreePath = Path.join(repo.dir, "worktree");
      runGit(repo.root, "worktree", "add", "-b", "feature", "--", worktreePath, "HEAD");
      await createLargeIgnoredDependencyTree(worktreePath);
      await Effect.runPromise(
        Effect.gen(function* () {
          const core = yield* GitCore;
          const scope = yield* Effect.scope;
          const receipts = makeMemoryWorktreePreparations();
          const receipt = yield* receipts.allocate({
            operationId: "completed-setup",
            // Preparation compares canonical paths; Windows short names and Git's forward slashes
            // differ from the raw ones.
            repositoryIdentity: yield* core
              .resolveCommonDir(repo.root)
              .pipe(Effect.flatMap((dir) => Effect.promise(() => canonicalWorktreePath(dir)))),
            projectIdentity: yield* Effect.promise(() => canonicalWorktreePath(repo.root)),
            owner: `thread:${input.threadId}`,
            requestedBase: "main",
            baseOid: runGit(repo.root, "rev-parse", "HEAD"),
            path: worktreePath,
            branch: "feature",
            namingIntent: "existing",
            runSetupScript: true,
            setupIdentity: null,
          });
          yield* receipts.update(receipt, { phase: "completed", createdCheckout: true });
          const runSetup = vi.fn(() => Effect.succeed({ status: "no-script" } as const));
          const prepare = yield* makeWorktreePreparation({
            scope,
            git: { ...core, allocateWorktreePath: () => Effect.succeed(worktreePath) },
            receipts,
            createWorktree: () => Effect.fail(new Error("Completed setup must reuse its checkout")),
            runSetup,
          });
          expect(
            yield* prepare({
              ...input,
              cwd: repo.root,
              projectCwd: repo.root,
              branch: "main",
              newBranch: "feature",
            }),
          ).toEqual({ worktree: { path: worktreePath, branch: "feature" } });
          expect(runSetup).not.toHaveBeenCalled();
        }).pipe(
          Effect.provide(automationLayer(makeWorld(), {}, "f5-preparation-dependencies-state-")),
          Effect.scoped,
        ),
      );
    } finally {
      await repo.cleanup();
    }
  });

  it("coalesces slow creation and replays completion without duplicate setup", async () => {
    const { prepare, createWorktree, runSetup } = await harness();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = createWorktree.getMockImplementation()!;
    createWorktree.mockImplementation((request) =>
      Effect.promise(() => held).pipe(Effect.andThen(original(request))),
    );
    const first = Effect.runPromise(prepare(input));
    const second = Effect.runPromise(prepare(input));
    await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledTimes(1));
    expect(runSetup).not.toHaveBeenCalled();
    release();
    expect(await Promise.all([first, second])).toEqual([result, result]);
    expect(await Effect.runPromise(prepare(input))).toEqual(result);
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(runSetup).toHaveBeenCalledTimes(1);
  });

  it("keeps preparing when the requesting client disconnects", async () => {
    const { prepare, createWorktree, runSetup, scope } = await harness();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = createWorktree.getMockImplementation()!;
    createWorktree.mockImplementation((request) =>
      Effect.promise(() => held).pipe(Effect.andThen(original(request))),
    );
    const request = await Effect.runPromise(prepare(input).pipe(Effect.forkIn(scope)));
    await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledTimes(1));
    await Effect.runPromise(Fiber.interrupt(request));
    release();
    expect(await Effect.runPromise(prepare(input))).toEqual(result);
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(runSetup).toHaveBeenCalledTimes(1);
  });

  it("retries failed setup on the same worktree instead of creating another", async () => {
    const { prepare, createWorktree, runSetup } = await harness();
    runSetup.mockImplementationOnce(() => Effect.fail(new Error("Cannot launch setup")));
    await expect(Effect.runPromise(prepare(input))).rejects.toThrow("Cannot launch setup");
    expect(await Effect.runPromise(prepare(input))).toEqual(result);
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(runSetup).toHaveBeenCalledTimes(2);
  });

  it("rejects reuse of a recovery identity for different thread content", async () => {
    const { prepare, createWorktree } = await harness();
    await Effect.runPromise(prepare(input));
    await expect(
      Effect.runPromise(prepare({ ...input, threadId: ThreadId.makeUnsafe("other") })),
    ).rejects.toThrow("different workspace");
    expect(createWorktree).toHaveBeenCalledTimes(1);
  });
  it("replays a verified completed receipt after the service restarts", async () => {
    const { scope, git, receipts, createWorktree, runSetup, prepare } = await harness();
    await Effect.runPromise(prepare(input));
    const restarted = await Effect.runPromise(
      makeWorktreePreparation({ scope, git, receipts, createWorktree, runSetup }),
    );
    expect(await Effect.runPromise(restarted(input))).toEqual(result);
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(runSetup).toHaveBeenCalledTimes(1);
  });
  it("replays the pinned checkout when the requested base advances or disappears", async () => {
    const { scope, git, receipts, createWorktree, runSetup, prepare } = await harness();
    await Effect.runPromise(prepare(input));
    for (const tip of ["advanced-base", null]) {
      const restarted = await Effect.runPromise(
        makeWorktreePreparation({
          scope,
          git: { ...git, resolveCommit: () => Effect.succeed(tip) },
          receipts,
          createWorktree,
          runSetup,
        }),
      );
      expect(await Effect.runPromise(restarted(input))).toEqual(result);
    }
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(runSetup).toHaveBeenCalledTimes(1);
  });
  it("replays a running asynchronous setup without launching it again", async () => {
    const { receipts, runSetup, prepare } = await harness();
    await Effect.runPromise(prepare(input));
    const receipt = (await Effect.runPromise(receipts.latest(result.worktree.path)))!;
    await Effect.runPromise(
      receipts.update(receipt, { phase: "setup_running", result: '{"async":true}' }),
    );
    expect(await Effect.runPromise(prepare(input))).toEqual(result);
    expect(runSetup).toHaveBeenCalledTimes(1);
  });
  it("refuses legacy checkout adoption when ignored-file inspection is truncated", async () => {
    const { scope, git, receipts, createWorktree, runSetup } = await harness();
    const prepare = await Effect.runPromise(
      makeWorktreePreparation({
        scope,
        git: {
          ...git,
          inspectCheckout: (path) =>
            git
              .inspectCheckout(path)
              .pipe(Effect.map((inspection) => ({ ...inspection, ignoredTruncated: true }))),
        },
        receipts,
        createWorktree,
        runSetup,
      }),
    );
    await expect(Effect.runPromise(prepare({ ...input, retryAcknowledged: true }))).rejects.toThrow(
      "cannot be verified",
    );
    expect(createWorktree).not.toHaveBeenCalled();
    expect(runSetup).not.toHaveBeenCalled();
    expect(await Effect.runPromise(receipts.latest(result.worktree.path))).toBeNull();
  });
  it("requires explicit acknowledgment after a restart during setup", async () => {
    const { scope, git, receipts, createWorktree, runSetup, prepare } = await harness();
    await Effect.runPromise(prepare(input));
    const receipt = (await Effect.runPromise(receipts.latest(result.worktree.path)))!;
    await Effect.runPromise(receipts.update(receipt, { phase: "setup_running" }));
    await Effect.runPromise(receipts.reconcile);
    const restarted = await Effect.runPromise(
      makeWorktreePreparation({ scope, git, receipts, createWorktree, runSetup }),
    );
    await expect(Effect.runPromise(restarted(input))).rejects.toThrow("external effects");
    expect(createWorktree).toHaveBeenCalledTimes(1);
    await Effect.runPromise(restarted({ ...input, retryAcknowledged: true }));
    expect(runSetup).toHaveBeenCalledTimes(2);
  });
  it("conflicts on changed bases and setup behavior even after completion", async () => {
    const { prepare } = await harness();
    await Effect.runPromise(prepare(input));
    await expect(Effect.runPromise(prepare({ ...input, branch: "other-base" }))).rejects.toThrow(
      "different workspace",
    );
    await expect(Effect.runPromise(prepare({ ...input, runSetupScript: false }))).rejects.toThrow(
      "different workspace",
    );
  });
  it("resumes an allocation interrupted before worktree add on its original path", async () => {
    const { prepare, receipts, createWorktree } = await harness();
    await Effect.runPromise(
      receipts.allocate({
        operationId: "before-add",
        repositoryIdentity: Path.join(projectRoot, ".git"),
        projectIdentity: projectRoot,
        owner: `thread:${input.threadId}`,
        requestedBase: input.branch,
        baseOid: "base-oid",
        path: result.worktree.path,
        branch: input.newBranch,
        namingIntent: "temporary",
        setupIdentity: null,
        runSetupScript: true,
      }),
    );
    expect(await Effect.runPromise(prepare(input))).toEqual(result);
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(createWorktree.mock.calls[0]?.[0]).toMatchObject({
      operationId: "before-add",
      path: result.worktree.path,
    });
  });
});
