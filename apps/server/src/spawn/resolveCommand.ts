import { accessSync, constants, readFileSync, statSync } from "node:fs";
import * as NodePath from "node:path";
import { ensureWindowsPathHydrated } from "@t3tools/shared/windowsPath";
import { Effect } from "effect";

const DEFAULT_WINDOWS_PATH_EXTENSIONS = [".COM", ".EXE", ".BAT", ".CMD"] as const;
const MAX_CMD_SHIM_BYTES = 64 * 1024;
const NODE_SCRIPT_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);

export type ResolvedCliInvocationKind = "native" | "nodeScript" | "npmShim";

export interface ResolvedCliInvocation {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
  readonly kind: ResolvedCliInvocationKind;
}

export interface CommandResolutionOptions {
  readonly platform?: NodeJS.Platform;
  readonly useCache?: boolean;
  readonly cwd?: string | undefined;
}

export class CommandNotFoundError extends Error {
  readonly _tag = "CommandNotFoundError";
  readonly command: string;

  constructor(command: string, detail?: string) {
    super(detail ?? `Command not found: ${command}`);
    this.name = "CommandNotFoundError";
    this.command = command;
  }
}

const POSITIVE_RESOLUTION_CACHE_TTL_MS = 5_000;
const resolutionCache = new Map<string, { readonly value: string; readonly expiresAt: number }>();

function findEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === normalizedName) return value;
  }
  return undefined;
}

function resolvePathValue(env: NodeJS.ProcessEnv): string {
  return findEnvironmentValue(env, "PATH") ?? "";
}

function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const rawValue = findEnvironmentValue(env, "PATHEXT");
  if (!rawValue) return DEFAULT_WINDOWS_PATH_EXTENSIONS;

  const extensions = rawValue
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (entry.startsWith(".") ? entry : `.${entry}`).toUpperCase());
  return extensions.length > 0 ? [...new Set(extensions)] : DEFAULT_WINDOWS_PATH_EXTENSIONS;
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isPathQualified(command: string, platform: NodeJS.Platform): boolean {
  if (command.includes("/") || command.includes("\\")) return true;
  // `C:tool` is drive-relative, not absolute, but it is still an explicitly
  // qualified Windows path and must never be searched beneath every PATH entry.
  return platform === "win32" && /^[A-Za-z]:/.test(command);
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(filePath: string, platform: NodeJS.Platform): boolean {
  if (!isFile(filePath)) return false;
  if (platform === "win32") return true;
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function joinForPlatform(base: string, entry: string, platform: NodeJS.Platform): string {
  // This POSIX-root case exists for platform-simulated tests. Real Windows
  // paths are still handled exclusively with win32 semantics.
  if (platform === "win32" && base.startsWith("/")) return NodePath.join(base, entry);
  return platform === "win32" ? NodePath.win32.join(base, entry) : NodePath.posix.join(base, entry);
}

function commandCandidates(
  command: string,
  platform: NodeJS.Platform,
  pathExtensions: ReadonlyArray<string>,
  pathQualified: boolean,
): ReadonlyArray<string> {
  if (platform !== "win32") return [command];

  const extension = NodePath.win32.extname(command);
  if (
    extension.length > 0 &&
    (pathQualified ||
      pathExtensions.includes(extension.toUpperCase()) ||
      NODE_SCRIPT_EXTENSIONS.has(extension.toLowerCase()))
  ) {
    return [command];
  }

  return pathExtensions.flatMap((pathExtension) => [
    `${command}${pathExtension}`,
    `${command}${pathExtension.toLowerCase()}`,
  ]);
}

function resolutionCacheKey(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
): string {
  return [
    platform,
    command,
    resolvePathValue(env),
    platform === "win32" ? resolveWindowsPathExtensions(env).join(";") : "",
    cwd ?? "",
  ].join("\0");
}

function resolveQualifiedCandidate(
  candidate: string,
  platform: NodeJS.Platform,
  cwd: string | undefined,
): string {
  if (!cwd) return candidate;
  if (platform !== "win32") {
    return NodePath.posix.isAbsolute(candidate)
      ? candidate
      : NodePath.posix.resolve(cwd, candidate);
  }
  if (NodePath.win32.isAbsolute(candidate)) return candidate;
  // Platform-simulated tests use POSIX temporary directories while exercising
  // Windows command semantics.
  if (cwd.startsWith("/")) {
    return NodePath.resolve(cwd, candidate.replaceAll("\\", "/"));
  }
  return NodePath.win32.resolve(cwd, candidate);
}

export function clearCommandResolutionCache(): void {
  resolutionCache.clear();
}

export function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  options: CommandResolutionOptions = {},
): string | null {
  const platform = options.platform ?? process.platform;
  const useCache = options.useCache ?? true;
  const cacheKey = resolutionCacheKey(command, platform, env, options.cwd);
  const cached = useCache ? resolutionCache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  if (cached) resolutionCache.delete(cacheKey);

  const pathExtensions =
    platform === "win32" ? resolveWindowsPathExtensions(env) : ([] as ReadonlyArray<string>);
  const pathQualified = isPathQualified(command, platform);
  const candidates = commandCandidates(command, platform, pathExtensions, pathQualified);
  let resolved: string | null = null;

  if (pathQualified) {
    resolved =
      candidates
        .map((candidate) => resolveQualifiedCandidate(candidate, platform, options.cwd))
        .find((candidate) => isExecutableFile(candidate, platform)) ?? null;
  } else {
    const pathEntries = resolvePathValue(env)
      .split(platform === "win32" ? ";" : ":")
      .map(stripWrappingQuotes)
      .filter(Boolean);
    search: for (const pathEntry of pathEntries) {
      for (const candidate of candidates) {
        const candidatePath = joinForPlatform(pathEntry, candidate, platform);
        if (isExecutableFile(candidatePath, platform)) {
          resolved = candidatePath;
          break search;
        }
      }
    }
  }

  // Misses must self-heal immediately when a CLI is installed into an
  // existing PATH directory. Positive entries are bounded to avoid stale
  // executable paths after upgrades or removals.
  if (useCache && resolved) {
    resolutionCache.set(cacheKey, {
      value: resolved,
      expiresAt: Date.now() + POSITIVE_RESOLUTION_CACHE_TTL_MS,
    });
  }
  return resolved;
}

export function isCommandAvailable(
  command: string,
  options: CommandResolutionOptions & { readonly env?: NodeJS.ProcessEnv } = {},
): boolean {
  return resolveExecutable(command, options.env ?? process.env, options) !== null;
}

function resolveNodeExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  adjacentTo?: string,
): string {
  if (adjacentTo) {
    const adjacentNode = adjacentTo.startsWith("/")
      ? NodePath.join(NodePath.dirname(adjacentTo), "node.exe")
      : NodePath.win32.join(NodePath.win32.dirname(adjacentTo), "node.exe");
    if (isFile(adjacentNode)) return adjacentNode;
  }
  const node = resolveExecutable("node", env, { platform });
  if (!node) {
    throw new CommandNotFoundError(
      command,
      `Cannot run '${command}' because Node.js is not installed or not on PATH.`,
    );
  }
  return node;
}

function resolveNpmShimTarget(shimPath: string, command: string): string {
  let source: string;
  try {
    const stat = statSync(shimPath);
    if (stat.size > MAX_CMD_SHIM_BYTES) {
      throw new CommandNotFoundError(
        command,
        `Refusing to run unsupported command shim '${shimPath}' (larger than 64 KiB).`,
      );
    }
    source = readFileSync(shimPath, "utf8");
  } catch (cause) {
    if (cause instanceof CommandNotFoundError) throw cause;
    throw new CommandNotFoundError(command, `Unable to read command shim '${shimPath}'.`);
  }

  if (!/%\*/.test(source) || !/(?:\bnode(?:\.exe)?\b|%_prog%)/i.test(source)) {
    throw new CommandNotFoundError(
      command,
      `Unsupported Windows command shim '${shimPath}'; only standard npm Node.js shims are supported.`,
    );
  }

  const targetReferences = [
    ...source.matchAll(
      /(?:["']?%_prog%["']?|["']?(?:%~dp0|%dp0%)[\\/]node(?:\.exe)?["']?|\bnode(?:\.exe)?)\s+["']?(?:%~dp0|%dp0%)[\\/]([^"'\r\n]+?\.(?:cjs|mjs|js))["']?\s+%\*/gim,
    ),
  ]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));

  if (
    /%_prog%/i.test(source) &&
    (!/set\s+"?_prog=(?:%~dp0|%dp0%)[\\/]node\.exe"?/i.test(source) ||
      !/set\s+"?_prog=node"?/i.test(source))
  ) {
    throw new CommandNotFoundError(
      command,
      `Unsupported Windows command shim '${shimPath}'; its launcher is not a standard npm Node.js shim.`,
    );
  }

  const uniqueTargets = [
    ...new Set(targetReferences.map((target) => target.replace(/[\\/]+/g, "\\").toLowerCase())),
  ];
  if (uniqueTargets.length !== 1 || !targetReferences[0]) {
    throw new CommandNotFoundError(
      command,
      `Malformed Windows command shim '${shimPath}'; its Node.js branches do not resolve to one script.`,
    );
  }

  const target = shimPath.startsWith("/")
    ? NodePath.resolve(NodePath.dirname(shimPath), targetReferences[0].replaceAll("\\", "/"))
    : NodePath.win32.resolve(NodePath.win32.dirname(shimPath), targetReferences[0]);
  if (!isFile(target)) {
    throw new CommandNotFoundError(
      command,
      `Windows command shim '${shimPath}' points to missing script '${target}'.`,
    );
  }
  return target;
}

export function resolveInvocation(
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
  options: CommandResolutionOptions = {},
): ResolvedCliInvocation {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { file: command, args: [...args], kind: "native" };
  }

  const executable = resolveExecutable(command, env, options);
  if (!executable) throw new CommandNotFoundError(command);

  const extension = NodePath.win32.extname(executable).toLowerCase();
  if (extension === ".exe" || extension === ".com") {
    return { file: executable, args: [...args], kind: "native" };
  }
  if (NODE_SCRIPT_EXTENSIONS.has(extension)) {
    return {
      file: resolveNodeExecutable(command, env, platform),
      args: [executable, ...args],
      kind: "nodeScript",
    };
  }
  if (extension === ".cmd") {
    const target = resolveNpmShimTarget(executable, command);
    return {
      file: resolveNodeExecutable(command, env, platform, executable),
      args: [target, ...args],
      kind: "npmShim",
    };
  }

  throw new CommandNotFoundError(
    command,
    `Unsupported Windows command '${executable}'. Use a directly runnable .exe/.com file or a JavaScript CLI entry point.`,
  );
}

export function resolveInvocationEffect(
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
  options: CommandResolutionOptions = {},
) {
  return Effect.promise(() => ensureWindowsPathHydrated(env)).pipe(
    Effect.flatMap(() =>
      Effect.try({
        try: () => resolveInvocation(command, args, env, options),
        catch: (cause) =>
          cause instanceof CommandNotFoundError
            ? cause
            : new CommandNotFoundError(command, String(cause)),
      }),
    ),
  );
}
