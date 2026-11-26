/**
 * Keeps Cursor's own settings from letting commands past F5 in read-only workflow stages.
 * Cursor's ACP server runs no sandbox (docs/reviews/cursor-live-gates.md), so F5's command policy
 * is the only control, and it only sees commands Cursor asks about. Cursor runs these without
 * asking:
 *
 * - commands on `permissions.allow` in `cli-config.json`, or on `terminalAllowlist` in
 *   `permissions.json`, both in the CLI's config dir;
 * - every command when `approvalMode` is `unrestricted` or `auto-review`;
 * - the same settings from any `.cursor/cli.json` between the repository root and the working
 *   directory, which the CLI merges into the user's config;
 * - a project's `.cursor/hooks.json` hooks, which are shell commands, and the project's
 *   `.cursor/mcp.json` servers once approved (approvals live in the CLI's per-project data dir,
 *   which an earlier interactive session may have written).
 *
 * Read-only sessions therefore start with `CURSOR_CONFIG_DIR` pointing at an F5-owned copy of
 * `cli-config.json` that keeps only display, model and account-display settings, with an empty
 * allowlist and `approvalMode: "allowlist"`, and no `permissions.json`. Sign-in doesn't move: in
 * Cursor CLI 2026.11.22's source, credentials live in the OS keychain, or in `auth.json` under
 * `~/.cursor` (macOS), `$XDG_CONFIG_HOME/cursor` or `~/.config/cursor` (Linux) or `%APPDATA%`
 * (Windows), never under `CURSOR_CONFIG_DIR`; gate C1 confirmed it live on macOS with the
 * keychain only. A workspace whose project files would loosen any of the above, or that F5 can't
 * read with certainty, is refused, because F5 can't override them. Team admin allowlists are
 * applied server-side and stay out of F5's reach.
 */
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";

import { cursorCliConfigDir } from "./CursorNativeSessions.ts";

export { cursorCliConfigDir };

export function cursorReadOnlyConfigDir(providerHomesDir: string, instanceId: string): string {
  return nodePath.join(providerHomesDir, "cursor-readonly", instanceId);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Settings copied from the user's `cli-config.json`: how the CLI displays things, which model it
 * uses, and the cached account and privacy details it shows. Anything else, including settings a
 * future release adds, is dropped, so a new way to skip approval can't reach read-only stages.
 */
const KEPT_CLI_CONFIG_KEYS = [
  "version",
  "editor",
  "display",
  "notifications",
  "hints",
  "model",
  "modelParameters",
  "selectedModel",
  "maxMode",
  "hasChangedDefaultModel",
  "exploreSubagentModel",
  "privacyCache",
  "authInfo",
] as const;

/** A `cli-config.json` with only the kept settings, no allowlist and approvals always asked. */
export function sanitizeCursorCliConfig(config: unknown): Record<string, unknown> {
  const base = isRecord(config) ? config : {};
  const kept: Record<string, unknown> = {};
  for (const key of KEPT_CLI_CONFIG_KEYS) if (base[key] !== undefined) kept[key] = base[key];
  const permissions = isRecord(base.permissions) ? base.permissions : {};
  return {
    ...kept,
    // Deny rules only ever refuse more, so they stay.
    permissions: { allow: [], deny: Array.isArray(permissions.deny) ? permissions.deny : [] },
    approvalMode: "allowlist",
  };
}

/** The user's own config: unreadable or invalid means none, which only loses their settings. */
async function readUserJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await nodeFs.readFile(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Writes the read-only config dir and returns the environment to launch Cursor with. The copy is
 * rewritten on every start, so a setting the CLI saved into it during an earlier session doesn't
 * outlive that session.
 */
export async function prepareCursorReadOnlyEnvironment(input: {
  readonly providerHomesDir: string;
  readonly instanceId: string;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<NodeJS.ProcessEnv> {
  const directory = cursorReadOnlyConfigDir(input.providerHomesDir, input.instanceId);
  const source = cursorCliConfigDir(input.environment);
  const config =
    nodePath.resolve(source) === nodePath.resolve(directory)
      ? undefined
      : await readUserJson(nodePath.join(source, "cli-config.json"));
  await nodeFs.mkdir(directory, { recursive: true, mode: 0o700 });
  await nodeFs.rm(nodePath.join(directory, "permissions.json"), { force: true });
  const target = nodePath.join(directory, "cli-config.json");
  // Stages of the same instance can start at once (sessions lock per thread), so each write gets
  // its own file, created exclusively, and the rename publishes a complete config.
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await nodeFs.writeFile(
      temporary,
      `${JSON.stringify(sanitizeCursorCliConfig(config), null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    await nodeFs.rename(temporary, target);
  } catch (error) {
    await nodeFs.rm(temporary, { force: true });
    throw error;
  }
  return { ...input.environment, CURSOR_CONFIG_DIR: directory };
}

/** Project config files larger than this are refused rather than read. */
const MAX_PROJECT_CONFIG_BYTES = 256 * 1024;

type ProjectJson =
  | { readonly kind: "absent" }
  | { readonly kind: "parsed"; readonly value: unknown }
  | { readonly kind: "unsafe"; readonly reason: string };

/**
 * A repository-controlled JSON file, read so that it can't hang or mislead F5: only a regular
 * file (opened non-blocking, so a FIFO can't stall startup) within the size limit, parsed as
 * strict JSON. Anything F5 can't read with certainty is unsafe, since the CLI might still read it
 * (for example as JSON with comments).
 */
async function readProjectJson(file: string): Promise<ProjectJson> {
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
      return { kind: "unsafe", reason: "isn't strict JSON, so F5 can't tell what Cursor reads" };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { kind: "unsafe", reason: `can't be read (${code ?? "unknown error"})` };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Why a project `.cursor/cli.json` would let commands run without asking F5, or undefined.
 * Only deny rules, an empty allowlist and `approvalMode: "allowlist"` are accepted: any other
 * key, including ones a future release adds, is refused.
 */
function cliConfigConflict(config: unknown): string | undefined {
  if (!isRecord(config)) return "isn't a JSON object";
  for (const [key, value] of Object.entries(config)) {
    if (key === "permissions") continue;
    if (key === "approvalMode")
      if (value === "allowlist") continue;
      else return "sets `approvalMode`, which would let Cursor run commands without asking F5";
    return `sets \`${key}\`, which F5 doesn't recognise`;
  }
  const permissions = config.permissions;
  if (permissions === undefined) return undefined;
  if (!isRecord(permissions)) return "has a `permissions` value F5 doesn't recognise";
  for (const [key, value] of Object.entries(permissions)) {
    if (key === "deny") continue;
    if (key === "allow" && Array.isArray(value) && value.length === 0) continue;
    return key === "allow"
      ? "sets `permissions.allow`, which would let Cursor run commands without asking F5"
      : `sets \`permissions.${key}\`, which F5 doesn't recognise`;
  }
  return undefined;
}

const hasEntries = (value: unknown) =>
  isRecord(value) ? Object.keys(value).length > 0 : Array.isArray(value) && value.length > 0;

function hooksConflict(config: unknown): string | undefined {
  if (!isRecord(config)) return "isn't a JSON object";
  return hasEntries(config.hooks) ? "defines hooks, which run shell commands" : undefined;
}

function mcpConflict(config: unknown): string | undefined {
  if (!isRecord(config)) return "isn't a JSON object";
  return hasEntries(config.mcpServers)
    ? "defines MCP servers, which Cursor can start without asking F5"
    : undefined;
}

async function checkProjectFile(
  file: string,
  conflict: (config: unknown) => string | undefined,
): Promise<CursorProjectConfigConflict | undefined> {
  const read = await readProjectJson(file);
  if (read.kind === "absent") return undefined;
  const reason = read.kind === "unsafe" ? read.reason : conflict(read.value);
  return reason === undefined ? undefined : { file, reason };
}

async function isDirectory(path: string): Promise<boolean> {
  return nodeFs.stat(path).then(
    (stats) => stats.isDirectory(),
    () => false,
  );
}

async function exists(path: string): Promise<boolean> {
  return nodeFs.lstat(path).then(
    () => true,
    () => false,
  );
}

export interface CursorProjectConfigConflict {
  readonly file: string;
  readonly reason: string;
}

/**
 * The first project file that would let Cursor act without asking F5, or undefined.
 *
 * - `.cursor/cli.json` is checked in `cwd` and every ancestor up to the filesystem root. The CLI
 *   reads these from the repository root down to the working directory; checking every ancestor
 *   covers that without finding the root.
 * - `.cursor/hooks.json` and `.cursor/mcp.json` are checked from `cwd` up to the repository root
 *   (the nearest ancestor with `.git`), or in `cwd` alone outside a repository. Your home folder
 *   is skipped: `~/.cursor/hooks.json` and `~/.cursor/mcp.json` are your own user-level settings.
 */
export async function findCursorProjectConfigConflict(
  cwd: string,
  options: { readonly homeDir?: string } = {},
): Promise<CursorProjectConfigConflict | undefined> {
  const home = options.homeDir ? nodePath.resolve(options.homeDir) : undefined;
  const ancestors: string[] = [];
  for (let directory = nodePath.resolve(cwd); ; ) {
    ancestors.push(directory);
    const parent = nodePath.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  let repositoryRoot = -1;
  for (const [index, directory] of ancestors.entries()) {
    if (await exists(nodePath.join(directory, ".git"))) {
      repositoryRoot = index;
      break;
    }
  }
  for (const [index, directory] of ancestors.entries()) {
    const cursorDir = nodePath.join(directory, ".cursor");
    const cli = await checkProjectFile(nodePath.join(cursorDir, "cli.json"), cliConfigConflict);
    if (cli) return cli;
    const inProject = index <= Math.max(repositoryRoot, 0) && directory !== home;
    if (inProject && (await isDirectory(cursorDir))) {
      const hooks = await checkProjectFile(nodePath.join(cursorDir, "hooks.json"), hooksConflict);
      if (hooks) return hooks;
      const mcp = await checkProjectFile(nodePath.join(cursorDir, "mcp.json"), mcpConflict);
      if (mcp) return mcp;
    }
  }
  return undefined;
}

/** The refusal shown when a workspace's project config can't be used in a read-only stage. */
export function cursorProjectConfigConflictMessage(conflict: CursorProjectConfigConflict): string {
  return `Cursor can't run read-only workflow stages here: ${conflict.file} ${conflict.reason}. Remove or fix it, or use another provider for this stage.`;
}
