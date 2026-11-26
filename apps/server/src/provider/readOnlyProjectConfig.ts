/**
 * Repository-controlled provider config in read-only workflow stages.
 *
 * The code under review is untrusted, and a repository's own provider files can run commands, or
 * allow them without asking F5, outside every enforcement F5 has. Each provider's read-only stage
 * refuses such a workspace (or, where the provider can be told to ignore project config, turns
 * it off), naming the file. These helpers hold what every check shares: which folders count as
 * the project, and a JSON reader that can't hang or mislead F5.
 */
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";

import { Effect } from "effect";

import { ProviderAdapterValidationError } from "./Errors.ts";
import { classifyReadOnlyShellCommand, isPlainReadProgram } from "./readOnlyWorkflowShell.ts";

export interface ReadOnlyProjectConfigConflict {
  readonly file: string;
  readonly reason: string;
}

/** Project config files larger than this are refused rather than read. */
const MAX_PROJECT_CONFIG_BYTES = 256 * 1024;

export type ProjectJson =
  | { readonly kind: "absent" }
  | { readonly kind: "parsed"; readonly value: unknown }
  | { readonly kind: "unsafe"; readonly reason: string };

/**
 * A repository-controlled JSON file, read so that it can't hang or mislead F5: only a regular
 * file (opened non-blocking, so a FIFO can't stall startup) within the size limit, parsed as
 * strict JSON. Anything F5 can't read with certainty is unsafe, since the provider might still
 * read it (for example as JSON with comments).
 */
export async function readProjectJson(file: string, providerName: string): Promise<ProjectJson> {
  let handle: nodeFs.FileHandle;
  try {
    handle = await nodeFs.open(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "unsafe", reason: `can't be read (${code ?? "unknown error"})` };
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { kind: "unsafe", reason: "is not a regular file" };
    if (stats.size > MAX_PROJECT_CONFIG_BYTES)
      return { kind: "unsafe", reason: `is larger than ${MAX_PROJECT_CONFIG_BYTES} bytes` };
    const text = await handle.readFile("utf8");
    try {
      return { kind: "parsed", value: JSON.parse(text) as unknown };
    } catch {
      return {
        kind: "unsafe",
        reason: `isn't strict JSON, so F5 can't tell what ${providerName} reads`,
      };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { kind: "unsafe", reason: `can't be read (${code ?? "unknown error"})` };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Reads `file` and asks `conflict` about it; an unreadable file is a conflict itself. */
export async function checkProjectJson(
  file: string,
  providerName: string,
  conflict: (config: unknown) => string | undefined,
): Promise<ReadOnlyProjectConfigConflict | undefined> {
  const read = await readProjectJson(file, providerName);
  if (read.kind === "absent") return undefined;
  const reason = read.kind === "unsafe" ? read.reason : conflict(read.value);
  return reason === undefined ? undefined : { file, reason };
}

/** Only a path that isn't there is absent; any other lookup error fails the check. */
const isAbsent = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

export async function pathExists(path: string): Promise<boolean> {
  return nodeFs.lstat(path).then(
    () => true,
    (error: unknown) => {
      if (isAbsent(error)) return false;
      throw error;
    },
  );
}

export async function isDirectory(path: string): Promise<boolean> {
  return nodeFs.stat(path).then(
    (stats) => stats.isDirectory(),
    (error: unknown) => {
      if (isAbsent(error)) return false;
      throw error;
    },
  );
}

/** A folder's entries, or none when it isn't there; any other error fails the check. */
export async function readDirectoryIfPresent(path: string): Promise<ReadonlyArray<string>> {
  return nodeFs.readdir(path).catch((error: unknown) => {
    if (isAbsent(error)) return [];
    throw error;
  });
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const hasEntries = (value: unknown) =>
  isRecord(value) ? Object.keys(value).length > 0 : Array.isArray(value) && value.length > 0;

export interface ProjectDirectories {
  /** `cwd` and every ancestor up to the filesystem root, nearest first. */
  readonly ancestors: ReadonlyArray<string>;
  /**
   * `cwd` up to the repository root (the nearest ancestor with `.git`), or `cwd` alone outside a
   * repository, without the home folder: its provider files are the user's own settings.
   */
  readonly project: ReadonlyArray<string>;
  /** The repository root, when `cwd` is in one. */
  readonly repositoryRoot?: string;
}

export async function projectDirectories(
  cwd: string,
  options: { readonly homeDir?: string } = {},
): Promise<ProjectDirectories> {
  const home = options.homeDir ? nodePath.resolve(options.homeDir) : undefined;
  const ancestors: string[] = [];
  for (let directory = nodePath.resolve(cwd); ; ) {
    ancestors.push(directory);
    const parent = nodePath.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  let rootIndex = -1;
  for (const [index, directory] of ancestors.entries()) {
    if (await pathExists(nodePath.join(directory, ".git"))) {
      rootIndex = index;
      break;
    }
  }
  return {
    ancestors,
    project: ancestors.slice(0, Math.max(rootIndex, 0) + 1).filter((dir) => dir !== home),
    ...(rootIndex >= 0 ? { repositoryRoot: ancestors[rootIndex]! } : {}),
  };
}

/**
 * Whether git tracks `file` in the repository at `root`. A git that can't answer (missing, timed
 * out, a "dubious ownership" checkout) rejects, so the check fails closed instead of skipping a
 * file that may be committed.
 */
export function isGitTracked(root: string, file: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", root, "ls-files", "-z", "--", nodePath.relative(root, file)],
      { timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        if (error)
          reject(new Error(`git couldn't tell whether ${file} is committed (${error.message})`));
        else resolve(String(stdout).length > 0);
      },
    );
  });
}

/** Refusal text for a read-only stage, the same for every provider. */
export function readOnlyProjectConfigConflictMessage(
  providerName: string,
  conflict: ReadOnlyProjectConfigConflict,
): string {
  return `${providerName} can't run read-only workflow stages here: ${conflict.file} ${conflict.reason}. Remove or fix it, or use another provider for this stage.`;
}

/**
 * Fails a read-only stage's start or turn when `find` reports a conflict, or when the check
 * itself fails: F5 refuses what it can't check.
 */
export const assertReadOnlyProjectConfig = (input: {
  readonly provider: string;
  readonly providerName: string;
  readonly operation: "startSession" | "sendTurn";
  readonly find: () => Promise<ReadOnlyProjectConfigConflict | undefined>;
}) =>
  Effect.tryPromise({
    try: input.find,
    catch: (cause) =>
      new ProviderAdapterValidationError({
        provider: input.provider,
        operation: input.operation,
        issue: `${input.providerName} can't run read-only workflow stages here: F5 couldn't check the workspace's ${input.providerName} project files (${cause instanceof Error ? cause.message : String(cause)}).`,
      }),
  }).pipe(
    Effect.flatMap((conflict) =>
      conflict
        ? Effect.fail(
            new ProviderAdapterValidationError({
              provider: input.provider,
              operation: input.operation,
              issue: readOnlyProjectConfigConflictMessage(input.providerName, conflict),
            }),
          )
        : Effect.void,
    ),
  );

// ── Claude ──────────────────────────────────────────────────────────────────

const CLAUDE_WRITE_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit)(?:\(|$)/;

/**
 * Whether a Claude `permissions.allow` rule would let a read-only stage write or run a command
 * F5's read-only allowlist wouldn't. An exact Bash rule is checked with that allowlist. A rule
 * ending in `*` or `:*` matches the prefix followed by any arguments, so it passes only when the
 * prefix is a single program F5 accepts with any arguments (`cat:*`, not `git log:*` or
 * `find:*`, whose arguments can write or run commands). Any other wildcard can't be proven
 * read-only.
 */
export function claudeAllowRuleBypassesReadOnly(rule: string): boolean {
  const trimmed = rule.trim();
  if (CLAUDE_WRITE_TOOLS.test(trimmed) || trimmed.startsWith("mcp__")) return true;
  if (trimmed === "Bash") return true;
  const bash = /^Bash\((.*)\)$/s.exec(trimmed);
  if (!bash) return false;
  const body = bash[1]!.trim();
  const prefix = /^(.*?)(?::\*|\s*\*)$/s.exec(body)?.[1]?.trim();
  if (prefix !== undefined) return !/^[\w.[-]+$/.test(prefix) || !isPlainReadProgram(prefix);
  if (body === "" || body.includes("*")) return true;
  return !classifyReadOnlyShellCommand(body).readOnly;
}

/**
 * Settings that make Claude Code run a command of the file's choosing, outside its tool
 * permissions and hooks: credential and telemetry helpers, and the status line.
 */
const CLAUDE_COMMAND_SETTINGS = [
  "apiKeyHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "otelHeadersHelper",
  "statusLine",
] as const;

/**
 * Environment variables a project may set for a read-only stage. Anything else could change what
 * an approved command runs (`PATH`, `GIT_EXTERNAL_DIFF`, `PAGER`, `CLAUDE_CODE_SHELL_PREFIX`) or
 * where Claude sends the code (`ANTHROPIC_BASE_URL`), so it is refused.
 */
const CLAUDE_SAFE_PROJECT_ENV = new Set([
  "MAX_THINKING_TOKENS",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "MAX_MCP_OUTPUT_TOKENS",
  "BASH_DEFAULT_TIMEOUT_MS",
  "BASH_MAX_TIMEOUT_MS",
  "BASH_MAX_OUTPUT_LENGTH",
  "DISABLE_TELEMETRY",
  "DISABLE_ERROR_REPORTING",
  "DISABLE_AUTOUPDATER",
  "DISABLE_NON_ESSENTIAL_MODEL_CALLS",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
]);

/** Permission modes that let Claude act without asking. */
const CLAUDE_PERMISSIVE_MODES = new Set(["acceptEdits", "bypassPermissions", "dontAsk", "auto"]);

/**
 * Why committed Claude settings would let a read-only stage run something F5 doesn't check, or
 * undefined. Command settings, environment and the default mode count in every folder; allow rules
 * only where Claude Code trusts the folder (`trusted`), since it ignores them elsewhere (gate L1).
 */
export function claudeProjectSettingsConflict(
  config: unknown,
  trusted: boolean,
): string | undefined {
  if (!isRecord(config)) return undefined;
  const command = CLAUDE_COMMAND_SETTINGS.find((key) => config[key] !== undefined);
  if (command) return `sets \`${command}\`, a command Claude Code runs without asking F5`;
  if (config.env !== undefined) {
    if (!isRecord(config.env)) return "sets `env` in a form F5 can't check";
    const unsafe = Object.keys(config.env).find((key) => !CLAUDE_SAFE_PROJECT_ENV.has(key));
    if (unsafe)
      return `sets the environment variable \`${unsafe}\`, which can change what commands F5 approves actually run`;
  }
  const permissions = isRecord(config.permissions) ? config.permissions : undefined;
  if (
    typeof permissions?.defaultMode === "string" &&
    CLAUDE_PERMISSIVE_MODES.has(permissions.defaultMode)
  )
    return `sets \`permissions.defaultMode\` to \`${permissions.defaultMode}\`, which lets Claude act without asking F5`;
  if (!trusted || !Array.isArray(permissions?.allow)) return undefined;
  const rule = permissions.allow.find(
    (entry): entry is string => typeof entry === "string" && claudeAllowRuleBypassesReadOnly(entry),
  );
  return rule === undefined
    ? undefined
    : `allows \`${rule}\`, which Claude would run without asking F5 in this trusted folder`;
}

/**
 * Whether Claude Code trusts `cwd`: its global config (`$CLAUDE_CONFIG_DIR/.claude.json`, else
 * `~/.claude.json`) accepted the trust dialog for it or a parent. Claude Code ignores a project's
 * allow rules in a folder it doesn't trust. A missing config means nothing is trusted; one that
 * exists but can't be read or parsed rejects, so the check fails closed. The folder is looked up
 * as given and by its real path, with native and forward-slash separators.
 */
export async function claudeWorkspaceTrusted(
  cwd: string,
  options: { readonly configFile: string },
): Promise<boolean> {
  let text: string;
  try {
    text = await nodeFs.readFile(options.configFile, "utf8");
  } catch (error) {
    if (isAbsent(error)) return false;
    throw error;
  }
  let projects: unknown;
  try {
    projects = (JSON.parse(text) as { projects?: unknown } | null)?.projects;
  } catch {
    throw new Error(
      `${options.configFile} isn't valid JSON, so F5 can't tell which folders Claude trusts`,
    );
  }
  if (!isRecord(projects)) return false;
  const starts = new Set([nodePath.resolve(cwd)]);
  starts.add(await nodeFs.realpath(cwd).catch(() => nodePath.resolve(cwd)));
  for (const start of starts) {
    for (let directory = start; ; ) {
      for (const key of new Set([directory, directory.replaceAll("\\", "/")])) {
        const entry = projects[key];
        if (isRecord(entry) && entry.hasTrustDialogAccepted === true) return true;
      }
      const parent = nodePath.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return false;
}

/**
 * Claude Code's global config for a stage in `cwd`: `$CLAUDE_CONFIG_DIR/.claude.json`, resolved
 * against `cwd` as the child resolves it (`resolveClaudeConfigDir`), else `~/.claude.json`.
 */
export function claudeGlobalConfigFile(
  environment: NodeJS.ProcessEnv,
  homeDir: string,
  cwd: string,
): string {
  const configDir = environment.CLAUDE_CONFIG_DIR;
  return configDir
    ? nodePath.join(nodePath.resolve(cwd, configDir.normalize("NFC")), ".claude.json")
    : nodePath.join(homeDir, ".claude.json");
}

/**
 * The first committed Claude settings file that would let a read-only stage act without F5's
 * checks, or undefined (`claudeProjectSettingsConflict`). In a repository only files git tracks
 * come from it: an untracked `settings.local.json` holds your own approvals. Outside one (an
 * exported tree) every settings file is treated as part of the code under review. Project hooks
 * are switched off separately (`disableAllHooks`).
 */
export async function findClaudeProjectConfigConflict(
  cwd: string,
  options: { readonly homeDir: string; readonly configFile: string },
): Promise<ReadOnlyProjectConfigConflict | undefined> {
  const trusted = await claudeWorkspaceTrusted(cwd, { configFile: options.configFile });
  const { project, repositoryRoot } = await projectDirectories(cwd, { homeDir: options.homeDir });
  for (const directory of project) {
    for (const name of ["settings.json", "settings.local.json"]) {
      const file = nodePath.join(directory, ".claude", name);
      if (!(await pathExists(file))) continue;
      if (repositoryRoot && !(await isGitTracked(repositoryRoot, file))) continue;
      const conflict = await checkProjectJson(file, "Claude", (config) =>
        claudeProjectSettingsConflict(config, trusted),
      );
      if (conflict) return conflict;
    }
  }
  return undefined;
}

// ── OpenCode (external servers only; F5's own servers ignore project config) ─────────

/**
 * Why a project `opencode.json` would make an external OpenCode server run a program of the
 * repository's choosing, or undefined: plugins, local MCP servers (started when the workspace is
 * opened, whatever the tool permissions), and LSP servers or formatters with their own command.
 */
export function openCodeProjectConfigConflict(config: unknown): string | undefined {
  if (!isRecord(config)) return undefined;
  if (hasEntries(config.plugin))
    return "loads OpenCode plugins, which run code when OpenCode starts";
  if (isRecord(config.mcp)) {
    const local = Object.entries(config.mcp).find(
      ([, server]) => isRecord(server) && server.type !== "remote" && server.enabled !== false,
    );
    if (local)
      return `defines the local MCP server \`${local[0]}\`, which OpenCode starts with the workspace`;
  }
  for (const key of ["lsp", "formatter"] as const) {
    const section = config[key];
    if (!isRecord(section)) continue;
    const custom = Object.entries(section).find(
      ([, entry]) => isRecord(entry) && entry.command !== undefined && entry.disabled !== true,
    );
    if (custom)
      return `defines the ${key === "lsp" ? "LSP server" : "formatter"} \`${custom[0]}\` with its own command, which OpenCode runs on files it reads or edits`;
  }
  return undefined;
}

export async function findOpenCodeProjectPluginConflict(
  cwd: string,
  options: { readonly homeDir?: string } = {},
): Promise<ReadOnlyProjectConfigConflict | undefined> {
  const { project } = await projectDirectories(cwd, options);
  for (const directory of project) {
    for (const folder of ["plugin", "plugins"]) {
      const pluginDir = nodePath.join(directory, ".opencode", folder);
      const entries = await readDirectoryIfPresent(pluginDir);
      const plugin = entries.find((name) => /\.(?:ts|js)$/.test(name));
      if (plugin)
        return {
          file: nodePath.join(pluginDir, plugin),
          reason: "is an OpenCode plugin, which runs code when OpenCode starts",
        };
    }
    for (const name of [
      "opencode.json",
      "opencode.jsonc",
      nodePath.join(".opencode", "opencode.json"),
      nodePath.join(".opencode", "opencode.jsonc"),
    ]) {
      const conflict = await checkProjectJson(
        nodePath.join(directory, name),
        "OpenCode",
        openCodeProjectConfigConflict,
      );
      if (conflict) return conflict;
    }
  }
  return undefined;
}

// ── Pi ─────────────────────────────────────────────────────────────────────

/**
 * The first entry of a `.pi/extensions` folder Pi would load: a `.ts` or `.js` file, or a folder
 * with an `index.ts`, `index.js` or `package.json` (whose `pi` manifest can name entry points).
 * A README or `.gitkeep` loads nothing.
 */
async function firstPiExtension(extensions: string): Promise<string | undefined> {
  for (const name of [...(await readDirectoryIfPresent(extensions))].sort()) {
    const entry = nodePath.join(extensions, name);
    if (/\.(?:ts|js)$/.test(name) && !(await isDirectory(entry))) return entry;
    if (!(await isDirectory(entry))) continue;
    for (const marker of ["package.json", "index.ts", "index.js"])
      if (await pathExists(nodePath.join(entry, marker))) return entry;
  }
  return undefined;
}

export async function findPiProjectExtensionConflict(
  cwd: string,
  options: { readonly homeDir?: string } = {},
): Promise<ReadOnlyProjectConfigConflict | undefined> {
  const { project } = await projectDirectories(cwd, options);
  for (const directory of project) {
    const extension = await firstPiExtension(nodePath.join(directory, ".pi", "extensions"));
    if (extension)
      return { file: extension, reason: "is a Pi extension, which runs code when Pi starts" };
    const conflict = await checkProjectJson(
      nodePath.join(directory, ".pi", "settings.json"),
      "Pi",
      (config) =>
        isRecord(config) && (hasEntries(config.packages) || hasEntries(config.extensions))
          ? "loads Pi packages or extensions, which run code when Pi starts"
          : undefined,
    );
    if (conflict) return conflict;
  }
  return undefined;
}

// ── Antigravity ────────────────────────────────────────────────────────────

/** `{}`, `[]`, or objects holding only those: a hooks file shaped like that defines nothing. */
const isEmptyContainer = (value: unknown): boolean =>
  (Array.isArray(value) && value.length === 0) ||
  (isRecord(value) && Object.values(value).every(isEmptyContainer));

const definesHooks = (config: unknown) => !isEmptyContainer(config);

export async function findAntigravityProjectHooksConflict(
  cwd: string,
  options: { readonly homeDir?: string } = {},
): Promise<ReadOnlyProjectConfigConflict | undefined> {
  const { project } = await projectDirectories(cwd, options);
  for (const directory of project) {
    for (const folder of [".agents", "_agents"]) {
      const conflict = await checkProjectJson(
        nodePath.join(directory, folder, "hooks.json"),
        "Antigravity",
        (config) => (definesHooks(config) ? "defines hooks, which run shell commands" : undefined),
      );
      if (conflict) return conflict;
    }
  }
  return undefined;
}
