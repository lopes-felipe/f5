import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { expect, vi } from "vitest";
import * as GitProcessEnvironment from "../gitProcessEnvironment.ts";
import { Effect, Fiber, FileSystem, Layer, Path, Schema, Scope } from "effect";

import { GitCommandError } from "../Errors.ts";
import { GitServiceLive } from "./GitService.ts";
import { GitService } from "../Services/GitService.ts";

const layer = it.layer(Layer.provideMerge(GitServiceLive, NodeServices.layer));

layer("GitServiceLive", (it) => {
  it.effect("interrupting a long Git call kills its owned process group", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const git = yield* GitService;
        const root = yield* Effect.promise(() =>
          FS.mkdtemp(NodePath.join(OS.tmpdir(), "f5-git-interrupt-")),
        );
        const pidFile = NodePath.join(root, "child.pid");
        const script =
          'require("fs").writeFileSync(process.env.F5_GIT_PID_FILE, String(process.pid)); setInterval(() => {}, 1000)';
        const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
        const fiber = yield* git
          .execute({
            operation: "GitService.test.interrupt",
            cwd: root,
            args: ["-c", `alias.f5-block=!node -e ${quote(script)}`, "f5-block"],
            env: { ...process.env, F5_GIT_PID_FILE: pidFile },
            timeoutMs: null,
          })
          .pipe(Effect.forkIn(yield* Scope.Scope));
        yield* Effect.promise(async () => {
          for (let attempt = 0; attempt < 200; attempt++) {
            try {
              await FS.access(pidFile);
              return;
            } catch {}
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          throw new Error("Git fixture child did not start.");
        });
        const pid = Number(yield* Effect.promise(() => FS.readFile(pidFile, "utf8")));
        yield* Fiber.interrupt(fiber);
        yield* Effect.promise(async () => {
          try {
            for (let attempt = 0; attempt < 200; attempt++) {
              try {
                process.kill(pid, 0);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
                throw error;
              }
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            throw new Error("Interrupted Git child remained alive.");
          } finally {
            await FS.rm(root, { recursive: true, force: true });
          }
        });
      }),
    ),
  );
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

  it.effect("disables optional index writes even when inherited settings enable them", () =>
    Effect.gen(function* () {
      const service = yield* GitService;
      const result = yield* service.execute({
        operation: "GitProcess.test.optionalLocks",
        cwd: process.cwd(),
        args: ["-c", "alias.f5-locks=!echo $GIT_OPTIONAL_LOCKS", "f5-locks"],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "1" },
      });
      assert.equal(result.stdout.trim(), "0");
    }),
  );

  it.effect("installs explicit bare discovery and enforces it on Git 2.38 or newer", () =>
    Effect.gen(function* () {
      const service = yield* GitService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "f5-bare-discovery-" });
      const bare = path.join(directory, "untrusted");
      yield* service.execute({
        operation: "test.initBare",
        cwd: directory,
        args: ["init", "--bare", bare],
      });
      const config = yield* service.execute({
        operation: "test.bareConfig",
        cwd: directory,
        args: ["config", "--get", "--", "safe.bareRepository"],
        allowNonZeroExit: true,
      });
      assert.equal(config.stdout.trim(), "explicit");
      const version = yield* service.execute({
        operation: "test.gitVersion",
        cwd: directory,
        args: ["--version"],
      });
      const [, major, minor] = /git version (\d+)\.(\d+)/.exec(version.stdout)!;
      if (Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 38)) {
        const discovered = yield* service.execute({
          operation: "test.discoveredBare",
          cwd: bare,
          args: ["rev-parse", "--is-bare-repository"],
          allowNonZeroExit: true,
        });
        assert.notEqual(discovered.code, 0);
        assert.include(discovered.stderr, "safe.bareRepository");
      }
      const explicit = yield* service.execute({
        operation: "test.explicitBare",
        cwd: directory,
        args: [`--git-dir=${bare}`, "rev-parse", "--is-bare-repository"],
      });
      assert.equal(explicit.stdout.trim(), "true");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "delivers Windows long-path configuration to the Git process without changing argv",
    () =>
      Effect.gen(function* () {
        const service = yield* GitService;
        const policy = GitProcessEnvironment.managedGitProcessEnvironment;
        const host = vi
          .spyOn(GitProcessEnvironment, "managedGitProcessEnvironment")
          .mockImplementation((environment) => policy(environment, "win32"));
        try {
          const result = yield* service.execute({
            operation: "test.windowsLongPaths",
            cwd: process.cwd(),
            args: ["config", "--get", "--", "core.longpaths"],
            allowNonZeroExit: true,
          });
          assert.equal(result.stdout.trim(), "true");
          expect(host).toHaveBeenCalledOnce();
        } finally {
          host.mockRestore();
        }
      }),
  );

  it.effect("reports corrupt configuration counts as typed errors without echoing the value", () =>
    Effect.gen(function* () {
      const service = yield* GitService;
      const result = yield* Effect.result(
        service.execute({
          operation: "test.invalidConfigCount",
          cwd: process.cwd(),
          args: ["--version"],
          env: { GIT_CONFIG_COUNT: "invalid-count-private-fixture" },
        }),
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.isTrue(Schema.is(GitCommandError)(result.failure));
        assert.notInclude(result.failure.detail, "invalid-count-private-fixture");
      }
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

  it.effect("retains stderr diagnostics while streaming progress", () =>
    Effect.gen(function* () {
      const gitService = yield* GitService;
      const chunks: Uint8Array[] = [];
      const result = yield* gitService.execute({
        operation: "GitProcess.test.progress",
        cwd: process.cwd(),
        args: ["rev-parse", "--verify", "__missing_progress_ref__"],
        allowNonZeroExit: true,
        onStderrChunk: (chunk) => chunks.push(chunk),
      });
      assert.notEqual(result.code, 0);
      assert.ok(chunks.length > 0);
      assert.include(result.stderr, "fatal:");
      assert.ok(result.stderr.length <= 4096);
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
