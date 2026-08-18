import type { CodexMcpServerEntry } from "@t3tools/contracts";
import {
  MAX_LAUNCH_ARGS_CHARS,
  MAX_LAUNCH_ARG_TOKENS,
  parseLaunchArgv,
} from "@t3tools/shared/cliArgs";
import { Schema } from "effect";

import { prependCodexCliTelemetryDisabledConfig } from "./codexCliConfig.ts";

export const F5_CODEX_LAUNCH_ARGS_ENV = "F5_CODEX_LAUNCH_ARGS";
export const LEGACY_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

const RESERVED_CODEX_FLAGS = new Set([
  "--cd",
  "-C",
  "--model",
  "-m",
  "--sandbox",
  "-s",
  "--ask-for-approval",
  "-a",
  "-c",
  "--config",
  "--profile",
  "-p",
  "--dangerously-bypass-approvals-and-sandbox",
  "--full-auto",
  "--enable",
  "--disable",
  "--code-mode-host",
  "--listen",
  "--stdio",
  "--ws-auth",
  "--ws-token-file",
  "--ws-token-sha256",
  "--ws-shared-secret-file",
  "--ws-issuer",
  "--ws-audience",
  "--ws-max-clock-skew-seconds",
]);

const RESERVED_CODEX_SHORT_FLAGS_WITH_ATTACHED_VALUES = ["-C", "-m", "-s", "-a", "-c", "-p"];

export class CodexLaunchArgsError extends Schema.TaggedErrorClass<CodexLaunchArgsError>()(
  "CodexLaunchArgsError",
  { message: Schema.String },
) {}

function reservedFlagName(arg: string): string | undefined {
  const equalsIndex = arg.indexOf("=");
  const name = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
  if (RESERVED_CODEX_FLAGS.has(name)) {
    return name;
  }
  return RESERVED_CODEX_SHORT_FLAGS_WITH_ATTACHED_VALUES.find(
    (shortFlag) => arg.startsWith(shortFlag) && arg.length > shortFlag.length,
  );
}

export interface FilteredCodexLaunchArgs {
  readonly argv: ReadonlyArray<string>;
  readonly dropped: ReadonlyArray<string>;
}

/**
 * Codex owns its subcommand, working directory, model, sandbox, approval
 * policy, and config layers. Remove attempts to override those values and
 * remove positional tokens so user input can never select another subcommand.
 */
export function filterReservedCodexLaunchArgs(
  input: ReadonlyArray<string>,
): FilteredCodexLaunchArgs {
  const argv: string[] = [];
  const dropped: string[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index]!;
    if (arg === "--") {
      // A terminator would make every managed argument appended later look
      // positional to Codex, producing an unstartable app-server invocation.
      dropped.push(...input.slice(index));
      break;
    }
    const reserved = reservedFlagName(arg);
    if (reserved) {
      dropped.push(arg);
      if (arg === reserved) {
        const value = input[index + 1];
        if (value !== undefined && !value.startsWith("-")) {
          dropped.push(value);
          index += 1;
        }
      }
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") {
      dropped.push(arg);
      continue;
    }
    argv.push(arg);
    if (!arg.includes("=")) {
      const value = input[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        argv.push(value);
        index += 1;
      }
    }
  }

  return { argv, dropped };
}

function validateProviderLaunchArgv(input: ReadonlyArray<string>): void {
  if (input.length > MAX_LAUNCH_ARG_TOKENS) {
    throw new CodexLaunchArgsError({
      message: `Codex launch arguments exceed the ${MAX_LAUNCH_ARG_TOKENS}-token limit.`,
    });
  }
  let totalChars = 0;
  for (const arg of input) {
    if (arg.includes("\0")) {
      throw new CodexLaunchArgsError({
        message: "Codex launch arguments cannot contain NUL bytes.",
      });
    }
    totalChars += arg.length;
  }
  if (totalChars > MAX_LAUNCH_ARGS_CHARS) {
    throw new CodexLaunchArgsError({
      message: `Codex launch arguments exceed the ${MAX_LAUNCH_ARGS_CHARS}-character limit.`,
    });
  }
}

export function readCodexEnvironmentLaunchArgs(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return (
    environment[F5_CODEX_LAUNCH_ARGS_ENV]?.trim() ||
    environment[LEGACY_CODEX_LAUNCH_ARGS_ENV]?.trim() ||
    ""
  );
}

export function resolveCodexLaunchArgv(input?: {
  readonly providerLaunchArgs?: ReadonlyArray<string>;
  readonly environment?: NodeJS.ProcessEnv;
}): FilteredCodexLaunchArgs {
  const environmentArgs = parseLaunchArgv(readCodexEnvironmentLaunchArgs(input?.environment));
  if (!environmentArgs.ok) {
    throw new CodexLaunchArgsError({
      message: `Invalid ${F5_CODEX_LAUNCH_ARGS_ENV} (or legacy ${LEGACY_CODEX_LAUNCH_ARGS_ENV}): ${environmentArgs.error}`,
    });
  }
  const providerArgs = input?.providerLaunchArgs ?? [];
  validateProviderLaunchArgv(providerArgs);
  return filterReservedCodexLaunchArgs([...environmentArgs.argv, ...providerArgs]);
}

export interface BuildCodexAppServerCommandInput {
  readonly providerLaunchArgs?: ReadonlyArray<string>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly mcpServers?: Record<string, CodexMcpServerEntry> | null;
  readonly mcpOAuthCallbackPort?: number | null;
  readonly mcpOAuthCallbackUrl?: string | null;
}

/** Build the one canonical argv used by every Codex app-server process. */
export function buildCodexAppServerCommand(
  input: BuildCodexAppServerCommandInput = {},
): FilteredCodexLaunchArgs {
  const resolved = resolveCodexLaunchArgv(input);
  const managedArgs = prependCodexCliTelemetryDisabledConfig([], {
    mcpServers: input.mcpServers ?? null,
    mcpOAuthCallbackPort: input.mcpOAuthCallbackPort ?? null,
    mcpOAuthCallbackUrl: input.mcpOAuthCallbackUrl ?? null,
  });
  return {
    argv: ["app-server", ...resolved.argv, ...managedArgs],
    dropped: resolved.dropped,
  };
}
