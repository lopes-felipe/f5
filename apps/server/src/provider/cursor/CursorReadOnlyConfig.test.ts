import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { cursorHomeDir } from "./CursorNativeSessions.ts";
import {
  cursorCliConfigDir,
  findCursorProjectConfigConflict,
  prepareCursorReadOnlyEnvironment,
  sanitizeCursorCliConfig,
} from "./CursorReadOnlyConfig.ts";

const tempDir = (prefix: string) => mkdtemp(path.join(os.tmpdir(), prefix));
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

describe("Cursor config dirs", () => {
  it("resolves the CLI config dir like the CLI: CURSOR_CONFIG_DIR, XDG_CONFIG_HOME, ~/.cursor", () => {
    const home = process.platform === "win32" ? { USERPROFILE: "/h" } : { HOME: "/h" };
    expect(cursorCliConfigDir({ ...home, CURSOR_CONFIG_DIR: "/c", XDG_CONFIG_HOME: "/x" })).toBe(
      "/c",
    );
    // The CLI applies XDG_CONFIG_HOME on macOS too.
    expect(cursorCliConfigDir({ ...home, XDG_CONFIG_HOME: "/x" })).toBe(path.join("/x", "cursor"));
    expect(cursorCliConfigDir({ ...home, CURSOR_CONFIG_DIR: "  " })).toBe(
      path.join("/h", ".cursor"),
    );
  });

  it("keeps ~/.cursor for what the CLI reads from home whatever the config dir", () => {
    expect(cursorHomeDir({ HOME: "/h", CURSOR_CONFIG_DIR: "/c", XDG_CONFIG_HOME: "/x" })).toBe(
      path.join("/h", ".cursor"),
    );
  });
});

describe("sanitizeCursorCliConfig", () => {
  it("keeps only display, model and account settings, empties the allowlist, forces allowlist", () => {
    expect(
      sanitizeCursorCliConfig({
        version: 1,
        model: { modelId: "m" },
        display: { mode: "dark" },
        authInfo: { email: "user@example.com" },
        approvalMode: "unrestricted",
        sandbox: { mode: "enabled" },
        autoAcceptWebSearch: true,
        someFutureAutoRun: true,
        permissions: { allow: ["Shell(*)"], deny: ["Shell(rm)"], other: ["x"] },
      }),
    ).toEqual({
      version: 1,
      model: { modelId: "m" },
      display: { mode: "dark" },
      authInfo: { email: "user@example.com" },
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

  it("lets stages of one instance prepare the config at the same time", async () => {
    const homes = await tempDir("cursor-provider-homes-");
    const userConfig = await tempDir("cursor-user-config-");
    const input = {
      providerHomesDir: homes,
      instanceId: "work",
      environment: { CURSOR_CONFIG_DIR: userConfig },
    };
    await Promise.all(Array.from({ length: 8 }, () => prepareCursorReadOnlyEnvironment(input)));
    const directory = path.join(homes, "cursor-readonly", "work");
    expect(JSON.parse(await readFile(path.join(directory, "cli-config.json"), "utf8"))).toEqual({
      approvalMode: "allowlist",
      permissions: { allow: [], deny: [] },
    });
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
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

describe("findCursorProjectConfigConflict", () => {
  /** A repository with `.git`, a nested working directory, and the given project files. */
  const makeRepo = async (files: Record<string, string>) => {
    const repo = await tempDir("cursor-project-");
    await mkdir(path.join(repo, ".git"));
    await mkdir(path.join(repo, ".cursor"));
    await mkdir(path.join(repo, "a", "b"), { recursive: true });
    for (const [name, content] of Object.entries(files))
      await writeFile(path.join(repo, ".cursor", name), content);
    return repo;
  };
  const check = (repo: string) =>
    findCursorProjectConfigConflict(path.join(repo, "a", "b"), { homeDir: "/nonexistent-home" });

  it.each([
    [{ permissions: { allow: ["Shell(rm)"] } }, "sets `permissions.allow`"],
    [{ permissions: { allow: "Shell(rm)" } }, "sets `permissions.allow`"],
    [{ permissions: { ask: [] } }, "sets `permissions.ask`, which F5 doesn't recognise"],
    [{ approvalMode: "unrestricted" }, "sets `approvalMode`"],
    [{ approvalMode: "auto-review" }, "sets `approvalMode`"],
    [{ model: { id: "m" } }, "sets `model`, which F5 doesn't recognise"],
    [["Shell(*)"], "isn't a JSON object"],
  ])("refuses a cli.json with %j in an ancestor", async (config, reason) => {
    const repo = await makeRepo({ "cli.json": JSON.stringify(config) });
    expect(await check(repo)).toEqual({
      file: path.join(repo, ".cursor", "cli.json"),
      reason: expect.stringContaining(reason),
    });
  });

  it.each([{ permissions: { allow: [], deny: ["Shell(rm)"] } }, { approvalMode: "allowlist" }, {}])(
    "accepts a cli.json with %j",
    async (config) => {
      expect(await check(await makeRepo({ "cli.json": JSON.stringify(config) }))).toBeUndefined();
    },
  );

  it("refuses a cli.json that isn't strict JSON, such as JSON with comments", async () => {
    const repo = await makeRepo({
      "cli.json": '{ // allow everything\n "permissions": { "allow": ["Shell(*)"] }, }',
    });
    expect(await check(repo)).toMatchObject({ reason: expect.stringContaining("strict JSON") });
  });

  it("refuses a cli.json that is a directory", async () => {
    const repo = await makeRepo({});
    await mkdir(path.join(repo, ".cursor", "cli.json"));
    expect(await check(repo)).toMatchObject({
      reason: expect.stringMatching(/not a regular file|can't be read/),
    });
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO without blocking on it", async () => {
    const repo = await makeRepo({});
    execFileSync("mkfifo", [path.join(repo, ".cursor", "cli.json")]);
    expect(await check(repo)).toMatchObject({ reason: "is not a regular file" });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses a cli.json it can't read",
    async () => {
      const repo = await makeRepo({ "cli.json": "{}" });
      await chmod(path.join(repo, ".cursor", "cli.json"), 0o000);
      expect(await check(repo)).toMatchObject({ reason: "can't be read (EACCES)" });
    },
  );

  it("refuses an oversized cli.json", async () => {
    const repo = await makeRepo({
      "cli.json": `{"permissions":{"deny":[]}}${" ".repeat(300_000)}`,
    });
    expect(await check(repo)).toMatchObject({ reason: expect.stringContaining("larger than") });
  });

  it.each([
    [
      "hooks.json",
      { version: 1, hooks: { beforeShellExecution: [{ command: "./x.sh" }] } },
      "hooks",
    ],
    ["mcp.json", { mcpServers: { local: { command: "node", args: ["s.js"] } } }, "MCP servers"],
  ])("refuses a project %s that defines something", async (name, config, what) => {
    const repo = await makeRepo({ [name]: JSON.stringify(config) });
    expect(await check(repo)).toEqual({
      file: path.join(repo, ".cursor", name),
      reason: expect.stringContaining(what),
    });
  });

  it("accepts empty project hooks and MCP files", async () => {
    const repo = await makeRepo({
      "hooks.json": JSON.stringify({ version: 1, hooks: {} }),
      "mcp.json": JSON.stringify({ mcpServers: {} }),
    });
    expect(await check(repo)).toBeUndefined();
  });

  it("ignores hooks and MCP files above the repository root and in the home folder", async () => {
    const outer = await tempDir("cursor-outer-");
    await mkdir(path.join(outer, ".cursor"));
    await writeFile(
      path.join(outer, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { mine: { command: "x" } } }),
    );
    const repo = path.join(outer, "repo");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    expect(
      await findCursorProjectConfigConflict(repo, { homeDir: "/nonexistent" }),
    ).toBeUndefined();
    // Without a repository only the working directory counts, and home is the user's own.
    const home = await tempDir("cursor-home-");
    await mkdir(path.join(home, ".cursor"));
    await writeFile(
      path.join(home, ".cursor", "hooks.json"),
      JSON.stringify({ hooks: { stop: [{ command: "x" }] } }),
    );
    expect(await findCursorProjectConfigConflict(home, { homeDir: home })).toBeUndefined();
  });

  it("still checks cli.json above the repository root", async () => {
    const outer = await tempDir("cursor-outer-");
    await mkdir(path.join(outer, ".cursor"));
    await writeFile(
      path.join(outer, ".cursor", "cli.json"),
      JSON.stringify({ approvalMode: "unrestricted" }),
    );
    const repo = path.join(outer, "repo");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    expect(await findCursorProjectConfigConflict(repo, { homeDir: "/nonexistent" })).toMatchObject({
      file: path.join(outer, ".cursor", "cli.json"),
    });
  });
});
