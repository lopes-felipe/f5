import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, Path, Sink, Stream } from "effect";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  checkClaudeProviderPreflight,
  checkClaudeProviderStatus,
  checkCodexProviderPreflight,
  checkCodexProviderStatus,
  hasCustomModelProvider,
  parseAuthStatusFromOutput,
  parseClaudeAuthStatusFromOutput,
  readCodexConfigModelProvider,
} from "./ProviderHealth";
import { prependCodexCliTelemetryDisabledConfig } from "../codexCliConfig";

// ── Test helpers ────────────────────────────────────────────────────

const encoder = new TextEncoder();
const CODEX_TELEMETRY_DISABLED_PREFIX = [...prependCodexCliTelemetryDisabledConfig([])];

function normalizeCodexArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  if (
    args.length >= CODEX_TELEMETRY_DISABLED_PREFIX.length &&
    CODEX_TELEMETRY_DISABLED_PREFIX.every((value, index) => args[index] === value)
  ) {
    return args.slice(CODEX_TELEMETRY_DISABLED_PREFIX.length);
  }

  return args;
}

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => { stdout: string; stderr: string; code: number },
  inspect?: (command: unknown) => void,
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      inspect?.(command);
      const cmd = command as unknown as { args: ReadonlyArray<string> };
      return Effect.succeed(mockHandle(handler(cmd.args)));
    }),
  );
}

function failingSpawnerLayer(description: string) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description,
        }),
      ),
    ),
  );
}

function hangingSpawnerLayer() {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    ),
  );
}

/**
 * Create a temporary CODEX_HOME scoped to the current Effect test.
 * Cleanup is registered in the test scope rather than via Vitest hooks.
 */
function withTempCodexHome(configContent?: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmpDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-test-codex-" });

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const originalCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = tmpDir;
        return originalCodexHome;
      }),
      (originalCodexHome) =>
        Effect.sync(() => {
          if (originalCodexHome !== undefined) {
            process.env.CODEX_HOME = originalCodexHome;
          } else {
            delete process.env.CODEX_HOME;
          }
        }),
    );

    if (configContent !== undefined) {
      yield* fileSystem.writeFileString(path.join(tmpDir, "config.toml"), configContent);
    }

    return { tmpDir } as const;
  });
}

it.layer(NodeServices.layer)("ProviderHealth", (it) => {
  // ── checkCodexProviderStatus tests ────────────────────────────────
  //
  // These tests control CODEX_HOME to ensure the custom-provider detection
  // in hasCustomModelProvider() does not interfere with the auth-probe
  // path being tested.

  describe("checkCodexProviderStatus", () => {
    it.effect("returns ready when codex is installed and authenticated", () =>
      Effect.gen(function* () {
        // Point CODEX_HOME at an empty tmp dir (no config.toml) so the
        // default code path (OpenAI provider, auth probe runs) is exercised.
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "authenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = normalizeCodexArgs(args).join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unavailable when codex is missing", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(status.message, "Codex CLI (`codex`) is not installed or not on PATH.");
      }).pipe(Effect.provide(failingSpawnerLayer("spawn codex ENOENT"))),
    );

    it.effect("returns unavailable when codex is below the minimum supported version", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Codex CLI v0.36.0 is too old for F5. Upgrade to v0.37.0 or newer and restart F5.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = normalizeCodexArgs(args).join(" ");
            if (joined === "--version") return { stdout: "codex 0.36.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unauthenticated when auth probe reports login required", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unauthenticated");
        assert.strictEqual(
          status.message,
          "Codex CLI is not authenticated. Run `codex login` and try again.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = normalizeCodexArgs(args).join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status") {
              return { stdout: "", stderr: "Not logged in. Run codex login.", code: 1 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unauthenticated when login status output includes 'not logged in'", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unauthenticated");
        assert.strictEqual(
          status.message,
          "Codex CLI is not authenticated. Run `codex login` and try again.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = normalizeCodexArgs(args).join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status")
              return { stdout: "Not logged in\n", stderr: "", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns warning when login status command is unsupported", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "warning");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Codex CLI authentication status command is unavailable in this Codex version.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = normalizeCodexArgs(args).join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status") {
              return { stdout: "", stderr: "error: unknown command 'login'", code: 2 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );
  });

  // ── Custom model provider: checkCodexProviderStatus integration ───

  describe("checkCodexProviderStatus with custom model provider", () => {
    it.effect("skips auth probe and returns ready when a custom model provider is configured", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome(
          [
            'model_provider = "portkey"',
            "",
            "[model_providers.portkey]",
            'base_url = "https://api.portkey.ai/v1"',
            'env_key = "PORTKEY_API_KEY"',
          ].join("\n"),
        );
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Using a custom Codex model provider; OpenAI login check skipped.",
        );
      }).pipe(
        Effect.provide(
          // The spawner only handles --version; if the test attempts
          // "login status" the throw proves the auth probe was NOT skipped.
          mockSpawnerLayer((args) => {
            const joined = normalizeCodexArgs(args).join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            throw new Error(`Auth probe should have been skipped but got args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("still reports error when codex CLI is missing even with custom provider", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome(
          [
            'model_provider = "portkey"',
            "",
            "[model_providers.portkey]",
            'base_url = "https://api.portkey.ai/v1"',
            'env_key = "PORTKEY_API_KEY"',
          ].join("\n"),
        );
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
      }).pipe(Effect.provide(failingSpawnerLayer("spawn codex ENOENT"))),
    );
  });

  describe("checkCodexProviderStatus with openai model provider", () => {
    it.effect("still runs auth probe when model_provider is openai", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "openai"\n');
        const status = yield* checkCodexProviderStatus;
        // The auth probe runs and sees "not logged in" → error
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.authStatus, "unauthenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = normalizeCodexArgs(args).join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status")
              return { stdout: "Not logged in\n", stderr: "", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );
  });

  describe("checkCodexProviderPreflight", () => {
    it.effect("honors binaryPath and homePath overrides", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "openai"\n');
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const overrideHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-test-codex-override-",
        });
        yield* fileSystem.writeFileString(
          path.join(overrideHome, "config.toml"),
          'model_provider = "portkey"\n',
        );

        let observedCommand: unknown;
        const status = yield* checkCodexProviderPreflight({
          providerOptions: {
            codex: {
              binaryPath: "/tmp/custom-codex",
              homePath: overrideHome,
            },
          },
        }).pipe(
          Effect.provide(
            mockSpawnerLayer(
              (args) => {
                const joined = normalizeCodexArgs(args).join(" ");
                if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
                throw new Error(`Auth probe should have been skipped but got args: ${joined}`);
              },
              (command) => {
                observedCommand = command;
              },
            ),
          ),
        );

        const command = observedCommand as {
          command?: string;
          options?: { env?: NodeJS.ProcessEnv };
        };

        assert.strictEqual(status.status, "ready");
        assert.strictEqual(
          status.message,
          "Using a custom Codex model provider; OpenAI login check skipped.",
        );
        assert.strictEqual(command.command, "/tmp/custom-codex");
        assert.strictEqual(command.options?.env?.CODEX_HOME, overrideHome);
      }),
    );

    it.effect("sets failureReason=notInstalled when the codex binary is missing", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderPreflight();
        assert.strictEqual(status.failureReason, "notInstalled");
      }).pipe(Effect.provide(failingSpawnerLayer("spawn codex ENOENT"))),
    );

    it.effect("sets failureReason=versionProbeFailed on codex version probe errors", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderPreflight();
        assert.strictEqual(status.failureReason, "versionProbeFailed");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = normalizeCodexArgs(args).join(" ");
            if (joined === "--version")
              return { stdout: "", stderr: "Something went wrong", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("sets failureReason=versionProbeTimeout when the codex version probe hangs", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const fiber = yield* checkCodexProviderPreflight().pipe(Effect.forkChild);
        yield* TestClock.adjust("5 seconds");
        const status = yield* Fiber.join(fiber);
        assert.strictEqual(status.failureReason, "versionProbeTimeout");
      }).pipe(Effect.provide(hangingSpawnerLayer())),
    );

    it.effect("sets failureReason=unsupportedVersion when the codex CLI is too old", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderPreflight();
        assert.strictEqual(status.failureReason, "unsupportedVersion");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = normalizeCodexArgs(args).join(" ");
            if (joined === "--version") return { stdout: "codex 0.36.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("sets failureReason=unauthenticated when codex auth explicitly fails", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderPreflight();
        assert.strictEqual(status.failureReason, "unauthenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = normalizeCodexArgs(args).join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status")
              return { stdout: "Not logged in\n", stderr: "", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );
  });

  // ── parseAuthStatusFromOutput pure tests ──────────────────────────

  describe("parseAuthStatusFromOutput", () => {
    it("exit code 0 with no auth markers is ready", () => {
      const parsed = parseAuthStatusFromOutput({ stdout: "OK\n", stderr: "", code: 0 });
      assert.strictEqual(parsed.status, "ready");
      assert.strictEqual(parsed.authStatus, "authenticated");
    });

    it("JSON with authenticated=false is unauthenticated", () => {
      const parsed = parseAuthStatusFromOutput({
        stdout: '[{"authenticated":false}]\n',
        stderr: "",
        code: 0,
      });
      assert.strictEqual(parsed.status, "error");
      assert.strictEqual(parsed.authStatus, "unauthenticated");
    });

    it("JSON without auth marker is warning", () => {
      const parsed = parseAuthStatusFromOutput({
        stdout: '[{"ok":true}]\n',
        stderr: "",
        code: 0,
      });
      assert.strictEqual(parsed.status, "warning");
      assert.strictEqual(parsed.authStatus, "unknown");
    });
  });

  // ── readCodexConfigModelProvider tests ─────────────────────────────

  describe("readCodexConfigModelProvider", () => {
    it.effect("returns undefined when config file does not exist", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        assert.strictEqual(yield* readCodexConfigModelProvider, undefined);
      }),
    );

    it.effect("returns undefined when config has no model_provider key", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model = "gpt-5-codex"\n');
        assert.strictEqual(yield* readCodexConfigModelProvider, undefined);
      }),
    );

    it.effect("returns the provider when model_provider is set at top level", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model = "gpt-5-codex"\nmodel_provider = "portkey"\n');
        assert.strictEqual(yield* readCodexConfigModelProvider, "portkey");
      }),
    );

    it.effect("returns openai when model_provider is openai", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "openai"\n');
        assert.strictEqual(yield* readCodexConfigModelProvider, "openai");
      }),
    );

    it.effect("ignores model_provider inside section headers", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome(
          [
            'model = "gpt-5-codex"',
            "",
            "[model_providers.portkey]",
            'base_url = "https://api.portkey.ai/v1"',
            'model_provider = "should-be-ignored"',
            "",
          ].join("\n"),
        );
        assert.strictEqual(yield* readCodexConfigModelProvider, undefined);
      }),
    );

    it.effect("handles comments and whitespace", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome(
          [
            "# This is a comment",
            "",
            '  model_provider = "azure"  ',
            "",
            "[profiles.deep-review]",
            'model = "gpt-5-pro"',
          ].join("\n"),
        );
        assert.strictEqual(yield* readCodexConfigModelProvider, "azure");
      }),
    );

    it.effect("handles single-quoted values in TOML", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome("model_provider = 'mistral'\n");
        assert.strictEqual(yield* readCodexConfigModelProvider, "mistral");
      }),
    );
  });

  // ── hasCustomModelProvider tests ───────────────────────────────────

  describe("hasCustomModelProvider", () => {
    it.effect("returns false when no config file exists", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        assert.strictEqual(yield* hasCustomModelProvider, false);
      }),
    );

    it.effect("returns false when model_provider is not set", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model = "gpt-5-codex"\n');
        assert.strictEqual(yield* hasCustomModelProvider, false);
      }),
    );

    it.effect("returns false when model_provider is openai", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "openai"\n');
        assert.strictEqual(yield* hasCustomModelProvider, false);
      }),
    );

    it.effect("returns true when model_provider is portkey", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "portkey"\n');
        assert.strictEqual(yield* hasCustomModelProvider, true);
      }),
    );

    it.effect("returns true when model_provider is azure", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "azure"\n');
        assert.strictEqual(yield* hasCustomModelProvider, true);
      }),
    );

    it.effect("returns true when model_provider is ollama", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "ollama"\n');
        assert.strictEqual(yield* hasCustomModelProvider, true);
      }),
    );

    it.effect("returns true when model_provider is a custom proxy", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "my-company-proxy"\n');
        assert.strictEqual(yield* hasCustomModelProvider, true);
      }),
    );
  });

  // ── checkClaudeProviderStatus tests ──────────────────────────

  describe("checkClaudeProviderStatus", () => {
    it.effect("runs probe commands with stdin ignored", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus;
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "authenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer(
            (args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status") {
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              }
              throw new Error(`Unexpected args: ${joined}`);
            },
            (command) => {
              const cmd = command as { options?: { stdin?: unknown } };
              assert.strictEqual(cmd.options?.stdin, "ignore");
            },
          ),
        ),
      ),
    );

    it.effect("returns ready when claude is installed and authenticated", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus;
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "authenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status")
              return {
                stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                stderr: "",
                code: 0,
              };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unavailable when claude is missing", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus;
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Claude Agent CLI (`claude`) is not installed or not on PATH.",
        );
      }).pipe(Effect.provide(failingSpawnerLayer("spawn claude ENOENT"))),
    );

    it.effect("returns error when version check fails with non-zero exit code", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus;
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version")
              return { stdout: "", stderr: "Something went wrong", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unauthenticated when auth status reports not logged in", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus;
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unauthenticated");
        assert.strictEqual(
          status.message,
          "Claude is not authenticated. Run `claude auth login` and try again.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status")
              return {
                stdout: '{"loggedIn":false}\n',
                stderr: "",
                code: 1,
              };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unauthenticated when output includes 'not logged in'", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus;
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unauthenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status") return { stdout: "Not logged in\n", stderr: "", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns ready when auth status command is unsupported", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus;
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Claude Agent authentication status command is unavailable in this version of Claude.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status")
              return { stdout: "", stderr: "error: unknown command 'auth'", code: 2 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );
  });

  describe("checkClaudeProviderPreflight", () => {
    it.effect("honors the configured claude binary path override", () =>
      Effect.gen(function* () {
        let observedCommand: unknown;
        const status = yield* checkClaudeProviderPreflight({
          providerOptions: {
            claudeAgent: {
              binaryPath: "/tmp/custom-claude",
            },
          },
        }).pipe(
          Effect.provide(
            mockSpawnerLayer(
              (args) => {
                const joined = args.join(" ");
                if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
                if (joined === "auth status") {
                  return {
                    stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                    stderr: "",
                    code: 0,
                  };
                }
                throw new Error(`Unexpected args: ${joined}`);
              },
              (command) => {
                observedCommand = command;
              },
            ),
          ),
        );

        const command = observedCommand as { command?: string };
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(command.command, "/tmp/custom-claude");
      }),
    );

    it.effect("sets failureReason=notInstalled when the claude binary is missing", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderPreflight();
        assert.strictEqual(status.failureReason, "notInstalled");
      }).pipe(Effect.provide(failingSpawnerLayer("spawn claude ENOENT"))),
    );

    it.effect("sets failureReason=versionProbeFailed on claude version probe errors", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderPreflight();
        assert.strictEqual(status.failureReason, "versionProbeFailed");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version")
              return { stdout: "", stderr: "Something went wrong", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("sets failureReason=versionProbeTimeout when the claude version probe hangs", () =>
      Effect.gen(function* () {
        const fiber = yield* checkClaudeProviderPreflight().pipe(Effect.forkChild);
        yield* TestClock.adjust("5 seconds");
        const status = yield* Fiber.join(fiber);
        assert.strictEqual(status.failureReason, "versionProbeTimeout");
      }).pipe(Effect.provide(hangingSpawnerLayer())),
    );

    it.effect("sets failureReason=unauthenticated when claude auth explicitly fails", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderPreflight();
        assert.strictEqual(status.failureReason, "unauthenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status")
              return { stdout: '{"loggedIn":false}\n', stderr: "", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );
  });

  // ── parseClaudeAuthStatusFromOutput pure tests ────────────────────

  describe("parseClaudeAuthStatusFromOutput", () => {
    it("exit code 0 with no auth markers is ready", () => {
      const parsed = parseClaudeAuthStatusFromOutput({ stdout: "OK\n", stderr: "", code: 0 });
      assert.strictEqual(parsed.status, "ready");
      assert.strictEqual(parsed.authStatus, "authenticated");
    });

    it("JSON with loggedIn=true is authenticated", () => {
      const parsed = parseClaudeAuthStatusFromOutput({
        stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
        stderr: "",
        code: 0,
      });
      assert.strictEqual(parsed.status, "ready");
      assert.strictEqual(parsed.authStatus, "authenticated");
    });

    it("JSON with loggedIn=false is unauthenticated", () => {
      const parsed = parseClaudeAuthStatusFromOutput({
        stdout: '{"loggedIn":false}\n',
        stderr: "",
        code: 0,
      });
      assert.strictEqual(parsed.status, "error");
      assert.strictEqual(parsed.authStatus, "unauthenticated");
    });

    it("JSON without auth marker is ready", () => {
      const parsed = parseClaudeAuthStatusFromOutput({
        stdout: '{"ok":true}\n',
        stderr: "",
        code: 0,
      });
      assert.strictEqual(parsed.status, "ready");
      assert.strictEqual(parsed.authStatus, "unknown");
    });
  });
});
