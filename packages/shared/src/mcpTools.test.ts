import type { McpServerDefinition } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  mcpToolPolicy,
  mcpToolPolicyChoice,
  setMcpDefaultToolPolicy,
  setMcpToolPolicy,
} from "./mcpTools";

const server: McpServerDefinition = {
  type: "http",
  url: "https://mcp.example",
  description: "kept",
};

describe("MCP tool policy", () => {
  it("never reads inherited property names as a tool's own policy", () => {
    const server = {
      type: "http" as const,
      url: "https://x.test/mcp",
      defaultToolPolicy: "ask" as const,
      toolPolicy: { search: "allow" as const },
    };
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"])
      expect(mcpToolPolicy(server, name)).toBe("ask");
    expect(mcpToolPolicy(server, "search")).toBe("allow");
  });

  it("defaults to Allow, and a tool's own entry beats the server default", () => {
    expect(mcpToolPolicy(server, "search")).toBe("allow");
    const asking = setMcpDefaultToolPolicy(server, "ask");
    expect(mcpToolPolicy(asking, "search")).toBe("ask");
    const allowed = setMcpToolPolicy(asking, "search", "allow");
    expect(allowed.toolPolicy).toEqual({ search: "allow" });
    expect(mcpToolPolicyChoice(allowed, "search")).toBe("allow");
    expect(mcpToolPolicyChoice(allowed, "write")).toBe("ask");
  });

  it("stores Block as a disabled tool and clears it when allowed again", () => {
    const blocked = setMcpToolPolicy(setMcpToolPolicy(server, "write", "ask"), "write", "block");
    expect(blocked.disabledTools).toEqual(["write"]);
    expect(blocked.toolPolicy).toBeUndefined();
    expect(mcpToolPolicyChoice(blocked, "write")).toBe("block");
    const asked = setMcpToolPolicy(blocked, "write", "ask");
    expect(asked.disabledTools).toBeUndefined();
    expect(asked.toolPolicy).toEqual({ write: "ask" });
    expect(asked.description).toBe("kept");
  });

  it("drops entries that match a new default, and stores Allow as no default", () => {
    const mixed = setMcpToolPolicy(setMcpToolPolicy(server, "a", "ask"), "b", "ask");
    const asking = setMcpDefaultToolPolicy(mixed, "ask");
    expect(asking.toolPolicy).toBeUndefined();
    expect(asking.defaultToolPolicy).toBe("ask");
    const back = setMcpDefaultToolPolicy(setMcpToolPolicy(asking, "a", "allow"), "allow");
    expect(back.defaultToolPolicy).toBeUndefined();
    expect(back.toolPolicy).toBeUndefined();
  });

  it("treats a tool outside the enabled-tools list as blocked", () => {
    expect(mcpToolPolicyChoice({ ...server, enabledTools: ["read"] }, "write")).toBe("block");
  });
});
