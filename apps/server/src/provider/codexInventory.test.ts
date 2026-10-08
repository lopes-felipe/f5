import { describe, expect, it } from "vitest";

import {
  codexInventorySource,
  codexMcpServerOrigins,
  parseCodexApps,
  parseCodexHooks,
  parseCodexMcpServers,
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

describe("parseCodexMcpServers", () => {
  it("annotates sources from config origins and includes configured-but-unstarted servers", () => {
    const origins = codexMcpServerOrigins({
      "mcp_servers.docs.command": { name: { type: "project", dotCodexFolder: "/repo/.codex" } },
      "mcp_servers.corp.url": { name: { type: "mdm", domain: "x", key: "y" } },
    });
    expect(
      parseCodexMcpServers(
        [{ name: "docs", startupStatus: "ready" }],
        {
          mcp_servers: {
            docs: { command: "docs" },
            corp: { url: "https://corp", enabled: false },
          },
        },
        origins,
      ),
    ).toEqual([
      { name: "docs", kind: "stdio", status: "ready", source: "project" },
      { name: "corp", kind: "http", enabled: false, source: "managed" },
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
