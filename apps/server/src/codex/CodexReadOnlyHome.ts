/**
 * Keeps Codex's execution-policy rules from letting commands past F5 in read-only workflow stages.
 *
 * Codex runs a command that matches an `allow` rule in a `.rules` file outside its sandbox and
 * without asking anyone (docs/reviews/cursor-live-gates.md, "Codex read-only escalation", G4
 * control). It loads rules from `$CODEX_HOME/rules` and from a project's `.codex/rules`, so either
 * would bypass F5's read-only policy in every enforcement mode.
 *
 * Read-only stages therefore run with `CODEX_HOME` pointing at an F5-owned home that links every
 * entry of the instance's own home except `rules`: sign-in, config, sessions and caches stay
 * shared, so session history and resume keep working. A workspace with its own `.codex/rules` is
 * refused, because F5 can't evaluate Starlark rules with certainty. System rules
 * (`/etc/codex/rules`) are the administrator's and stay in force.
 *
 * Sign-in must stay one credential, never two (Codex 0.170 `login/src/auth/storage*.rs`):
 * - `auth.json` is a symbolic link on every platform. Codex resolves symlinks before it replaces
 *   the file, so a refreshed token lands in the instance's own `auth.json`; it refuses to replace a
 *   hard-linked file, and a copy could rotate here and sign the user out of their own home.
 * - The stage runs with file credential storage (`codexReadOnlyStageConfigArgs`): a keyring
 *   entry is keyed by the canonical `CODEX_HOME`, so in `auto` mode a refresh would land in a
 *   second keyring entry and drop the `auth.json` link. A sign-in kept only in the keyring can't be
 *   shared with this home at all, so such an instance is refused.
 */
import * as nodeFs from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import { expandHomePath } from "../pathExpansion.ts";
import {
  KNOWN_SHARED_DIRECTORIES,
  SHADOW_LOCAL_ENTRY_NAMES,
  hasKnownFileIdentity,
  normalizeWindowsLinkPath,
} from "../provider/Drivers/CodexHomeLayout.ts";

/**
 * Entries of the instance's home a read-only stage never sees, matched without case: on a
 * case-insensitive filesystem Codex would read a `Rules` link as `rules`.
 */
const EXCLUDED_ENTRY_NAMES: ReadonlySet<string> = new Set(["rules"]);
const isExcludedEntry = (name: string) => EXCLUDED_ENTRY_NAMES.has(name.toLowerCase());

const AUTH_FILE_NAME = "auth.json";

/**
 * Codex's SQLite databases and their side files. They are never linked: SQLite keeps a database's
 * `-wal` and `-shm` next to the path it opened, so two processes reaching one database through
 * different links (Windows hard links) can corrupt it. The stage opens them in the instance's home
 * instead (`sqlite_home` below).
 */
const isSqliteEntry = (name: string) => /\.sqlite(?:-wal|-shm|-journal)?$/i.test(name);

/**
 * Locks that guard state the two homes share. They are created in the instance's home ahead of
 * time, so both processes take the same lock even when the stage starts first.
 */
const SHARED_LOCK_DIRECTORIES = ["mcp-oauth-locks"] as const;
const SHARED_LOCK_FILES = ["auth.lock"] as const;

/**
 * Codex config for every read-only stage's app-server:
 * - file credential storage, so the linked `auth.json` stays the only credential (see above);
 * - the default project-root markers, so Codex reads project `.codex` layers from exactly the
 *   folders `findCodexProjectRulesConflict` checks;
 * - the SQLite folder the instance's own sessions use (`sharedSqliteHome`), so its databases are
 *   opened through one path.
 * Managed config still wins over all three. `environment` is the stage's child environment.
 */
export async function codexReadOnlyStageConfigArgs(
  sourceHome: string,
  environment: NodeJS.ProcessEnv,
): Promise<ReadonlyArray<string>> {
  const sqliteHome = await sharedSqliteHome(nodePath.resolve(sourceHome), environment);
  return [
    "-c",
    'cli_auth_credentials_store="file"',
    "-c",
    'project_root_markers=[".git"]',
    ...(sqliteHome ? ["-c", `sqlite_home=${JSON.stringify(sqliteHome)}`] : []),
  ];
}

/**
 * Where the stage must open SQLite to share the instance's databases, or undefined when Codex
 * already resolves the same folder in both homes. Codex 0.170 uses `sqlite_home` from config, else
 * `$CODEX_SQLITE_HOME`, else `CODEX_HOME`. The stage's `config.toml` is a link to the instance's,
 * so an absolute `sqlite_home` and the inherited variable already agree; a relative `sqlite_home`
 * resolves against the config's folder, and the `CODEX_HOME` default differs, so both are pinned to
 * the instance's home.
 */
async function sharedSqliteHome(
  source: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const configured = await topLevelConfigString(source, "sqlite_home");
  if (configured !== undefined && configured.trim() !== "") {
    const value = configured.trim();
    return nodePath.isAbsolute(value) || value.startsWith("~")
      ? undefined
      : nodePath.resolve(source, value);
  }
  return environment.CODEX_SQLITE_HOME?.trim() ? undefined : source;
}

export class CodexReadOnlyHomeError extends Error {
  override readonly name = "CodexReadOnlyHomeError";
}

export function codexReadOnlyHomeDir(providerHomesDir: string, instanceId: string): string {
  return nodePath.join(providerHomesDir, "codex-readonly", instanceId);
}

/**
 * The home Codex would use outside a read-only stage: the configured home, else the inherited
 * `CODEX_HOME`, else `~/.codex` (as `resolveCodexInstanceHomePaths` resolves it).
 */
export function codexReadOnlySourceHome(
  homePath: string | undefined,
  environment: NodeJS.ProcessEnv,
): string {
  const configured = homePath?.trim()
    ? homePath
    : environment.CODEX_HOME?.trim()
      ? environment.CODEX_HOME
      : undefined;
  return nodePath.resolve(
    configured ? expandHomePath(configured) : nodePath.join(nodeOs.homedir(), ".codex"),
  );
}

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

async function lstatOrUndefined(path: string) {
  try {
    return await nodeFs.lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function sameTarget(existing: string, target: string, platform: NodeJS.Platform): boolean {
  return platform === "win32"
    ? normalizeWindowsLinkPath(existing) === normalizeWindowsLinkPath(target)
    : existing === target;
}

async function createLink(
  target: string,
  link: string,
  entryName: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform !== "win32") return nodeFs.symlink(target, link);
  if (entryName === AUTH_FILE_NAME) {
    // Codex refuses to replace a hard-linked credential file, so only a symbolic link shares it.
    try {
      return await nodeFs.symlink(target, link, "file");
    } catch (error) {
      throw new CodexReadOnlyHomeError(
        `F5 couldn't link your Codex sign-in into the read-only stage home (${link}): Windows refused a symbolic link to ${target} (${errorCode(error) ?? String(error)}). Turn on Developer Mode, or use another provider for read-only stages.`,
      );
    }
  }
  const info = await nodeFs.stat(target).catch((error: unknown) => {
    // A broken link in the instance's home has nothing to share; skip it rather than refuse.
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return;
  if (info.isDirectory()) return nodeFs.symlink(target, link, "junction");
  try {
    await nodeFs.link(target, link);
  } catch (error) {
    if (errorCode(error) !== "EXDEV") throw error;
    await nodeFs.copyFile(target, link);
  }
}

/**
 * Moves a real `auth.json` found in the read-only home over the instance's own when it is newer
 * (or the instance has none), so relinking never discards a refreshed token. Codex 0.170 writes
 * through the link, so this only matters if a later Codex replaced the link itself. A hard link to
 * the instance's file is the same file and is left to the relink.
 */
async function keepNewerSignIn(
  local: string,
  source: string,
  localInfo: Awaited<ReturnType<typeof nodeFs.lstat>>,
): Promise<void> {
  const sourceInfo = await nodeFs.stat(source).catch(() => undefined);
  if (sourceInfo && hasKnownFileIdentity(localInfo.ino) && localInfo.ino === sourceInfo.ino) return;
  if (sourceInfo && sourceInfo.mtimeMs >= localInfo.mtimeMs) return;
  // Same directory as the destination, so the rename is atomic and never crosses a volume.
  const staged = `${source}.f5-${process.pid}-${Date.now()}`;
  await nodeFs.copyFile(local, staged);
  await nodeFs.rename(staged, source);
}

/** Makes `link` a link to `target`, leaving a correct link alone. */
async function ensureLink(
  target: string,
  link: string,
  entryName: string,
  platform: NodeJS.Platform,
  retried = false,
): Promise<void> {
  const info = await lstatOrUndefined(link);
  if (info?.isSymbolicLink()) {
    const existing = nodePath.resolve(nodePath.dirname(link), await nodeFs.readlink(link));
    if (sameTarget(existing, target, platform)) return;
    await nodeFs.rm(link, { force: true });
  } else if (info) {
    // A sign-in that ended up as a real file here may be the only fresh token: keep it.
    if (entryName === AUTH_FILE_NAME && info.isFile()) await keepNewerSignIn(link, target, info);
    // A hard link is the right shape for other files on Windows, but never for `auth.json`.
    if (platform === "win32" && info.isFile() && entryName !== AUTH_FILE_NAME) {
      const targetInfo = await nodeFs.stat(target).catch(() => undefined);
      if (
        targetInfo &&
        hasKnownFileIdentity(info.ino) &&
        info.ino === targetInfo.ino &&
        info.dev === targetInfo.dev
      )
        return;
    }
    await nodeFs.rm(link, { recursive: true, force: true });
  }
  try {
    await createLink(target, link, entryName, platform);
  } catch (error) {
    // Another F5 process may have created it in between: check it once more.
    if (errorCode(error) === "EEXIST" && !retried)
      return ensureLink(target, link, entryName, platform, true);
    throw error;
  }
}

/**
 * A top-level string `key` of the instance's `config.toml`, or undefined when it isn't set before
 * the first table.
 */
async function topLevelConfigString(source: string, key: string): Promise<string | undefined> {
  const text = await nodeFs.readFile(nodePath.join(source, "config.toml"), "utf8").catch(() => "");
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`);
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) return undefined;
    const match = pattern.exec(line);
    if (!match) continue;
    if (match[1] === undefined) return match[2];
    try {
      // TOML basic strings share JSON's common escapes; anything else is kept as written.
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return match[1];
    }
  }
  return undefined;
}

async function materialize(input: {
  readonly sourceHome: string;
  readonly readOnlyHome: string;
  readonly platform: NodeJS.Platform;
}): Promise<void> {
  const source = nodePath.resolve(input.sourceHome);
  const home = nodePath.resolve(input.readOnlyHome);
  if (source === home)
    throw new CodexReadOnlyHomeError(
      "Codex's read-only stage home must be different from the instance's home.",
    );
  // Never create the instance's home: without it there is no sign-in to share.
  if (!(await lstatOrUndefined(source)))
    throw new CodexReadOnlyHomeError(
      `Codex can't run read-only workflow stages yet: its home folder ${source} doesn't exist. Sign in to Codex first.`,
    );
  await nodeFs.mkdir(home, { recursive: true });
  // Two paths to one folder (a symlinked parent, a junction) would turn the cleanup below on the
  // instance's own `rules` and sessions.
  const [sourceInfo, homeInfo] = await Promise.all([nodeFs.stat(source), nodeFs.stat(home)]);
  const sameDirectory = hasKnownFileIdentity(sourceInfo.ino)
    ? sourceInfo.ino === homeInfo.ino && sourceInfo.dev === homeInfo.dev
    : sameTarget(await nodeFs.realpath(source), await nodeFs.realpath(home), input.platform);
  if (sameDirectory)
    throw new CodexReadOnlyHomeError(
      `Codex's read-only stage home (${home}) is the instance's own home (${source}).`,
    );
  await Promise.all(
    [...KNOWN_SHARED_DIRECTORIES, ...SHARED_LOCK_DIRECTORIES].map((directory) =>
      nodeFs.mkdir(nodePath.join(source, directory), { recursive: true }),
    ),
  );
  for (const file of SHARED_LOCK_FILES)
    await nodeFs.writeFile(nodePath.join(source, file), "", { flag: "a" });
  const sourceEntries = await nodeFs.readdir(source);
  if (!sourceEntries.includes(AUTH_FILE_NAME)) {
    const store = (await topLevelConfigString(source, "cli_auth_credentials_store"))
      ?.trim()
      .toLowerCase();
    if (store === "keyring" || store === "auto")
      throw new CodexReadOnlyHomeError(
        `Codex can't run read-only workflow stages with a sign-in kept in your system keychain (cli_auth_credentials_store = "${store}" in ${nodePath.join(source, "config.toml")}): Codex ties it to its home folder, and these stages use a separate one. Set it to "file" and sign in to Codex again, or use another provider for this stage.`,
      );
  }
  const wanted = new Set<string>(KNOWN_SHARED_DIRECTORIES);
  for (const name of sourceEntries) {
    if (!isExcludedEntry(name) && !SHADOW_LOCAL_ENTRY_NAMES.has(name) && !isSqliteEntry(name))
      wanted.add(name);
  }
  // A rules file here would apply to every later read-only stage, for example one Codex wrote
  // for an execpolicy amendment. Database links from an earlier build go too.
  for (const name of await nodeFs.readdir(home)) {
    if (isExcludedEntry(name) || isSqliteEntry(name))
      await nodeFs.rm(nodePath.join(home, name), { recursive: true, force: true });
  }
  for (const name of await nodeFs.readdir(home)) {
    if (wanted.has(name) || SHADOW_LOCAL_ENTRY_NAMES.has(name)) continue;
    const info = await lstatOrUndefined(nodePath.join(home, name));
    if (info?.isSymbolicLink()) await nodeFs.rm(nodePath.join(home, name), { force: true });
  }
  for (const name of wanted)
    await ensureLink(nodePath.join(source, name), nodePath.join(home, name), name, input.platform);
}

const materializations = new Map<string, Promise<void>>();

/**
 * Builds or repairs the read-only stage home for `sourceHome`. Up to four review stages of one
 * instance start together and share the home, so runs for the same home are serialized, and each
 * step leaves a correct link alone.
 */
export async function materializeCodexReadOnlyHome(input: {
  readonly sourceHome: string;
  readonly readOnlyHome: string;
  readonly platform?: NodeJS.Platform;
}): Promise<void> {
  const key = nodePath.resolve(input.readOnlyHome);
  const previous = materializations.get(key) ?? Promise.resolve();
  const run = previous.then(() =>
    materialize({ ...input, platform: input.platform ?? process.platform }),
  );
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  materializations.set(key, settled);
  try {
    await run;
  } finally {
    if (materializations.get(key) === settled) materializations.delete(key);
  }
}

export interface CodexProjectRulesConflict {
  readonly file: string;
  readonly reason: string;
}

/**
 * Codex's project-root marker with the default `[".git"]` markers, which read-only stages pin: a
 * `.git` file (a worktree or submodule), or a `.git` folder holding `HEAD`.
 */
async function isProjectRoot(directory: string): Promise<boolean> {
  const marker = nodePath.join(directory, ".git");
  const info = await nodeFs.stat(marker).catch(() => undefined);
  if (!info) return false;
  if (!info.isDirectory()) return true;
  return (await nodeFs.stat(nodePath.join(marker, "HEAD")).catch(() => undefined)) !== undefined;
}

/**
 * The first project rules file that would apply in `cwd`, or undefined. Codex reads `.codex/`
 * project layers in every folder from the working directory up to the project root (the nearest
 * ancestor with a project-root marker, `codexReadOnlyStageConfigArgs`), or the working
 * directory alone without one. It skips only a `.codex` that is its own home, which in a read-only
 * stage is F5's, so your home folder's `.codex` counts as a project layer when a repository is
 * rooted there. Any non-empty `*.rules` file blocks, and so does one F5 can't read with certainty.
 */
export async function findCodexProjectRulesConflict(
  cwd: string,
): Promise<CodexProjectRulesConflict | undefined> {
  const ancestors: string[] = [];
  for (let directory = nodePath.resolve(cwd); ; ) {
    ancestors.push(directory);
    const parent = nodePath.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  let projectRoot = 0;
  for (const [index, directory] of ancestors.entries()) {
    if (await isProjectRoot(directory)) {
      projectRoot = index;
      break;
    }
  }
  for (const directory of ancestors.slice(0, projectRoot + 1)) {
    const rulesDir = nodePath.join(directory, ".codex", "rules");
    let entries: ReadonlyArray<string>;
    try {
      entries = await nodeFs.readdir(rulesDir);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      return { file: rulesDir, reason: `can't be read (${code ?? String(error)})` };
    }
    for (const name of [...entries].sort()) {
      if (!name.endsWith(".rules")) continue;
      const file = nodePath.join(rulesDir, name);
      const info = await nodeFs.stat(file).catch(() => undefined);
      if (!info) return { file, reason: "can't be read" };
      if (!info.isFile()) return { file, reason: "isn't a regular file" };
      if (info.size > 0)
        return { file, reason: "has Codex rules, which can run commands without asking F5" };
    }
  }
  return undefined;
}

/** The refusal shown when a workspace's Codex rules can't be used in a read-only stage. */
export function codexProjectRulesConflictMessage(conflict: CodexProjectRulesConflict): string {
  return `Codex can't run read-only workflow stages here: ${conflict.file} ${conflict.reason}. Remove it, or use another provider for this stage.`;
}
