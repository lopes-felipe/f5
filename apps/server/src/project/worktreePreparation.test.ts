import { ThreadId, type GitPrepareWorktreeInput } from "@t3tools/contracts";
import { Effect, Exit, Fiber, Scope } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectSetupScriptRunnerShape } from "./Services/ProjectSetupScriptRunner.ts";
import { makeWorktreePreparation } from "./worktreePreparation.ts";

const input: GitPrepareWorktreeInput = {
  cwd: "/repo/old-worktree",
  projectCwd: "/repo",
  threadId: ThreadId.makeUnsafe("draft-1"),
  branch: "origin/feature",
  newBranch: "t3code/12345678",
};
const result = { worktree: { branch: input.newBranch, path: "/repo/new-worktree" } };
const scopes: Scope.Closeable[] = [];
afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void));
});

async function harness() {
  const scope = await Effect.runPromise(Scope.make());
  scopes.push(scope);
  const createWorktree = vi.fn(() => Effect.succeed(result));
  const runSetup = vi.fn<ProjectSetupScriptRunnerShape["runForThread"]>(() =>
    Effect.succeed({ status: "no-script" } as const),
  );
  const prepare = await Effect.runPromise(
    makeWorktreePreparation({ scope, createWorktree, runSetup }),
  );
  return { scope, createWorktree, runSetup, prepare };
}

describe("worktree preparation", () => {
  it("launches project setup in the prepared cwd for draft and established threads", async () => {
    const { prepare, runSetup } = await harness();
    for (const threadId of [input.threadId, ThreadId.makeUnsafe("server-1")]) {
      await Effect.runPromise(prepare({ ...input, threadId, newBranch: `t3code/${threadId}` }));
      expect(runSetup).toHaveBeenLastCalledWith({
        threadId,
        projectCwd: "/repo",
        worktreePath: result.worktree.path,
        preferredTerminalId: `setup-t3code-${threadId}`,
      });
    }
  });

  it("coalesces slow creation and replays completion without duplicate setup", async () => {
    const { prepare, createWorktree, runSetup } = await harness();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    createWorktree.mockImplementation(() => Effect.promise(() => held).pipe(Effect.as(result)));
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
    createWorktree.mockImplementation(() => Effect.promise(() => held).pipe(Effect.as(result)));
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
});
