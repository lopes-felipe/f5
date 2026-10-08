/**
 * Removes one Claude session transcript from an instance's isolated store.
 *
 * The SDK's `deleteSession(id, { dir })` treats `dir` as the project
 * directory and resolves the store from the server's own
 * `CLAUDE_CONFIG_DIR`/home, so it cannot target an isolated profile's config
 * dir. This mirrors its local semantics against an explicit config dir
 * instead: `<configDir>/projects/<project>/<id>.jsonl` plus the sidecar
 * `<configDir>/projects/<project>/<id>/` directory (subagent transcripts,
 * tool results). Nothing outside `<configDir>/projects` is touched.
 *
 * @module provider/claudeSessionCleanup
 */
import { realpathSync } from "node:fs";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import { isUuid } from "./claudeResumeState.ts";

function canonicalDir(path: string): string {
  const resolved = NodePath.resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * The config dir F5 may delete transcripts from, or `undefined` when the
 * instance shares its store with the user's own Claude CLI.
 *
 * Only an explicitly isolated instance qualifies: a non-default F5 profile
 * (managed provider home) or a configured `homePath`. Even then the dir must
 * differ from the user's default `~/.claude` and from the store the F5
 * server's own environment points at, because sessions there are visible to
 * (and may have been continued with) `claude --resume`.
 */
export function resolveClaudeTranscriptCleanupDir(input: {
  readonly configDir: string;
  readonly isolatedProfile: boolean;
  readonly homePath: string;
  readonly userHomeDir: string;
  readonly serverConfigDir: string;
}): string | undefined {
  if (!input.isolatedProfile && input.homePath.trim().length === 0) return undefined;
  const configDir = canonicalDir(input.configDir);
  const shared = [NodePath.join(input.userHomeDir, ".claude"), input.serverConfigDir].map(
    canonicalDir,
  );
  return shared.includes(configDir) ? undefined : configDir;
}

export interface ClaudeSessionCleanupResult {
  /** Absolute paths removed; empty when the session had no local transcript. */
  readonly removed: ReadonlyArray<string>;
}

function isMissing(error: unknown): boolean {
  const code =
    error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

export async function deleteClaudeSessionTranscript(input: {
  readonly claudeConfigDir: string;
  readonly sessionId: string;
}): Promise<ClaudeSessionCleanupResult> {
  // Session ids are UUIDs; anything else could address a path.
  if (!isUuid(input.sessionId)) {
    throw new Error(`Refusing to delete a Claude session with a non-UUID id.`);
  }
  const projectsDir = NodePath.join(input.claudeConfigDir, "projects");
  let projectEntries: ReadonlyArray<import("node:fs").Dirent>;
  try {
    projectEntries = await NodeFs.readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return { removed: [] };
    throw error;
  }
  const removed: string[] = [];
  for (const entry of projectEntries) {
    if (!entry.isDirectory()) continue;
    const projectDir = NodePath.join(projectsDir, entry.name);
    const transcriptPath = NodePath.join(projectDir, `${input.sessionId}.jsonl`);
    const sidecarPath = NodePath.join(projectDir, input.sessionId);
    for (const [path, kind] of [
      [transcriptPath, "file"],
      [sidecarPath, "directory"],
    ] as const) {
      let stat: import("node:fs").Stats;
      try {
        stat = await NodeFs.lstat(path);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      // Symlinks are unlinked, never followed.
      if (kind === "directory" && stat.isDirectory()) {
        await NodeFs.rm(path, { recursive: true, force: true });
      } else if (kind === "file" && (stat.isFile() || stat.isSymbolicLink())) {
        await NodeFs.unlink(path);
      } else if (stat.isSymbolicLink()) {
        await NodeFs.unlink(path);
      } else {
        continue;
      }
      removed.push(path);
    }
  }
  return { removed };
}
