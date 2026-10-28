import { describe, expect, it } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path } from "effect";
import { claudeToolSearchOverride, resolveClaudeToolSearchOverride } from "./claudeToolSearch";

describe("Claude tool search", () => {
  it.each(["auto", "auto:50", "auto:invalid", "auto:1e1", "auto:0.5e1", "auto:1.5e0"])(
    "enables deferred schemas for %s",
    (value) => expect(claudeToolSearchOverride(value)).toBe("true"),
  );
  it.each([
    undefined,
    "false",
    "true",
    "auto:0",
    "auto:100",
    "auto:-1",
    "auto:101",
    "auto:1_000",
    "auto:1e2",
  ])("preserves explicit endpoints %s", (value) =>
    expect(claudeToolSearchOverride(value)).toBeUndefined(),
  );

  it("uses local, project, user and process precedence, including worktrees", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const checkout = path.join(root, "checkout");
        const worktree = path.join(root, "worktree");
        const configDirectory = path.join(root, "home");
        const gitDir = path.join(checkout, ".git", "worktrees", "topic");
        yield* fs.makeDirectory(gitDir, { recursive: true });
        yield* fs.makeDirectory(path.join(checkout, ".claude"));
        yield* fs.makeDirectory(path.join(worktree, ".claude"), { recursive: true });
        yield* fs.makeDirectory(configDirectory);
        yield* fs.writeFileString(path.join(worktree, ".git"), "gitdir: " + gitDir);
        yield* fs.writeFileString(path.join(gitDir, "commondir"), "../..");
        const resolve = resolveClaudeToolSearchOverride({
          cwd: worktree,
          configDirectory,
          homeDirectory: root,
          platform: "darwin",
          environment: { ENABLE_TOOL_SEARCH: "false" },
        });
        const save = (directory: string, name: string, value: string) =>
          fs.writeFileString(
            path.join(directory, name),
            JSON.stringify({ env: { ENABLE_TOOL_SEARCH: value } }),
          );
        expect(yield* resolve).toBeUndefined();
        yield* save(configDirectory, "settings.json", "auto");
        expect(yield* resolve).toBe("true");
        yield* save(path.join(worktree, ".claude"), "settings.json", "false");
        expect(yield* resolve).toBeUndefined();
        yield* save(path.join(worktree, ".claude"), "settings.local.json", "auto");
        expect(yield* resolve).toBe("true");
        yield* save(path.join(checkout, ".claude"), "settings.local.json", "auto:100");
        expect(yield* resolve).toBeUndefined();
        yield* fs.writeFileString(
          path.join(checkout, ".claude", "settings.local.json"),
          '{ /* local wins */ "env": { "ENABLE_TOOL_SEARCH": "auto:50", }, }',
        );
        expect(yield* resolve).toBe("true");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });
});
