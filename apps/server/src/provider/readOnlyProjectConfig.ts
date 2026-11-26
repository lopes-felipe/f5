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
import { classifyReadOnlyShellCommand } from "./readOnlyWorkflowShell.ts";

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

export async function pathExists(path: string): Promise<boolean> {
  return nodeFs.lstat(path).then(
    () => true,
    () => false,
  );
}

export async function isDirectory(path: string): Promise<boolean> {
  return nodeFs.stat(path).then(
    (stats) => stats.isDirectory(),
    () => false,
  );
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

/** Whether git tracks `file` in the repository at `root`; false when git can't say. */
export function isGitTracked(root: string, file: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", root, "ls-files", "--error-unmatch", "--", nodePath.relative(root, file)],
      { timeout: 10_000, windowsHide: true },
      (error) => resolve(!error),
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
 * F5's read-only allowlist wouldn't. Bash rules are checked with that allowlist after dropping a
 * trailing `*` or `:*`; any other wildcard can't be proven read-only.
 */
export function claudeAllowRuleBypassesReadOnly(rule: string): boolean {
  const trimmed = rule.trim();
  if (CLAUDE_WRITE_TOOLS.test(trimmed) || trimmed.startsWith("mcp__")) return true;
  if (trimmed === "Bash") return true;
  const bash = /^Bash\((.*)\)$/s.exec(trimmed);
  if (!bash) return false;
  const pattern = bash[1]!.replace(/:?\*\s*$/, "").trim();
  if (pattern === "" || pattern.includes("*")) return true;
  return !classifyReadOnlyShellCommand(pattern).readOnly;
}

/**
 * Whether Claude Code trusts `cwd`: its global config (`$CLAUDE_CONFIG_DIR/.claude.json`, else
 * `~/.claude.json`) accepted the trust dialog for it or a parent. Claude Code ignores a project's
 * allow rules in a folder it doesn't trust.
 */
export async function claudeWorkspaceTrusted(
  cwd: string,
  options: { readonly configFile: string },
): Promise<boolean> {
  let projects: unknown;
  try {
    projects = (
      JSON.parse(await nodeFs.readFile(options.configFile, "utf8")) as { projects?: unknown }
    ).projects;
  } catch {
    return false;
  }
  if (!isRecord(projects)) return false;
  for (let directory = nodePath.resolve(cwd); ; ) {
    const entry = projects[directory];
    if (isRecord(entry) && entry.hasTrustDialogAccepted === true) return true;
    const parent = nodePath.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

export function claudeGlobalConfigFile(environment: NodeJS.ProcessEnv, homeDir: string): string {
  const configDir = environment.CLAUDE_CONFIG_DIR?.trim();
  return configDir
    ? nodePath.join(configDir, ".claude.json")
    : nodePath.join(homeDir, ".claude.json");
}

/**
 * The first committed Claude settings file that would let a read-only stage act without F5's
 * checks, or undefined. Only a workspace Claude Code trusts applies a project's allow rules, and
 * only files git tracks come from the repository: an untracked `settings.local.json` holds your
 * own approvals. Project hooks are switched off separately (`disableAllHooks`).
 */
export async function findClaudeProjectConfigConflict(
  cwd: string,
  options: { readonly homeDir: string; readonly configFile: string },
): Promise<ReadOnlyProjectConfigConflict | undefined> {
  if (!(await claudeWorkspaceTrusted(cwd, { configFile: options.configFile }))) return undefined;
  const { project, repositoryRoot } = await projectDirectories(cwd, { homeDir: options.homeDir });
  if (!repositoryRoot) return undefined;
  for (const directory of project) {
    for (const name of ["settings.json", "settings.local.json"]) {
      const file = nodePath.join(directory, ".claude", name);
      if (!(await pathExists(file)) || !(await isGitTracked(repositoryRoot, file))) continue;
      const conflict = await checkProjectJson(file, "Claude", (config) => {
        const allow =
          isRecord(config) && isRecord(config.permissions) ? config.permissions.allow : undefined;
        if (!Array.isArray(allow)) return undefined;
        const rule = allow.find(
          (entry): entry is string =>
            typeof entry === "string" && claudeAllowRuleBypassesReadOnly(entry),
        );
        return rule === undefined
          ? undefined
          : `allows \`${rule}\`, which Claude would run without asking F5 in this trusted folder`;
      });
      if (conflict) return conflict;
    }
  }
  return undefined;
}

// ── OpenCode (external servers only; F5's own servers ignore project config) ─────────

export async function findOpenCodeProjectPluginConflict(
  cwd: string,
  options: { readonly homeDir?: string } = {},
): Promise<ReadOnlyProjectConfigConflict | undefined> {
  const { project } = await projectDirectories(cwd, options);
  for (const directory of project) {
    for (const folder of ["plugin", "plugins"]) {
      const pluginDir = nodePath.join(directory, ".opencode", folder);
      const entries = await nodeFs.readdir(pluginDir).catch(() => [] as string[]);
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
        (config) =>
          isRecord(config) && hasEntries(config.plugin)
            ? "loads OpenCode plugins, which run code when OpenCode starts"
            : undefined,
      );
      if (conflict) return conflict;
    }
  }
  return undefined;
}

// ── Pi ─────────────────────────────────────────────────────────────────────

export async function findPiProjectExtensionConflict(
  cwd: string,
  options: { readonly homeDir?: string } = {},
): Promise<ReadOnlyProjectConfigConflict | undefined> {
  const { project } = await projectDirectories(cwd, options);
  for (const directory of project) {
    const extensions = nodePath.join(directory, ".pi", "extensions");
    if ((await nodeFs.readdir(extensions).catch(() => [] as string[])).length > 0)
      return { file: extensions, reason: "holds Pi extensions, which run code when Pi starts" };
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
