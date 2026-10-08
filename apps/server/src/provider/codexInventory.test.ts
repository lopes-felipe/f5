import { describe, expect, it } from "vitest";

import {
  codexInventorySource,
  parseCodexApps,
  parseCodexHooks,
  parseCodexMcpServersFromLayers,
  parseCodexPlugins,
} from "./codexInventory.ts";

describe("codexInventorySource", () => {
  it("maps hook and config layer sources to owners", () => {
    expect(codexInventorySource("user")).toBe("instance");
    expect(codexInventorySource("sessionFlags")).toBe("instance");
    expect(codexInventorySource("project")).toBe("project");
    expect(codexInventorySource("plugin")).toBe("plugin");
    expect(codexInventorySource("mdm")).toBe("managed");
    expect(codexInventorySource("enterpriseManaged")).toBe("managed");
    expect(codexInventorySource("legacyManagedConfigTomlFromFile")).toBe("managed");
    expect(codexInventorySource("somethingNew")).toBe("unknown");
  });
});

describe("parseCodexHooks", () => {
  it("dedupes by key, omits arguments and marks managed hooks", () => {
    expect(
      parseCodexHooks([
        {
          cwd: "/repo",
          hooks: [
            {
              key: "h1",
              eventName: "preToolUse",
              matcher: "shell",
              handlerType: "command",
              command: "/bin/check --secret=1",
              source: "project",
              sourcePath: "/repo/.codex/hooks.json",
              enabled: true,
              isManaged: false,
            },
            { key: "h1", eventName: "preToolUse", source: "project" },
            { key: "h2", eventName: "stop", source: "user", isManaged: true },
          ],
        },
      ]),
    ).toEqual([
      {
        event: "preToolUse",
        matcher: "shell",
        handlerType: "command",
        program: "check",
        source: "project",
        sourcePath: "/repo/.codex/hooks.json",
        enabled: true,
      },
      { event: "stop", source: "managed" },
    ]);
  });
});

describe("parseCodexPlugins", () => {
  it("lists installed plugins only", () => {
    expect(
      parseCodexPlugins({
        marketplaces: [
          {
            name: "local",
            path: "/home/.codex/plugins",
            plugins: [
              { id: "a", name: "Alpha", installed: true, enabled: false, localVersion: "2.0" },
              { id: "b", name: "Beta", installed: false },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        id: "a",
        name: "Alpha",
        version: "2.0",
        marketplace: "local",
        enabled: false,
        source: "instance",
        sourcePath: "/home/.codex/plugins",
      },
    ]);
  });
});

describe("parseCodexMcpServersFromLayers", () => {
  it("lists configured servers per layer and skips F5's own session override", () => {
    expect(
      parseCodexMcpServersFromLayers([
        { name: { type: "sessionFlags" }, version: "1", config: { mcp_servers: {} } },
        {
          name: { type: "project", dotCodexFolder: "/repo/.codex" },
          version: "1",
          config: { mcp_servers: { docs: { command: "docs", env: { TOKEN: "secret" } } } },
        },
        {
          name: { type: "user", file: "/home/.codex/config.toml" },
          version: "1",
          config: { mcp_servers: { mine: { url: "https://mcp.example", enabled: false } } },
        },
        {
          name: { type: "mdm", domain: "com.openai.codex", key: "config" },
          version: "1",
          config: { mcp_servers: { corp: { command: "corp" } } },
          disabledReason: "untrusted",
        },
      ]),
    ).toEqual([
      { name: "docs", kind: "stdio", source: "project", sourcePath: "/repo/.codex" },
      {
        name: "mine",
        kind: "http",
        enabled: false,
        source: "instance",
        sourcePath: "/home/.codex/config.toml",
      },
      {
        name: "corp",
        kind: "stdio",
        enabled: false,
        source: "managed",
        sourcePath: "com.openai.codex/config",
      },
    ]);
  });
});

describe("parseCodexApps", () => {
  it("maps app connectors", () => {
    expect(
      parseCodexApps([{ id: "gh", name: "GitHub", isEnabled: true, isAccessible: false }]),
    ).toEqual([
      { name: "GitHub", kind: "app", enabled: true, status: "inaccessible", source: "instance" },
    ]);
  });
});
