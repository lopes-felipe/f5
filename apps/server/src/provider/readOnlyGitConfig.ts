/**
 * Git configuration for read-only workflow stages whose approved commands run outside any
 * sandbox (`readOnlyWorkflowShell.ts`). The classifier judges a `git diff` or `git status` by its
 * text, but the repository's own config can make Git run a program for it: an external diff,
 * a diff driver's command or textconv, a clean or smudge filter, an fsmonitor hook, or a GPG
 * program for signatures. A clone never copies `.git/config`, so such a helper needs earlier
 * local write access, for example from a previous stage in the same worktree.
 *
 * Every helper the repository's own config defines (local or worktree scope, includes resolved)
 * is overridden with an empty value through `GIT_CONFIG_KEY_n`, so Git refuses to run it and the
 * command fails instead. Helpers from your global and system config, such as Git LFS's filters,
 * are your own installs and keep working.
 */
import { execFile } from "node:child_process";

import { appendGitConfigPairs, type GitConfigPair } from "../git/gitConfigEnvironment.ts";

/** Config keys whose value is a program Git runs while reading. Section and key are lower case. */
const GIT_READ_HELPER_KEYS =
  "^(diff\\.external|diff\\..+\\.(command|textconv)|filter\\..+\\.(clean|smudge|process)|core\\.fsmonitor|gpg(\\..+)?\\.program)$";

/** Scopes that come from the repository rather than from you or F5. */
const REPOSITORY_SCOPES = new Set(["local", "worktree"]);

/** Always set: fsmonitor runs a hook (or a daemon) during `git status`, and only saves time. */
const STATIC_PAIRS: readonly GitConfigPair[] = [["core.fsmonitor", "false"]];

/**
 * Parses `git config --null --show-scope --get-regexp`: `scope\0key\nvalue\0` per entry, or
 * `scope\0key\0` for a key without a value.
 */
export function parseScopedGitConfigKeys(output: string): Array<{ scope: string; key: string }> {
  const tokens = output.split("\0");
  const entries: Array<{ scope: string; key: string }> = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const scope = tokens[index]!;
    const keyAndValue = tokens[index + 1]!;
    const newline = keyAndValue.indexOf("\n");
    entries.push({ scope, key: newline === -1 ? keyAndValue : keyAndValue.slice(0, newline) });
  }
  return entries;
}

/**
 * The overrides for a stage working in `cwd`. Git missing means no helper can run either, so it
 * gets the static pairs only. Any other failure rejects: F5 doesn't start a stage it can't check.
 */
export function readOnlyGitConfigPairs(
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<GitConfigPair[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, "config", "--null", "--show-scope", "--get-regexp", GIT_READ_HELPER_KEYS],
      { env: environment, timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT")
          return resolve([...STATIC_PAIRS]);
        // Exit code 1: no key matched.
        if (error && error.code !== 1)
          return reject(
            new Error(
              `F5 couldn't read the Git config of ${cwd} for a read-only stage: ${String(stderr).trim() || error.message}`,
            ),
          );
        const keys = new Set(
          parseScopedGitConfigKeys(String(stdout))
            .filter((entry) => REPOSITORY_SCOPES.has(entry.scope))
            .map((entry) => entry.key)
            .filter((key) => key !== "core.fsmonitor"),
        );
        resolve([...STATIC_PAIRS, ...[...keys].map((key): GitConfigPair => [key, ""])]);
      },
    );
  });
}

/** `environment` with the stage's overrides appended after any Git config it already carries. */
export async function withReadOnlyGitConfig(
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<NodeJS.ProcessEnv> {
  return appendGitConfigPairs({ ...environment }, await readOnlyGitConfigPairs(cwd, environment));
}
