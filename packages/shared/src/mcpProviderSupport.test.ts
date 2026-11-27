import type { McpServerDefinition } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  MCP_HUB_PROVIDERS,
  mcpProviderMatrix,
  mcpProviderSupport,
  setMcpProviderEnabled,
} from "./mcpProviderSupport";
import {
  filterEnabledMcpServers,
  translateMcpForClaudeAgent,
  translateMcpForCodex,
} from "./mcpTranslation";

describe("mcpProviderSupport", () => {
  it("supports a plain server everywhere", () => {
    const matrix = mcpProviderMatrix({ type: "http", url: "https://example.test/mcp" });
    expect(matrix.map((entry) => entry.provider)).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "opencode",
      "grok",
      "antigravity",
      "muse",
      "acp",
      "pi",
    ]);
    expect(matrix.every((entry) => entry.support === "supported")).toBe(true);
    expect(MCP_HUB_PROVIDERS).not.toContain("codex");
    expect(MCP_HUB_PROVIDERS).not.toContain("claudeAgent");
  });

  it("names the fields each provider ignores", () => {
    const server: McpServerDefinition = {
      type: "stdio",
      command: "node",
      cwd: "/srv",
      startupTimeoutSec: 20,
      supportsParallelToolCalls: true,
      connectionScope: "shared",
    };
    expect(mcpProviderSupport(server, "claudeAgent")).toEqual({
      provider: "claudeAgent",
      support: "limited",
      reasons: [
        "Ignores the working directory; the server starts in the conversation's",
        "Starts its own copy of the server in each session",
        "Ignores startup timeout, parallel tool calls",
      ],
    });
    expect(mcpProviderSupport(server, "codex").reasons).toEqual([
      "Starts its own copy of the server in each session",
    ]);
    expect(mcpProviderSupport(server, "cursor").reasons).toEqual(["Ignores parallel tool calls"]);
    expect(mcpProviderSupport({ type: "sse", url: "https://x.test" }, "codex").support).toBe(
      "limited",
    );
    // An empty list is not a set field.
    expect(
      mcpProviderSupport({ type: "http", url: "https://x.test", scopes: [] }, "claudeAgent")
        .support,
    ).toBe("supported");
  });

  it("drops the native-path limits once the hub serves Codex and Claude", () => {
    const server: McpServerDefinition = {
      type: "stdio",
      command: "node",
      cwd: "/srv",
      connectionScope: "shared",
      startupTimeoutSec: 30,
      supportsParallelToolCalls: true,
    };
    const onHub = { nativeProvidersOnHub: true };
    expect(mcpProviderSupport(server, "codex", onHub)).toEqual({
      provider: "codex",
      support: "supported",
      reasons: [],
    });
    expect(mcpProviderSupport(server, "claudeAgent", onHub).reasons).toEqual([
      "Ignores parallel tool calls",
    ]);
    expect(mcpProviderSupport({ type: "sse", url: "https://x.test" }, "codex", onHub).support).toBe(
      "supported",
    );
    expect(mcpProviderSupport(server, "codex").support).toBe("limited");
  });

  it("turns providers off and on, and translators leave off servers out", () => {
    const base: McpServerDefinition = { type: "http", url: "https://x.test/mcp" };
    const offForCodex = setMcpProviderEnabled(base, "codex", false);
    expect(offForCodex.disabledProviders).toEqual(["codex"]);
    expect(mcpProviderSupport(offForCodex, "codex").support).toBe("off");
    expect(setMcpProviderEnabled(offForCodex, "codex", false).disabledProviders).toEqual(["codex"]);
    expect(setMcpProviderEnabled(offForCodex, "codex", true)).toEqual(base);
    // A provider this version does not know is dropped, so the toggle can save.
    const unknown = { ...base, disabledProviders: ["future-agent"] } as McpServerDefinition;
    expect(setMcpProviderEnabled(unknown, "codex", false).disabledProviders).toEqual(["codex"]);
    // Repeated names count once, so turning another provider off stays within the limit.
    const repeated = {
      ...base,
      disabledProviders: Array.from({ length: 9 }, () => "codex"),
    } as McpServerDefinition;
    expect(setMcpProviderEnabled(repeated, "claudeAgent", false).disabledProviders).toEqual([
      "codex",
      "claudeAgent",
    ]);

    const servers = { docs: offForCodex, other: base };
    expect(Object.keys(translateMcpForCodex(servers) ?? {})).toEqual(["other"]);
    expect(Object.keys(translateMcpForClaudeAgent(servers) ?? {})).toEqual(["docs", "other"]);
    expect(Object.keys(filterEnabledMcpServers(servers, "cursor"))).toEqual(["docs", "other"]);
    expect(Object.keys(filterEnabledMcpServers(servers))).toEqual(["docs", "other"]);
  });
});
