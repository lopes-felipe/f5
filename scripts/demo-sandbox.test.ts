import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { isProtectedAppStateDir } from "@t3tools/shared/appStatePaths";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEMO_SERVER_SETTINGS,
  PASSTHROUGH_KEYS,
  createDemoRoot,
  isolatedEnv,
  writeDemoSettings,
} from "./lib/demo-sandbox.ts";

const roots: string[] = [];
const PLANTED = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "META_API_KEY", "GH_TOKEN", "CODEX_HOME"];
// Tests overwrite these, so restore the developer's real values afterwards.
const ORIGINAL_ENV = Object.fromEntries(
  [...PLANTED, ...PASSTHROUGH_KEYS].map((key) => [key, process.env[key]]),
);
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function freshRoot(): string {
  const root = createDemoRoot("f5-demo-sandbox-test-");
  roots.push(root);
  return root;
}

describe("demo sandbox", () => {
  it("creates a fresh root with state and home outside protected dirs", () => {
    const root = freshRoot();
    expect(root.startsWith(Path.resolve(OS.tmpdir()))).toBe(true);
    expect(existsSync(Path.join(root, "state"))).toBe(true);
    expect(existsSync(Path.join(root, "home"))).toBe(true);
    expect(isProtectedAppStateDir(Path.join(root, "state"))).toBe(false);
  });

  it("never reuses a root", () => {
    expect(freshRoot()).not.toBe(freshRoot());
  });

  it("drops credentials and provider overrides from the child env", () => {
    for (const key of PLANTED) process.env[key] = "planted-secret";
    const root = freshRoot();
    const env = isolatedEnv(root, { F5_SKIP_USERDATA_IMPORT: "1" });
    for (const key of PLANTED) expect(env[key]).toBeUndefined();
    expect(Object.values(env)).not.toContain("planted-secret");
    expect(env.HOME).toBe(Path.join(root, "home"));
    expect(env.F5_STATE_DIR).toBe(Path.join(root, "state"));
    expect(env.T3CODE_STATE_DIR).toBe(Path.join(root, "state"));
    expect(env.F5_SKIP_USERDATA_IMPORT).toBe("1");
  });

  it("passes through display, temp and shell variables", () => {
    // Create the root first: TMPDIR, TEMP and TMP steer os.tmpdir().
    const root = freshRoot();
    for (const key of PASSTHROUGH_KEYS) process.env[key] = `value-of-${key}`;
    const env = isolatedEnv(root);
    for (const key of [
      "PATH",
      "TEMP",
      "TMP",
      "DISPLAY",
      "WAYLAND_DISPLAY",
      "XAUTHORITY",
      "XDG_RUNTIME_DIR",
    ]) {
      expect(env[key]).toBe(`value-of-${key}`);
    }
  });

  it("keeps a child process's home and app-data resolution inside the root", () => {
    const root = freshRoot();
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        "const os = require('node:os'); process.stdout.write(JSON.stringify([os.homedir(), process.env.USERPROFILE, process.env.APPDATA, process.env.LOCALAPPDATA]))",
      ],
      { env: isolatedEnv(root), encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const resolved = JSON.parse(result.stdout) as string[];
    for (const value of resolved) {
      expect(Path.resolve(value).startsWith(Path.join(root, "home"))).toBe(true);
    }
  });

  it("writes demo server settings into the state dir", () => {
    const root = freshRoot();
    const file = writeDemoSettings(root);
    expect(file).toBe(Path.join(root, "state", "settings.json"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(DEMO_SERVER_SETTINGS);
  });
});
