import { chmodSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, describe, it, vi } from "vitest";
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Scope, Stream } from "effect";

import {
  ProviderAdapterRequestError,
  ProviderUnsupportedError,
  ProviderValidationBusyError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { HarnessValidation } from "../Services/HarnessValidation.ts";
import { HarnessValidationLive } from "./HarnessValidation.ts";

type RunOneOffPrompt = NonNullable<ProviderAdapterShape<ProviderAdapterError>["runOneOffPrompt"]>;
type OneOffInput = Parameters<RunOneOffPrompt>[0];

function writeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, { mode: 0o755 });
  chmodSync(filePath, 0o755);
}

function makeReadyCodexCli(filePath: string): void {
  writeExecutable(
    filePath,
    `#!/bin/sh
case "$*" in
  *"--version"*)
  echo "codex 1.0.0"
  exit 0
  ;;
  *"login status"*)
  echo '{"authenticated":true}'
  exit 0
  ;;
esac
echo "unexpected args: $*" >&2
exit 1
`,
  );
}

function makeUnsupportedCodexCli(filePath: string): void {
  writeExecutable(
    filePath,
    `#!/bin/sh
case "$*" in
  *"--version"*)
  echo "codex 0.36.0"
  exit 0
  ;;
esac
echo "unexpected args: $*" >&2
exit 1
`,
  );
}

function makeReadyClaudeCli(filePath: string): void {
  writeExecutable(
    filePath,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "1.0.0"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo '{"loggedIn":true}'
  exit 0
fi
echo "unexpected args: $*" >&2
exit 1
`,
  );
}

function unexpectedEffect(label: string) {
  return vi.fn(() => Effect.die(new Error(`Unexpected adapter call: ${label}`)));
}

function makeAdapter(
  provider: ProviderAdapterShape<ProviderAdapterError>["provider"],
  runOneOffPrompt: RunOneOffPrompt,
): ProviderAdapterShape<ProviderAdapterError> {
  return {
    provider,
    capabilities: { sessionModelSwitch: "unsupported" },
    startSession: unexpectedEffect(`${provider}.startSession`) as never,
    sendTurn: unexpectedEffect(`${provider}.sendTurn`) as never,
    interruptTurn: unexpectedEffect(`${provider}.interruptTurn`) as never,
    respondToRequest: unexpectedEffect(`${provider}.respondToRequest`) as never,
    respondToUserInput: unexpectedEffect(`${provider}.respondToUserInput`) as never,
    stopSession: unexpectedEffect(`${provider}.stopSession`) as never,
    listSessions: vi.fn(() => Effect.succeed([])),
    hasSession: vi.fn(() => Effect.succeed(false)),
    readThread: unexpectedEffect(`${provider}.readThread`) as never,
    rollbackThread: unexpectedEffect(`${provider}.rollbackThread`) as never,
    runOneOffPrompt,
    stopAll: vi.fn(() => Effect.void),
    streamEvents: Stream.empty,
  };
}

function makeValidationLayer(adapters: {
  readonly codex: ProviderAdapterShape<ProviderAdapterError>;
  readonly claudeAgent: ProviderAdapterShape<ProviderAdapterError>;
}) {
  return HarnessValidationLive.pipe(
    Layer.provide(
      Layer.succeed(ProviderAdapterRegistry, {
        getByProvider: (provider) =>
          provider === "codex"
            ? Effect.succeed(adapters.codex)
            : provider === "claudeAgent"
              ? Effect.succeed(adapters.claudeAgent)
              : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["codex", "claudeAgent"] as const),
      }),
    ),
  );
}

function makeProviderOptions(input: {
  readonly codexBinaryPath: string;
  readonly claudeBinaryPath: string;
  readonly codexHomePath?: string;
}) {
  return {
    mcpServers: {
      broken: {
        type: "stdio" as const,
        command: "/definitely/missing-mcp",
      },
    },
    codex: {
      binaryPath: input.codexBinaryPath,
      ...(input.codexHomePath ? { homePath: input.codexHomePath } : {}),
    },
    claudeAgent: {
      binaryPath: input.claudeBinaryPath,
      permissionMode: "plan",
      maxThinkingTokens: 256,
      launchArgs: {
        "--append-system-prompt": "Validate connectivity",
      },
    },
  };
}

async function runValidationEffect<A, E>(
  effect: Effect.Effect<A, E, HarnessValidation | FileSystem.FileSystem | Scope.Scope>,
  adapters: {
    readonly codex: ProviderAdapterShape<ProviderAdapterError>;
    readonly claudeAgent: ProviderAdapterShape<ProviderAdapterError>;
  },
) {
  const validationLayer = makeValidationLayer(adapters).pipe(Layer.provide(NodeServices.layer));
  const appLayer = Layer.mergeAll(NodeServices.layer, validationLayer);
  return await Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(appLayer))));
}

describe("HarnessValidationLive", () => {
  it("short-circuits terminal preflight failures without running one-off prompts", async () => {
    const codexRunOneOffPrompt = vi.fn<RunOneOffPrompt>();
    const claudeRunOneOffPrompt = vi.fn<RunOneOffPrompt>();

    await runValidationEffect(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const service = yield* Effect.service(HarnessValidation);
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-harness-test-" });
        const codexPath = path.join(tempDir, "codex");
        const missingClaudePath = path.join(tempDir, "missing-claude");
        makeUnsupportedCodexCli(codexPath);

        const results = yield* service.validate({
          providerOptions: {
            codex: { binaryPath: codexPath },
            claudeAgent: { binaryPath: missingClaudePath },
          },
        });

        expect(results.map((result) => [result.provider, result.failureKind])).toEqual([
          ["claudeAgent", "notInstalled"],
          ["codex", "unsupportedVersion"],
        ]);
        expect(claudeRunOneOffPrompt).not.toHaveBeenCalled();
        expect(codexRunOneOffPrompt).not.toHaveBeenCalled();
      }),
      {
        codex: makeAdapter("codex", codexRunOneOffPrompt),
        claudeAgent: makeAdapter("claudeAgent", claudeRunOneOffPrompt),
      },
    );
  });

  it("passes provider-scoped options, uses synthetic thread ids, isolates cwd, and ignores MCP validation", async () => {
    const capturedInputs: Array<{
      provider: "codex" | "claudeAgent";
      input: OneOffInput;
      cwdExistsDuringCall: boolean;
    }> = [];

    const codexRunOneOffPrompt = vi.fn((input: OneOffInput) =>
      Effect.sync(() => {
        capturedInputs.push({
          provider: "codex",
          input,
          cwdExistsDuringCall: input.cwd ? existsSync(input.cwd) : false,
        });
        return { text: "OK" };
      }),
    );
    const claudeRunOneOffPrompt = vi.fn((input: OneOffInput) =>
      Effect.sync(() => {
        capturedInputs.push({
          provider: "claudeAgent",
          input,
          cwdExistsDuringCall: input.cwd ? existsSync(input.cwd) : false,
        });
        return { text: "OK" };
      }),
    );

    await runValidationEffect(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const service = yield* Effect.service(HarnessValidation);
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-harness-test-" });
        const codexPath = path.join(tempDir, "codex");
        const claudePath = path.join(tempDir, "claude");
        const codexHomePath = path.join(tempDir, ".codex-home");
        makeReadyCodexCli(codexPath);
        makeReadyClaudeCli(claudePath);

        const results = yield* service.validate({
          providerOptions: makeProviderOptions({
            codexBinaryPath: codexPath,
            claudeBinaryPath: claudePath,
            codexHomePath,
          }),
        });

        expect(results.map((result) => result.status)).toEqual(["ready", "ready"]);

        const codexInput = capturedInputs.find((entry) => entry.provider === "codex");
        const claudeInput = capturedInputs.find((entry) => entry.provider === "claudeAgent");

        expect(codexInput).toBeDefined();
        expect(claudeInput).toBeDefined();
        expect(codexInput?.cwdExistsDuringCall).toBe(true);
        expect(claudeInput?.cwdExistsDuringCall).toBe(true);
        expect(codexInput?.input.cwd).not.toBe(process.cwd());
        expect(claudeInput?.input.cwd).not.toBe(process.cwd());
        expect(
          codexInput?.input.cwd?.startsWith(path.join(os.tmpdir(), "t3-harness-validation-codex-")),
        ).toBe(true);
        expect(
          claudeInput?.input.cwd?.startsWith(
            path.join(os.tmpdir(), "t3-harness-validation-claudeAgent-"),
          ),
        ).toBe(true);
        expect(String(codexInput?.input.threadId).startsWith("harness-validation:codex:")).toBe(
          true,
        );
        expect(
          String(claudeInput?.input.threadId).startsWith("harness-validation:claudeAgent:"),
        ).toBe(true);
        expect(codexInput?.input.runtimeMode).toBe("approval-required");
        expect(claudeInput?.input.runtimeMode).toBeUndefined();
        expect(codexInput?.input.timeoutMs).toBe(20_000);
        expect(claudeInput?.input.timeoutMs).toBe(20_000);
        expect(codexInput?.input.providerOptions).toEqual({
          codex: {
            binaryPath: codexPath,
            homePath: codexHomePath,
          },
        });
        expect(codexInput?.input.providerOptions).not.toHaveProperty("mcpServers");
        expect(claudeInput?.input.providerOptions).toEqual({
          claudeAgent: {
            binaryPath: claudePath,
            permissionMode: "plan",
            maxThinkingTokens: 256,
            launchArgs: {
              "--append-system-prompt": "Validate connectivity",
            },
          },
        });
        expect(claudeInput?.input.providerOptions).not.toHaveProperty("mcpServers");
      }),
      {
        codex: makeAdapter("codex", codexRunOneOffPrompt),
        claudeAgent: makeAdapter("claudeAgent", claudeRunOneOffPrompt),
      },
    );
  });

  it("runs validations in parallel and preserves provider order", async () => {
    const started: Array<"codex" | "claudeAgent"> = [];
    const releaseCodex = Deferred.makeUnsafe<void>();
    const releaseClaude = Deferred.makeUnsafe<void>();
    const bothStarted = Deferred.makeUnsafe<void>();
    const codexRunOneOffPrompt = vi.fn(() =>
      Effect.gen(function* () {
        started.push("codex");
        if (started.length === 2) {
          yield* Deferred.succeed(bothStarted, undefined);
        }
        yield* Deferred.await(releaseCodex);
        return { text: "OK" };
      }),
    );
    const claudeRunOneOffPrompt = vi.fn(() =>
      Effect.gen(function* () {
        started.push("claudeAgent");
        if (started.length === 2) {
          yield* Deferred.succeed(bothStarted, undefined);
        }
        yield* Deferred.await(releaseClaude);
        return { text: "OK" };
      }),
    );

    await runValidationEffect(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const service = yield* Effect.service(HarnessValidation);
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-harness-test-" });
        const codexPath = path.join(tempDir, "codex");
        const claudePath = path.join(tempDir, "claude");
        makeReadyCodexCli(codexPath);
        makeReadyClaudeCli(claudePath);

        const validationFiber = yield* service
          .validate({
            providerOptions: makeProviderOptions({
              codexBinaryPath: codexPath,
              claudeBinaryPath: claudePath,
            }),
          })
          .pipe(Effect.forkChild);

        yield* Deferred.await(bothStarted);
        expect(started.toSorted()).toEqual(["claudeAgent", "codex"]);

        yield* Deferred.succeed(releaseCodex, undefined);
        yield* Deferred.succeed(releaseClaude, undefined);
        const results = yield* Fiber.join(validationFiber);
        expect(results.map((result) => result.provider)).toEqual(["claudeAgent", "codex"]);
      }),
      {
        codex: makeAdapter("codex", codexRunOneOffPrompt),
        claudeAgent: makeAdapter("claudeAgent", claudeRunOneOffPrompt),
      },
    );
  });

  it("rejects concurrent validation requests while one is already running", async () => {
    const release = Deferred.makeUnsafe<void>();
    const started = Deferred.makeUnsafe<void>();
    const block = () =>
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined).pipe(Effect.ignore);
        yield* Deferred.await(release);
        return { text: "OK" };
      });

    await runValidationEffect(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const service = yield* Effect.service(HarnessValidation);
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-harness-test-" });
        const codexPath = path.join(tempDir, "codex");
        const claudePath = path.join(tempDir, "claude");
        makeReadyCodexCli(codexPath);
        makeReadyClaudeCli(claudePath);

        const firstFiber = yield* service
          .validate({
            providerOptions: makeProviderOptions({
              codexBinaryPath: codexPath,
              claudeBinaryPath: claudePath,
            }),
          })
          .pipe(Effect.forkChild);

        yield* Deferred.await(started);

        const secondExit = yield* service
          .validate({
            providerOptions: makeProviderOptions({
              codexBinaryPath: codexPath,
              claudeBinaryPath: claudePath,
            }),
          })
          .pipe(Effect.exit);

        expect(Exit.isFailure(secondExit)).toBe(true);
        if (Exit.isFailure(secondExit)) {
          const error = Cause.squash(secondExit.cause);
          expect(error).toBeInstanceOf(ProviderValidationBusyError);
          expect((error as ProviderValidationBusyError).message).toBe(
            "Harness validation is already in progress.",
          );
        }

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(firstFiber);
      }),
      {
        codex: makeAdapter(
          "codex",
          vi.fn(() => block()),
        ),
        claudeAgent: makeAdapter(
          "claudeAgent",
          vi.fn(() => block()),
        ),
      },
    );
  });

  it("classifies provider one-off prompt failures as connectivity errors", async () => {
    const codexRunOneOffPrompt = vi.fn(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "runOneOffPrompt",
          detail: "Codex one-off prompt query timed out.",
        }),
      ),
    );
    const claudeRunOneOffPrompt = vi.fn(() => Effect.succeed({ text: "OK" }));

    await runValidationEffect(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const service = yield* Effect.service(HarnessValidation);
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-harness-test-" });
        const codexPath = path.join(tempDir, "codex");
        const claudePath = path.join(tempDir, "claude");
        makeReadyCodexCli(codexPath);
        makeReadyClaudeCli(claudePath);

        const results = yield* service.validate({
          providerOptions: makeProviderOptions({
            codexBinaryPath: codexPath,
            claudeBinaryPath: claudePath,
          }),
        });

        const codex = results.find((result) => result.provider === "codex");
        const claude = results.find((result) => result.provider === "claudeAgent");

        expect(codex?.failureKind).toBe("connectivity");
        expect(codex?.message).toBe("Codex one-off prompt query timed out.");
        expect(claude?.status).toBe("ready");
      }),
      {
        codex: makeAdapter("codex", codexRunOneOffPrompt),
        claudeAgent: makeAdapter("claudeAgent", claudeRunOneOffPrompt),
      },
    );
  });

  it("classifies service-level one-off prompt timeouts as connectivity errors", async () => {
    const codexRunOneOffPrompt = vi.fn(() => Effect.never);
    const claudeRunOneOffPrompt = vi.fn(() => Effect.succeed({ text: "OK" }));
    const previousTimeout = process.env.T3_HARNESS_CONNECTIVITY_TIMEOUT_MS;
    process.env.T3_HARNESS_CONNECTIVITY_TIMEOUT_MS = "10";

    try {
      const results = await runValidationEffect(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const service = yield* Effect.service(HarnessValidation);
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-harness-test-" });
          const codexPath = path.join(tempDir, "codex");
          const claudePath = path.join(tempDir, "claude");
          makeReadyCodexCli(codexPath);
          makeReadyClaudeCli(claudePath);

          return yield* service.validate({
            providerOptions: makeProviderOptions({
              codexBinaryPath: codexPath,
              claudeBinaryPath: claudePath,
            }),
          });
        }),
        {
          codex: makeAdapter("codex", codexRunOneOffPrompt),
          claudeAgent: makeAdapter("claudeAgent", claudeRunOneOffPrompt),
        },
      );
      const codex = results.find((result) => result.provider === "codex");
      const claude = results.find((result) => result.provider === "claudeAgent");

      expect(codex?.failureKind).toBe("connectivity");
      expect(codex?.message).toBe("Codex one-off prompt query timed out.");
      expect(claude?.status).toBe("ready");
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.T3_HARNESS_CONNECTIVITY_TIMEOUT_MS;
      } else {
        process.env.T3_HARNESS_CONNECTIVITY_TIMEOUT_MS = previousTimeout;
      }
    }
  });
});
