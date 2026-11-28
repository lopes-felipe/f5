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

  it("switches the project folder in place past idle and archived local references", async () => {
    const f = await fixture();
    git(f.repo.root, "branch", "topic");
    await f.create(ThreadId.makeUnsafe("idle"));
    const archived = ThreadId.makeUnsafe("archived");
    await f.create(archived);
    await f.runtime.runPromise(
      f.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("archive"),
        threadId: archived,
        createdAt: new Date().toISOString(),
      }),
    );
    const result = await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("checkout_branch", { branch: "topic" })),
    );
    expect(result.error).toBeNull();
    expect(result.phase).toBe("completed");
    expect(git(f.repo.root, "branch", "--show-current")).toBe("topic");
  });

  it("refuses an in-place switch of the project folder while another local thread has queued work, naming it", async () => {
    const f = await fixture();
    git(f.repo.root, "branch", "topic");
    const busy = ThreadId.makeUnsafe("busy");
    await f.create(busy);
    await f.runtime.runPromise(
      f.queue.insertSubmission({
        submissionId: CommandId.makeUnsafe("busy-queued"),
        itemId: CommandId.makeUnsafe("busy-queued"),
        atHead: false,
        requestHash: "busy-queued",
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("busy-queued"),
          threadId: busy,
          message: {
            messageId: MessageId.makeUnsafe("busy-queued"),
            role: "user",
            text: "next",
            attachments: [],
          },
          interactionMode: "default",
          runtimeMode: "approval-required",
          createdAt: new Date().toISOString(),
        },
      }),
    );
    const result = await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("checkout_branch", { branch: "topic" })),
    );
    expect(result.phase).toBe("failed");
    expect(result.errorCode).toBe("WorkspaceRequiresNewWorktree");
    expect(result.error).toBe("In use by Thread (queued messages). Start a new worktree instead.");
    expect(git(f.repo.root, "branch", "--show-current")).toBe("main");
  });

  it("refuses an in-place switch of the project folder while another local thread's turn start is pending", async () => {
    const f = await fixture();
    git(f.repo.root, "branch", "topic");
    const busy = ThreadId.makeUnsafe("busy");
    await f.create(busy);
    await f.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_turns(thread_id,pending_message_id,state,requested_at,checkpoint_files_json) VALUES (${busy},'busy-message','pending','now','[]')`;
      }),
    );
    const result = await f.runtime.runPromise(
      f.transition.switchWorkspace(await f.request("checkout_branch", { branch: "topic" })),
    );
    expect(result.phase).toBe("failed");
    expect(result.error).toBe("In use by Thread (running turn). Start a new worktree instead.");
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

  describe("switching the branch of a worktree the agent already moved", () => {
    // The thread still records `recorded`; its folder is on `agent-branch`.
    const moved = async () => {
      const f = await fixture();
      const target = path.join(f.config.worktreesDir, "recorded");
      git(f.repo.root, "worktree", "add", "-q", "-b", "recorded", target, "main");
      await f.runtime.runPromise(
        f.transition.switchWorkspace(
          await f.request("attach_existing", { targetPath: target, branch: "recorded" }),
        ),
      );
      git(target, "checkout", "-q", "-b", "agent-branch");
      const switchBack = async () =>
        f.runtime.runPromise(
          f.transition.switchWorkspace(await f.request("checkout_branch", { branch: "recorded" })),
        );
      return { f, target, switchBack };
    };

    it("switches in place while an idle thread shares the worktree", async () => {
      const { f, target, switchBack } = await moved();
      await f.create(ThreadId.makeUnsafe("peer"), "agent-branch", target);
      // Only live use blocks: the idle peer follows whatever branch the folder is on.
      const result = await switchBack();
      expect(result.error).toBeNull();
      expect(result.phase).toBe("completed");
      expect(git(target, "branch", "--show-current")).toBe("recorded");
      // The peer is re-recorded with the switch itself, before any status read:
      // a later restore of a removed folder must not bring back the old branch.
      const peer = (await f.runtime.runPromise(f.engine.getReadModel())).threads.find(
        (thread) => thread.id === "peer",
      );
      expect(peer?.branch).toBe("recorded");
    });

    it("refuses while an accepted turn waits for provider delivery", async () => {
      const { f, target, switchBack } = await moved();
      await f.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO projection_turns(thread_id,state,requested_at,checkpoint_files_json) VALUES (${f.threadId},'pending','now','[]')`;
        }),
      );
      await expect(switchBack()).rejects.toThrow(/active or pending turn/);
      expect(git(target, "branch", "--show-current")).toBe("agent-branch");
    });

    it("refuses from a detached HEAD, whose commits a checkout would leave unreachable", async () => {
      const { target, switchBack } = await moved();
      await fs.writeFile(path.join(target, "README.md"), "agent\n");
      git(target, "commit", "-qam", "agent change");
      git(target, "checkout", "-q", "--detach");
      const result = await switchBack();
      expect(result.phase).toBe("failed");
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

  it("moves to a placeholder branch named from the thread", async () => {
    const f = await fixture();
    const request = await f.request("move_to_new_worktree");
    const result = await f.runtime.runPromise(f.transition.switchWorkspace(request));
    expect(result.phase).toBe("completed");
    const thread = (await f.runtime.runPromise(f.engine.getReadModel())).threads[0]!;
    expect(thread.branch).toMatch(/^f5\/wip\/[a-z0-9][a-z0-9-]*$/);
    expect(git(thread.worktreePath!, "branch", "--show-current").trim()).toBe(thread.branch);
  });

  it("takes the next free placeholder name when one is taken", async () => {
    const first = await fixture();
    const request = await first.request("move_to_new_worktree");
    const model = await first.runtime.runPromise(first.engine.getReadModel());
    const thread = model.threads[0]!;
    const taken = `f5/wip/${(thread.title || "new thread")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")}`;
    git(first.repo.root, "branch", taken);
    const result = await first.runtime.runPromise(first.transition.switchWorkspace(request));
    expect(result.phase).toBe("completed");
    const moved = (await first.runtime.runPromise(first.engine.getReadModel())).threads[0]!;
    expect(moved.branch).not.toBe(taken);
    expect(moved.branch).toMatch(/^f5\/wip\/.+-1$/);
  });

  it.each([
    "t3code/abcdef12",
    "t3code-abcdef12",
    "t3code/12345678-1234-4234-8234-123456789abc",
    "f5/wip/foo",
    "F5/wip/foo-2",
  ])("reserves placeholder branch %s for managed worktrees", async (branch) => {
    const f = await fixture();
    const request = await f.request("move_to_new_worktree", { branch });
    await expect(f.runtime.runPromise(f.transition.switchWorkspace(request))).rejects.toThrow(
      "wip/ is reserved for F5 placeholder branches",
    );
  });
});
