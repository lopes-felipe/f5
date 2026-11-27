/**
 * Git configuration for read-only workflow stages whose approved commands run outside any
 * sandbox (`readOnlyWorkflowShell.ts`). The classifier judges a `git diff` or `git status` by its
 * text, but a repository's own config can make Git run a program for it: an external diff,
 * a diff driver's command or textconv, a clean or smudge filter, an fsmonitor hook, or a GPG
 * program for signatures. A clone never copies `.git/config`, so such a helper needs earlier
 * local write access, for example from a previous stage in the same worktree.
 *
 * Two things keep those programs from running:
 *
 * - When the stage starts, every helper the config of its folder's repository defines (local or
 *   worktree scope, includes resolved) is overridden through `GIT_CONFIG_KEY_n`
 *   (`readOnlyGitConfigPairs`). Helpers from your global and system config, such as Git LFS's
 *   filters, are your own installs and keep working.
 * - The overrides are fixed once the provider runs, and a command can read another repository
 *   (`git -C`, `cd`, a submodule) or the config can change. So before F5 approves a command that
 *   runs Git, it reads the config of every repository the command can reach and refuses the
 *   command when one defines a helper the overrides don't cover (`ReadOnlyGitGuard`).
 */
import { execFile } from "node:child_process";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { appendGitConfigPairs, type GitConfigPair } from "../git/gitConfigEnvironment.ts";
import { readOnlyShellDirectoryUses } from "./readOnlyWorkflowShell.ts";

/** Config keys whose value is a program Git runs while reading. Section and key are lower case. */
const GIT_READ_HELPER_KEYS =
  "^(diff\\.external|diff\\..+\\.(command|textconv)|filter\\..+\\.(clean|smudge|process)|core\\.fsmonitor|gpg(\\..+)?\\.program)$";

/** Scopes that come from the repository rather than from you or F5. */
const REPOSITORY_SCOPES = new Set(["local", "worktree"]);

/** Always set: fsmonitor runs a hook (or a daemon) during `git status`, and only saves time. */
const STATIC_PAIRS: readonly GitConfigPair[] = [["core.fsmonitor", "false"]];
const STATIC_KEYS = new Set(STATIC_PAIRS.map(([key]) => key));

/** Folders a command can be in, and repositories it can read, before F5 stops following it. */
const MAX_DIRECTORIES = 32;
const MAX_REPOSITORIES = 64;
const MAX_SUBMODULE_DEPTH = 5;
const PROBE_TIMEOUT_MS = 10_000;

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
 * The overrides for one helper key. A textconv and a clean or smudge filter become `cat`, which
 * passes the content through, so `git diff` and `git status` keep working and show what is
 * stored. A filter process speaks a protocol `cat` doesn't: it is emptied, and the filter is
 * marked not required so that Git passes the content through when the process can't start. An
 * external diff, a driver's command and a GPG program have no harmless stand-in either and are
 * emptied, so Git fails for the paths that need them instead of running the program.
 */
function neutralPairs(key: string): GitConfigPair[] {
  const process = /^(filter\..+)\.process$/.exec(key);
  if (process)
    return [
      [key, ""],
      [`${process[1]}.required`, "false"],
    ];
  return [[key, /^(?:diff\..+\.textconv|filter\..+\.(?:clean|smudge))$/.test(key) ? "cat" : ""]];
}

interface GitRun {
  readonly code: number | string | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs Git and resolves whatever its exit code; `code` is "ENOENT" when Git is missing. */
const runGit = (args: ReadonlyArray<string>, environment: NodeJS.ProcessEnv): Promise<GitRun> =>
  new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      {
        env: environment,
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        resolve({
          code: error ? ((error as NodeJS.ErrnoException).code ?? "failed") : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
    );
  });

/**
 * The helper keys a repository's own config defines, read with `git <target…> config`. Git
 * missing means no helper can run either. Any other failure throws: F5 doesn't approve what it
 * can't check.
 */
async function repositoryHelperKeys(
  target: ReadonlyArray<string>,
  label: string,
  environment: NodeJS.ProcessEnv,
): Promise<string[]> {
  const run = await runGit(
    [...target, "config", "--null", "--show-scope", "--get-regexp", GIT_READ_HELPER_KEYS],
    environment,
  );
  if (run.code === "ENOENT") return [];
  // Exit code 1: no key matched.
  if (run.code !== 0 && run.code !== 1)
    throw new Error(
      `F5 couldn't read the Git config of ${label} for a read-only stage: ${run.stderr.trim() || `git exited with ${String(run.code)}`}`,
    );
  return [
    ...new Set(
      parseScopedGitConfigKeys(run.stdout)
        .filter((entry) => REPOSITORY_SCOPES.has(entry.scope))
        .map((entry) => entry.key),
    ),
  ];
}

/**
 * The overrides for a stage working in `cwd`. Git missing means no helper can run either, so it
 * gets the static pairs only. Any other failure rejects: F5 doesn't start a stage it can't check.
 */
export async function readOnlyGitConfigPairs(
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<GitConfigPair[]> {
  const keys = await repositoryHelperKeys(["-C", cwd], cwd, environment);
  const pairs = new Map<string, GitConfigPair>(STATIC_PAIRS.map((pair) => [pair[0], pair]));
  for (const key of keys)
    if (!STATIC_KEYS.has(key)) for (const pair of neutralPairs(key)) pairs.set(pair[0], pair);
  return [...pairs.values()];
}

/** `environment` with the stage's overrides appended after any Git config it already carries. */
export async function withReadOnlyGitConfig(
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<NodeJS.ProcessEnv> {
  return appendGitConfigPairs({ ...environment }, await readOnlyGitConfigPairs(cwd, environment));
}

/** A stage's overrides and the check F5 runs before it approves a command that runs Git. */
export interface ReadOnlyGitGuard {
  /** The overrides the provider process is started with. */
  readonly pairs: ReadonlyArray<GitConfigPair>;
  /**
   * Why a command the classifier accepts must still be refused, or undefined. `cwd` is the folder
   * the command starts in when the request names one; the stage's folder otherwise.
   */
  readonly refusal: (command: string, cwd?: string | undefined) => Promise<string | undefined>;
}

/** The ways a path written in a command can be read: as it is, and with a leading `~` expanded. */
function writtenPaths(written: string, home: string): string[] | undefined {
  if (!written.startsWith("~")) return [written];
  if (written === "~" || written.startsWith("~/"))
    // Quoted, the `~` is a folder's name; unquoted, it is the home folder.
    return [written, Path.join(home, written.slice(1))];
  // `~name`, `~+`, `~-`: a named directory F5 can't look up.
  return undefined;
}

async function isDirectory(path: string): Promise<boolean> {
  return FS.stat(path).then(
    (stat) => stat.isDirectory(),
    () => false,
  );
}

/** Git directories under `modules/`, where Git keeps a submodule's repository. */
async function submoduleGitDirectories(commonDirectory: string): Promise<string[] | undefined> {
  const found: string[] = [];
  const pending = [Path.join(commonDirectory, "modules")];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await FS.readdir(directory, { withFileTypes: true }).catch(() => []);
    if ((visited += entries.length) > 5_000) return undefined;
    const names = new Set(entries.map((entry) => entry.name));
    if (names.has("config") && names.has("HEAD")) {
      found.push(directory);
      // A submodule's own submodules live in its `modules/`; nothing else here is a repository.
      if (names.has("modules")) pending.push(Path.join(directory, "modules"));
      continue;
    }
    // A submodule name can contain `/`, which nests its repository in folders.
    for (const entry of entries)
      if (entry.isDirectory()) pending.push(Path.join(directory, entry.name));
  }
  return found;
}

/** Paths the index records as submodules (mode 160000), relative to the top of the worktree. */
async function indexSubmodulePaths(
  directory: string,
  environment: NodeJS.ProcessEnv,
): Promise<string[]> {
  const run = await runGit(["-C", directory, "ls-files", "--stage", "-z"], environment);
  if (run.code !== 0)
    throw new Error(
      `F5 couldn't list the submodules of ${directory} for a read-only stage: ${run.stderr.trim() || `git exited with ${String(run.code)}`}`,
    );
  const paths: string[] = [];
  for (const entry of run.stdout.split("\0")) {
    if (!entry.startsWith("160000 ")) continue;
    const tab = entry.indexOf("\t");
    if (tab !== -1) paths.push(entry.slice(tab + 1));
  }
  return paths;
}

/**
 * The stage's overrides, read now, and the check that later commands only reach repositories
 * those overrides cover. `cwd` is the stage's folder; `environment` is the provider's.
 *
 * A config that can't be read now doesn't stop the stage: it gets the static overrides, and the
 * check then refuses each Git command in a repository whose config is still unreadable or
 * defines a helper. A stage that ends up in a sandbox never asks, so it loses nothing.
 */
export async function makeReadOnlyGitGuard(
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ReadOnlyGitGuard> {
  const pairs = await readOnlyGitConfigPairs(cwd, environment).catch(() => [...STATIC_PAIRS]);
  const covered = new Set(pairs.map(([key]) => key));
  const home = environment.HOME?.trim() || OS.homedir();

  const uncovered = (keys: ReadonlyArray<string>, where: string) => {
    const key = keys.find((candidate) => !covered.has(candidate));
    return key === undefined
      ? undefined
      : `the Git config of ${where} sets \`${key}\`, a program Git would run for this command. F5 turned off the ones it found in this stage's folder when the stage started and can't turn off this one: read that repository with \`gh\` or F5's forge tools, or go on without it`;
  };

  /** Why Git can't run in `directory`: its repository, or a submodule of it, has such a key. */
  const repositoryRefusal = async (
    directory: string,
    seen: Set<string>,
    depth: number,
  ): Promise<string | undefined> => {
    if (seen.has(directory)) return undefined;
    seen.add(directory);
    if (seen.size > MAX_REPOSITORIES || depth > MAX_SUBMODULE_DEPTH)
      return "this command reaches more Git repositories and submodules than F5 checks for one command";
    // Git fails in a folder that doesn't exist, and so does the `cd` that led there.
    if (!(await isDirectory(directory))) return undefined;
    const own = uncovered(
      await repositoryHelperKeys(["-C", directory], directory, environment),
      directory,
    );
    if (own) return own;
    const located = await runGit(
      ["-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      environment,
    );
    // Not inside a repository: Git has no repository config to read there.
    if (located.code !== 0) return undefined;
    const commonDirectory = located.stdout.trim();
    const modules = await submoduleGitDirectories(commonDirectory);
    if (modules === undefined)
      return "this repository has more submodules than F5 checks for one command";
    for (const gitDirectory of modules) {
      const refusal = uncovered(
        await repositoryHelperKeys(["--git-dir", gitDirectory], gitDirectory, environment),
        `the submodule in ${gitDirectory}`,
      );
      if (refusal) return refusal;
    }
    // `git status` and `git diff` run Git inside a checked-out submodule, wherever its
    // repository is kept: `modules/` above, its own `.git` folder, or where a `.git` file points.
    const top = await runGit(["-C", directory, "rev-parse", "--show-toplevel"], environment);
    if (top.code !== 0) return undefined;
    for (const submodule of await indexSubmodulePaths(directory, environment)) {
      const refusal = await repositoryRefusal(
        Path.join(top.stdout.trim(), submodule),
        seen,
        depth + 1,
      );
      if (refusal) return refusal;
    }
    return undefined;
  };

  return {
    pairs,
    refusal: async (command, commandCwd) => {
      const uses = readOnlyShellDirectoryUses(command);
      if (!uses?.some((use) => use.kind === "git")) return undefined;
      // Every folder the command can be in: a `cd` may fail, so its target is added, not swapped
      // in. More folders than the shell would visit only means more repositories are checked.
      const folders = new Set([Path.resolve(commandCwd ?? cwd)]);
      const repositories = new Set<string>();
      for (const use of uses) {
        if (use.kind === "cd") {
          const targets = use.path === undefined ? undefined : writtenPaths(use.path, home);
          if (targets === undefined)
            return "F5 can't tell which folder this `cd` leads to, so it can't check the Git config there: write the folder out in full";
          // `cd -` and `cd +1` go back to a folder the command has already been in.
          if (/^[-+]\d*$/.test(use.path!)) continue;
          // A copy: the set grows while its earlier folders are walked.
          for (const folder of Array.from(folders))
            for (const target of targets) folders.add(Path.resolve(folder, target));
        } else {
          let reached = [...folders];
          for (const written of use.path) {
            const targets = writtenPaths(written, home);
            if (targets === undefined)
              return "F5 can't tell which folder this `git -C` leads to, so it can't check the Git config there: write the folder out in full";
            reached = reached.flatMap((folder) =>
              targets.map((target) => Path.resolve(folder, target)),
            );
          }
          for (const folder of reached) repositories.add(folder);
        }
        if (folders.size > MAX_DIRECTORIES || repositories.size > MAX_REPOSITORIES)
          return "this command moves between more folders than F5 checks for one command: run Git in fewer folders per command";
      }
      try {
        const seen = new Set<string>();
        for (const repository of repositories) {
          const refusal = await repositoryRefusal(repository, seen, 0);
          if (refusal) return refusal;
        }
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  };
}
