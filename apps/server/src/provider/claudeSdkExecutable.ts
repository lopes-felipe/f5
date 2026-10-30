import { javascriptRuntimeExecutable } from "@t3tools/shared/hostRuntime";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import * as NodePath from "node:path";

import { isAsarExecutablePath, resolveAsarExecutablePath } from "../spawn/asarExecutable.ts";
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

function prefersMusl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    return report != null && report.header?.glibcVersionRuntime === undefined;
  } catch {
    return false;
  }
}

export function resolveBundledClaudeExecutable(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  options: {
    readonly preferMusl?: boolean;
    readonly resolve?: (specifier: string) => string;
    readonly fileExists?: (filePath: string) => boolean;
    readonly electron?: boolean;
  } = {},
): string {
  const packageName = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  const executableName = platform === "win32" ? "claude.exe" : "claude";
  // Match the pinned SDK's libc preference and fallback order, including npm
  // installs where both Linux variants are present.
  const packages =
    platform === "linux"
      ? (options.preferMusl ?? prefersMusl())
        ? [`${packageName}-musl`, packageName]
        : [packageName, `${packageName}-musl`]
      : platform === "android"
        ? [`@anthropic-ai/claude-agent-sdk-linux-${arch}-android`]
        : [packageName];
  const fileExists = options.fileExists ?? isFile;
  const electron = options.electron ?? Boolean(process.versions.electron);
  let resolvePackage = options.resolve;
  try {
    if (!resolvePackage) {
      const require = createRequire(import.meta.url);
      const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
      resolvePackage = createRequire(sdkEntry).resolve;
    }
    for (const candidate of packages) {
      try {
        const executable = resolveAsarExecutablePath(
          resolvePackage(`${candidate}/${executableName}`),
          { electron, fileExists },
        );
        // Electron's virtual fs.stat can report an archived file as present
        // even when the physical sibling required by a native spawn is absent.
        if (electron && isAsarExecutablePath(executable)) continue;
        if (fileExists(executable)) return executable;
      } catch {
        // The SDK also tries the other libc variant when a package is missing.
      }
    }
  } catch {
    // Report dependency-resolution failures with the same actionable error.
  }
  throw new CommandNotFoundError(
    DEFAULT_CLAUDE_BINARY,
    `Bundled Claude Agent SDK executable for ${platform}-${arch} is unavailable or not unpacked. Reinstall F5, or reinstall dependencies with optional packages enabled.`,
  );
}

export function resolveClaudeSdkExecutableOptions(
  binaryPath: string | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cwd?: string,
): ClaudeSdkExecutableOptions {
  // Keep the configured default identity for profile certification, but give
  // the SDK a physical path: its require.resolve result can live inside ASAR.
  if (isDefaultClaudeBinary(binaryPath)) {
    return { pathToClaudeCodeExecutable: resolveBundledClaudeExecutable(platform) };
  }

  const command = binaryPath!.trim();
  if (platform !== "win32") {
    return NODE_SCRIPT_EXTENSIONS.has(NodePath.extname(command).toLowerCase())
      ? { pathToClaudeCodeExecutable: command, executable: "node" }
      : { pathToClaudeCodeExecutable: resolveAsarExecutablePath(command) };
  }
  const resolved = resolveExecutable(
    NODE_SCRIPT_EXTENSIONS.has(NodePath.win32.extname(command).toLowerCase())
      ? command
      : resolveAsarExecutablePath(command),
    environment,
    { platform, cwd },
  );
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
  return { pathToClaudeCodeExecutable: resolveAsarExecutablePath(resolved) };
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
    const node =
      platform === "win32" ? resolveExecutable("node", environment) : javascriptRuntimeExecutable();
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
