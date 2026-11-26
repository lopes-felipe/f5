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
    expect(MCP_HUB_PROVIDERS).toContain("codex");
    expect(MCP_HUB_PROVIDERS).toContain("claudeAgent");
  });

  it("names only what an agent's own client ignores, since the hub runs every server", () => {
    const server: McpServerDefinition = {
      type: "stdio",
      command: "node",
      cwd: "/srv",
      connectionScope: "shared",
      startupTimeoutSec: 30,
      supportsParallelToolCalls: true,
    };
    expect(mcpProviderSupport(server, "codex")).toEqual({
      provider: "codex",
      support: "supported",
      reasons: [],
    });
    expect(mcpProviderSupport(server, "claudeAgent").reasons).toEqual([
      "Ignores parallel tool calls",
    ]);
    expect(mcpProviderSupport(server, "cursor").reasons).toEqual(["Ignores parallel tool calls"]);
    expect(mcpProviderSupport({ type: "sse", url: "https://x.test" }, "codex").support).toBe(
      "supported",
    );
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

    const servers = { docs: offForCodex, other: base };
    expect(Object.keys(translateMcpForCodex(servers) ?? {})).toEqual(["other"]);
    expect(Object.keys(translateMcpForClaudeAgent(servers) ?? {})).toEqual(["docs", "other"]);
    expect(Object.keys(filterEnabledMcpServers(servers, "cursor"))).toEqual(["docs", "other"]);
    expect(Object.keys(filterEnabledMcpServers(servers))).toEqual(["docs", "other"]);
  });
});
