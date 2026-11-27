import {
  CommandId,
  type WorkspaceCheckoutIdentity,
  type WorkspaceTransitionSnapshot,
  type WorktreesSwitchWorkspaceInput,
} from "@t3tools/contracts";
import { Deferred, Effect, Fiber } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GitCore } from "../../git/Services/GitCore.ts";
import { canonicalWorktreePath } from "../../git/worktreePaths.ts";
import { git } from "../../storage/storageAutomation.testHarness.ts";
import { WorkspaceWriteContext } from "../workspaceTransitionContext.ts";
import { createWorkspaceTransitionFixture } from "./WorkspaceTransition.testHarness.ts";
import { makeWorkspaceTransition } from "./WorkspaceTransition.ts";

describe("workspace transition execution", { timeout: 60_000 }, () => {
  const fixture = createWorkspaceTransitionFixture();

  it.each(["reserved", "snapshot", "ref", "checkout", "copy", "applied", "committed"])(
    "reconciles an interrupted move after %s",
    async (step) => {
      const f = await fixture();
      await fs.writeFile(path.join(f.repo.root, "README.md"), "snapshot tracked\n");
      await fs.writeFile(path.join(f.repo.root, "loose"), "snapshot loose");
      const before = git(f.repo.root, "status", "--porcelain=v2", "-z");
      const request = await f.request("move_to_new_worktree", { branch: "restart-move" });
      const gitCore = await f.runtime.runPromise(Effect.service(GitCore));
      const source = await f.runtime.runPromise(gitCore.inspectCheckout(f.repo.root));
      const snapshot = await f.runtime.runPromise(gitCore.readMoveSnapshot(f.repo.root));
      const targetPath = await canonicalWorktreePath(
        await f.runtime.runPromise(
          gitCore.allocateWorktreePath({ cwd: f.repo.root, branch: "restart-move" }),
        ),
      );
      const at = new Date().toISOString();
      let record = await f.runtime.runPromise(
        f.store.reserve({
          operationId: request.operationId,
          threadId: f.threadId,
          version: 0,
          intent: request.intent,
          phase: "reserved",
          request,
          requestHash: "restart-fixture",
          source: {
            path: source.canonicalRoot,
            repository: source.commonDir,
            branch: source.branch,
            headSha: source.headSha,
          },
          target: {
            path: targetPath,
            repository: source.commonDir,
            branch: "restart-move",
            headSha: source.headSha,
          },
          observed: null,
          fingerprint: null,
          mutationAttempted: false,
          commandId: `workspace:${request.operationId}`,
          setupOwnerToken: null,
          result: null,
          error: null,
          createdAt: at,
          updatedAt: at,
        }),
      );
      if (step !== "reserved") {
        record = await f.runtime.runPromise(
          f.store.update(record, {
            phase: "applying",
            moveData: {
              snapshot,
              snapshotRef: `refs/f5/moves/${record.operationId}`,
              createdBranch: false,
              createdWorktree: false,
              copyStarted: false,
              discarded: false,
              discardStarted: false,
            },
            move: { copiedFileCount: snapshot.copiedFileCount, discarded: false },
          }),
        );
        if (step !== "snapshot")
          await f.runtime.runPromise(
            gitCore.setMoveRef(
              f.repo.root,
              record.moveData!.snapshotRef!,
              snapshot.trackedStashSha!,
            ),
          );
        if (["checkout", "copy", "applied", "committed"].includes(step)) {
          record = await f.runtime.runPromise(f.store.update(record, { mutationAttempted: true }));
          await f.runtime.runPromise(
            gitCore.createWorktree({
              cwd: f.repo.root,
              path: targetPath,
              branch: snapshot.baseSha,
              newBranch: "restart-move",
              submodules: "none",
              preparation: {
                owner: `thread:${f.threadId}`,
                operationId: `move:${record.operationId}`,
                runSetupScript: true,
              },
            }),
          );
          if (step !== "checkout") {
            await f.runtime.runPromise(
              gitCore.stashApplySha(targetPath, snapshot.trackedStashSha!),
            );
            await f.runtime.runPromise(
              gitCore.copyMoveUntracked(f.repo.root, targetPath, snapshot.untracked),
            );
          }
          if (["applied", "committed"].includes(step))
            record = await f.runtime.runPromise(
              f.store.update(record, { phase: "applied", observed: record.target }),
            );
          if (step === "committed") {
            record = await f.runtime.runPromise(
              f.store.update(record, {
                result: {
                  branch: "restart-move",
                  worktreePath: targetPath,
                  sessionUpdatedAt: null,
                },
              }),
            );
            await f.runtime.runPromise(
              f.engine
                .dispatch({
                  type: "thread.meta.update",
                  commandId: CommandId.makeUnsafe(record.commandId),
                  threadId: f.threadId,
                  branch: "restart-move",
                  worktreePath: targetPath,
                })
                .pipe(
                  Effect.provideService(WorkspaceWriteContext, {
                    expected: request.expected,
                    operationId: record.operationId,
                    version: record.version,
                  }),
                ),
            );
          }
        }
      }
      await f.runtime.runPromise(Effect.scoped(makeWorkspaceTransition));
      const recovered = (await f.runtime.runPromise(f.store.get(record.operationId)))!;
      expect(recovered.phase).toBe(step === "committed" ? "completed" : "failed");
      expect(git(f.repo.root, "status", "--porcelain=v2", "-z")).toBe(before);
      expect(git(f.repo.root, "for-each-ref", "refs/f5/moves")).toBe("");
      expect(
        await fs
          .stat(targetPath)
          .then(() => true)
          .catch(() => false),
      ).toBe(step === "committed");
      expect(git(f.repo.root, "branch", "--list", "restart-move").length > 0).toBe(
        step === "committed",
      );
    },
  );

  it("ends a move whose cleanup fails, keeps the copy and reports it instead of holding the thread", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo.root, "README.md"), "tracked snapshot");
    await fs.writeFile(path.join(f.repo.root, "loose"), "complete copy");
    f.failPhase.current = "applied";
    f.cleanupControl.fail = true;
    await expect(
      f.runtime.runPromise(
        f.transition.moveThread({ threadId: f.threadId, branch: "move-recovery" }),
      ),
      // The caller gets why the move stopped and why it could not be cleaned up.
    ).rejects.toThrow(
      /^crash after applied\. Cleaning up failed \(rollback unavailable\), so \S+ on move-recovery may still be there\. The project folder is unchanged\.$/,
    );
    const record = (await f.runtime.runPromise(f.store.forThread(f.threadId)))!;
    expect(record.phase).toBe("cancelled");
    expect(await f.runtime.runPromise(f.store.forThread(f.threadId, true))).toBeNull();
    // The copy stays for the user; only the private snapshot ref goes.
    expect(git(f.repo.root, "for-each-ref", "refs/f5/moves")).toBe("");
    expect(await fs.readFile(path.join(record.target.path, "loose"), "utf8")).toBe("complete copy");
    expect(await fs.readFile(path.join(f.repo.root, "loose"), "utf8")).toBe("complete copy");
    expect((await thread(f)).worktreePath).toBeNull();
    expect(await notes(f)).toEqual([
      [
        "error",
        `Moving this thread to a new worktree did not finish; it stays in the project folder. Kept ${path.basename(record.target.path)}: it could not be cleaned up (rollback unavailable).`,
      ],
    ]);
    // Nothing has to be resolved before the next attempt.
    f.failPhase.current = null;
    f.cleanupControl.fail = false;
    const moved = await f.runtime.runPromise(
      f.transition.moveThread({ threadId: f.threadId, branch: "move-again" }),
    );
    expect((await thread(f)).worktreePath).toBe(moved.worktreePath);
  });

  it.each([
    { name: "cut off before Git changed", phase: "stopping", mutated: false, via: "startup" },
    { name: "cut off after Git changed", phase: "applying", mutated: true, via: "startup" },
    { name: "found later, after Git changed", phase: "applying", mutated: true, via: "read" },
    { name: "parked by an older version", phase: "needs_recovery", mutated: true, via: "startup" },
    { name: "parked before Git changed", phase: "needs_recovery", mutated: false, via: "read" },
  ] as const)("settles a branch switch $name", async ({ phase, mutated, via }) => {
    const f = await fixture();
    const source = await projectCheckout(f);
    const record = await interrupted(f, {
      intent: "checkout_branch",
      branch: "topic",
      source,
      target: { ...source, branch: "topic" },
      phase,
      mutationAttempted: mutated,
    });
    if (mutated) git(f.repo.root, "checkout", "-qb", "topic");
    else git(f.repo.root, "branch", "topic");
    const settled =
      via === "startup"
        ? await f.runtime
            .runPromise(Effect.scoped(makeWorkspaceTransition))
            .then(() => f.runtime.runPromise(f.store.get(record.operationId)))
        : await f.runtime.runPromise(f.transition.getTransition({ threadId: f.threadId }));
    // Git decides: the thread is on the branch its folder is on, and nothing is held.
    expect(settled?.phase).toBe(mutated ? "completed" : "failed");
    expect((await thread(f)).branch).toBe(mutated ? "topic" : "main");
    expect(await f.runtime.runPromise(f.store.forThread(f.threadId, true))).toBeNull();
    expect(await f.runtime.runPromise(f.store.unsettled)).toEqual([]);
    expect(await notes(f)).toEqual([
      mutated ? ["info", "Switched to topic"] : ["error", "Switching to topic did not finish."],
    ]);
  });

  it.each([
    // The worker recreated the worktree for this thread and was cut off after that.
    { found: "the worktree it restored", restored: true },
    { found: "nothing", restored: false },
    // Something else is at the path. A finished switch would have refused it,
    // so settling must not record it either.
    { found: "a worktree on another branch", restored: false },
    { found: "a worktree it did not create", restored: false },
  ] as const)(
    "settles an interrupted restore by what is at the path: $found",
    async ({ found, restored }) => {
      const f = await fixture();
      const target = path.join(f.config.worktreesDir, "gone");
      git(f.repo.root, "worktree", "add", "-q", "-b", "gone", target, "main");
      await f.runtime.runPromise(
        f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: target })),
      );
      const worktreePath = (await thread(f)).worktreePath!;
      await fs.rm(target, { recursive: true });
      const missing = {
        path: worktreePath,
        repository: (await projectCheckout(f)).repository,
        branch: "gone",
        headSha: null,
      };
      const record = await interrupted(f, {
        intent: "recreate",
        source: missing,
        target: missing,
        phase: "applying",
        mutationAttempted: true,
      });
      if (found === "the worktree it restored")
        await f.runtime.runPromise(
          Effect.gen(function* () {
            yield* (yield* GitCore).ensureWorktree({
              owner: `thread:${f.threadId}`,
              cwd: f.repo.root,
              path: target,
              branch: "gone",
              submodules: "none",
            });
          }),
        );
      else if (found !== "nothing") {
        git(f.repo.root, "worktree", "prune");
        if (found === "a worktree on another branch")
          git(f.repo.root, "worktree", "add", "-q", "-b", "elsewhere", target, "main");
        else git(f.repo.root, "worktree", "add", "-q", target, "gone");
      }
      await f.runtime.runPromise(Effect.scoped(makeWorkspaceTransition));
      expect((await f.runtime.runPromise(f.store.get(record.operationId)))?.phase).toBe(
        restored ? "completed" : "failed",
      );
      // Either way the thread still names its worktree and its branch; the
      // next send restores a missing one.
      expect(await thread(f)).toMatchObject({ worktreePath, branch: "gone" });
      expect(await f.runtime.runPromise(f.store.forThread(f.threadId, true))).toBeNull();
      expect((await notes(f)).at(-1)).toEqual(
        restored
          ? ["info", "Worktree restored on gone"]
          : ["error", "Restoring the worktree did not finish."],
      );
    },
  );

  it("records a branch switch that Git finished even when the commit was refused, and says so", async () => {
    const f = await fixture();
    git(f.repo.root, "branch", "topic");
    // A terminal opens in the folder after the checkout, so the commit is refused.
    f.phaseHook.current = (phase) => {
      if (phase !== "applied") return;
      f.phaseHook.current = null;
      f.world.terminals.push({
        threadId: f.threadId,
        terminalId: "shell",
        cwd: f.repo.root,
        status: "running",
      });
    };
    const result = await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("checkout_branch", { branch: "topic" })),
    );
    // The folder is on the new branch, so the thread is too: the record follows Git.
    expect(git(f.repo.root, "branch", "--show-current")).toBe("topic");
    expect(result.phase).toBe("completed");
    expect((await thread(f)).branch).toBe("topic");
    // The refusal is not lost: the timeline carries it.
    const [tone, summary] = (await notes(f)).at(-1)!;
    expect(tone).toBe("error");
    expect(summary).toMatch(/^Switched to topic, but a later step failed: .*terminal/i);
  });

  it("answers the caller of a switch whose cancel was itself cut off", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "held");
    git(f.repo.root, "worktree", "add", "-q", "-b", "held", target, "main");
    await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: target })),
    );
    await fs.rm(target, { recursive: true });
    f.mutationControl.block = true;
    const caller = f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("recreate")).pipe(Effect.result),
    );
    await f.runtime.runPromise(Deferred.await(f.mutationEntered));
    // The client that asked for the cancel goes away while it is still running.
    const cancelling = f.runtime.runFork(f.transition.cancel(f.threadId));
    await f.runtime.runPromise(Fiber.interrupt(cancelling));
    // The worker left its answer to the cancel; the caller still gets one.
    const answered = await Promise.race([
      caller,
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 5_000)),
    ]);
    expect(answered).not.toBe("waiting");
    // Whatever the answer was, nothing is held: the next switch runs.
    await vi.waitFor(async () =>
      expect(
        (await f.runtime.runPromise(f.transition.getTransition({ threadId: f.threadId })))?.phase,
      ).toMatch(/failed|cancelled/),
    );
    f.mutationControl.block = false;
    const next = await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("use_project_checkout")),
    );
    expect(next.phase).toBe("completed");
  });

  it("reports an interrupted switch once however many readers find it", async () => {
    const f = await fixture();
    const source = await projectCheckout(f);
    await interrupted(f, {
      intent: "checkout_branch",
      branch: "topic",
      source,
      target: { ...source, branch: "topic" },
      phase: "stopping",
      mutationAttempted: false,
    });
    git(f.repo.root, "branch", "topic");
    // Every open window reads the thread's switch at once.
    await Promise.all(
      Array.from({ length: 6 }, () =>
        f.runtime.runPromise(f.transition.getTransition({ threadId: f.threadId })),
      ),
    );
    expect(await notes(f)).toEqual([["error", "Switching to topic did not finish."]]);
  });

  it("leaves the thread where it was when attaching was cut off, and ends a switch whose thread is gone", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "attach");
    git(f.repo.root, "worktree", "add", "-q", "-b", "attach", target, "main");
    const source = await projectCheckout(f);
    const attached = {
      ...source,
      path: await canonicalWorktreePath(target),
      branch: "attach",
    };
    const first = await interrupted(f, {
      intent: "attach_existing",
      targetPath: target,
      source,
      target: attached,
      phase: "applied",
      mutationAttempted: false,
    });
    // Attaching never changes Git: without an accepted metadata write it did not happen.
    expect(
      (await f.runtime.runPromise(f.transition.getTransition({ threadId: f.threadId })))?.phase,
    ).toBe("failed");
    expect((await thread(f)).worktreePath).toBeNull();
    expect(await notes(f)).toEqual([
      ["error", "Switching to attach did not finish; this thread stays where it was."],
    ]);
    expect(first.operationId).not.toBe("");
    // A thread that is archived cannot be settled against; its row still ends.
    const second = await interrupted(f, {
      intent: "attach_existing",
      targetPath: target,
      source,
      target: attached,
      phase: "applying",
      mutationAttempted: false,
    });
    await f.runtime.runPromise(
      f.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("archive-interrupted"),
        threadId: f.threadId,
        createdAt: new Date().toISOString(),
      }),
    );
    await vi.waitFor(async () =>
      expect((await f.runtime.runPromise(f.store.get(second.operationId)))?.phase).toBe(
        "cancelled",
      ),
    );
    expect(await fs.stat(target)).toBeDefined();
  });

  it("never gets stuck when the metadata commit keeps failing after Git changed", async () => {
    const f = await fixture();
    git(f.repo.root, "branch", "topic");
    f.failPhase.current = "completed";
    const request = await f.request("checkout_branch", { branch: "topic" });
    const result = await f.runtime.runPromise(f.transition.switchWorkspace(request));
    // The commit failed again while settling, so the switch ends as not done.
    expect(result.phase).toBe("failed");
    expect((await thread(f)).branch).toBe("main");
    expect(git(f.repo.root, "branch", "--show-current")).toBe("topic");
    expect(await f.runtime.runPromise(f.store.forThread(f.threadId, true))).toBeNull();
    // Nothing is held: the very next switch runs.
    f.failPhase.current = null;
    const back = await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("checkout_branch", { branch: "main" })),
    );
    expect(back.phase).toBe("completed");
    expect(git(f.repo.root, "branch", "--show-current")).toBe("main");
  });
});

type Fixture = Awaited<ReturnType<ReturnType<typeof createWorkspaceTransitionFixture>>>;

const thread = async (f: Fixture) =>
  (await f.runtime.runPromise(f.engine.getReadModel())).threads.find(
    (entry) => entry.id === f.threadId,
  )!;

/** What the timeline says about the workspace, oldest first. */
const notes = async (f: Fixture) =>
  (await thread(f)).activities
    .filter((activity) => activity.kind === "workspace.note")
    .map((activity) => [activity.tone, activity.summary]);

const projectCheckout = async (f: Fixture): Promise<WorkspaceCheckoutIdentity> => ({
  path: await canonicalWorktreePath(f.repo.root),
  // Canonicalize exactly as the transition does; raw Git output differs on Windows
  // (forward slashes, 8.3 short names), which would read as a repository change.
  repository: await canonicalWorktreePath(
    git(f.repo.root, "rev-parse", "--path-format=absolute", "--git-common-dir"),
  ),
  branch: git(f.repo.root, "branch", "--show-current"),
  headSha: git(f.repo.root, "rev-parse", "HEAD"),
});

/** A switch as a crash would leave it: reserved, advanced to `phase`, with no worker. */
async function interrupted(
  f: Fixture,
  input: {
    readonly intent: WorktreesSwitchWorkspaceInput["intent"];
    readonly branch?: string;
    readonly targetPath?: string;
    readonly source: WorkspaceCheckoutIdentity;
    readonly target: WorkspaceCheckoutIdentity;
    readonly phase: WorkspaceTransitionSnapshot["phase"];
    readonly mutationAttempted: boolean;
  },
) {
  const request = await f.request(input.intent, {
    ...(input.branch ? { branch: input.branch } : {}),
    ...(input.targetPath ? { targetPath: input.targetPath } : {}),
  });
  const at = new Date().toISOString();
  const reserved = await f.runtime.runPromise(
    f.store.reserve({
      operationId: request.operationId,
      threadId: f.threadId,
      version: 0,
      intent: request.intent,
      phase: "reserved",
      request,
      requestHash: "interrupted",
      source: input.source,
      target: input.target,
      observed: null,
      fingerprint: null,
      mutationAttempted: false,
      result: null,
      error: null,
      commandId: `workspace:${request.operationId}`,
      setupOwnerToken: null,
      createdAt: at,
      updatedAt: at,
    }),
  );
  return f.runtime.runPromise(
    f.store.update(reserved, { phase: input.phase, mutationAttempted: input.mutationAttempted }),
  );
}
