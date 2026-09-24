import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";

import { GitCommandError } from "../Errors.ts";
import { GitServiceLive } from "./GitService.ts";
import { GitService } from "../Services/GitService.ts";

const layer = it.layer(Layer.provideMerge(GitServiceLive, NodeServices.layer));

layer("GitServiceLive", (it) => {
  it.effect("runGit executes successful git commands", () =>
    Effect.gen(function* () {
      const gitService = yield* GitService;
      const result = yield* gitService.execute({
        operation: "GitProcess.test.version",
        cwd: process.cwd(),
        args: ["--version"],
      });

      assert.equal(result.code, 0);
      assert.ok(result.stdout.toLowerCase().includes("git version"));
    }),
  );

  it.effect("forces noninteractive credentials even when the caller enables prompts", () =>
    Effect.gen(function* () {
      const gitService = yield* GitService;
      const result = yield* gitService.execute({
        operation: "GitProcess.test.noninteractive",
        cwd: process.cwd(),
        args: ["-c", "alias.f5-env=!echo $GIT_TERMINAL_PROMPT:$GCM_INTERACTIVE", "f5-env"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "1", GCM_INTERACTIVE: "always" },
        timeoutMs: null,
      });
      assert.equal(result.stdout.trim(), "0:never");
    }),
  );

  it.effect(
    "keeps an SSH command override while disabling prompts and bounding stalled connections",
    () =>
      Effect.gen(function* () {
        const gitService = yield* GitService;
        const ssh = `"${process.execPath}" -e "console.error(process.argv.slice(1).join(' '));process.exit(1)" --`;
        const result = yield* gitService.execute({
          operation: "GitProcess.test.ssh",
          cwd: process.cwd(),
          args: ["ls-remote", "ssh://example.invalid/repo"],
          env: { GIT_SSH_COMMAND: ssh },
          allowNonZeroExit: true,
        });
        assert.notEqual(result.code, 0);
        assert.include(result.stderr, "BatchMode=yes");
        assert.include(result.stderr, "ConnectTimeout=30");
        assert.include(result.stderr, "ServerAliveCountMax=3");
      }),
  );

  it.effect("runGit can return non-zero exit codes when allowed", () =>
    Effect.gen(function* () {
      const gitService = yield* GitService;
      const result = yield* gitService.execute({
        operation: "GitProcess.test.allowNonZero",
        cwd: process.cwd(),
        args: ["rev-parse", "--verify", "__definitely_missing_ref__"],
        allowNonZeroExit: true,
      });

      assert.notEqual(result.code, 0);
    }),
  );

  it.effect("runGit fails with GitCommandError when non-zero exits are not allowed", () =>
    Effect.gen(function* () {
      const gitService = yield* GitService;
      const result = yield* Effect.result(
        gitService.execute({
          operation: "GitProcess.test.failOnNonZero",
          cwd: process.cwd(),
          args: ["rev-parse", "--verify", "__definitely_missing_ref__"],
        }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.ok(Schema.is(GitCommandError)(result.failure));
        assert.equal(result.failure.operation, "GitProcess.test.failOnNonZero");
        assert.equal(result.failure.command, "git rev-parse --verify __definitely_missing_ref__");
      }
    }),
  );
});
