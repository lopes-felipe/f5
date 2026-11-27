import { describe, expect, it } from "vitest";
import type { McpServerDefinition } from "@t3tools/contracts";
import {
  createEmptyDraft,
  decodeDraftServer,
  draftFromCatalog,
  draftFromServer,
  rebaseDraft,
} from "./mcpDraft";

describe("catalog drafts", () => {
  const catalog = (args: string[]) =>
    draftFromCatalog({
      name: "notes",
      server: { type: "stdio", command: "npx", args },
      secretKeys: [],
      needsInput: [],
      leftOutOptions: [],
    });

  it("lists plain arguments one per line and keeps line breaks inside one through Save", () => {
    expect(catalog(["-y", "<root>"]).argsFormat).toBe("lines");
    for (const args of [
      ["--label\r", "next"],
      ["two\nlines", "next"],
    ]) {
      const draft = catalog(args);
      expect(draft.argsFormat).not.toBe("lines");
      const { server } = decodeDraftServer(draft);
      expect(server.type === "stdio" ? server.args : undefined).toEqual(args);
    }
  });
});

describe("legacy server names", () => {
  const legacy: McpServerDefinition = { type: "stdio", command: "node" };

  it("keeps a stored legacy name, including an Override of a legacy common server", () => {
    // Edit and Override both start from the stored server.
    expect(decodeDraftServer(draftFromServer("team.docs", legacy)).name).toBe("team.docs");
  });

  it("refuses a legacy name for a new or renamed server", () => {
    expect(() =>
      decodeDraftServer({ ...createEmptyDraft(), name: "team.docs", command: "node" }),
    ).toThrow();
    expect(() =>
      decodeDraftServer({ ...draftFromServer("team.docs", legacy), name: "other.docs" }),
    ).toThrow();
  });
});

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
  it("keeps typing made while a save ran, even a return to the old value", () => {
    const saved: McpServerDefinition = { type: "stdio", command: "a" };
    const submitted = { ...draftFromServer("files", saved), command: "b", cwd: "/w" };
    // While the save runs the user types the old command again; cwd stays as submitted.
    const typed = { ...submitted, command: "a" };
    const stored: McpServerDefinition = { type: "stdio", command: "b", cwd: "/w" };
    const rebased = rebaseDraft(typed, "files", stored, submitted);
    expect(rebased.command).toBe("a");
    expect(rebased.cwd).toBe("/w");
    expect(rebased.original?.server).toEqual(stored);
  });
  it("moves argument text and its format together", () => {
    const saved: McpServerDefinition = { type: "stdio", command: "node", args: ["x"] };
    const opened = draftFromServer("files", saved);
    expect(opened.argsFormat).toBe("json");
    // Another save removed the arguments; this draft still holds edited JSON arguments.
    const edited = { ...opened, args: '["x","y"]' };
    const rebased = rebaseDraft(edited, "files", { type: "stdio", command: "node" });
    expect(rebased.args).toBe('["x","y"]');
    expect(rebased.argsFormat).toBe("json");
    expect(decodeDraftServer(rebased).server.args).toEqual(["x", "y"]);
    // Untouched arguments follow the newer save, format included.
    const untouched = rebaseDraft(opened, "files", { type: "stdio", command: "node" });
    expect([untouched.args, untouched.argsFormat]).toEqual(["", "lines"]);
  });
  it("uses explicit argument formats so a leading bracket is a valid line argument", () => {
    const draft = { ...createEmptyDraft(), name: "shell", command: "node", args: "[literal\n" };
    expect(decodeDraftServer(draft).server.args).toEqual(["[literal", ""]);
    expect(() => decodeDraftServer({ ...draft, argsFormat: "json" })).toThrow();
  });
});

describe("fields the form does not edit", () => {
  it("takes them from the current saved entry, so a change saved elsewhere survives", () => {
    const opened: McpServerDefinition = { type: "stdio", command: "docs" };
    const draft = { ...draftFromServer("docs", opened), description: "Team docs" };
    // Another window turned Claude off after this draft was opened.
    const current: McpServerDefinition = { ...opened, disabledProviders: ["claudeAgent"] };
    expect(decodeDraftServer(draft, current).server).toMatchObject({
      description: "Team docs",
      disabledProviders: ["claudeAgent"],
    });
  });

  it("drops provider names this version does not know, so the entry stays writable", () => {
    const saved = {
      type: "stdio",
      command: "docs",
      disabledProviders: ["claudeAgent", "future-agent"],
    } as unknown as McpServerDefinition;
    expect(decodeDraftServer(draftFromServer("docs", saved)).server.disabledProviders).toEqual([
      "claudeAgent",
    ]);
    const onlyUnknown = { ...saved, disabledProviders: ["future-agent"] } as McpServerDefinition;
    expect(
      decodeDraftServer(draftFromServer("docs", onlyUnknown)).server.disabledProviders,
    ).toBeUndefined();
  });
});
