import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

// No relative imports: Vitest loads this from several package configs.

const HOME_ENV_NAMES = ["F5_HOME", "T3CODE_HOME", "F5_STATE_DIR", "T3CODE_STATE_DIR"] as const;

/** Live provider suites need the developer's real credentials and keep the real home. */
export function isLiveTestRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.entries(env).some(
    ([name, value]) => /^F5_[A-Z0-9_]+_LIVE_TEST$/.test(name) && value === "1",
  );
}

/** The account's home from the user database, which `HOME` cannot redirect. */
function accountHome(): string | undefined {
  try {
    return userInfo().homedir || undefined;
  } catch {
    // A UID without a passwd entry (common in containers) makes userInfo() throw.
    return undefined;
  }
}

function playwrightBrowsersPath(realHome: string): string {
  if (process.platform === "darwin") return join(realHome, "Library", "Caches", "ms-playwright");
  if (process.platform === "win32")
    return join(process.env.LOCALAPPDATA ?? join(realHome, "AppData", "Local"), "ms-playwright");
  return join(process.env.XDG_CACHE_HOME ?? join(realHome, ".cache"), "ms-playwright");
}

/**
 * Points every Vitest worker at a throwaway home before workers are spawned.
 *
 * Tests must never resolve the developer's real home: storage tests write
 * placeholder bytes over `~/.f5/userdata/state.sqlite`, and a per-test sandbox
 * restored out of order once put the real home back mid-test and destroyed a
 * live profile database. With the whole run rooted in a temporary home, a
 * misbehaving sandbox can only leak into another temporary directory.
 */
export function isolateTestHome(env: NodeJS.ProcessEnv = process.env): void {
  if (env.VITEST !== "true" || env.F5_TEST_HOME || isLiveTestRun(env)) return;
  const realHome = env.F5_TEST_REAL_HOME ?? accountHome() ?? homedir();
  const home = mkdtempSync(join(tmpdir(), "f5-vitest-home-"));
  env.PLAYWRIGHT_BROWSERS_PATH ??= playwrightBrowsersPath(realHome);
  env.F5_TEST_REAL_HOME = realHome;
  env.F5_TEST_HOME = home;
  for (const name of HOME_ENV_NAMES) delete env[name];
  env.HOME = home;
  env.USERPROFILE = home;
  if (/^[A-Za-z]:/.test(home)) {
    env.HOMEDRIVE = home.slice(0, 2);
    env.HOMEPATH = home.slice(2);
  }
  process.once("exit", () => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // Best-effort: the directory lives under the OS temporary directory.
    }
  });
}
