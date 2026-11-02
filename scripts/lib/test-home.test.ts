import { existsSync, rmSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { homeEnvFor, isolateTestHome } from "./test-home";

const created: string[] = [];

afterEach(() => {
  for (const home of created.splice(0)) rmSync(home, { recursive: true, force: true });
});

function isolate(env: NodeJS.ProcessEnv, accountHome?: () => string | undefined) {
  const home = isolateTestHome(env, accountHome ? { accountHome } : {});
  if (home) created.push(home);
  return home;
}

describe("isolateTestHome", () => {
  it("does nothing outside Vitest", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/home/dev" };
    expect(isolate(env)).toBeUndefined();
    expect(env).toEqual({ HOME: "/home/dev" });
  });

  it("roots the run in a fresh home and clears state-directory overrides", () => {
    const env: NodeJS.ProcessEnv = {
      VITEST: "true",
      HOME: "/home/dev",
      F5_HOME: "/home/dev/.f5",
      T3CODE_HOME: "/home/dev/.t3",
      F5_STATE_DIR: "/state",
      T3CODE_STATE_DIR: "/state-t3",
    };
    const home = isolate(env, () => "/home/account");
    expect(home).toBeDefined();
    expect(existsSync(home!)).toBe(true);
    expect(env.HOME).toBe(home);
    expect(env.USERPROFILE).toBe(home);
    expect(env.F5_TEST_HOME).toBe(home);
    expect(env.F5_TEST_REAL_HOME).toBe("/home/account");
    for (const name of ["F5_HOME", "T3CODE_HOME", "F5_STATE_DIR", "T3CODE_STATE_DIR"]) {
      expect(env[name]).toBeUndefined();
    }
  });

  it("protects both the account home and the incoming home", () => {
    const env: NodeJS.ProcessEnv = { VITEST: "true", HOME: "/workspace/devhome" };
    isolate(env, () => "/home/account");
    expect(env.F5_TEST_PROTECTED_HOMES?.split(delimiter)).toEqual([
      resolve("/home/account"),
      resolve("/workspace/devhome"),
    ]);
  });

  it("resolves the Playwright cache from the incoming home before replacing it", () => {
    const env: NodeJS.ProcessEnv = {
      VITEST: "true",
      HOME: "/workspace/devhome",
      LOCALAPPDATA: "/workspace/devhome/AppData/Local",
    };
    isolate(env, () => "/home/account");
    const expected =
      process.platform === "darwin"
        ? join("/workspace/devhome", "Library", "Caches", "ms-playwright")
        : process.platform === "win32"
          ? join("/workspace/devhome/AppData/Local", "ms-playwright")
          : join("/workspace/devhome", ".cache", "ms-playwright");
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(expected);
  });

  it("keeps an explicit Playwright browsers path", () => {
    const env: NodeJS.ProcessEnv = {
      VITEST: "true",
      HOME: "/home/dev",
      PLAYWRIGHT_BROWSERS_PATH: "/opt/browsers",
    };
    isolate(env, () => "/home/dev");
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe("/opt/browsers");
  });

  it("is idempotent once the run has a fake home", () => {
    const env: NodeJS.ProcessEnv = { VITEST: "true", HOME: "/home/dev" };
    const first = isolate(env, () => "/home/dev");
    expect(isolate(env, () => "/home/dev")).toBeUndefined();
    expect(env.HOME).toBe(first);
  });

  it("keeps the real home in live runs but still records it for the guards", () => {
    const env: NodeJS.ProcessEnv = {
      VITEST: "true",
      HOME: "/home/dev",
      F5_CLAUDE_LIVE_TEST: "1",
    };
    expect(isolate(env, () => "/home/dev")).toBeUndefined();
    expect(env.HOME).toBe("/home/dev");
    expect(env.F5_TEST_HOME).toBeUndefined();
    expect(env.F5_TEST_REAL_HOME).toBe("/home/dev");
    expect(env.F5_TEST_PROTECTED_HOMES).toBe(resolve("/home/dev"));
  });

  it("falls back to the incoming home when the account has no passwd entry", () => {
    const env: NodeJS.ProcessEnv = { VITEST: "true", HOME: "/home/container" };
    // os.homedir() reads HOME, which is the incoming home at this point.
    const previousHome = process.env.HOME;
    process.env.HOME = "/home/container";
    try {
      isolate(env, () => undefined);
    } finally {
      process.env.HOME = previousHome;
    }
    expect(env.F5_TEST_REAL_HOME).toBe("/home/container");
  });
});

describe("homeEnvFor", () => {
  it("splits Windows homes into HOMEDRIVE and HOMEPATH", () => {
    expect(homeEnvFor("C:\\Users\\dev\\tmp")).toEqual({
      HOME: "C:\\Users\\dev\\tmp",
      USERPROFILE: "C:\\Users\\dev\\tmp",
      HOMEDRIVE: "C:",
      HOMEPATH: "\\Users\\dev\\tmp",
    });
    expect(homeEnvFor("/tmp/home")).toEqual({ HOME: "/tmp/home", USERPROFILE: "/tmp/home" });
  });
});
