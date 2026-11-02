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
 * The environment is process-global, so sandboxes can overlap: a test that
 * timed out keeps running while Vitest starts the next one. Release therefore
 * restores only while its own home is still active, and never restores the
 * real user home (the run-wide fake home from `isolateTestHome` is used
 * instead). An out-of-order restore once destroyed a live profile database.
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

/** The variable `os.homedir()` consults on this platform. */
const HOME_ENV_NAME = process.platform === "win32" ? "USERPROFILE" : "HOME";
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
  /** Real user homes to protect; defaults to {@link realUserHomes}. */
  readonly realHomes?: ReadonlyArray<string>;
}

/**
 * Homes that tests must never write into: the account home from the user
 * database (unaffected by `HOME`) and the one recorded by `isolateTestHome`.
 */
export function realUserHomes(): ReadonlyArray<string> {
  const homes = new Set<string>();
  try {
    homes.add(Path.resolve(OS.userInfo().homedir));
  } catch {
    // Some containers have no passwd entry; F5_TEST_REAL_HOME still applies.
  }
  if (process.env.F5_TEST_REAL_HOME) homes.add(Path.resolve(process.env.F5_TEST_REAL_HOME));
  return [...homes];
}

/**
 * Throws when `path` resolves inside a real user's `~/.f5` or `~/.t3`.
 */
export function assertOutsideRealUserState(
  path: string,
  realHomes: ReadonlyArray<string> = realUserHomes(),
): void {
  for (const home of realHomes) {
    for (const stateRoot of [".f5", ".t3"]) {
      if (isSameOrInside(path, Path.join(home, stateRoot))) {
        throw new Error(
          `Refusing to touch ${path}: it is inside the real user state directory ${Path.join(home, stateRoot)}.`,
        );
      }
    }
  }
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

// macOS and Windows volumes are case-insensitive by default.
function normalizePath(path: string): string {
  const resolved = Path.resolve(path);
  return process.platform === "win32" || process.platform === "darwin"
    ? resolved.toLowerCase()
    : resolved;
}

function isSamePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function isSameOrInside(path: string, root: string): boolean {
  const relative = Path.relative(normalizePath(root), normalizePath(path));
  // Only a `..` segment leaves the root; a child named `..backup` stays inside.
  const escapes = relative === ".." || relative.startsWith(`..${Path.sep}`);
  return relative === "" || (!escapes && !Path.isAbsolute(relative));
}

function isRealHome(value: string | undefined, realHomes: ReadonlyArray<string>): boolean {
  return value !== undefined && realHomes.some((home) => isSamePath(value, home));
}

/** Owned sandbox homes already deleted; restoring one would point HOME at nothing. */
const retiredHomes = new Set<string>();

function isRetiredHome(value: string | undefined): boolean {
  return value !== undefined && retiredHomes.has(normalizePath(value));
}

/** Points a snapshot's home variables at the run-wide fake home. */
function useRunHome(snapshot: EnvSnapshot): void {
  const fallback = process.env.F5_TEST_HOME;
  snapshot.HOME = fallback;
  snapshot.USERPROFILE = fallback;
  snapshot.HOMEDRIVE = undefined;
  snapshot.HOMEPATH = undefined;
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
  const realHomes = input.realHomes ?? realUserHomes();
  if (isRealHome(process.env[HOME_ENV_NAME], realHomes) && !process.env.F5_TEST_REAL_HOME) {
    throw new Error(
      `${HOME_ENV_NAME} is the real user home (${process.env[HOME_ENV_NAME]}) and the run is not isolated. ` +
        "Run tests through a Vitest config that calls isolateTestHome().",
    );
  }
  const snapshot = captureEnv();
  if (isRealHome(snapshot.HOME, realHomes) || isRealHome(snapshot.USERPROFILE, realHomes)) {
    // Something already restored the real home; never put it back again.
    useRunHome(snapshot);
  }
  const ownsHome = input.home === undefined;
  const home = input.home ?? FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-home-sandbox-"));
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    // A newer sandbox owns the environment; restoring would yank its home.
    // Leaving our (soon deleted) home in place for it is the safe failure.
    const active = process.env[HOME_ENV_NAME];
    if (active !== undefined && isSamePath(active, home)) {
      // An older overlapping sandbox released first and deleted the home this
      // snapshot captured; return to the run-wide fake home instead.
      if (isRetiredHome(snapshot[HOME_ENV_NAME]) && process.env.F5_TEST_HOME) useRunHome(snapshot);
      if (snapshot[HOME_ENV_NAME] === undefined) {
        // No safe home to return to: keep the sandbox path rather than unset
        // HOME, which would make os.homedir() fall back to the real home.
        restoreEnv({ ...snapshot, HOME: home, USERPROFILE: home });
      } else {
        restoreEnv(snapshot);
      }
    }
    if (ownsHome) {
      retiredHomes.add(normalizePath(home));
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
