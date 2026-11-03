import { execFile } from "node:child_process";
import { statSync } from "node:fs";

import { compareCliVersions } from "./cliVersion.ts";
import { isDefaultClaudeBinary, resolveClaudeCliInvocation } from "./claudeSdkExecutable.ts";
import { parseGenericCliVersion } from "./providerSnapshot.ts";

/** First Claude Code release that honors `onFailure` on SDK hook matchers. */
export const CLAUDE_HOOK_ON_FAILURE_MIN_VERSION = "2.1.317";
const VERSION_TIMEOUT_MS = 10_000;

const versions = new Map<string, Promise<string | undefined>>();

function cacheKey(file: string): string {
  try {
    const stat = statSync(file);
    return `${file}\0${stat.mtimeMs}\0${stat.size}`;
  } catch {
    return file;
  }
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
  const key = cacheKey(invocation.file);
  const cached = versions.get(key);
  if (cached) return cached;
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
  versions.set(key, pending);
  // A failed probe is retried on the next launch rather than pinned.
  void pending.then((version) => {
    if (version === undefined) versions.delete(key);
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
