import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  cursorCliConfigDir,
  findPermissiveCursorProjectConfig,
  prepareCursorReadOnlyEnvironment,
  sanitizeCursorCliConfig,
} from "./CursorReadOnlyConfig.ts";

const tempDir = (prefix: string) => mkdtemp(path.join(os.tmpdir(), prefix));
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

describe("cursorCliConfigDir", () => {
  it("follows the CLI: CURSOR_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.cursor", () => {
    const home = process.platform === "win32" ? { USERPROFILE: "/h" } : { HOME: "/h" };
    expect(cursorCliConfigDir({ ...home, CURSOR_CONFIG_DIR: "/c", XDG_CONFIG_HOME: "/x" })).toBe(
      "/c",
    );
    expect(cursorCliConfigDir({ ...home, XDG_CONFIG_HOME: "/x" })).toBe(path.join("/x", "cursor"));
    expect(cursorCliConfigDir({ ...home, CURSOR_CONFIG_DIR: "  " })).toBe(
      path.join("/h", ".cursor"),
    );
  });
});

describe("sanitizeCursorCliConfig", () => {
  it("empties the allowlist, forces allowlist approval and keeps everything else", () => {
    expect(
      sanitizeCursorCliConfig({
        model: { id: "m" },
        approvalMode: "unrestricted",
        permissions: { allow: ["Shell(*)"], deny: ["Shell(rm)"], other: ["x"] },
      }),
    ).toEqual({
      model: { id: "m" },
      approvalMode: "allowlist",
      permissions: { allow: [], deny: ["Shell(rm)"] },
    });
    expect(sanitizeCursorCliConfig(undefined)).toEqual({
      approvalMode: "allowlist",
      permissions: { allow: [], deny: [] },
    });
    expect(sanitizeCursorCliConfig({ approvalMode: "auto-review", permissions: "bad" })).toEqual({
      approvalMode: "allowlist",
      permissions: { allow: [], deny: [] },
    });
  });
});

describe("prepareCursorReadOnlyEnvironment", () => {
  it("copies the user's config sanitized, without permissions.json, and points the CLI at it", async () => {
    const userConfig = await tempDir("cursor-user-config-");
    const homes = await tempDir("cursor-provider-homes-");
    await writeFile(
      path.join(userConfig, "cli-config.json"),
      JSON.stringify({ model: { id: "m" }, permissions: { allow: ["Shell(npm)"] } }),
    );
    await writeFile(
      path.join(userConfig, "permissions.json"),
      JSON.stringify({ terminalAllowlist: ["npm"] }),
    );
    const environment = await prepareCursorReadOnlyEnvironment({
      providerHomesDir: homes,
      instanceId: "work",
      environment: { HOME: "/unused", CURSOR_CONFIG_DIR: userConfig, KEEP: "1" },
    });
    const directory = path.join(homes, "cursor-readonly", "work");
    expect(environment).toEqual({ HOME: "/unused", CURSOR_CONFIG_DIR: directory, KEEP: "1" });
    expect(JSON.parse(await readFile(path.join(directory, "cli-config.json"), "utf8"))).toEqual({
      model: { id: "m" },
      approvalMode: "allowlist",
      permissions: { allow: [], deny: [] },
    });
    expect(await exists(path.join(directory, "permissions.json"))).toBe(false);
    // The user's own files are untouched.
    expect(await exists(path.join(userConfig, "permissions.json"))).toBe(true);
  });

  it("rewrites the copy on every start and removes a permissions.json left in it", async () => {
    const homes = await tempDir("cursor-provider-homes-");
    const userConfig = await tempDir("cursor-user-config-");
    const input = {
      providerHomesDir: homes,
      instanceId: "work",
      environment: { CURSOR_CONFIG_DIR: userConfig },
    };
    await prepareCursorReadOnlyEnvironment(input);
    const directory = path.join(homes, "cursor-readonly", "work");
    await writeFile(
      path.join(directory, "cli-config.json"),
      JSON.stringify({ approvalMode: "unrestricted" }),
    );
    await writeFile(path.join(directory, "permissions.json"), "{}");
    await prepareCursorReadOnlyEnvironment(input);
    expect(JSON.parse(await readFile(path.join(directory, "cli-config.json"), "utf8"))).toEqual({
      approvalMode: "allowlist",
      permissions: { allow: [], deny: [] },
    });
    expect(await exists(path.join(directory, "permissions.json"))).toBe(false);
  });
});

describe("findPermissiveCursorProjectConfig", () => {
  const withProjectConfig = async (config: string) => {
    const repo = await tempDir("cursor-project-");
    await mkdir(path.join(repo, ".cursor"));
    await mkdir(path.join(repo, "a", "b"), { recursive: true });
    await writeFile(path.join(repo, ".cursor", "cli.json"), config);
    return repo;
  };

  it.each([
    JSON.stringify({ permissions: { allow: ["Shell(rm)"] } }),
    JSON.stringify({ permissions: { allow: "Shell(rm)" } }),
    JSON.stringify({ approvalMode: "unrestricted" }),
    JSON.stringify({ approvalMode: "auto-review" }),
  ])("finds %s in an ancestor of the working directory", async (config) => {
    const repo = await withProjectConfig(config);
    expect(await findPermissiveCursorProjectConfig(path.join(repo, "a", "b"))).toBe(
      path.join(repo, ".cursor", "cli.json"),
    );
  });

  it.each([
    JSON.stringify({ permissions: { allow: [], deny: ["Shell(rm)"] } }),
    JSON.stringify({ approvalMode: "allowlist", model: { id: "m" } }),
    "not json",
  ])("accepts %s", async (config) => {
    const repo = await withProjectConfig(config);
    expect(await findPermissiveCursorProjectConfig(path.join(repo, "a", "b"))).toBeUndefined();
  });
});
