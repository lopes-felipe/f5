import { CommandId } from "@t3tools/contracts";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
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

  it.each([
    "accept_inspected_workspace",
    "keep_original_workspace",
    "use_project_checkout",
  ] as const)("cleans up move recovery for %s immediately", async (action) => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo.root, "README.md"), "tracked snapshot");
    await fs.writeFile(path.join(f.repo.root, "loose"), "complete copy");
    f.failPhase.current = "applied";
    f.cleanupControl.fail = true;
    await expect(
      f.runtime.runPromise(
        f.transition.moveThread({ threadId: f.threadId, branch: "move-recovery" }),
      ),
    ).rejects.toThrow();
    let record = (await f.runtime.runPromise(f.store.forThread(f.threadId)))!;
    expect(record.phase).toBe("needs_recovery");
    expect(git(f.repo.root, "for-each-ref", "refs/f5/moves")).not.toBe("");
    f.failPhase.current = null;
    f.cleanupControl.fail = false;
    const preview = await f.runtime.runPromise(
      f.transition.previewRecovery({ operationId: record.operationId }),
    );
    const resolved = await f.runtime.runPromise(
      f.transition.resolve({
        operationId: record.operationId,
        version: preview.transition.version,
        acceptanceToken: preview.acceptanceToken,
        action,
      }),
    );
    expect(resolved.phase).toBe("completed");
    expect(git(f.repo.root, "for-each-ref", "refs/f5/moves")).toBe("");
    expect(
      await fs
        .stat(record.target.path)
        .then(() => true)
        .catch(() => false),
    ).toBe(action === "accept_inspected_workspace");
    expect(git(f.repo.root, "branch", "--list", "move-recovery").length > 0).toBe(
      action === "accept_inspected_workspace",
    );
    expect(await fs.readFile(path.join(f.repo.root, "loose"), "utf8")).toBe("complete copy");
  });

  it("recovers a partial Git outcome only after preview and rejects stale acceptance tokens", async () => {
    const f = await fixture();
    const request = await f.request("checkout_branch", { branch: "topic" });
    // Canonicalize exactly as the transition does; raw Git output differs on Windows
    // (forward slashes, 8.3 short names), which would read as a repository change.
    const repository = await canonicalWorktreePath(
      git(f.repo.root, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    );
    const source = {
      path: await canonicalWorktreePath(f.repo.root),
      repository,
      branch: "main",
      headSha: git(f.repo.root, "rev-parse", "HEAD"),
    };
    const record = await f.runtime.runPromise(
      f.store.reserve({
        operationId: request.operationId,
        threadId: f.threadId,
        version: 0,
        intent: request.intent,
        phase: "reserved",
        request,
        requestHash: "crashed",
        source,
        target: { ...source, branch: "topic" },
        observed: null,
        fingerprint: null,
        mutationAttempted: false,
        result: null,
        error: null,
        commandId: `workspace:${request.operationId}`,
        setupOwnerToken: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    await f.runtime.runPromise(
      f.store.update(record, { phase: "applying", mutationAttempted: true }),
    );
    git(f.repo.root, "checkout", "-qb", "topic");
    await f.runtime.runPromise(f.store.reconcile);
    const preview = await f.runtime.runPromise(
      f.transition.previewRecovery({ operationId: record.operationId }),
    );
    await fs.writeFile(path.join(f.repo.root, "changed.txt"), "retained");
    await expect(
      f.runtime.runPromise(
        f.transition.resolve({
          operationId: record.operationId,
          version: preview.transition.version,
          acceptanceToken: preview.acceptanceToken,
          action: "accept_inspected_workspace",
        }),
      ),
    ).rejects.toThrow(/changed/);
    const fresh = await f.runtime.runPromise(
      f.transition.previewRecovery({ operationId: record.operationId }),
    );
    await expect(
      f.runtime.runPromise(
        f.transition.resolve({
          operationId: record.operationId,
          version: fresh.transition.version,
          acceptanceToken: fresh.acceptanceToken,
          action: "retry",
        }),
      ),
    ).rejects.toThrow(/partial/);
    const result = await f.runtime.runPromise(
      f.transition.resolve({
        operationId: record.operationId,
        version: fresh.transition.version,
        acceptanceToken: fresh.acceptanceToken,
        action: "accept_inspected_workspace",
      }),
    );
    expect(result.phase).toBe("completed");
    expect(await fs.readFile(path.join(f.repo.root, "changed.txt"), "utf8")).toBe("retained");
  });

  it("rolls back the metadata transaction if completion persistence fails after Git, then accepts the inspected checkout", async () => {
    const f = await fixture();
    git(f.repo.root, "branch", "topic");
    f.failPhase.current = "completed";
    const request = await f.request("checkout_branch", { branch: "topic" });
    const result = await f.runtime.runPromise(f.transition.switchWorkspace(request));
    expect(result.phase).toBe("needs_recovery");
    expect((await f.runtime.runPromise(f.engine.getReadModel())).threads[0]?.branch).toBe("main");
    expect(git(f.repo.root, "branch", "--show-current")).toBe("topic");
    f.failPhase.current = null;
    const preview = await f.runtime.runPromise(
      f.transition.previewRecovery({ operationId: request.operationId }),
    );
    const accepted = await f.runtime.runPromise(
      f.transition.resolve({
        operationId: request.operationId,
        version: preview.transition.version,
        acceptanceToken: preview.acceptanceToken,
        action: "accept_inspected_workspace",
      }),
    );
    expect(accepted.phase).toBe("completed");
  });

  it.each(["dirty.txt", "untracked/nested.txt", "ignored/nested.txt"])(
    "rejects a preview after contents change in %s",
    async (relative) => {
      const f = await fixture();
      git(f.repo.root, "branch", "topic");
      f.failPhase.current = "applied";
      const result = await f.runtime.runPromise(
        f.transition.switchWorkspace(await f.request("checkout_branch", { branch: "topic" })),
      );
      expect(result.phase).toBe("needs_recovery");
      f.failPhase.current = null;
      const file = path.join(f.repo.root, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      if (relative.startsWith("ignored/"))
        await fs.appendFile(path.join(f.repo.root, ".git", "info", "exclude"), "\nignored/\n");
      await fs.writeFile(file, "first");
      const preview = await f.runtime.runPromise(
        f.transition.previewRecovery({ operationId: result.operationId }),
      );
      await fs.writeFile(file, "changed contents");
      await expect(
        f.runtime.runPromise(
          f.transition.resolve({
            operationId: result.operationId,
            version: preview.transition.version,
            acceptanceToken: preview.acceptanceToken,
            action: "accept_inspected_workspace",
          }),
        ),
      ).rejects.toThrow(/changed/);
    },
  );
});
