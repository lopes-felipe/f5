import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";

import { compareCliVersions } from "./cliVersion.ts";
import { isDefaultClaudeBinary, resolveClaudeCliInvocation } from "./claudeSdkExecutable.ts";
import { parseGenericCliVersion } from "./providerSnapshot.ts";

/** First Claude Code release that honors `onFailure` on SDK hook matchers. */
export const CLAUDE_HOOK_ON_FAILURE_MIN_VERSION = "2.1.317";
const VERSION_TIMEOUT_MS = 10_000;
/** A wrapper can start another binary without changing itself, so answers expire. */
const VERSION_TTL_MS = 10 * 60_000;
/** Failed or hung probes are cached briefly so they cannot add the timeout to every launch. */
const FAILED_VERSION_TTL_MS = 60_000;

const versions = new Map<
  string,
  { readonly version: Promise<string | undefined>; expiresAt: number }
>();

function fileIdentity(file: string): string {
  try {
    const resolved = realpathSync(file);
    const stat = statSync(resolved);
    return `${file}\0${resolved}\0${stat.mtimeMs}\0${stat.size}`;
  } catch {
    return file;
  }
}

/**
 * Identity of everything that decides the answer: the runtime and, for a JavaScript entry run
 * through Node, the script itself (resolved through links, so a symlinked upgrade changes it).
 */
export function claudeVersionCacheKey(invocation: {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
}): string {
  return [invocation.file, ...invocation.args].map(fileIdentity).join("\u0001");
}

/** Test seam: forget every cached answer. */
export function clearClaudeExecutableVersionCache(): void {
  versions.clear();
}

/**
 * `claude --version` of a custom executable, cached per file identity. Undefined when the
 * executable cannot run or prints no version; callers then keep the older behavior.
 */
export function readClaudeExecutableVersion(
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<string | undefined> {
  let invocation: ReturnType<typeof resolveClaudeCliInvocation>;
  try {
    invocation = resolveClaudeCliInvocation(
      binaryPath,
      ["--version"],
      environment,
      cwd ? { cwd } : {},
    );
  } catch {
    return Promise.resolve(undefined);
  }
  const key = claudeVersionCacheKey(invocation);
  const cached = versions.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.version;
  const pending = new Promise<string | undefined>((resolve) => {
    const child = execFile(
      invocation.file,
      [...invocation.args],
      { env: environment, timeout: VERSION_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) =>
        resolve(error ? undefined : (parseGenericCliVersion(`${stdout}\n${stderr}`) ?? undefined)),
    );
    // A wrapper that reads stdin before answering must not hold the launch until the timeout.
    child.stdin?.end();
  });
  const entry = { version: pending, expiresAt: Date.now() + VERSION_TIMEOUT_MS + VERSION_TTL_MS };
  versions.set(key, entry);
  // A failed probe keeps the older behavior for a minute, then is retried.
  void pending.then((version) => {
    if (version === undefined) entry.expiresAt = Date.now() + FAILED_VERSION_TTL_MS;
  });
  return pending;
}

/**
 * Whether F5's mandatory hook may set `onFailure: "block"`. The SDK refuses a session whose
 * CLI lacks `hook_on_failure_supported`, so only the bundled runtime or a custom executable
 * reporting 2.1.317+ qualifies; older executables keep the in-hook deny-on-error path.
 */
export function claudeHookOnFailureSupported(
  binaryPath: string | null | undefined,
  executableVersion: string | undefined,
): boolean {
  if (isDefaultClaudeBinary(binaryPath)) return true;
  return (
    executableVersion !== undefined &&
    compareCliVersions(executableVersion, CLAUDE_HOOK_ON_FAILURE_MIN_VERSION) >= 0
  );
}
