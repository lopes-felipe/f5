import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import * as NodePath from "node:path";
import { promisify } from "node:util";
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

const MAX_PATH_DIRECTORY_LISTINGS = 1024;
const PATH_DIRECTORY_SETTLE_MS = 2_000;
const EMPTY_DIRECTORY = new Set<string>();
const pathDirectoryListings = new Map<
  string,
  { readonly info: Stats; readonly names: Promise<ReadonlySet<string> | undefined> }
>();

async function listPathDirectory(directory: string): Promise<ReadonlySet<string> | undefined> {
  const info = await stat(directory).catch((cause: NodeJS.ErrnoException) =>
    cause.code === "ENOENT" || cause.code === "ENOTDIR" ? null : undefined,
  );
  if (!info || !info.isDirectory()) {
    pathDirectoryListings.delete(directory);
    return info === undefined ? undefined : EMPTY_DIRECTORY;
  }

  const cached = pathDirectoryListings.get(directory);
  if (
    cached &&
    cached.info.mtimeMs === info.mtimeMs &&
    cached.info.ino === info.ino &&
    cached.info.dev === info.dev
  ) {
    return cached.names;
  }
  pathDirectoryListings.delete(directory);
  // Relative directories depend on the working directory. Recent changes can
  // share an mtime on filesystems with coarse timestamps (FAT has a 2 s step).
  const absolute =
    process.platform === "win32"
      ? /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(directory)
      : NodePath.isAbsolute(directory);
  const reusable = absolute && Date.now() - info.mtimeMs >= PATH_DIRECTORY_SETTLE_MS;
  const names = readdir(directory).then(
    (entries) => new Set(entries.map((name) => name.toLowerCase())),
    () => undefined,
  );
  if (!reusable) return names;

  const listing = { info, names };
  if (pathDirectoryListings.size >= MAX_PATH_DIRECTORY_LISTINGS) {
    const oldest = pathDirectoryListings.keys().next().value;
    if (oldest !== undefined) pathDirectoryListings.delete(oldest);
  }
  pathDirectoryListings.set(directory, listing);
  const result = await names;
  if (result === undefined && pathDirectoryListings.get(directory) === listing) {
    pathDirectoryListings.delete(directory);
  }
  return result;
}

// Listings omit 8.3 aliases and cannot account for trailing-dot normalization
// or differences between JavaScript and Windows Unicode case folding.
const LISTED_NAME_PATTERN = /^[\w.+-]*[\w+-]$/;

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
let resolutionCache = new Map<string, { readonly value: string; readonly expiresAt: number }>();

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

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isExecutableFile(filePath: string, platform: NodeJS.Platform): Promise<boolean> {
  if (!(await isFile(filePath))) return false;
  if (platform === "win32") return true;
  try {
    await access(filePath, constants.X_OK);
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
  resolutionCache = new Map();
  pendingXcodeGitLookups = new Map();
  pathDirectoryListings.clear();
}

async function findExecutables(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  cwd: string | undefined,
  firstOnly: boolean,
): Promise<string[]> {
  const pathExtensions =
    platform === "win32" ? resolveWindowsPathExtensions(env) : ([] as ReadonlyArray<string>);
  const pathQualified = isPathQualified(command, platform);
  const candidates = commandCandidates(command, platform, pathExtensions, pathQualified);

  if (pathQualified) {
    for (const candidate of candidates) {
      const candidatePath = resolveQualifiedCandidate(candidate, platform, cwd);
      if (await isExecutableFile(candidatePath, platform)) return [candidatePath];
    }
    return [];
  }

  // Skip exact repeats only. Windows can make a directory case-sensitive, so
  // entries that differ in case are not provably the same directory.
  const pathEntries = new Set(
    resolvePathValue(env)
      .split(platform === "win32" ? ";" : ":")
      .map(stripWrappingQuotes)
      .filter(Boolean),
  );
  const found: string[] = [];
  for (const pathEntry of pathEntries) {
    const names = platform === "win32" ? await listPathDirectory(pathEntry) : undefined;
    for (const candidate of candidates) {
      if (names && LISTED_NAME_PATTERN.test(candidate) && !names.has(candidate.toLowerCase()))
        continue;
      const candidatePath = joinForPlatform(pathEntry, candidate, platform);
      if (await isExecutableFile(candidatePath, platform)) {
        found.push(candidatePath);
        if (firstOnly) return found;
        // One match per directory, as PATH lookup would pick it.
        break;
      }
    }
  }
  return found;
}

/**
 * Every executable match for `command`, in PATH order and at most one per PATH
 * entry. Used where the first match may be a launcher that must be skipped.
 * Not cached.
 */
export function resolveExecutables(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<CommandResolutionOptions, "useCache"> = {},
): Promise<string[]> {
  return findExecutables(command, env, options.platform ?? process.platform, options.cwd, false);
}

export async function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  options: CommandResolutionOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const useCache = options.useCache ?? true;
  // An update can clear the cache while this lookup is waiting on filesystem I/O.
  const cache = resolutionCache;
  const cacheKey = resolutionCacheKey(command, platform, env, options.cwd);
  const cached = useCache ? cache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  if (cached) cache.delete(cacheKey);

  const resolved = (await findExecutables(command, env, platform, options.cwd, true))[0] ?? null;

  // Misses must self-heal immediately when a CLI is installed into an
  // existing PATH directory. Positive entries are bounded to avoid stale
  // executable paths after upgrades or removals.
  if (useCache && resolved) {
    cache.set(cacheKey, {
      value: resolved,
      expiresAt: Date.now() + POSITIVE_RESOLUTION_CACHE_TTL_MS,
    });
  }
  return resolved;
}

// Git for Windows 2.56 moved x64 builds from mingw64 to ucrt64; ARM64 builds
// live in clangarm64 and 32-bit ones in mingw32.
const GIT_FOR_WINDOWS_BUILDS = ["ucrt64", "clangarm64", "mingw64", "mingw32"] as const;

// Exact forms that cannot start hooks, helpers, pagers, editors or lazy fetches.
const CONSOLE_FREE_GIT_READS = [
  "rev-parse --git-path index",
  "rev-parse --path-format=absolute --git-path index",
  "rev-parse --path-format=absolute --git-path MERGE_HEAD",
  "rev-parse --path-format=absolute --git-common-dir",
  "rev-parse --path-format=absolute --show-toplevel",
  "rev-parse --git-common-dir",
  "rev-parse --show-toplevel",
  "rev-parse --symbolic-full-name HEAD",
  "rev-parse --abbrev-ref --symbolic-full-name @{upstream}",
  "symbolic-ref --quiet HEAD",
  "symbolic-ref *",
  "remote",
  "remote -v",
  "remote get-url *",
  "remote get-url -- *",
  "config --get *",
  "config --get -- *",
].map((form) => form.split(" "));

export function runsGitWithoutConsole(
  platform: NodeJS.Platform,
  executable: string,
  args: ReadonlyArray<string>,
): boolean {
  if (platform !== "win32") return false;
  const { basename, dirname } = NodePath.win32;
  const bin = dirname(executable);
  const build = basename(dirname(bin)).toLowerCase();
  if (basename(executable).toLowerCase() !== "git.exe" || basename(bin).toLowerCase() !== "bin")
    return false;
  if (!GIT_FOR_WINDOWS_BUILDS.some((candidate) => candidate === build)) return false;
  const rest =
    args[0] === "--git-dir" && args[1] !== undefined && !args[1].startsWith("-")
      ? args.slice(2)
      : args;
  return CONSOLE_FREE_GIT_READS.some(
    (form) =>
      form.length === rest.length &&
      form.every((part, i) => part === rest[i] || (part === "*" && !rest[i]!.startsWith("-"))),
  );
}

/**
 * Swaps Git for Windows' launcher (`<Git>\cmd\git.exe`, the only git its
 * installer puts on PATH, or the portable build's `<Git>\bin\git.exe`) for the
 * git.exe it starts. The launcher costs a second process on every git command,
 * and each launch leaks a kernel token reference that slows process creation
 * machine-wide until reboot. The real binary sets HOME itself, but adds its own
 * folders to PATH for hooks, ssh and credential helpers only when MSYSTEM is
 * unset, so the launcher stays when MSYSTEM is set. Anything else is returned
 * as is.
 */
export async function preferGitForWindowsBinary(
  executable: string,
  env: NodeJS.ProcessEnv,
  fileExists: (filePath: string) => boolean | Promise<boolean> = isFile,
): Promise<string> {
  if (findEnvironmentValue(env, "MSYSTEM")) return executable;
  const path = NodePath.win32;
  if (path.basename(executable).toLowerCase() !== "git.exe") return executable;
  const launcherDirectory = path.dirname(executable);
  const launcherFolder = path.basename(launcherDirectory).toLowerCase();
  if (launcherFolder !== "cmd" && launcherFolder !== "bin") return executable;
  const installRoot = path.dirname(launcherDirectory);
  for (const build of GIT_FOR_WINDOWS_BUILDS) {
    const candidate = path.join(installRoot, build, "bin", "git.exe");
    if (await fileExists(candidate)) return candidate;
  }
  return executable;
}

export type XcodeGitLocator = (
  env: NodeJS.ProcessEnv,
) => string | undefined | Promise<string | undefined>;

// xcrun honors DEVELOPER_DIR and the `xcode-select` choice, as the shim does.
const execFileAsync = promisify(execFile);
async function locateXcodeGitWithXcrun(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/xcrun", ["--find", "git"], {
      encoding: "utf8",
      env,
      timeout: 5_000,
    });
    const located = stdout.trim();
    return NodePath.posix.isAbsolute(located) ? located : undefined;
  } catch {
    return undefined;
  }
}

const MACOS_GIT_SHIM = "/usr/bin/git";
const XCODE_GIT_CACHE_TTL_MS = 30_000;
let pendingXcodeGitLookups = new Map<string, Promise<string>>();

// An injected locator may answer differently for the same PATH, so its entries
// are kept apart from every other locator's.
let xcodeGitLocatorIdCount = 0;
const xcodeGitLocatorIds = new WeakMap<XcodeGitLocator, number>();
function xcodeGitLocatorId(locator: XcodeGitLocator): number {
  let id = xcodeGitLocatorIds.get(locator);
  if (id === undefined) {
    id = xcodeGitLocatorIdCount++;
    xcodeGitLocatorIds.set(locator, id);
  }
  return id;
}

export interface GitExecutableOptions {
  readonly locateXcodeGit?: XcodeGitLocator;
  /** The xcrun shim's path; only tests change it. */
  readonly macosGitShim?: string;
}

/**
 * /usr/bin/git is an xcrun shim that finds the active developer directory on
 * every run: about 8 ms per spawn, against under 3 ms for the git behind it.
 * Only the shim is replaced, so a git the user put first on PATH (Homebrew,
 * Nix) still wins, and git's own children keep the same PATH. Any lookup
 * failure keeps plain `git`.
 */
async function resolveMacosGit(
  env: NodeJS.ProcessEnv,
  options: GitExecutableOptions,
): Promise<string> {
  const locateXcodeGit = options.locateXcodeGit ?? locateXcodeGitWithXcrun;
  const shim = options.macosGitShim ?? MACOS_GIT_SHIM;
  const cache = resolutionCache;
  const pendingLookups = pendingXcodeGitLookups;
  const cacheKey = [
    resolutionCacheKey("git", "darwin", env, undefined),
    "xcode-git",
    env.DEVELOPER_DIR ?? "",
    shim,
    String(xcodeGitLocatorId(locateXcodeGit)),
  ].join("\0");
  const pending = pendingLookups.get(cacheKey);
  if (pending) return pending;

  const lookup = (async () => {
    const cached = cache.get(cacheKey);
    // An Xcode update or removal deletes the binary; look again instead of failing the spawn.
    if (
      cached &&
      cached.expiresAt > Date.now() &&
      (cached.value === "git" || (await isExecutableFile(cached.value, "darwin")))
    ) {
      return cached.value;
    }
    const located =
      (await resolveExecutable("git", env, { platform: "darwin" })) === shim
        ? await locateXcodeGit(env)
        : undefined;
    const resolved =
      located !== undefined && (await isExecutableFile(located, "darwin")) ? located : "git";
    cache.set(cacheKey, {
      value: resolved,
      expiresAt: Date.now() + XCODE_GIT_CACHE_TTL_MS,
    });
    return resolved;
  })().finally(() => pendingLookups.delete(cacheKey));
  pendingLookups.set(cacheKey, lookup);
  return lookup;
}

/**
 * The executable to spawn for git. On Linux, and when PATH holds a git.cmd
 * wrapper (which would need cmd.exe, cutting multi-line commit messages at the
 * first newline), this stays `git` for the platform's own lookup. On macOS the
 * xcrun shim is skipped (see `resolveMacosGit`).
 */
export async function resolveGitExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  options: GitExecutableOptions = {},
): Promise<string> {
  if (platform === "darwin") return resolveMacosGit(env, options);
  if (platform !== "win32") return "git";
  const cache = resolutionCache;
  const cacheKey = `${resolutionCacheKey("git", platform, env, undefined)}\0real-git\0${
    findEnvironmentValue(env, "MSYSTEM") ? "msystem" : ""
  }`;
  const cached = cache.get(cacheKey);
  // Cached with the PATH scan: its file checks would otherwise run before every
  // git launch.
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const found = await resolveExecutable("git", env, { platform });
  const resolved =
    found && NodePath.win32.extname(found).toLowerCase() === ".exe"
      ? await preferGitForWindowsBinary(found, env)
      : "git";
  cache.set(cacheKey, {
    value: resolved,
    expiresAt: Date.now() + POSITIVE_RESOLUTION_CACHE_TTL_MS,
  });
  return resolved;
}

export async function isCommandAvailable(
  command: string,
  options: CommandResolutionOptions & { readonly env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  return (await resolveExecutable(command, options.env ?? process.env, options)) !== null;
}

async function resolveNodeExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  adjacentTo?: string,
): Promise<string> {
  if (adjacentTo) {
    const adjacentNode = adjacentTo.startsWith("/")
      ? NodePath.join(NodePath.dirname(adjacentTo), "node.exe")
      : NodePath.win32.join(NodePath.win32.dirname(adjacentTo), "node.exe");
    if (await isFile(adjacentNode)) return adjacentNode;
  }
  const node = await resolveExecutable("node", env, { platform });
  if (!node) {
    throw new CommandNotFoundError(
      command,
      `Cannot run '${command}' because Node.js is not installed or not on PATH.`,
    );
  }
  return node;
}

// What npm's cmd-shim writes for a package whose bin is a native executable.
const NPM_EXECUTABLE_SHIM_PREFIX = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
];
const NPM_EXECUTABLE_SHIM_RUN = /^"%dp0%\\([^"%]+\.exe)" +%\*$/;

async function readShimSource(shimPath: string): Promise<string | undefined> {
  try {
    if ((await stat(shimPath)).size > MAX_CMD_SHIM_BYTES) return undefined;
    return await readFile(shimPath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The executable an npm cmd-shim runs, when the shim does nothing else (as
 * `npm install -g opencode-ai` writes for opencode.exe). Started directly, the
 * executable stays in the kill-on-close job libuv puts every child in, so it
 * stops when this process is killed.
 */
export async function npmShimExecutable(
  shimPath: string,
  readSource: (
    filePath: string,
  ) => string | undefined | Promise<string | undefined> = readShimSource,
  fileExists: (filePath: string) => boolean | Promise<boolean> = isFile,
): Promise<string | undefined> {
  if (NodePath.win32.extname(shimPath).toLowerCase() !== ".cmd") return undefined;
  // Compared exactly: whitespace CMD keeps, such as after `SET dp0=`, would
  // make it run a different file than the one found here.
  const lines = (await readSource(shimPath))?.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines?.length !== NPM_EXECUTABLE_SHIM_PREFIX.length + 1) return undefined;
  if (NPM_EXECUTABLE_SHIM_PREFIX.some((expected, index) => lines[index] !== expected)) {
    return undefined;
  }
  const target = NPM_EXECUTABLE_SHIM_RUN.exec(lines.at(-1)!)?.[1];
  if (target === undefined) return undefined;
  // Platform-simulated tests use POSIX temporary directories.
  const executable = shimPath.startsWith("/")
    ? NodePath.join(NodePath.dirname(shimPath), target.replaceAll("\\", "/"))
    : NodePath.win32.join(NodePath.win32.dirname(shimPath), target);
  return (await fileExists(executable)) ? executable : undefined;
}

async function resolveNpmShimTarget(shimPath: string, command: string): Promise<string> {
  let source: string;
  try {
    if ((await stat(shimPath)).size > MAX_CMD_SHIM_BYTES) {
      throw new CommandNotFoundError(
        command,
        `Refusing to run unsupported command shim '${shimPath}' (larger than 64 KiB).`,
      );
    }
    source = await readFile(shimPath, "utf8");
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
  if (!(await isFile(target))) {
    throw new CommandNotFoundError(
      command,
      `Windows command shim '${shimPath}' points to missing script '${target}'.`,
    );
  }
  return target;
}

export async function resolveInvocation(
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
  options: CommandResolutionOptions = {},
): Promise<ResolvedCliInvocation> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { file: command, args: [...args], kind: "native" };
  }

  const executable = await resolveExecutable(command, env, options);
  if (!executable) throw new CommandNotFoundError(command);

  const extension = NodePath.win32.extname(executable).toLowerCase();
  if (extension === ".exe" || extension === ".com") {
    return { file: executable, args: [...args], kind: "native" };
  }
  if (NODE_SCRIPT_EXTENSIONS.has(extension)) {
    return {
      file: await resolveNodeExecutable(command, env, platform),
      args: [executable, ...args],
      kind: "nodeScript",
    };
  }
  if (extension === ".cmd") {
    const shimExecutable = await npmShimExecutable(executable);
    if (shimExecutable !== undefined) {
      return { file: shimExecutable, args: [...args], kind: "native" };
    }
    const target = await resolveNpmShimTarget(executable, command);
    return {
      file: await resolveNodeExecutable(command, env, platform, executable),
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
      Effect.tryPromise({
        try: () => resolveInvocation(command, args, env, options),
        catch: (cause) =>
          cause instanceof CommandNotFoundError
            ? cause
            : new CommandNotFoundError(command, String(cause)),
      }),
    ),
  );
}
