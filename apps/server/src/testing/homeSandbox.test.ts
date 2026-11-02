import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  assertOutsideRealUserState,
  createHomeSandbox,
  realUserHomes,
  withHomeSandbox,
} from "./homeSandbox.ts";

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

type EnvSnapshot = Record<(typeof SANDBOXED_ENV_NAMES)[number], string | undefined>;

function captureEnv(): EnvSnapshot {
  return Object.fromEntries(
    SANDBOXED_ENV_NAMES.map((name) => [name, process.env[name]]),
  ) as EnvSnapshot;
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const name of SANDBOXED_ENV_NAMES) {
    const value = snapshot[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function restoreOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function removeTreeBestEffort(path: string): void {
  try {
    FS.rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // The production helper intentionally treats temporary-directory cleanup
    // as best-effort on Windows, and its tests should do the same.
  }
}

describe.sequential("homeSandbox", () => {
  it("redirects the resolved home and restores every environment variable exactly", () => {
    const original = captureEnv();
    let sandbox: ReturnType<typeof createHomeSandbox> | undefined;
    try {
      process.env.HOME = "before-home";
      process.env.USERPROFILE = "before-profile";
      delete process.env.F5_HOME;
      process.env.T3CODE_HOME = "before-t3-home";
      delete process.env.F5_STATE_DIR;
      process.env.T3CODE_STATE_DIR = "before-t3-state";
      const expected = captureEnv();

      sandbox = createHomeSandbox();
      expect(Path.resolve(OS.homedir())).toBe(Path.resolve(sandbox.home));
      expect(process.env.F5_HOME).toBeUndefined();

      sandbox.release();
      expect(captureEnv()).toEqual(expected);
    } finally {
      sandbox?.release();
      restoreEnv(original);
    }
  });

  it("removes an owned home but preserves a caller-supplied home", () => {
    const owned = createHomeSandbox();
    const ownedHome = owned.home;
    owned.release();
    expect(FS.existsSync(ownedHome)).toBe(false);

    const suppliedHome = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-supplied-home-"));
    const supplied = createHomeSandbox({ home: suppliedHome });
    supplied.release();
    expect(FS.existsSync(suppliedHome)).toBe(true);
    removeTreeBestEffort(suppliedHome);
  });

  it("makes release idempotent without clobbering a newer sandbox", () => {
    const first = createHomeSandbox();
    first.release();
    const second = createHomeSandbox();
    try {
      first.release();
      expect(Path.resolve(OS.homedir())).toBe(Path.resolve(second.home));
    } finally {
      second.release();
    }
  });

  it("restores the environment when home redirection verification fails", () => {
    const before = captureEnv();
    const suppliedHome = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-rejected-home-"));
    try {
      expect(() =>
        createHomeSandbox({
          home: suppliedHome,
          resolveHome: () => Path.join(suppliedHome, "wrong"),
        }),
      ).toThrow(/Home sandbox did not take effect/u);
      expect(captureEnv()).toEqual(before);
    } finally {
      restoreEnv(before);
      removeTreeBestEffort(suppliedHome);
    }
  });

  it("keeps a newer sandbox active when an older one releases out of order", () => {
    const before = captureEnv();
    const first = createHomeSandbox();
    const second = createHomeSandbox();
    try {
      // A timed-out test releasing late must not yank the next test's home.
      first.release();
      expect(Path.resolve(OS.homedir())).toBe(Path.resolve(second.home));
      second.release();
      expect(Path.resolve(OS.homedir())).toBe(Path.resolve(first.home));
    } finally {
      second.release();
      restoreEnv(before);
    }
  });

  it("never restores a real user home captured in its snapshot", () => {
    const before = captureEnv();
    const realHome = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-fake-real-home-"));
    const fallbackHome = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-fallback-home-"));
    const previousRealHome = process.env.F5_TEST_REAL_HOME;
    const previousTestHome = process.env.F5_TEST_HOME;
    try {
      process.env.F5_TEST_REAL_HOME = realHome;
      process.env.F5_TEST_HOME = fallbackHome;
      process.env.HOME = realHome;
      process.env.USERPROFILE = realHome;
      const sandbox = createHomeSandbox({ realHomes: [realHome] });
      sandbox.release();
      expect(Path.resolve(OS.homedir())).toBe(Path.resolve(fallbackHome));
    } finally {
      restoreEnv(before);
      restoreOptionalEnv("F5_TEST_REAL_HOME", previousRealHome);
      restoreOptionalEnv("F5_TEST_HOME", previousTestHome);
      removeTreeBestEffort(realHome);
      removeTreeBestEffort(fallbackHome);
    }
  });

  it("refuses to sandbox a run whose home is the real user home without isolation", () => {
    const before = captureEnv();
    const realHome = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-unisolated-home-"));
    const previousRealHome = process.env.F5_TEST_REAL_HOME;
    try {
      delete process.env.F5_TEST_REAL_HOME;
      process.env.HOME = realHome;
      process.env.USERPROFILE = realHome;
      expect(() => createHomeSandbox({ realHomes: [realHome] })).toThrow(/not isolated/u);
      expect(captureEnv()).toEqual({ ...before, HOME: realHome, USERPROFILE: realHome });
    } finally {
      restoreEnv(before);
      restoreOptionalEnv("F5_TEST_REAL_HOME", previousRealHome);
      removeTreeBestEffort(realHome);
    }
  });

  it("rejects paths inside a real user's .f5 or .t3 state", () => {
    const realHome = Path.resolve(OS.tmpdir(), "f5-guarded-real-home");
    for (const path of [
      Path.join(realHome, ".f5"),
      Path.join(realHome, ".f5", "userdata", "state.sqlite"),
      Path.join(realHome, ".t3", "worktrees", "blocked"),
    ]) {
      expect(() => assertOutsideRealUserState(path, [realHome])).toThrow(/real user state/u);
    }
    for (const path of [
      Path.join(realHome, ".f5x", "state.sqlite"),
      Path.join(realHome, "project", ".f5"),
      Path.join(OS.tmpdir(), "elsewhere", ".f5", "userdata", "state.sqlite"),
    ]) {
      expect(() => assertOutsideRealUserState(path, [realHome])).not.toThrow();
    }
  });

  it("protects the account home recorded for the run", () => {
    expect(realUserHomes()).toContain(Path.resolve(OS.userInfo().homedir));
    expect(() =>
      assertOutsideRealUserState(
        Path.join(OS.userInfo().homedir, ".f5", "userdata", "state.sqlite"),
      ),
    ).toThrow(/real user state/u);
  });

  it("releases an acquired sandbox when the scoped effect fails", async () => {
    const before = captureEnv();
    let sandboxHome: string | undefined;
    const exit = await Effect.runPromise(
      Effect.exit(
        withHomeSandbox(
          Effect.sync(() => {
            sandboxHome = OS.homedir();
            throw new Error("expected failure");
          }),
        ),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(captureEnv()).toEqual(before);
    expect(sandboxHome).toBeDefined();
    expect(FS.existsSync(sandboxHome!)).toBe(false);
  });
});
