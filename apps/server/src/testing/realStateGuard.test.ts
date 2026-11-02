import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import setupRealStateGuard from "../../scripts/realStateGuard.globalSetup.ts";
import { watchProfileDatabases } from "./realStateGuard.ts";

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");

const homes: string[] = [];

function fakeHome(): string {
  const home = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-guard-home-"));
  homes.push(home);
  return home;
}

function writeDatabase(path: string): void {
  FS.mkdirSync(Path.dirname(path), { recursive: true });
  FS.writeFileSync(path, Buffer.concat([SQLITE_HEADER, Buffer.alloc(84)]));
}

function restoreOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const home of homes.splice(0)) FS.rmSync(home, { recursive: true, force: true });
});

describe("realStateGuard", () => {
  it("reports damaged headers and missing files separately", () => {
    const home = fakeHome();
    const damaged = Path.join(home, ".f5", "userdata", "state.sqlite");
    const deleted = Path.join(home, ".f5", "userdata-profiles", "work", "state.sqlite");
    const legacy = Path.join(home, ".t3", "userdata", "state.sqlite");
    for (const path of [damaged, deleted, legacy]) writeDatabase(path);

    const check = watchProfileDatabases([home]);
    FS.writeFileSync(damaged, "ready");
    FS.rmSync(deleted);
    FS.writeFileSync(legacy, "ready");

    expect(check()).toEqual({ damaged: [damaged, legacy], missing: [deleted] });
  });

  it("fails the process exit code when a real database is damaged", () => {
    const home = fakeHome();
    const database = Path.join(home, ".f5", "userdata", "state.sqlite");
    writeDatabase(database);
    const previous = {
      real: process.env.F5_TEST_REAL_HOME,
      protected: process.env.F5_TEST_PROTECTED_HOMES,
      exitCode: process.exitCode,
    };
    try {
      process.env.F5_TEST_REAL_HOME = home;
      process.env.F5_TEST_PROTECTED_HOMES = home;
      const teardown = setupRealStateGuard();
      FS.writeFileSync(database, "ready");
      expect(() => teardown?.()).toThrow(/damaged real F5 profile databases/u);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previous.exitCode;
      restoreOptionalEnv("F5_TEST_REAL_HOME", previous.real);
      restoreOptionalEnv("F5_TEST_PROTECTED_HOMES", previous.protected);
    }
  });

  it("does not fail when a real database is deleted during the run", () => {
    const home = fakeHome();
    const database = Path.join(home, ".f5", "userdata", "state.sqlite");
    writeDatabase(database);
    const check = watchProfileDatabases([home]);
    FS.rmSync(database);
    expect(check().damaged).toEqual([]);
  });
});
