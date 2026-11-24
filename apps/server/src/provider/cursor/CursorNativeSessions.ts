/**
 * Cursor CLI native session files, shared by text generation, one-off prompts
 * and the read-only report script.
 *
 * Every ACP `session/new` leaves `<config>/acp-sessions/<sessionId>/meta.json`,
 * and a session that ran a prompt also leaves
 * `<config>/chats/<md5(cwd)>/<sessionId>/`. F5 deletes only those recorded,
 * deterministic paths for sessions it created, after the writer exited. It
 * never scans or prunes the stores.
 */
import { createHash, randomBytes } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import { Effect } from "effect";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

export function cursorConfigDir(environment: NodeJS.ProcessEnv = process.env): string {
  const home = environment.HOME?.trim() || environment.USERPROFILE?.trim() || nodeOs.homedir();
  return nodePath.join(home, ".cursor");
}

export function cursorChatsWorkspaceKey(cwd: string): string {
  return createHash("md5").update(cwd).digest("hex");
}

/**
 * The workspace keys the CLI may have hashed: the resolved path and, when it
 * differs, the real path (for example `/private/tmp` for `/tmp`). Which one
 * the CLI uses for a symlinked workspace is an unrecorded live row, so both
 * are tried; each only exists if the CLI wrote it.
 */
function workspaceKeys(cwd: string, realCwd: string | undefined): ReadonlyArray<string> {
  const resolved = nodePath.resolve(cwd);
  return [...new Set([resolved, ...(realCwd ? [realCwd] : [])])].map(cursorChatsWorkspaceKey);
}

/** The paths one ACP session may own, or none when the id is not a plain session id. */
export function cursorAcpSessionPaths(input: {
  readonly configDir: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly realCwd?: string;
}): ReadonlyArray<string> {
  return cursorAcpSessionComponents(input).map((parts) => nodePath.join(input.configDir, ...parts));
}

function cursorAcpSessionComponents(input: {
  readonly sessionId: string;
  readonly cwd: string;
  readonly realCwd?: string;
}): ReadonlyArray<ReadonlyArray<string>> {
  if (!SESSION_ID_PATTERN.test(input.sessionId)) return [];
  return [
    ["acp-sessions", input.sessionId],
    ...workspaceKeys(input.cwd, input.realCwd).map((key) => ["chats", key, input.sessionId]),
  ];
}

/** Every component below `root` must be a real directory, never a symlink. */
async function isPlainDirectoryChain(root: string, parts: ReadonlyArray<string>): Promise<boolean> {
  let current = root;
  for (const part of parts) {
    current = nodePath.join(current, part);
    const stat = await nodeFs.lstat(current).catch(() => undefined);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return false;
  }
  return true;
}

/**
 * Deletes one session directory under the canonical store root. The store
 * root itself is resolved once (a symlinked `~/.cursor` is where Cursor
 * writes too); below it every component must be a plain directory. The
 * session directory is first renamed to a tombstone in the same parent, and
 * the delete proceeds only if the tombstone is still a plain directory whose
 * parent still resolves to the verified location. Otherwise the rename is
 * undone and nothing is deleted.
 */
async function removeOwnedPath(
  canonicalRoot: string,
  parts: ReadonlyArray<string>,
): Promise<boolean> {
  if (parts.length < 2 || parts.some((part) => !part || part === "." || part === ".."))
    return false;
  if (!(await isPlainDirectoryChain(canonicalRoot, parts))) return false;
  const parent = nodePath.join(canonicalRoot, ...parts.slice(0, -1));
  const target = nodePath.join(parent, parts.at(-1)!);
  const tombstone = nodePath.join(parent, `.f5-delete-${randomBytes(8).toString("hex")}`);
  await nodeFs.rename(target, tombstone);
  const tombstoneStat = await nodeFs.lstat(tombstone).catch(() => undefined);
  const parentReal = await nodeFs.realpath(parent).catch(() => undefined);
  if (
    !tombstoneStat ||
    tombstoneStat.isSymbolicLink() ||
    !tombstoneStat.isDirectory() ||
    parentReal !== parent
  ) {
    await nodeFs.rename(tombstone, target).catch(() => undefined);
    return false;
  }
  // `rm` never follows symlinks nested inside the directory it removes.
  await nodeFs.rm(tombstone, { recursive: true, force: true });
  return true;
}

/**
 * Deletes the files of one F5-created ACP session. Call only after the agent
 * process has exited. Failures are swallowed: cleanup never fails the caller.
 */
export const deleteCursorAcpSession = (input: {
  readonly configDir: string;
  readonly sessionId: string;
  readonly cwd: string;
}): Effect.Effect<number> =>
  Effect.promise(async () => {
    const canonicalRoot = await nodeFs.realpath(input.configDir).catch(() => undefined);
    if (!canonicalRoot) return 0;
    const realCwd = await nodeFs.realpath(input.cwd).catch(() => undefined);
    let removed = 0;
    for (const parts of cursorAcpSessionComponents({ ...input, ...(realCwd ? { realCwd } : {}) })) {
      if (await removeOwnedPath(canonicalRoot, parts).catch(() => false)) removed++;
    }
    return removed;
  });

/** Stable scratch workspace for text generation and one-off prompts. */
export function cursorScratchDir(stateDir: string): string {
  return nodePath.join(stateDir, "provider-scratch", "cursor");
}
