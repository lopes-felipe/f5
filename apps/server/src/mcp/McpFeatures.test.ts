import { makeMcpSecretWriter } from "./McpSecretWriter.ts";
import { makeMcpAccountExecutionResolver } from "./accountExecution.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { Effect, Option } from "effect";
import { afterEach, describe, it, expect } from "vitest";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import {
  detectMcpImports,
  otherClientConfigFiles,
  readMcpImportFile,
  serverUserConfigLocation,
} from "./McpImportDetection.ts";
import { probeMcpServer } from "./McpProbe.ts";
import {
  collectMcpSecrets,
  resolveMcpSecrets,
  validateStoredMcpSecrets,
} from "./McpSecretResolver.ts";
import { resolvedMcpSecretsIn } from "./mcpResolvedSecrets.ts";
import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore.ts";

const dirs: string[] = [];
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "f5-mcp-features-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const fixture = fileURLToPath(new URL("./fixtures/probe-server.mjs", import.meta.url));
const execution = { environment: { ...process.env }, cwd: tmpdir() };
function probe(
  mode = "normal",
  options: { startupTimeoutSec?: number; env?: Record<string, string>; args?: string[] } = {},
) {
  return probeMcpServer(
    {
      instanceId: ProviderInstanceId.make("codex"),
      serverName: "fixture",
      server: {
        type: "stdio",
        command: process.execPath,
        args: [fixture, mode, ...(options.args ?? [])],
        ...(options.startupTimeoutSec !== undefined
          ? { startupTimeoutSec: options.startupTimeoutSec }
          : {}),
        ...(options.env ? { env: options.env } : {}),
      },
    },
    execution,
  );
}

describe("MCP feature boundaries", () => {
  it("uses the selected project root for feature operations and rejects unknown project IDs", async () => {
    const projectId = ProjectId.makeUnsafe("feature-project");
    const project = {
      projectId,
      title: "Feature project",
      workspaceRoot: "/selected-project",
      defaultModel: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    };
    const resolver = await Effect.runPromise(
      makeMcpAccountExecutionResolver.pipe(
        Effect.provideService(ProjectionProjectRepository, {
          getById: (input) =>
            Effect.succeed(input.projectId === projectId ? Option.some(project) : Option.none()),
          upsert: () => Effect.void,
          listAll: () => Effect.succeed([project]),
          deleteById: () => Effect.void,
        }),
      ),
    );
    expect((await Effect.runPromise(resolver({ provider: "codex", projectId }))).cwd).toBe(
      "/selected-project",
    );
    await expect(
      Effect.runPromise(
        resolver({ provider: "codex", projectId: ProjectId.makeUnsafe("unknown") }),
      ),
    ).rejects.toThrow("does not exist");
  });
  it("detects top-level and per-project Claude state, .mcp.json, and Codex TOML using account homes", async () => {
    const dir = await temp();
    const claude = join(dir, "claude");
    const codex = join(dir, "codex");
    const project = join(dir, "project");
    await Promise.all([mkdir(claude), mkdir(codex), mkdir(project)]);
    await writeFile(
      join(claude, ".claude.json"),
      JSON.stringify({
        mcpServers: { user: { command: "node" } },
        projects: {
          [project]: { mcpServers: { user: { command: "legacy" } } },
          "/unrelated-project": { mcpServers: { unrelated: { command: "do-not-import" } } },
        },
      }),
    );
    await writeFile(
      join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { project: { type: "http", url: "http://localhost/mcp" } } }),
    );
    await writeFile(
      join(codex, "config.toml"),
      '[mcp_servers.codex]\ncommand="codex-server"\nargs=["", "  value  "]',
    );
    const result = await detectMcpImports({
      environment: { HOME: dir, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex },
      cwd: project,
    });
    expect(result.issues).toEqual([]);
    expect(result.candidates[1]).toMatchObject({
      selectedByDefault: false,
      issues: [expect.objectContaining({ field: "name", severity: "warning" })],
    });
    expect(result.candidates[2]?.selectedByDefault).toBe(false);
    expect(result.candidates.map((entry) => entry.name)).toEqual([
      "user",
      "user",
      "project",
      "codex",
    ]);
  });
  it("offers Cursor, VS Code, Claude Desktop, and OpenCode servers without preselecting them", async () => {
    const dir = await temp();
    const project = join(dir, "project");
    const xdg = join(dir, "xdg");
    await mkdir(join(dir, ".cursor"), { recursive: true });
    await mkdir(join(project, ".vscode"), { recursive: true });
    await mkdir(join(xdg, "opencode"), { recursive: true });
    await writeFile(
      join(dir, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { cursor_user: { command: "cursor-server" } } }),
    );
    await writeFile(
      join(project, ".vscode", "mcp.json"),
      `{
  // VS Code allows comments and trailing commas.
  "servers": { "vscode": { "type": "http", "url": "https://vscode.example/mcp", }, },
  "inputs": [],
}`,
    );
    await writeFile(
      join(xdg, "opencode", "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        mcp: {
          oc_local: { type: "local", command: ["npx", "server"], environment: { K: "{env:K}" } },
          oc_remote: { type: "remote", url: "https://oc.example/mcp", enabled: false },
        },
      }),
    );
    const result = await detectMcpImports({
      environment: { HOME: dir, XDG_CONFIG_HOME: xdg, CLAUDE_CONFIG_DIR: join(dir, "none") },
      cwd: project,
    });
    expect(result.issues).toEqual([]);
    expect(result.candidates.map((entry) => [entry.name, entry.selectedByDefault])).toEqual([
      ["cursor_user", false],
      ["oc_local", false],
      ["oc_remote", false],
      ["vscode", false],
    ]);
    expect(result.candidates[1]!.server).toEqual({
      type: "stdio",
      command: "npx",
      args: ["server"],
      env: { K: "${env:K}" },
    });
    expect(result.candidates[2]!.server).toMatchObject({ type: "http", enabled: false });
    expect(result.candidates[3]!.server).toMatchObject({
      type: "http",
      url: "https://vscode.example/mcp",
    });
  });
  it("lists other clients' configuration paths per platform", () => {
    expect(
      otherClientConfigFiles({ environment: {}, home: "/Users/a", cwd: "/w", platform: "darwin" }),
    ).toEqual([
      "/Users/a/.cursor/mcp.json",
      "/Users/a/Library/Application Support/Code/User/mcp.json",
      "/Users/a/Library/Application Support/Claude/claude_desktop_config.json",
      "/Users/a/.config/opencode/opencode.json",
      "/Users/a/.config/opencode/opencode.jsonc",
      "/w/.cursor/mcp.json",
      "/w/.vscode/mcp.json",
      "/w/opencode.json",
      "/w/opencode.jsonc",
    ]);
    expect(
      otherClientConfigFiles({
        environment: { APPDATA: "C:\\Users\\a\\AppData\\Roaming" },
        home: "C:\\Users\\a",
        platform: "win32",
      })[2],
    ).toBe("C:\\Users\\a\\AppData\\Roaming\\Claude\\claude_desktop_config.json");
  });
  it("refuses to test a server that needs an unset environment variable", async () => {
    const result = await Effect.runPromise(
      probeMcpServer(
        {
          instanceId: ProviderInstanceId.make("codex"),
          serverName: "needs-env",
          server: { type: "http", url: "https://${env:F5_TEST_UNSET_HOST}/mcp" },
        },
        { environment: {}, cwd: tmpdir() },
      ),
    );
    expect(result).toMatchObject({
      ok: false,
      error: "This server needs the environment variable F5_TEST_UNSET_HOST, which is not set.",
    });
  });
  it("ignores Codex TOML without MCP servers during detection", async () => {
    const dir = await temp();
    await mkdir(join(dir, ".codex"));
    await writeFile(
      join(dir, ".codex/config.toml"),
      'model="gpt-5"\n[projects."/tmp"]\ntrust_level="trusted"',
    );
    expect(await detectMcpImports({ environment: { HOME: dir } })).toEqual({
      candidates: [],
      issues: [],
      readFiles: [join(dir, ".codex/config.toml")],
    });
  });
  async function separateProfileFixture() {
    const dir = await temp();
    const user = join(dir, "user");
    const project = join(dir, "project");
    const userConfig = join(user, "cfg");
    // Where otherClientConfigFiles looks for VS Code's user mcp.json on this platform.
    const userAppData =
      process.platform === "darwin" ? join(user, "Library", "Application Support") : userConfig;
    const profileHome = join(dir, "profile", "provider-homes", "claude");
    const profileCodex = join(dir, "profile", "provider-homes", "codex");
    await mkdir(join(user, ".cursor"), { recursive: true });
    await mkdir(join(user, ".codex"), { recursive: true });
    await mkdir(join(userAppData, "Code", "User"), { recursive: true });
    await mkdir(join(profileHome, ".claude"), { recursive: true });
    await mkdir(profileCodex, { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(
      join(user, ".claude.json"),
      JSON.stringify({
        mcpServers: { personal_claude: { command: "a" } },
        projects: { [project]: { mcpServers: { personal_project: { command: "p" } } } },
      }),
    );
    await writeFile(
      join(user, ".codex", "config.toml"),
      '[mcp_servers.personal_codex]\ncommand="b"',
    );
    await writeFile(
      join(user, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: { cursor_user: { command: "c" }, profile_claude: { command: "x" } },
      }),
    );
    await writeFile(
      join(userAppData, "Code", "User", "mcp.json"),
      JSON.stringify({ servers: { vscode_user: { type: "http", url: "https://v.example/mcp" } } }),
    );
    await writeFile(
      join(profileHome, ".claude", ".claude.json"),
      JSON.stringify({ mcpServers: { profile_claude: { command: "d" } } }),
    );
    return {
      user,
      project,
      profileHome,
      environment: {
        F5_PROFILE_ISOLATED: "1",
        HOME: profileHome,
        CLAUDE_CONFIG_DIR: join(profileHome, ".claude"),
        CODEX_HOME: profileCodex,
        XDG_CONFIG_HOME: join(profileHome, ".config"),
      },
      userLocation: () => ({
        home: user,
        environment: { HOME: user, XDG_CONFIG_HOME: userConfig, APPDATA: userConfig },
      }),
    };
  }
  it("reads the user's own home in a separate profile only when asked", async () => {
    const fixture = await separateProfileFixture();
    const withoutHome = await detectMcpImports({
      environment: fixture.environment,
      cwd: fixture.project,
      userLocation: fixture.userLocation,
    });
    expect(withoutHome.candidates.map((entry) => entry.name)).toEqual(["profile_claude"]);
    expect(withoutHome.readFiles).toEqual([join(fixture.profileHome, ".claude", ".claude.json")]);
    expect(withoutHome.userHome).toEqual({ path: fixture.user, included: false });

    const result = await detectMcpImports({
      environment: fixture.environment,
      cwd: fixture.project,
      includeUserHome: true,
      userLocation: fixture.userLocation,
    });
    expect(result.issues).toEqual([]);
    expect(result.userHome).toEqual({ path: fixture.user, included: true });
    expect(result.candidates.map((entry) => [entry.name, entry.selectedByDefault])).toEqual([
      ["profile_claude", undefined],
      ["personal_claude", false],
      ["personal_project", false],
      ["personal_codex", false],
      ["cursor_user", false],
      ["profile_claude", false],
      ["vscode_user", false],
    ]);
    // The Cursor copy of profile_claude is flagged against the profile's own entry.
    expect(result.candidates[5]!.issues).toEqual([
      expect.objectContaining({ field: "name", severity: "warning" }),
    ]);
    expect(result.readFiles).toHaveLength(5);
  });
  it("keeps the Default profile on the account's home even when asked for the user's", async () => {
    const dir = await temp();
    await mkdir(join(dir, ".cursor"));
    await writeFile(
      join(dir, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { cursor_user: { command: "c" } } }),
    );
    await writeFile(
      join(dir, ".claude.json"),
      JSON.stringify({ mcpServers: { account: { command: "a" } } }),
    );
    let asked = false;
    const result = await detectMcpImports({
      // CLAUDE_CONFIG_DIR is blank, so it must fall back to HOME, not the working directory.
      environment: { HOME: dir, CLAUDE_CONFIG_DIR: " " },
      includeUserHome: true,
      userLocation: () => {
        asked = true;
        return { home: join(dir, "elsewhere"), environment: {} };
      },
    });
    expect(asked).toBe(false);
    expect(result.userHome).toBeUndefined();
    expect(result.candidates.map((entry) => [entry.name, entry.selectedByDefault])).toEqual([
      ["account", undefined],
      ["cursor_user", false],
    ]);
  });
  it("reads a file reached through two spellings once", async () => {
    const dir = await temp();
    const codex = join(dir, "codex");
    await mkdir(codex);
    await symlink(codex, join(dir, "codex-link"));
    await writeFile(join(codex, "config.toml"), '[mcp_servers.once]\ncommand="a"');
    const result = await detectMcpImports({
      environment: { F5_PROFILE_ISOLATED: "1", HOME: join(dir, "profile"), CODEX_HOME: codex },
      includeUserHome: true,
      userLocation: () => ({
        home: join(dir, "user"),
        environment: { CODEX_HOME: join(dir, "codex-link") },
      }),
    });
    expect(result.candidates.map((entry) => entry.name)).toEqual(["once"]);
    expect(result.readFiles).toEqual([join(codex, "config.toml")]);
  });
  it("finds the server user's home from HOME, then the account database", () => {
    expect(serverUserConfigLocation({ HOME: "/work/home" }, () => "/home/a").home).toBe(
      "/work/home",
    );
    expect(serverUserConfigLocation({ HOME: "" }, () => "/home/a").home).toBe("/home/a");
    expect(
      serverUserConfigLocation({}, () => {
        throw new Error("no account entry");
      }).home.length,
    ).toBeGreaterThan(0);
  });
  it("refuses symlinks, directories, and oversized import files", async () => {
    const dir = await temp();
    const file = join(dir, "large");
    await writeFile(file, Buffer.alloc(1024 * 1024 + 1));
    await expect(readMcpImportFile(file)).rejects.toThrow("1 MiB");
    await symlink(file, join(dir, "link"));
    await expect(readMcpImportFile(join(dir, "link"))).rejects.toThrow();
    await expect(readMcpImportFile(dir)).rejects.toThrow("regular files");
  });
  it("initializes stdio and lists capabilities without running a tool", async () => {
    const result = await Effect.runPromise(probe());
    expect(result).toMatchObject({
      ok: true,
      toolsTruncated: false,
      resourceCount: 1,
      promptCount: 1,
      serverInfo: { name: "probe-fixture" },
    });
    expect(result.tools[0]).toMatchObject({ name: "tool0", readOnly: true });
  });
  it("redacts echoed environment credentials and caps tools", async () => {
    const result = await Effect.runPromise(
      probe("many", { env: { PROBE_TOKEN: "very-private-token" } }),
    );
    expect(result.tools).toHaveLength(200);
    expect(result.toolsTruncated).toBe(true);
    expect(result.stderrTail).toContain("[redacted]");
    expect(JSON.stringify(result)).not.toContain("very-private-token");
  });
  it("redacts bare inherited account credentials from probe stderr", async () => {
    const result = await Effect.runPromise(
      probeMcpServer(
        {
          serverName: "inherited",
          server: { type: "stdio", command: process.execPath, args: [fixture, "fail"] },
        },
        {
          ...execution,
          environment: { ...execution.environment, ACCOUNT_TOKEN: "inherited-private-value" },
        },
      ),
    );
    expect(result.stderrTail).toContain("[redacted]");
    expect(JSON.stringify(result)).not.toContain("inherited-private-value");
  });
  it("caps tool fields after redaction expands them", async () => {
    const result = await Effect.runPromise(
      probe("sanitizer-growth", { env: { PROBE_TOKEN: "abcdefgh" } }),
    );
    expect(result.ok).toBe(true);
    expect(result.tools[0]?.name).toHaveLength(128);
    expect(result.tools[0]?.description).toHaveLength(300);
    expect(result.tools[0]?.name).toContain("[redacted]");
  });
  it("returns sanitized stderr when a stdio command exits before initialization", async () => {
    const result = await Effect.runPromise(
      probe("fail", { env: { PROBE_TOKEN: "sensitive-stderr-token" } }),
    );
    expect(result.ok).toBe(false);
    expect(result.stderrTail).toContain("[redacted]");
    expect(JSON.stringify(result)).not.toContain("sensitive-stderr-token");
  });
  it("times out startup and rejects a concurrent test of the same account and server", async () => {
    const first = Effect.runPromise(probe("hang", { startupTimeoutSec: 1 }));
    // The first effect acquires admission before yielding to spawn.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await Effect.runPromise(probe());
    expect(second.error).toBe("This server is already being tested.");
    expect((await first).ok).toBe(false);
  });
  it("kills a forked grandchild after a successful probe", async () => {
    const filename = join(await temp(), "pid");
    const result = await Effect.runPromise(probe("grandchild", { args: [filename] }));
    expect(result.ok).toBe(true);
    const pid = Number(await readFile(filename, "utf8"));
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  });
  it("releases the entire stdio group when a caller interrupts a probe", async () => {
    const filename = join(await temp(), "interrupted-pid");
    const controller = new AbortController();
    const running = Effect.runPromise(probe("hang-grandchild", { args: [filename] }), {
      signal: controller.signal,
    });
    let pid: number | undefined;
    try {
      await Promise.race([
        expect
          .poll(
            async () => {
              try {
                return Number(await readFile(filename, "utf8")) > 0;
              } catch {
                return false;
              }
            },
            { timeout: 5000 },
          )
          .toBe(true),
        running.then((result) => {
          throw new Error(`Probe ended before interruption: ${JSON.stringify(result)}`);
        }),
      ]);
      pid = Number(await readFile(filename, "utf8"));
    } finally {
      controller.abort();
      await running.catch(() => undefined);
    }
    await expect(running).rejects.toThrow();
    await expect
      .poll(
        () => {
          try {
            process.kill(pid!, 0);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 5000 },
      )
      .toBe(false);
  });

  it("admits at most four probes globally across different servers", async () => {
    const pending = Array.from({ length: 4 }, (_, index) =>
      Effect.runPromise(
        probeMcpServer(
          {
            serverName: `global-${index}`,
            server: {
              type: "stdio",
              command: process.execPath,
              args: [fixture, "hang"],
              startupTimeoutSec: 1,
            },
          },
          execution,
        ),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await Effect.runPromise(
      probeMcpServer(
        {
          serverName: "global-fifth",
          server: { type: "stdio", command: process.execPath, args: [fixture] },
        },
        execution,
      ),
    );
    expect(result.error).toBe(
      "Too many tests are running (limit 4). Wait for one to finish and try again.",
    );
    expect((await Promise.all(pending)).every((entry) => !entry.ok)).toBe(true);
  });
  it("recognizes HTTP 401 without beginning an authentication flow", async () => {
    const server = createServer((_, response) => {
      response.writeHead(401);
      response.end("Unauthorized");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No fixture port.");
      const result = await Effect.runPromise(
        probeMcpServer(
          {
            serverName: "http",
            server: { type: "http", url: `http://127.0.0.1:${address.port}/mcp` },
          },
          execution,
        ),
      );
      expect(result).toMatchObject({ ok: false, authRequired: true });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("skips only a missing-secret server and keeps referenced and fresh secrets during collection", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const removed: string[] = [];
    const store: ServerSecretStoreShape = {
      get: (name) =>
        Effect.succeed(
          name === `mcp-secret-${id}` ? new TextEncoder().encode("private-value") : null,
        ),
      set: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      remove: (name) =>
        Effect.sync(() => {
          removed.push(name);
        }),
      list: () =>
        Effect.succeed([
          { name: `mcp-secret-${id}`, modifiedAt: 0 },
          { name: "mcp-secret-stale", modifiedAt: 0 },
          { name: "mcp-secret-fresh", modifiedAt: Date.now() },
        ]),
    };
    const servers = {
      good: { type: "stdio" as const, command: "node", env: { TOKEN: "${f5-secret:" + id + "}" } },
      missing: {
        type: "http" as const,
        url: "https://example.com",
        headers: { Authorization: "${f5-secret:00000000-0000-4000-8000-000000000001}" },
      },
    };
    const resolved = await Effect.runPromise(resolveMcpSecrets(servers, store));
    expect(resolved.servers.good?.env?.TOKEN).toBe("private-value");
    expect(resolved.servers.missing).toBeUndefined();
    expect(resolved.issues[0]?.serverName).toBe("missing");
    await expect(Effect.runPromise(validateStoredMcpSecrets(servers, store))).rejects.toThrow(
      "missing",
    );
    await Effect.runPromise(
      validateStoredMcpSecrets(
        { ...servers, missing: { ...servers.missing, enabled: false } },
        store,
        servers,
      ),
    );
    await expect(Effect.runPromise(validateStoredMcpSecrets(servers, store))).rejects.toThrow(
      "missing.headers.Authorization",
    );
    // References inside values, arguments and URLs resolve too, and are remembered for redaction.
    const reference = "${f5-secret:" + id + "}";
    const embedded = await Effect.runPromise(
      resolveMcpSecrets(
        {
          cli: {
            type: "stdio",
            command: "node",
            args: [`--token=${reference}`],
            env: { AUTH: `Bearer ${reference}` },
          },
          remote: { type: "http", url: `https://example.com/mcp?key=${reference}` },
        },
        store,
      ),
    );
    expect(embedded.issues).toEqual([]);
    expect(embedded.servers.cli?.args).toEqual(["--token=private-value"]);
    expect(embedded.servers.cli?.env?.AUTH).toBe("Bearer private-value");
    expect(embedded.servers.remote?.url).toBe("https://example.com/mcp?key=private-value");
    // The whole field and the value itself, longest first.
    expect(resolvedMcpSecretsIn("--token=private-value")).toEqual([
      "--token=private-value",
      "private-value",
    ]);
    await Effect.runPromise(collectMcpSecrets(store, servers));
    expect(removed).toEqual(["mcp-secret-stale"]);
  });
});

it("bounds secret writes across concurrent clients without exposing values in errors", async () => {
  const entries = new Map<string, Uint8Array>();
  const store: ServerSecretStoreShape = {
    get: (name) => Effect.succeed(entries.get(name) ?? null),
    set: (name, value) =>
      Effect.sync(() => {
        entries.set(name, value);
      }),
    list: () =>
      Effect.succeed([...entries.keys()].map((name) => ({ name, modifiedAt: Date.now() }))),
    remove: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
  };
  const write = await Effect.runPromise(makeMcpSecretWriter(store, 2));
  const results = await Promise.allSettled(
    ["first", "second", "third"].map((value) => Effect.runPromise(write(value))),
  );
  expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(2);
  expect(entries.size).toBe(2);
  await expect(Effect.runPromise(write("private-value"))).rejects.toThrow("storage limit");
});
