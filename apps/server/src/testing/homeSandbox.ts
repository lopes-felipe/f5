/**
 * homeSandbox - Home directory isolation for tests.
 *
 * Tests that exercise default state-directory resolution must never resolve to
 * the developer's real home directory: storage maintenance deletes recognized
 * directories under `~/.f5` and `~/.t3`, and several tests write placeholder
 * bytes over `~/.f5/userdata/state.sqlite`.
 *
 * `os.homedir()` consults `HOME` on POSIX and `USERPROFILE` on Windows, so a
 * sandbox that only overrides `HOME` silently leaves Windows runs pointed at
 * live user state. `HOMEDRIVE` and `HOMEPATH` are also redirected for child
 * processes such as Git for Windows. This module owns the full override set and
 * refuses to hand out a sandbox whose redirection did not take effect.
 *
 * @module homeSandbox
 */
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { Effect } from "effect";

const SANDBOXED_ENV_NAMES = [
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "F5_HOME",
  "T3CODE_HOME",
  "F5_STATE_DIR",
  "T3CODE_STATE_DIR",
] as const;

type SandboxedEnvName = (typeof SANDBOXED_ENV_NAMES)[number];
type EnvSnapshot = Record<SandboxedEnvName, string | undefined>;

/**
 * HomeSandbox - An active home directory redirection.
 */
export interface HomeSandbox {
  /** Absolute path the process now resolves as the home directory. */
  readonly home: string;
  /** Restores the previous environment and removes an owned temporary home. */
  readonly release: () => void;
}

interface HomeSandboxOptions {
  readonly home?: string;
  readonly resolveHome?: () => string;
}

function captureEnv(): EnvSnapshot {
  const snapshot = {} as EnvSnapshot;
  for (const name of SANDBOXED_ENV_NAMES) {
    snapshot[name] = process.env[name];
  }
  return snapshot;
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const name of SANDBOXED_ENV_NAMES) {
    const value = snapshot[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

function applyEnv(home: string): void {
  for (const name of SANDBOXED_ENV_NAMES) {
    delete process.env[name];
  }
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  if (/^[A-Za-z]:/.test(home)) {
    process.env.HOMEDRIVE = home.slice(0, 2);
    process.env.HOMEPATH = home.slice(2);
  }
}

function isSamePath(left: string, right: string): boolean {
  const normalizedLeft = Path.resolve(left);
  const normalizedRight = Path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/**
 * Redirects home directory resolution at the environment level.
 *
 * Pass `home` to reuse a directory the caller manages; otherwise a temporary
 * directory is created and removed on release. Throws when `os.homedir()` does
 * not follow the override, rather than letting the caller operate on real user
 * state.
 */
export function createHomeSandbox(input: HomeSandboxOptions = {}): HomeSandbox {
  const snapshot = captureEnv();
  const ownsHome = input.home === undefined;
  const home = input.home ?? FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-home-sandbox-"));
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    restoreEnv(snapshot);
    if (ownsHome) {
      try {
        FS.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Cleanup is best-effort: never replace a test failure or safety refusal
        // with a transient Windows filesystem error.
      }
    }
  };

  try {
    applyEnv(home);
    const resolved = (input.resolveHome ?? OS.homedir)();
    if (!isSamePath(resolved, home)) {
      throw new Error(
        `Home sandbox did not take effect: os.homedir() resolved to ${resolved} instead of ${home}. ` +
          "Refusing to continue because the test would read and delete real user state.",
      );
    }
  } catch (error) {
    try {
      release();
    } catch {
      // Preserve the safety refusal even if restoring the environment fails.
    }
    throw error;
  }

  return { home, release };
}

/**
 * Runs an effect with home directory resolution redirected into a sandbox.
 */
export function withHomeSandbox<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => createHomeSandbox()),
    () => effect,
    (sandbox) => Effect.sync(() => sandbox.release()),
  );
}
