import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createHomeSandbox, withHomeSandbox } from "./homeSandbox.ts";

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
