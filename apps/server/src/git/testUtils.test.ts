import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { type ExecuteGitInput, type GitServiceShape } from "./Services/GitService.ts";
import { makeLocalPushFriendlyGitService } from "./testUtils.ts";

function makeRecordingService(resolve?: (input: ExecuteGitInput) => string): {
  readonly service: GitServiceShape;
  readonly calls: ExecuteGitInput[];
} {
  const calls: ExecuteGitInput[] = [];
  return {
    calls,
    service: {
      execute: (input) => {
        calls.push(input);
        return Effect.succeed({
          code: 0,
          stdout: resolve?.(input) ?? "",
          stderr: "",
        });
      },
    },
  };
}

describe("makeLocalPushFriendlyGitService", () => {
  it("delegates non-push commands without modification", async () => {
    const base = makeRecordingService(() => "main\n");
    const service = makeLocalPushFriendlyGitService(base.service);
    const input = { operation: "test", cwd: "/repo", args: ["branch", "--show-current"] };

    const result = await Effect.runPromise(service.execute(input));

    expect(result.stdout).toBe("main\n");
    expect(base.calls).toEqual([input]);
  });

  it("materializes local pushes without delegating a push process", async () => {
    const base = makeRecordingService((input) => {
      if (input.args.join(" ") === "branch --show-current") return "feature/test\n";
      if (input.args.join(" ") === "remote get-url origin") return "/remote.git\n";
      if (input.args.join(" ") === "rev-parse HEAD") return "abc123\n";
      return "";
    });
    const service = makeLocalPushFriendlyGitService(base.service);

    await Effect.runPromise(
      service.execute({
        operation: "test",
        cwd: "/repo",
        args: ["push", "--set-upstream", "origin", "HEAD:feature/test"],
      }),
    );

    expect(base.calls.some((call) => call.args[0] === "push")).toBe(false);
    expect(base.calls.map((call) => [call.cwd, call.args])).toContainEqual([
      "/remote.git",
      ["fetch", "/repo", "abc123:refs/heads/feature/test"],
    ]);
    expect(base.calls.map((call) => call.args)).toContainEqual([
      "update-ref",
      "refs/remotes/origin/feature/test",
      "abc123",
    ]);
    expect(base.calls.map((call) => call.args)).toContainEqual([
      "branch",
      "--set-upstream-to",
      "origin/feature/test",
      "feature/test",
    ]);
  });

  it("deletes local remote branches without resolving HEAD", async () => {
    const base = makeRecordingService((input) => {
      if (input.args.join(" ") === "branch --show-current") return "main\n";
      if (input.args.join(" ") === "remote get-url origin") return "/remote.git\n";
      return "";
    });
    const service = makeLocalPushFriendlyGitService(base.service);

    await Effect.runPromise(
      service.execute({
        operation: "test",
        cwd: "/repo",
        args: ["push", "origin", ":obsolete"],
      }),
    );

    expect(base.calls.some((call) => call.args[0] === "push")).toBe(false);
    expect(base.calls.some((call) => call.args[0] === "rev-parse")).toBe(false);
    expect(base.calls.map((call) => [call.cwd, call.args])).toContainEqual([
      "/remote.git",
      ["update-ref", "-d", "refs/heads/obsolete"],
    ]);
    expect(base.calls.map((call) => [call.cwd, call.args])).toContainEqual([
      "/repo",
      ["update-ref", "-d", "refs/remotes/origin/obsolete"],
    ]);
  });
});
