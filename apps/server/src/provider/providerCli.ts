import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { CodexMcpServerEntry } from "@t3tools/contracts";

import { prependCodexCliTelemetryDisabledConfig } from "./codexCliConfig.ts";
import { resolveCodexHome } from "../os-jank.ts";
import { buildProviderChildProcessEnv } from "../providerProcessEnv.ts";

export interface ProviderCliCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface ProviderCliCommandOptions {
  readonly binaryPath?: string | undefined;
  readonly envOverrides?: NodeJS.ProcessEnv | undefined;
  readonly mcpServers?: Record<string, CodexMcpServerEntry> | null | undefined;
}

export interface ClaudeCliCommandOptions {
  readonly binaryPath?: string | undefined;
  readonly envOverrides?: NodeJS.ProcessEnv | undefined;
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
    const commandArgs =
      binary === "codex"
        ? prependCodexCliTelemetryDisabledConfig(args, {
            mcpServers: options?.mcpServers ?? null,
          })
        : [...args];
    const command = ChildProcess.make(resolvedBinary, [...commandArgs], {
      env: buildProviderChildProcessEnv(process.env, options?.envOverrides),
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
) => runProviderCliCommand("claude", args, options);
