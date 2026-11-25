import { describe, expect, it } from "vitest";
import type { McpServerDefinition } from "@t3tools/contracts";
import { createEmptyDraft, decodeDraftServer, draftFromServer, rebaseDraft } from "./mcpDraft";

describe("lossless MCP editing", () => {
  it.each([undefined, false, true])(
    "round-trips the parallel tool calls setting %s",
    (supportsParallelToolCalls) => {
      const server: McpServerDefinition = {
        type: "stdio",
        command: "node",
        ...(supportsParallelToolCalls !== undefined ? { supportsParallelToolCalls } : {}),
      };
      expect(decodeDraftServer(draftFromServer("shell", server)).server).toEqual(server);
    },
  );
  it("preserves arguments, zero, and empty lists while changing another field", () => {
    const server: McpServerDefinition = {
      type: "stdio",
      command: "node",
      args: ["", "  spaces  ", "multiline\nargument"],
      env: {},
      enabledTools: [],
      disabledTools: [],
      scopes: [],
      startupTimeoutSec: 0,
      toolTimeoutSec: 0,
    };
    expect(decodeDraftServer({ ...draftFromServer("shell", server), cwd: "/tmp" }).server).toEqual({
      ...server,
      cwd: "/tmp",
    });
  });
  it("preserves empty args and significant whitespace in entered lines", () => {
    const draft = {
      ...createEmptyDraft(),
      name: "shell",
      command: "node",
      args: "  arg  \n\nlast",
    };
    expect(decodeDraftServer(draft).server.args).toEqual(["  arg  ", "", "last"]);
    expect(decodeDraftServer({ ...draft, args: "[]", argsFormat: "json" }).server.args).toEqual([]);
  });
  it("preserves empty header maps when another field changes", () => {
    const server: McpServerDefinition = { type: "http", url: "http://localhost/mcp", headers: {} };
    expect(
      decodeDraftServer({ ...draftFromServer("remote", server), enabled: false }).server,
    ).toEqual({ ...server, enabled: false });
  });
  it("validates changed remote URLs", () => {
    expect(() =>
      decodeDraftServer({ ...createEmptyDraft("http"), name: "remote", url: "file:///tmp" }),
    ).toThrow();
    expect(
      decodeDraftServer({
        ...createEmptyDraft("http"),
        name: "remote",
        url: "http://localhost:3000",
      }).server.url,
    ).toBe("http://localhost:3000");
  });
  it("keeps provider switches and connection scope, even across a transport change", () => {
    const server: McpServerDefinition = {
      type: "stdio",
      command: "node",
      description: "Local files",
      disabledProviders: ["codex"],
      connectionScope: "shared",
    };
    const draft = draftFromServer("files", server);
    expect(draft.description).toBe("Local files");
    expect(decodeDraftServer({ ...draft, command: "bun" }).server).toEqual({
      ...server,
      command: "bun",
    });
    expect(
      decodeDraftServer({ ...draft, type: "http", url: "https://files.test/mcp", description: "" })
        .server,
    ).toEqual({
      type: "http",
      url: "https://files.test/mcp",
      enabled: true,
      disabledProviders: ["codex"],
      connectionScope: "shared",
    });
  });
  it("rebases a draft onto a newer save without losing the user's edits", () => {
    const saved: McpServerDefinition = { type: "stdio", command: "node", disabledTools: ["a"] };
    const edited = { ...draftFromServer("files", saved), command: "bun" };
    const newer: McpServerDefinition = {
      ...saved,
      disabledTools: ["a", "b"],
      disabledProviders: ["pi"],
    };
    const rebased = rebaseDraft(edited, "files", newer);
    expect(rebased.command).toBe("bun");
    expect(rebased.disabledTools).toBe("a\nb");
    expect(decodeDraftServer(rebased).server).toEqual({ ...newer, command: "bun" });
  });
  it("uses explicit argument formats so a leading bracket is a valid line argument", () => {
    const draft = { ...createEmptyDraft(), name: "shell", command: "node", args: "[literal\n" };
    expect(decodeDraftServer(draft).server.args).toEqual(["[literal", ""]);
    expect(() => decodeDraftServer({ ...draft, argsFormat: "json" })).toThrow();
  });
});
