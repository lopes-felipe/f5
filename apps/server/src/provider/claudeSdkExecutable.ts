import { statSync } from "node:fs";
import { createRequire } from "node:module";
import * as NodePath from "node:path";

import {
  CommandNotFoundError,
  resolveExecutable,
  resolveInvocation,
  type CommandResolutionOptions,
  type ResolvedCliInvocation,
} from "../spawn/resolveCommand.ts";

const DEFAULT_CLAUDE_BINARY = "claude";
const NODE_SCRIPT_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);

export interface ClaudeSdkExecutableOptions {
  readonly pathToClaudeCodeExecutable?: string;
  readonly executable?: "node";
}

export function isDefaultClaudeBinary(binaryPath: string | null | undefined): boolean {
  const normalized = binaryPath?.trim();
  return !normalized || normalized === DEFAULT_CLAUDE_BINARY;
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function resolveBundledClaudeExecutable(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const packageName = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  const executableName = platform === "win32" ? "claude.exe" : "claude";
  const require = createRequire(import.meta.url);
  let executable: string;
  try {
    const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
    const sdkRequire = createRequire(sdkEntry);
    executable = sdkRequire.resolve(`${packageName}/${executableName}`);
  } catch {
    throw new CommandNotFoundError(
      DEFAULT_CLAUDE_BINARY,
      `Bundled Claude Agent SDK executable for ${platform}-${arch} is unavailable. Reinstall dependencies with optional packages enabled.`,
    );
  }
  if (!isFile(executable)) {
    throw new CommandNotFoundError(
      DEFAULT_CLAUDE_BINARY,
      `Bundled Claude Agent SDK executable is missing at '${executable}'.`,
    );
  }
  return executable;
}

export function resolveClaudeSdkExecutableOptions(
  binaryPath: string | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cwd?: string,
): ClaudeSdkExecutableOptions {
  if (isDefaultClaudeBinary(binaryPath)) return {};

  const command = binaryPath!.trim();
  if (platform !== "win32") {
    return NODE_SCRIPT_EXTENSIONS.has(NodePath.extname(command).toLowerCase())
      ? { pathToClaudeCodeExecutable: command, executable: "node" }
      : { pathToClaudeCodeExecutable: command };
  }
  const resolved = resolveExecutable(command, environment, { platform, cwd });
  if (!resolved) throw new CommandNotFoundError(command);

  const extension = NodePath.win32.extname(resolved).toLowerCase();
  if (platform === "win32" && (extension === ".cmd" || extension === ".bat")) {
    throw new CommandNotFoundError(
      command,
      `Claude SDK cannot launch the Windows shim '${resolved}'. Configure a directly runnable .exe or the CLI's cli.js entry point.`,
    );
  }
  if (NODE_SCRIPT_EXTENSIONS.has(extension)) {
    return { pathToClaudeCodeExecutable: resolved, executable: "node" };
  }
  return { pathToClaudeCodeExecutable: resolved };
}

export function resolveClaudeCliInvocation(
  binaryPath: string | null | undefined,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
  options: CommandResolutionOptions = {},
): ResolvedCliInvocation {
  const platform = options.platform ?? process.platform;
  if (isDefaultClaudeBinary(binaryPath)) {
    const bundled = resolveBundledClaudeExecutable(platform);
    return resolveInvocation(bundled, args, environment, options);
  }

  const sdkOptions = resolveClaudeSdkExecutableOptions(
    binaryPath,
    environment,
    platform,
    options.cwd,
  );
  const executable = sdkOptions.pathToClaudeCodeExecutable;
  if (!executable) throw new CommandNotFoundError(binaryPath ?? DEFAULT_CLAUDE_BINARY);
  if (sdkOptions.executable === "node") {
    const node = platform === "win32" ? resolveExecutable("node", environment) : process.execPath;
    if (!node) {
      throw new CommandNotFoundError(
        binaryPath ?? DEFAULT_CLAUDE_BINARY,
        `Cannot run Claude JavaScript entry '${executable}' because Node.js is unavailable.`,
      );
    }
    return { file: node, args: [executable, ...args], kind: "nodeScript" };
  }
  return { file: executable, args: [...args], kind: "native" };
}
