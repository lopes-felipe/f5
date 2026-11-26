/**
 * Keeps Codex's execution-policy rules from letting commands past F5 in read-only workflow stages.
 *
 * Codex runs a command that matches an `allow` rule in a `.rules` file outside its sandbox and
 * without asking anyone (docs/reviews/read-only-live-gates.md, "Codex read-only escalation", G4
 * control). It loads rules from `$CODEX_HOME/rules` and from a project's `.codex/rules`, so either
 * would bypass F5's read-only policy in every enforcement mode.
 *
 * Read-only stages therefore run with `CODEX_HOME` pointing at an F5-owned home that links every
 * entry of the instance's own home except `rules`: sign-in, config, sessions and caches stay
 * shared, so session history and resume keep working. Sign-in must be linked, never copied: a
 * copied token could rotate here and sign the user out of their own home. A workspace with its own
 * `.codex/rules` is refused, because F5 can't evaluate Starlark rules with certainty. System rules
 * (`/etc/codex/rules`) are the administrator's and stay in force.
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
import {
  projectDirectories,
  type ReadOnlyProjectConfigConflict,
} from "../provider/readOnlyProjectConfig.ts";

/** Entries of the instance's home a read-only stage never sees. */
const EXCLUDED_ENTRY_NAMES: ReadonlySet<string> = new Set(["rules"]);

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
  const info = await nodeFs.stat(target);
  if (info.isDirectory()) return nodeFs.symlink(target, link, "junction");
  try {
    await nodeFs.link(target, link);
  } catch (error) {
    if (errorCode(error) !== "EXDEV") throw error;
    if (entryName === "auth.json")
      throw new CodexReadOnlyHomeError(
        `F5 couldn't link your Codex sign-in into the read-only stage home (${link}): it is on another volume than ${target}.`,
      );
    await nodeFs.copyFile(target, link);
  }
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
    if (platform === "win32" && info.isFile()) {
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
  await nodeFs.mkdir(home, { recursive: true });
  await Promise.all(
    KNOWN_SHARED_DIRECTORIES.map((directory) =>
      nodeFs.mkdir(nodePath.join(source, directory), { recursive: true }),
    ),
  );
  const wanted = new Set<string>(KNOWN_SHARED_DIRECTORIES);
  for (const name of await nodeFs.readdir(source)) {
    if (!EXCLUDED_ENTRY_NAMES.has(name) && !SHADOW_LOCAL_ENTRY_NAMES.has(name)) wanted.add(name);
  }
  // A rules file here would apply to every later read-only stage, for example one Codex wrote
  // for an execpolicy amendment.
  for (const name of EXCLUDED_ENTRY_NAMES)
    await nodeFs.rm(nodePath.join(home, name), { recursive: true, force: true });
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

export type CodexProjectRulesConflict = ReadOnlyProjectConfigConflict;

/**
 * The first project rules file that would apply in `cwd`, or undefined. Codex reads `.codex/`
 * project layers between the working directory and the repository root (the nearest ancestor with
 * `.git`), or the working directory alone outside a repository. Your home folder is skipped: its
 * `.codex` is your own Codex home, which read-only stages replace. Any non-empty `*.rules` file
 * blocks, and so does one F5 can't read with certainty.
 */
export async function findCodexProjectRulesConflict(
  cwd: string,
  options: { readonly homeDir?: string } = {},
): Promise<CodexProjectRulesConflict | undefined> {
  const { project } = await projectDirectories(cwd, options);
  for (const directory of project) {
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
