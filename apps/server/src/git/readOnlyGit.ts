/**
 * Git invocation for host-side inspection. Fixed executable, argument arrays,
 * no shell. Repository and user configuration may not run helpers on our
 * behalf: external diff drivers, text conversion, pagers, fsmonitor, hooks,
 * credential helpers, and network fetches are disabled, and optional index
 * writes are skipped.
 */
import { runProcess, type ProcessRunResult } from "../processRunner.ts";

/** Inherited variables that can redirect Git or make it run another program. */
const STRIPPED_GIT_ENV = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_EXEC_PATH",
  "GIT_EXTERNAL_DIFF",
  "GIT_DIFF_OPTS",
  "GIT_PAGER",
  "PAGER",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_TRACE",
  "GIT_TRACE2",
  "GIT_TRACE2_EVENT",
  "GIT_TRACE2_PERF",
]);

export function readOnlyGitEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    const upper = key.toUpperCase();
    if (STRIPPED_GIT_ENV.has(upper) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(upper)) continue;
    env[key] = value;
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_PAGER: "cat",
    PAGER: "cat",
    ...overrides,
  };
}

const HOOKS_DISABLED_PATH = process.platform === "win32" ? "NUL" : "/dev/null";

/** Global options placed before every subcommand. */
export const READ_ONLY_GIT_GLOBAL_ARGS: ReadonlyArray<string> = [
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.pager=cat",
  "-c",
  `core.hooksPath=${HOOKS_DISABLED_PATH}`,
  "-c",
  "credential.helper=",
  "-c",
  "protocol.allow=never",
  "-c",
  "color.ui=false",
];

/** Options for diff-producing subcommands (diff, log -p, show). */
export const READ_ONLY_GIT_DIFF_ARGS: ReadonlyArray<string> = [
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
];

export interface ReadOnlyGitOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly processRunner?: typeof runProcess;
}

export function readOnlyGitArgv(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...READ_ONLY_GIT_GLOBAL_ARGS, ...args];
}

export function runReadOnlyGit(
  args: ReadonlyArray<string>,
  options: ReadOnlyGitOptions,
): Promise<ProcessRunResult> {
  return (options.processRunner ?? runProcess)("git", [...readOnlyGitArgv(args)], {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 30_000,
    allowNonZeroExit: true,
    outputMode: "truncate",
    maxStdoutBytes: options.maxStdoutBytes ?? 4 * 1024 * 1024,
    maxStderrBytes: options.maxStderrBytes ?? 32 * 1024,
    ...(options.signal ? { signal: options.signal } : {}),
    env: readOnlyGitEnvironment(process.env, options.env),
  });
}

/**
 * Revisions are user- or model-supplied data. Reject option-like and
 * range/pathspec syntax; callers still pass `--end-of-options` where Git
 * supports it.
 */
export function isSafeRevision(value: string): boolean {
  return (
    value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*(?:[~^][0-9]{0,4})*$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//")
  );
}
