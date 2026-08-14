import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { CodexMcpServerEntry } from "@t3tools/contracts";

import { prependCodexCliTelemetryDisabledConfig } from "./codexCliConfig.ts";
import { CodexLaunchArgsError, resolveCodexLaunchArgv } from "./codexLaunchArgs.ts";
import { resolveCodexHome } from "../os-jank.ts";
import { buildProviderChildProcessEnv } from "../providerProcessEnv.ts";
import { CommandNotFoundError, resolveInvocationEffect } from "../spawn/resolveCommand.ts";
import { resolveClaudeCliInvocation } from "./claudeSdkExecutable.ts";

export interface ProviderCliCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface ProviderCliCommandOptions {
  readonly binaryPath?: string | undefined;
  readonly envOverrides?: NodeJS.ProcessEnv | undefined;
  readonly launchArgs?: ReadonlyArray<string> | undefined;
  readonly mcpServers?: Record<string, CodexMcpServerEntry> | null | undefined;
  readonly mcpOAuthCallbackPort?: number | null | undefined;
  readonly mcpOAuthCallbackUrl?: string | null | undefined;
}

export interface ClaudeCliCommandOptions {
  readonly binaryPath?: string | undefined;
  readonly envOverrides?: NodeJS.ProcessEnv | undefined;
  readonly cwd?: string | undefined;
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

export function buildCodexCliEnvOverrides(input?: {
  readonly homePath?: string | undefined;
}): NodeJS.ProcessEnv | undefined {
  const codexHome = resolveCodexHome(input);
  return codexHome ? { CODEX_HOME: codexHome } : undefined;
}

export function runProviderCliCommand(
  binary: string,
  args: ReadonlyArray<string>,
  options?: ProviderCliCommandOptions,
) {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const resolvedBinary = options?.binaryPath ?? binary;
    const environment = buildProviderChildProcessEnv(process.env, options?.envOverrides);
    const launchArgs =
      binary === "codex"
        ? yield* Effect.try({
            try: () =>
              resolveCodexLaunchArgv({
                ...(options?.launchArgs ? { providerLaunchArgs: options.launchArgs } : {}),
                environment,
              }),
            catch: (cause) =>
              Schema.is(CodexLaunchArgsError)(cause)
                ? cause
                : new CodexLaunchArgsError({ message: String(cause) }),
          })
        : { argv: [], dropped: [] };
    if (launchArgs.dropped.length > 0) {
      yield* Effect.logWarning("ignored reserved Codex launch arguments", {
        dropped: launchArgs.dropped,
      });
    }
    const commandArgs =
      binary === "codex"
        ? prependCodexCliTelemetryDisabledConfig([...launchArgs.argv, ...args], {
            mcpServers: options?.mcpServers ?? null,
            mcpOAuthCallbackPort: options?.mcpOAuthCallbackPort ?? null,
            mcpOAuthCallbackUrl: options?.mcpOAuthCallbackUrl ?? null,
          })
        : [...args];
    const invocation = yield* resolveInvocationEffect(resolvedBinary, commandArgs, environment);
    const command = ChildProcess.make(invocation.file, [...invocation.args], {
      env: environment,
      stdin: "ignore",
    });

    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies ProviderCliCommandResult;
  }).pipe(Effect.scoped);
}

export const runCodexCliCommand = (
  args: ReadonlyArray<string>,
  options?: ProviderCliCommandOptions,
) => runProviderCliCommand("codex", args, options);

export const runClaudeCliCommand = (
  args: ReadonlyArray<string>,
  options?: ClaudeCliCommandOptions,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const environment = buildProviderChildProcessEnv(process.env, options?.envOverrides);
    const invocation = yield* Effect.try({
      try: () =>
        resolveClaudeCliInvocation(options?.binaryPath, args, environment, { cwd: options?.cwd }),
      catch: (cause) =>
        cause instanceof CommandNotFoundError
          ? cause
          : new CommandNotFoundError(options?.binaryPath ?? "claude", String(cause)),
    });
    const command = ChildProcess.make(invocation.file, [...invocation.args], {
      env: environment,
      stdin: "ignore",
    });
    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, code: exitCode } satisfies ProviderCliCommandResult;
  }).pipe(Effect.scoped);
