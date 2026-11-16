import { CommandId, EventId, MessageId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import { Deferred, Effect, Fiber } from "effect";
import fsPromises, * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GitCore } from "../../git/Services/GitCore.ts";
import { WorktreePreparations } from "../../persistence/Services/WorktreePreparations.ts";
import { git } from "../../storage/storageAutomation.testHarness.ts";
import { createWorkspaceTransitionFixture } from "./WorkspaceTransition.testHarness.ts";
import { makeWorkspaceTransition } from "./WorkspaceTransition.ts";
import { withWorktreeLifecycleLock } from "./WorktreeLifecycleCoordinator.ts";

describe("workspace transition execution", { timeout: 60_000 }, () => {
  const fixture = createWorkspaceTransitionFixture();

  it("serializes competing move/recovery requests and blocks final turn acceptance without deadlocking", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo.root, "loose"), "copy");
    f.copyControl.block = true;
    const running = f.runtime.runPromise(
      f.transition.moveThread({ threadId: f.threadId, branch: "concurrent-move" }),
    );
    await f.runtime.runPromise(Deferred.await(f.copyEntered));
    const second = f.runtime
      .runPromise(f.transition.moveThread({ threadId: f.threadId, branch: "second-move" }))
      .then(
        () => null,
        (error: Error) => error,
      );
    const request = await f.request("use_project_checkout");
    const recovery = f.runtime.runPromise(f.transition.switchWorkspace(request)).then(
      (result) => result,
      (error: Error) => error,
    );
    const at = new Date().toISOString();
    await expect(
      f.runtime.runPromise(
        f.engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("send-during-move"),
            threadId: f.threadId,
            message: {
              messageId: MessageId.makeUnsafe("move-message"),
              role: "user",
              text: "wait",
              attachments: [],
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt: at,
          })
          .pipe(Effect.timeout("2 seconds")),
      ),
    ).rejects.toThrow(/transition|switch/i);
    await f.runtime.runPromise(Deferred.succeed(f.copyRelease, undefined));
    const moved = await running;
    expect(await second).toBeInstanceOf(Error);
    const recovered = await recovery;
    expect(recovered instanceof Error || recovered.phase === "failed").toBe(true);
    expect((await f.runtime.runPromise(f.engine.getReadModel())).threads[0]?.worktreePath).toBe(
      moved.worktreePath,
    );
    expect(git(f.repo.root, "branch", "--list", "second-move")).toBe("");
  });

  it("keeps copied checkout files when the conversation is archived during a move", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo.root, "loose"), "keep me");
    await fs.writeFile(path.join(f.repo.root, "README.md"), "tracked archive copy");
    f.copyControl.block = true;
    const running = f.runtime
      .runPromise(f.transition.moveThread({ threadId: f.threadId, branch: "archive-move" }))
      .then(
        () => null,
        (error: Error) => error,
      );
    await f.runtime.runPromise(Deferred.await(f.copyEntered));
    await f.runtime.runPromise(
      f.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("archive-move"),
        threadId: f.threadId,
        createdAt: new Date().toISOString(),
      }),
    );
    const result = await running;
    await f.runtime.runPromise(f.transition.cancel(f.threadId));
    expect(result).toBeInstanceOf(Error);
    const record = (await f.runtime.runPromise(f.store.forThread(f.threadId)))!;
    expect(record.phase).toBe("cancelled");
    expect(record.error).toContain("Retained checkout");
    expect(git(f.repo.root, "for-each-ref", "refs/f5/moves")).toBe("");
    // Reproduce a cancelled record left by an older server before ref cleanup.
    const gitCore = await f.runtime.runPromise(Effect.service(GitCore));
    const latest = (await f.runtime.runPromise(f.store.get(record.operationId)))!;
    const ref = `refs/f5/moves/${record.operationId}`;
    await f.runtime.runPromise(
      gitCore.setMoveRef(f.repo.root, ref, latest.moveData!.snapshot.trackedStashSha!),
    );
    await f.runtime.runPromise(
      f.store.update(latest, { moveData: { ...latest.moveData!, snapshotRef: ref } }),
    );
    await f.runtime.runPromise(Effect.scoped(makeWorkspaceTransition));
    expect(git(f.repo.root, "for-each-ref", "refs/f5/moves")).toBe("");
    await f.runtime.runPromise(
      f.engine.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.makeUnsafe("unarchive-move"),
        threadId: f.threadId,
        createdAt: new Date().toISOString(),
      }),
    );
    await f.runtime.runPromise(Effect.scoped(makeWorkspaceTransition));
    expect((await f.runtime.runPromise(f.store.get(record.operationId)))?.phase).toBe("cancelled");
    expect((await f.runtime.runPromise(f.store.get(record.operationId)))?.error).toContain(
      "Retained checkout",
    );
    expect(await fs.readFile(path.join(record.target.path, "loose"), "utf8")).toBe("keep me");
    expect(await fs.readFile(path.join(f.repo.root, "loose"), "utf8")).toBe("keep me");
  });

  it("waits for filesystem copying to settle before cancellation returns", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo.root, "a"), "first");
    await fs.writeFile(path.join(f.repo.root, "b"), "second");
    const core = await f.runtime.runPromise(Effect.service(GitCore));
    const snapshot = await f.runtime.runPromise(core.readMoveSnapshot(f.repo.root));
    const target = path.join(f.repo.dir, "cancel-copy");
    await fs.mkdir(target);
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = fsPromises.copyFile;
    const spy = vi.spyOn(fsPromises, "copyFile").mockImplementationOnce(async (...args) => {
      await original(...args);
      entered();
      await releasePromise;
    });
    const copying = Effect.runFork(core.copyMoveUntracked(f.repo.root, target, snapshot.untracked));
    try {
      await enteredPromise;
      let interrupted = false;
      const cancellation = Effect.runPromise(Fiber.interrupt(copying)).then(() => {
        interrupted = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(interrupted).toBe(false);
      release();
      await cancellation;
      expect(await fs.readFile(path.join(target, "b"), "utf8")).toBe("second");
    } finally {
      release();
      await Effect.runPromise(Fiber.interrupt(copying));
      spy.mockRestore();
    }
  });

  it("recreates the recorded checkout, prepares outside locks, and resumes only a missing-worktree pause", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "recovery");
    git(f.repo.root, "worktree", "add", "-q", "-b", "recovery", target, "main");
    await f.runtime.runPromise(
      f.transition.switchWorkspace(
        await f.request("attach_existing", { targetPath: target, branch: "recovery" }),
      ),
    );
    await fs.rm(target, { recursive: true });
    await f.runtime.runPromise(
      f.queue.setPaused({ threadId: f.threadId, paused: true, reasonCode: "worktree_missing" }),
    );
    const before = await f.runtime.runPromise(f.queue.listByThread(f.threadId));
    const recovered = await f.runtime.runPromise(
      f.manager.recover({
        threadId: f.threadId,
        expectedQueueRevision: before.state.revision,
        action: "recreate",
      }),
    );
    expect(recovered.registration).toBe("matching");
    expect(f.preparations).toContain(await fs.realpath(target));
    expect((await f.runtime.runPromise(f.queue.listByThread(f.threadId))).state.paused).toBe(false);
    await fs.rm(target, { recursive: true });
    await f.runtime.runPromise(
      f.queue.setPaused({ threadId: f.threadId, paused: true, reasonCode: "manual_pause" }),
    );
    const result = await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("recreate_from_base")),
    );
    expect(result.phase).toBe("completed");
    expect(result.target.path).toBe(await fs.realpath(target));
    expect(result.target.branch).not.toBe("recovery");
    expect(
      (await f.runtime.runPromise(f.queue.listByThread(f.threadId))).state.pauseReasonCode,
    ).toBe("manual_pause");
  });

  it("holds a preparation failure independently of queue resume and never repeats its Git step", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "retry");
    git(f.repo.root, "worktree", "add", "-q", "-b", "retry", target, "main");
    await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: target })),
    );
    await fs.rm(target, { recursive: true });
    f.preparationControl.fail = true;
    const request = await f.request("recreate");
    const result = await f.runtime.runPromise(f.transition.switchWorkspace(request));
    expect(result.phase).toBe("needs_recovery");
    await f.runtime.runPromise(f.queue.setPaused({ threadId: f.threadId, paused: false }));
    expect((await f.runtime.runPromise(f.store.forThread(f.threadId, true)))?.operationId).toBe(
      request.operationId,
    );
    expect(await f.runtime.runPromise(f.transition.switchWorkspace(request))).toEqual(result);
    expect(f.preparations).toHaveLength(1);
    const preview = await f.runtime.runPromise(
      f.transition.previewRecovery({ operationId: request.operationId }),
    );
    await expect(
      f.runtime.runPromise(
        f.transition.resolve({
          operationId: request.operationId,
          version: preview.transition.version,
          acceptanceToken: preview.acceptanceToken,
          action: "retry",
        }),
      ),
    ).rejects.toThrow(/partial/);
  });

  it("allows archive to interrupt preparation, settle its caller, and retain checkout files", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "cancel");
    git(f.repo.root, "worktree", "add", "-q", "-b", "cancel", target, "main");
    await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: target })),
    );
    await fs.rm(target, { recursive: true });
    f.preparationControl.block = true;
    const request = await f.request("recreate");
    const running = f.runtime.runPromise(f.transition.switchWorkspace(request));
    await f.runtime.runPromise(Deferred.await(f.preparationEntered));
    await f.runtime.runPromise(
      f.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("archive-active-transition"),
        threadId: f.threadId,
        createdAt: new Date().toISOString(),
      }),
    );
    expect((await running).phase).toBe("cancelled");
    expect((await f.runtime.runPromise(f.store.get(request.operationId)))?.phase).toBe("cancelled");
    expect(await fs.stat(target)).toBeDefined();
  });

  it("times out waiting for the stopped session projection without holding checkout locks", async () => {
    const f = await fixture();
    git(f.repo.root, "branch", "topic");
    const at = new Date().toISOString();
    await f.runtime.runPromise(
      f.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("idle-session"),
        threadId: f.threadId,
        session: {
          threadId: f.threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: at,
        },
        createdAt: at,
      }),
    );
    const request = await f.request("checkout_branch", { branch: "topic" });
    const running = f.runtime.runPromise(f.transition.switchWorkspace(request));
    await f.runtime.runPromise(Deferred.await(f.stoppingEntered));
    expect((await f.runtime.runPromise(f.store.get(request.operationId)))?.phase).toBe("stopping");
    await f.runtime.runPromise(
      withWorktreeLifecycleLock(f.repo.root, Effect.void).pipe(Effect.timeout("1 second")),
    );
    const result = await running;
    expect(result.phase).toBe("failed");
    expect(git(f.repo.root, "branch", "--show-current")).toBe("main");
  });

  for (const intent of ["recreate", "recreate_from_base"] as const) {
    it.each(["failure", "cancel"] as const)(
      `can leave a missing checkout after ${intent} %s without repeating Git`,
      async (outcome) => {
        const f = await fixture();
        const target = path.join(f.config.worktreesDir, "missing");
        git(f.repo.root, "worktree", "add", "-q", "-b", "missing", target, "main");
        await f.runtime.runPromise(
          f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: target })),
        );
        await fs.rm(target, { recursive: true });
        await f.runtime.runPromise(
          f.queue.setPaused({ threadId: f.threadId, paused: true, reasonCode: "worktree_missing" }),
        );
        f.mutationControl.fail = outcome === "failure";
        f.mutationControl.block = outcome === "cancel";
        const request = await f.request(intent);
        const running = f.runtime.runPromise(f.transition.switchWorkspace(request));
        await f.runtime.runPromise(Deferred.await(f.mutationEntered));
        if (outcome === "cancel") await f.runtime.runPromise(f.transition.cancel(f.threadId, true));
        expect((await running).phase).toBe("needs_recovery");
        const preview = await f.runtime.runPromise(
          f.transition.previewRecovery({ operationId: request.operationId }),
        );
        expect(preview.actual).toBeNull();
        expect(preview.original).toBeNull();
        expect(preview.canRetry).toBe(false);
        const resolved = await f.runtime.runPromise(
          f.transition.resolve({
            operationId: request.operationId,
            version: preview.transition.version,
            acceptanceToken: preview.acceptanceToken,
            action: "use_project_checkout",
          }),
        );
        expect(resolved.phase).toBe("completed");
        expect(resolved.result?.worktreePath).toBeNull();
        expect((await f.runtime.runPromise(f.queue.listByThread(f.threadId))).state.paused).toBe(
          false,
        );
        expect(
          await fs.stat(target).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
      },
    );
    it(`${intent} does not claim a Git mutation when applying fails before its first mutating call`, async () => {
      const f = await fixture();
      const target = path.join(f.config.worktreesDir, "preflight");
      git(f.repo.root, "worktree", "add", "-q", "-b", "preflight", target, "main");
      await f.runtime.runPromise(
        f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: target })),
      );
      await fs.rm(target, { recursive: true });
      f.failPhase.current = "applying";
      const result = await f.runtime.runPromise(
        f.transition.switchWorkspace(await f.request(intent)),
      );
      expect(result.phase).toBe("failed");
      expect((await f.runtime.runPromise(f.store.get(result.operationId)))?.mutationAttempted).toBe(
        false,
      );
      expect(await f.runtime.runPromise(f.store.forThread(f.threadId, true))).toBeNull();
    });
  }

  it("finishes a recovered Work locally handoff with a real setup token and replays the setup action", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "handoff");
    git(f.repo.root, "worktree", "add", "-q", "-b", "handoff", target, "main");
    await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: target })),
    );
    const at = new Date().toISOString();
    const operationId = "setup-handoff";
    const itemId = CommandId.makeUnsafe("setup-first-turn");
    const snapshot: WorktreeSetupSnapshot = {
      threadId: f.threadId,
      operationId,
      itemId,
      phase: "failed",
      startedAt: at,
      endedAt: at,
      request: {
        projectCwd: f.repo.root,
        baseBranch: "main",
        branch: "handoff",
        requireWorktree: true,
        runSetupScript: true,
      },
      baseRef: "main",
      baseSha: git(f.repo.root, "rev-parse", "HEAD"),
      worktreePath: target,
      createdBranch: false,
      createdWorktree: false,
      setupScript: null,
      agentStarted: false,
      stages: [],
      error: "setup failed",
      generation: 0,
      sequence: 1,
    };
    await f.runtime.runPromise(
      f.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("seed-setup"),
        threadId: f.threadId,
        activity: {
          id: EventId.makeUnsafe(`worktree-setup:${f.threadId}`),
          kind: "worktree-setup",
          tone: "error",
          summary: "Failed setup",
          payload: snapshot,
          turnId: null,
          createdAt: at,
        },
        createdAt: at,
      }),
    );
    await f.runtime.runPromise(
      f.queue.insertSubmission({
        submissionId: itemId,
        itemId,
        atHead: true,
        requestHash: "setup",
        worktreeBlockToken: operationId,
        command: {
          type: "thread.turn.start",
          commandId: itemId,
          threadId: f.threadId,
          message: {
            messageId: MessageId.makeUnsafe("message"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: "default",
          runtimeMode: "approval-required",
          createdAt: at,
        },
      }),
    );
    await f.runtime.runPromise(
      f.queue.setPaused({
        threadId: f.threadId,
        paused: true,
        reasonCode: "worktree_setup_failed",
      }),
    );
    f.failPhase.current = "completed";
    await expect(
      f.runtime.runPromise(f.setupService.workLocally(f.threadId, operationId)),
    ).rejects.toThrow();
    expect(
      (await f.runtime.runPromise(f.queue.listByThread(f.threadId))).state.worktreeBlockToken,
    ).toBe(operationId);
    f.failPhase.current = null;
    const transitionId = `work-locally:${operationId}`;
    const preview = await f.runtime.runPromise(
      f.transition.previewRecovery({ operationId: transitionId }),
    );
    const result = await f.runtime.runPromise(
      f.transition.resolve({
        operationId: transitionId,
        version: preview.transition.version,
        acceptanceToken: preview.acceptanceToken,
        action: "accept_inspected_workspace",
      }),
    );
    expect(result.phase).toBe("completed");
    expect((await f.runtime.runPromise(f.queue.listByThread(f.threadId))).state).toMatchObject({
      worktreeBlockToken: null,
      paused: false,
    });
    const settled = await f.runtime.runPromise(f.setupService.workLocally(f.threadId, operationId));
    expect(settled?.phase).toBe("cancelled_kept");
    expect(await fs.stat(target)).toBeTruthy();
    expect(await f.runtime.runPromise(f.setupService.workLocally(f.threadId, operationId))).toEqual(
      settled,
    );
  });

  it("retries indeterminate async preparation after its old setup token was cleared, preserving the existing setup pause", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "async-restart");
    await f.runtime.runPromise(
      Effect.gen(function* () {
        const gitCore = yield* GitCore;
        const receipts = yield* WorktreePreparations;
        yield* gitCore.createWorktree({
          cwd: f.repo.root,
          branch: "main",
          newBranch: "async-restart",
          path: target,
          preparation: { owner: "workflow:async", runSetupScript: true },
        });
        const receipt = (yield* gitCore.readWorktreePreparation(target))!;
        yield* receipts.update(receipt, { phase: "setup_running", result: '{"async":true}' });
        yield* receipts.reconcile;
      }),
    );
    await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: target })),
    );
    await f.runtime.runPromise(
      f.queue.setPaused({
        threadId: f.threadId,
        paused: true,
        reasonCode: "worktree_setup_failed",
      }),
    );
    expect(
      (await f.runtime.runPromise(f.manager.threadState({ threadId: f.threadId }))).recovery,
    ).toBe("interrupted");
    const queue = await f.runtime.runPromise(f.queue.listByThread(f.threadId));
    const state = await f.runtime.runPromise(
      f.manager.recover({
        threadId: f.threadId,
        action: "recreate",
        expectedQueueRevision: queue.state.revision,
      }),
    );
    expect(state.recovery).toBe("none");
    expect(
      (await f.runtime.runPromise(f.queue.listByThread(f.threadId))).state.pauseReasonCode,
    ).toBe("worktree_setup_failed");
  });
});
