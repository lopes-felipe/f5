import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { git } from "../../storage/storageAutomation.testHarness.ts";
import { createWorkspaceTransitionFixture } from "./WorkspaceTransition.testHarness.ts";

describe("workspace transition execution", { timeout: 60_000 }, () => {
  const fixture = createWorkspaceTransitionFixture();

  it("joins identical retries, commits once, and never accepts a changed payload", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "topic");
    git(f.repo.root, "worktree", "add", "-q", "-b", "topic", target, "main");
    const input = await f.request("attach_existing", { targetPath: target, branch: "topic" });
    const [one, two] = await Promise.all([
      f.runtime.runPromise(f.transition.switchWorkspace(input)),
      f.runtime.runPromise(f.transition.switchWorkspace(input)),
    ]);
    expect(one.phase).toBe("completed");
    expect(two).toEqual(one);
    expect(await f.runtime.runPromise(f.transition.switchWorkspace(input))).toEqual(one);
    await expect(
      f.runtime.runPromise(f.transition.switchWorkspace({ ...input, branch: "changed" })),
    ).rejects.toThrow(/another request|different/);
    expect((await f.runtime.runPromise(f.engine.getReadModel())).threads[0]?.worktreePath).toBe(
      await fs.realpath(target),
    );
  });

  it("blocks in-place checkout for an idle archived local reference and live terminals", async () => {
    const f = await fixture();
    git(f.repo.root, "branch", "topic");
    const foreign = ThreadId.makeUnsafe("archived");
    await f.create(foreign);
    await f.runtime.runPromise(
      f.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("archive"),
        threadId: foreign,
        createdAt: new Date().toISOString(),
      }),
    );
    const result = await f.runtime.runPromise(
      f.transition.switchWorkspace(
        await f.request("checkout_branch", { branch: "topic", sharedFilesystemConfirmed: true }),
      ),
    );
    expect(result.phase).toBe("failed");
    expect(result.error).toMatch(/references this checkout/);
    expect(git(f.repo.root, "branch", "--show-current")).toBe("main");
  });

  it.each(["checkout_branch", "create_branch_and_checkout"] as const)(
    "refuses %s when the conversation's own terminal is live",
    async (intent) => {
      const f = await fixture();
      if (intent === "checkout_branch") git(f.repo.root, "branch", "topic");
      f.world.terminals.push({
        threadId: f.threadId,
        terminalId: "own-shell",
        cwd: f.repo.root,
        status: "running",
      });
      const result = await f.runtime.runPromise(
        f.transition.switchWorkspace(await f.request(intent, { branch: "topic" })),
      );
      expect(result.phase).toBe("failed");
      expect(result.errorCode).toBe("WorkspaceRequiresNewWorktree");
      expect(git(f.repo.root, "branch", "--show-current")).toBe("main");
    },
  );

  it("requires explicit sharing confirmation and rejects external attachments", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "shared");
    git(f.repo.root, "worktree", "add", "-q", "-b", "shared", target, "main");
    await f.create(ThreadId.makeUnsafe("other"), "shared", target);
    const rejected = await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: target })),
    );
    expect(rejected.phase).toBe("failed");
    expect(rejected.error).toMatch(/sharing/);
    const accepted = await f.runtime.runPromise(
      f.transition.switchWorkspace(
        await f.request("attach_existing", { targetPath: target, sharedFilesystemConfirmed: true }),
      ),
    );
    expect(accepted.phase).toBe("completed");
    const external = path.join(f.repo.root, "..", "external");
    git(f.repo.root, "worktree", "add", "-q", "-b", "external", external, "main");
    await expect(
      f.runtime.runPromise(
        f.transition.switchWorkspace(await f.request("attach_existing", { targetPath: external })),
      ),
    ).rejects.toThrow(/profile/);
  });

  it("creates and checks out a branch atomically, leaving a manual pause alone", async () => {
    const f = await fixture();
    await f.runtime.runPromise(
      f.queue.setPaused({ threadId: f.threadId, paused: true, reasonCode: "manual_pause" }),
    );
    const result = await f.runtime.runPromise(
      f.transition.switchWorkspace(
        await f.request("create_branch_and_checkout", { branch: "created" }),
      ),
    );
    expect(result.error).toBeNull();
    expect(result.phase).toBe("completed");
    expect(git(f.repo.root, "branch", "--show-current")).toBe("created");
    expect(
      (await f.runtime.runPromise(f.queue.listByThread(f.threadId))).state.pauseReasonCode,
    ).toBe("manual_pause");
  });

  describe("restoring the recorded branch of a drifted worktree", () => {
    const drifted = async () => {
      const f = await fixture();
      const target = path.join(f.config.worktreesDir, "recorded");
      git(f.repo.root, "worktree", "add", "-q", "-b", "recorded", target, "main");
      await f.runtime.runPromise(
        f.transition.switchWorkspace(
          await f.request("attach_existing", { targetPath: target, branch: "recorded" }),
        ),
      );
      git(target, "checkout", "-q", "-b", "agent-branch");
      const restore = async () =>
        f.runtime.runPromise(
          f.manager
            .recover({
              threadId: f.threadId,
              action: "restoreRecordedBranch",
              expectedQueueRevision: (await f.runtime.runPromise(f.queue.listByThread(f.threadId)))
                .state.revision,
            })
            .pipe(
              Effect.flip,
              Effect.map((error) => error.message),
              Effect.orElseSucceed(() => null),
            ),
        );
      return { f, target, restore };
    };

    it("checks the branch out under the transition and resumes the paused queue item", async () => {
      const { f, target, restore } = await drifted();
      await fs.writeFile(path.join(target, "scratch.txt"), "wip");
      expect(await restore()).toContain("Commit or stash");
      await fs.rm(path.join(target, "scratch.txt"));
      const at = new Date().toISOString();
      await f.runtime.runPromise(
        f.queue.insertSubmission({
          submissionId: CommandId.makeUnsafe("drift-queued"),
          itemId: CommandId.makeUnsafe("drift-queued"),
          atHead: false,
          requestHash: "drift-queued",
          command: {
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("drift-queued"),
            threadId: f.threadId,
            message: {
              messageId: MessageId.makeUnsafe("drift-queued"),
              role: "user",
              text: "next",
              attachments: [],
            },
            interactionMode: "default",
            runtimeMode: "approval-required",
            createdAt: at,
          },
        }),
      );
      await f.runtime.runPromise(
        f.queue.setPaused({ threadId: f.threadId, paused: true, reasonCode: "worktree_missing" }),
      );
      // The paused message that exposed the drift does not block its own recovery.
      expect(await restore()).toBeNull();
      expect(git(target, "branch", "--show-current")).toBe("recorded");
      const queue = await f.runtime.runPromise(f.queue.listByThread(f.threadId));
      expect(queue.state.paused).toBe(false);
      expect(queue.items).toHaveLength(1);
    });

    it("refuses while another conversation shares the checkout", async () => {
      const { f, target, restore } = await drifted();
      await f.create(ThreadId.makeUnsafe("peer"), "agent-branch", target);
      expect(await restore()).toMatch(/references this checkout/);
      expect(git(target, "branch", "--show-current")).toBe("agent-branch");
    });

    it("refuses while an accepted turn waits for provider delivery", async () => {
      const { f, target, restore } = await drifted();
      await f.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO projection_turns(thread_id,state,requested_at,checkpoint_files_json) VALUES (${f.threadId},'pending','now','[]')`;
        }),
      );
      expect(await restore()).toMatch(/active or pending turn/);
      expect(git(target, "branch", "--show-current")).toBe("agent-branch");
    });

    it("refuses during an in-progress Git operation or on a detached HEAD", async () => {
      const { target, restore } = await drifted();
      // A clean tree can still be mid-operation; switching would abandon its state.
      git(target, "bisect", "start");
      expect(await restore()).toMatch(/bisect in progress/);
      git(target, "bisect", "reset");
      await fs.writeFile(path.join(target, "README.md"), "agent\n");
      git(target, "commit", "-qam", "agent change");
      git(target, "checkout", "-q", "--detach");
      // The detached commit would be unreachable from the recorded branch.
      expect(await restore()).toContain("detached HEAD");
      expect(git(target, "branch", "--show-current")).toBe("");
    });
  });

  it("refuses a live terminal that opens before locked revalidation", async () => {
    const f = await fixture();
    git(f.repo.root, "branch", "topic");
    f.world.terminals.push({
      threadId: f.threadId,
      terminalId: "shell",
      cwd: f.repo.root,
      status: "running",
    });
    const result = await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("checkout_branch", { branch: "topic" })),
    );
    expect(result.phase).toBe("failed");
    expect(git(f.repo.root, "branch", "--show-current")).toBe("main");
  });

  it("preserves an ignored secret when the target branch tracks the same filename", async () => {
    const f = await fixture();
    const target = path.join(f.config.worktreesDir, "env-topic");
    git(f.repo.root, "worktree", "add", "-q", "-b", "env-topic", target, "main");
    await fs.writeFile(path.join(target, ".env"), "branch file");
    git(target, "add", "-f", ".env");
    git(target, "commit", "-qm", "tracked configuration");
    git(target, "checkout", "-qb", "hold-topic");
    await fs.appendFile(path.join(f.repo.root, ".git", "info", "exclude"), "\n.env\n");
    await fs.writeFile(path.join(f.repo.root, ".env"), "local secret");
    const result = await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("checkout_branch", { branch: "env-topic" })),
    );
    expect(result.phase).toBe("failed");
    expect(result.checkoutConflict?.files).toContain(".env");
    expect(await fs.readFile(path.join(f.repo.root, ".env"), "utf8")).toBe("local secret");
    expect(git(f.repo.root, "branch", "--show-current")).toBe("main");
  });

  it("refreshes the recorded branch in the same shared checkout without confirming a new attachment", async () => {
    const f = await fixture();
    await f.create(ThreadId.makeUnsafe("archived-peer"));
    await f.runtime.runPromise(
      f.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("archive-peer"),
        threadId: ThreadId.makeUnsafe("archived-peer"),
        createdAt: new Date().toISOString(),
      }),
    );
    git(f.repo.root, "checkout", "-qb", "changed-outside");
    const result = await f.runtime.runPromise(
      f.transition.switchWorkspace(
        await f.request("attach_existing", { targetPath: f.repo.root, branch: "changed-outside" }),
      ),
    );
    expect(result.phase).toBe("completed");
    expect(result.result?.branch).toBe("changed-outside");
  });

  it("moves to a flat temporary branch when the t3code namespace is occupied", async () => {
    const f = await fixture();
    git(f.repo.root, "branch", "t3code");
    const request = await f.request("move_to_new_worktree");
    const result = await f.runtime.runPromise(f.transition.switchWorkspace(request));
    expect(result.phase).toBe("completed");
    const thread = (await f.runtime.runPromise(f.engine.getReadModel())).threads[0]!;
    expect(thread.branch).toMatch(/^t3code-[0-9a-f]{8}$/);
    expect(git(thread.worktreePath!, "branch", "--show-current").trim()).toBe(thread.branch);
  });

  it.each(["t3code/abcdef12", "t3code-abcdef12", "t3code/12345678-1234-4234-8234-123456789abc"])(
    "reserves temporary branch %s for managed worktrees",
    async (branch) => {
      const f = await fixture();
      const request = await f.request("move_to_new_worktree", { branch });
      await expect(f.runtime.runPromise(f.transition.switchWorkspace(request))).rejects.toThrow(
        "Invalid branch name",
      );
    },
  );
});
