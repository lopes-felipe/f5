import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { delimiter, join, resolve } from "node:path";

// No relative imports: Vitest loads this from several package configs.

const HOME_ENV_NAMES = ["F5_HOME", "T3CODE_HOME", "F5_STATE_DIR", "T3CODE_STATE_DIR"] as const;

/** Live provider suites need the developer's real credentials and keep the real home. */
export function isLiveTestRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.entries(env).some(
    ([name, value]) => /^F5_[A-Z0-9_]+_LIVE_TEST$/.test(name) && value === "1",
  );
}

/** The account's home from the user database, which `HOME` cannot redirect. */
function defaultAccountHome(): string | undefined {
  try {
    return userInfo().homedir || undefined;
  } catch {
    // A UID without a passwd entry (common in containers) makes userInfo() throw.
    return undefined;
  }
}

function playwrightBrowsersPath(home: string, env: NodeJS.ProcessEnv): string {
  if (process.platform === "darwin") return join(home, "Library", "Caches", "ms-playwright");
  if (process.platform === "win32")
    return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "ms-playwright");
  return join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "ms-playwright");
}

/** The home variables `os.homedir()` and Windows child processes read for `home`. */
export function homeEnvFor(home: string): Record<string, string> {
  const vars: Record<string, string> = { HOME: home, USERPROFILE: home };
  if (/^[A-Za-z]:/.test(home)) {
    vars.HOMEDRIVE = home.slice(0, 2);
    vars.HOMEPATH = home.slice(2);
  }
  return vars;
}

export interface IsolateTestHomeOptions {
  /** Defaults to the user database entry, falling back to `os.homedir()`. */
  readonly accountHome?: () => string | undefined;
}

/**
 * Points every Vitest worker at a throwaway home before workers are spawned.
 *
 * Tests must never resolve the developer's real home: storage tests write
 * placeholder bytes over `~/.f5/userdata/state.sqlite`, and a per-test sandbox
 * restored out of order once put the real home back mid-test and destroyed a
 * live profile database. With the whole run rooted in a temporary home, a
 * misbehaving sandbox can only leak into another temporary directory.
 *
 * Both the account home and the incoming `HOME` (they differ in devcontainers
 * and F5 provider environments) are recorded in `F5_TEST_PROTECTED_HOMES`.
 * Live runs keep the real home but still record it, so guards stay active.
 */
export function isolateTestHome(
  env: NodeJS.ProcessEnv = process.env,
  options: IsolateTestHomeOptions = {},
): string | undefined {
  if (env.VITEST !== "true" || env.F5_TEST_HOME) return undefined;
  const incomingHome = env.HOME || env.USERPROFILE || undefined;
  const realHome =
    env.F5_TEST_REAL_HOME ?? (options.accountHome ?? defaultAccountHome)() ?? homedir();
  const protectedHomes = new Set(
    [...(env.F5_TEST_PROTECTED_HOMES?.split(delimiter) ?? []), realHome, incomingHome]
      .filter((home): home is string => Boolean(home))
      .map((home) => resolve(home)),
  );
  env.F5_TEST_REAL_HOME = realHome;
  env.F5_TEST_PROTECTED_HOMES = [...protectedHomes].join(delimiter);
  if (isLiveTestRun(env)) return undefined;

  // Browsers were installed under the incoming home; resolve before replacing it.
  env.PLAYWRIGHT_BROWSERS_PATH ??= playwrightBrowsersPath(incomingHome ?? realHome, env);
  const home = mkdtempSync(join(tmpdir(), "f5-vitest-home-"));
  env.F5_TEST_HOME = home;
  for (const name of HOME_ENV_NAMES) delete env[name];
  delete env.HOMEDRIVE;
  delete env.HOMEPATH;
  Object.assign(env, homeEnvFor(home));
  process.once("exit", () => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // Best-effort: the directory lives under the OS temporary directory.
    }
  });
  return home;
}
