import { ProjectId, type McpHubServerStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { mcpServerNameKey } from "@t3tools/shared/mcpValidation";

import { hubServersForChat, isMcpHubProvider, mergeChatMcpServers } from "./mcpHubChat";

const PROJECT = ProjectId.make("project-1");
const OTHER = ProjectId.make("project-2");

function hub(overrides: Partial<McpHubServerStatus>): McpHubServerStatus {
  return {
    name: "docs",
    connectionScope: "shared",
    transport: "http",
    state: "ready",
    attempts: 0,
    attachedSessions: 1,
    projectIds: [PROJECT],
    providers: ["cursor"],
    ...overrides,
  };
}

describe("hubServersForChat", () => {
  it("keeps only connections serving this agent in this project", () => {
    expect(
      hubServersForChat(
        [
          hub({ name: "docs", toolCount: 3 }),
          hub({ name: "pi-only", providers: ["pi"] }),
          hub({ name: "elsewhere", projectIds: [OTHER] }),
        ],
        "cursor",
        PROJECT,
      ),
    ).toEqual([{ name: "docs", status: "ready", toolCount: 3 }]);
  });

  it("maps hub states and reports a server's worst connection", () => {
    expect(
      hubServersForChat(
        [
          hub({ name: "files", connectionScope: "session", transport: "stdio", state: "ready" }),
          hub({
            name: "files",
            connectionScope: "session",
            transport: "stdio",
            state: "failed",
            error: "exited",
          }),
          hub({ name: "auth", state: "needs-auth" }),
          hub({ name: "boot", state: "retrying" }),
        ],
        "cursor",
        PROJECT,
      ),
    ).toEqual([
      { name: "auth", status: "needs-auth" },
      { name: "boot", status: "starting" },
      { name: "files", status: "failed", error: "exited" },
    ]);
  });

  it("serves every provider's configured servers through the hub", () => {
    expect(isMcpHubProvider("cursor")).toBe(true);
    expect(isMcpHubProvider("codex")).toBe(true);
    expect(isMcpHubProvider("claudeAgent")).toBe(true);
    expect(isMcpHubProvider(null)).toBe(false);
  });
});

describe("mergeChatMcpServers", () => {
  it("prefers hub entries and keeps the agent's own servers", () => {
    const merged = mergeChatMcpServers(
      [{ name: "Docs", status: "needs-auth" }],
      [
        { name: "docs", status: "ready", toolCount: 0 },
        { name: "codex-own", status: "ready", toolCount: 3 },
      ],
    );
    expect(merged.servers).toEqual([
      { name: "Docs", status: "needs-auth" },
      { name: "codex-own", status: "ready", toolCount: 3 },
    ]);
    expect([...merged.hubNames]).toEqual([mcpServerNameKey("Docs")]);
    expect(mergeChatMcpServers(null, [{ name: "a", status: "ready" }]).servers).toEqual([
      { name: "a", status: "ready" },
    ]);
  });
});
