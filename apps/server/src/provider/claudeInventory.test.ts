import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  claudeAgentMemoryPath,
  hookProgramName,
  parseClaudeHooks,
  parseInstalledPlugins,
  readClaudeInventory,
  resolveClaudeUserStatePath,
} from "./claudeInventory.ts";

let root: string;

async function write(path: string, content: unknown) {
  await NodeFs.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFs.writeFile(
    path,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
  );
}

function agentFile(name: string, memory?: string) {
  return `---\nname: ${name}\ndescription: ${name} agent\n${memory ? `memory: ${memory}\n` : ""}---\nBody\n`;
}

beforeEach(async () => {
  root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "f5-claude-inventory-"));
});

afterEach(async () => {
  await NodeFs.rm(root, { recursive: true, force: true });
});

describe("hookProgramName", () => {
  it("keeps only the program name, never its arguments", () => {
    expect(hookProgramName("TOKEN=abc /usr/local/bin/notify --key secret")).toBe("notify");
    expect(hookProgramName('"C:\\tools\\lint.exe" --fix')).toBe("lint.exe");
    expect(hookProgramName("   ")).toBeUndefined();
  });
});

describe("parseClaudeHooks", () => {
  it("flattens matcher groups and omits commands", () => {
    const hooks = parseClaudeHooks(
      {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "./guard.sh --token=xyz" },
              { type: "http", url: "https://hooks.example.com/path?key=1" },
            ],
          },
        ],
      },
      { source: "project", sourcePath: "/repo/.claude/settings.json" },
    );
    expect(hooks).toEqual([
      {
        event: "PreToolUse",
        matcher: "Bash",
        handlerType: "command",
        program: "guard.sh",
        source: "project",
        sourcePath: "/repo/.claude/settings.json",
      },
      {
        event: "PreToolUse",
        matcher: "Bash",
        handlerType: "http",
        program: "hooks.example.com",
        source: "project",
        sourcePath: "/repo/.claude/settings.json",
      },
    ]);
    expect(JSON.stringify(hooks)).not.toContain("xyz");
  });
});

describe("parseInstalledPlugins", () => {
  it("reads v1 and v2 layouts", () => {
    expect(parseInstalledPlugins({ version: 1, plugins: { "a@m": { version: "1.0.0" } } })).toEqual(
      [{ key: "a@m", version: "1.0.0" }],
    );
    expect(
      parseInstalledPlugins({
        version: 2,
        plugins: { "b@m": [{ scope: "project", projectPath: "/repo", installPath: "/x" }] },
      }),
    ).toEqual([{ key: "b@m", scope: "project", projectPath: "/repo", installPath: "/x" }]);
  });
});

describe("claudeAgentMemoryPath", () => {
  it("maps each scope to its directory and resolves user scope through the config dir", () => {
    const base = { agentName: "reviewer", configDir: "/profiles/a/.claude", projectRoot: "/repo" };
    expect(claudeAgentMemoryPath({ ...base, scope: "user" })).toBe(
      "/profiles/a/.claude/agent-memory/reviewer",
    );
    expect(claudeAgentMemoryPath({ ...base, scope: "project" })).toBe(
      "/repo/.claude/agent-memory/reviewer",
    );
    expect(claudeAgentMemoryPath({ ...base, scope: "local" })).toBe(
      "/repo/.claude/agent-memory-local/reviewer",
    );
    expect(claudeAgentMemoryPath({ ...base, agentName: "../escape", scope: "user" })).toBe(
      undefined,
    );
  });
});

describe("resolveClaudeUserStatePath", () => {
  it("uses the config dir only when CLAUDE_CONFIG_DIR is set", () => {
    expect(resolveClaudeUserStatePath({ CLAUDE_CONFIG_DIR: "/c" }, "/c", "linux")).toBe(
      "/c/.claude.json",
    );
    expect(resolveClaudeUserStatePath({}, "/home/u/.claude", "linux")).toBe("/home/u/.claude.json");
  });
});

describe("readClaudeInventory", () => {
  it("keeps two isolated profiles on one project from seeing each other's private entries", async () => {
    const project = NodePath.join(root, "repo");
    const profileA = NodePath.join(root, "profile-a", ".claude");
    const profileB = NodePath.join(root, "profile-b", ".claude");

    await write(NodePath.join(project, ".claude", "settings.json"), {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "project-hook" }] }] },
    });
    await write(
      NodePath.join(project, ".claude", "agents", "shared.md"),
      agentFile("shared", "project"),
    );
    await write(NodePath.join(project, ".mcp.json"), {
      mcpServers: { docs: { command: "docs-mcp", env: { TOKEN: "secret" } } },
    });

    await write(NodePath.join(profileA, "settings.json"), {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "a-hook" }] }] },
    });
    await write(NodePath.join(profileA, "agents", "alpha.md"), agentFile("alpha", "user"));
    await NodeFs.mkdir(NodePath.join(profileA, "agent-memory", "alpha"), { recursive: true });
    await write(NodePath.join(profileA, ".claude.json"), {
      mcpServers: { "a-private": { type: "http", url: "https://a.example", headers: { x: "y" } } },
    });

    await write(NodePath.join(profileB, "agents", "beta.md"), agentFile("beta", "local"));
    await write(NodePath.join(profileB, ".claude.json"), {
      mcpServers: { "b-private": { command: "b" } },
    });

    const read = (configDir: string) =>
      readClaudeInventory({
        configDir,
        userStatePath: NodePath.join(configDir, ".claude.json"),
        projectRoot: project,
        managedSettingsPath: NodePath.join(root, "managed", "managed-settings.json"),
      });
    const [a, b] = await Promise.all([read(profileA), read(profileB)]);

    expect(a.hooks.map((hook) => [hook.program, hook.source])).toEqual([
      ["a-hook", "instance"],
      ["project-hook", "project"],
    ]);
    expect(b.hooks.map((hook) => [hook.program, hook.source])).toEqual([
      ["project-hook", "project"],
    ]);

    expect(a.agents.map((agent) => [agent.name, agent.memoryScope, agent.memoryExists])).toEqual([
      ["alpha", "user", true],
      ["shared", "project", false],
    ]);
    expect(a.agents[0]?.memoryPath).toBe(NodePath.join(profileA, "agent-memory", "alpha"));
    expect(b.agents.map((agent) => [agent.name, agent.memoryScope, agent.source])).toEqual([
      ["beta", "local", "instance"],
      ["shared", "project", "project"],
    ]);
    expect(b.agents[0]?.memoryPath).toBe(
      NodePath.join(project, ".claude", "agent-memory-local", "beta"),
    );

    expect(a.connectors.map((connector) => connector.name).toSorted()).toEqual([
      "a-private",
      "docs",
    ]);
    expect(b.connectors.map((connector) => connector.name).toSorted()).toEqual([
      "b-private",
      "docs",
    ]);
    expect(JSON.stringify([a, b])).not.toContain("secret");
    expect(JSON.stringify(b)).not.toContain("profile-a");
    expect(JSON.stringify(a)).not.toContain("profile-b");
  });

  it("lists installed plugins with their contributed hooks and agents", async () => {
    const configDir = NodePath.join(root, ".claude");
    const installPath = NodePath.join(configDir, "plugins", "cache", "m", "tools", "1.0.0");
    await write(NodePath.join(configDir, "plugins", "installed_plugins.json"), {
      version: 2,
      plugins: {
        "tools@m": [{ scope: "user", installPath, version: "1.0.0" }],
        "other@m": [{ scope: "project", projectPath: "/elsewhere", installPath }],
      },
    });
    await write(NodePath.join(configDir, "settings.json"), { enabledPlugins: { "tools@m": true } });
    await write(NodePath.join(installPath, "hooks", "hooks.json"), {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/x" }] }],
      },
    });
    await write(NodePath.join(installPath, "agents", "helper.md"), agentFile("helper"));

    const inventory = await readClaudeInventory({
      configDir,
      userStatePath: NodePath.join(configDir, ".claude.json"),
      managedSettingsPath: NodePath.join(root, "managed", "managed-settings.json"),
    });
    expect(inventory.plugins).toEqual([
      {
        id: "tools@m",
        name: "tools",
        version: "1.0.0",
        marketplace: "m",
        enabled: true,
        source: "instance",
        sourcePath: installPath,
      },
    ]);
    expect(inventory.hooks).toEqual([
      expect.objectContaining({ event: "SessionStart", source: "plugin", pluginId: "tools@m" }),
    ]);
    expect(inventory.agents).toEqual([
      expect.objectContaining({ name: "helper", source: "plugin" }),
    ]);
  });

  it("reports malformed files as warnings instead of failing", async () => {
    const configDir = NodePath.join(root, ".claude");
    await write(NodePath.join(configDir, "settings.json"), "{ not json");
    const inventory = await readClaudeInventory({
      configDir,
      userStatePath: NodePath.join(configDir, ".claude.json"),
      managedSettingsPath: NodePath.join(root, "managed", "managed-settings.json"),
    });
    expect(inventory.hooks).toEqual([]);
    expect(inventory.warnings).toEqual([
      `${NodePath.join(configDir, "settings.json")} is not valid JSON.`,
    ]);
  });
});
