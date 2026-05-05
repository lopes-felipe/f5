import { describe, expect, it } from "vitest";

import {
  compactThreadActivityPayload,
  parseMcpToolName,
  readRuntimeConfiguredPayload,
  readToolActivityPayload,
} from "./orchestrationActivityPayload";

describe("orchestrationActivityPayload", () => {
  it("parses MCP tool names into server and tool segments", () => {
    expect(parseMcpToolName("mcp__filesystem__list_allowed_directories")).toEqual({
      server: "filesystem",
      tool: "list_allowed_directories",
    });
    expect(parseMcpToolName("mcp__github__fetch_pull_request__with_comments")).toEqual({
      server: "github",
      tool: "fetch_pull_request__with_comments",
    });
    expect(parseMcpToolName("mcp__filesystem")).toBeNull();
    expect(parseMcpToolName("mcp____list_allowed_directories")).toBeNull();
    expect(parseMcpToolName("filesystem__list_allowed_directories")).toBeNull();
  });

  it("reads legacy tool payloads and normalizes in_progress status", () => {
    const payload = readToolActivityPayload({
      itemType: "command_execution",
      providerItemId: "provider-item-1",
      status: "in_progress",
      title: "Run lint",
      data: {
        item: {
          input: {
            command: ["bun", "run", "lint"],
          },
        },
      },
    });

    expect(payload).toEqual({
      itemType: "command_execution",
      providerItemId: "provider-item-1",
      status: "inProgress",
      title: "Run lint",
      command: "bun run lint",
    });
  });

  it("compacts Claude Read payloads into read-path hints with line summaries", () => {
    const compacted = compactThreadActivityPayload({
      kind: "tool.completed",
      payload: {
        itemType: "dynamic_tool_call",
        providerItemId: "item-claude-read-compact",
        status: "completed",
        title: "Tool call",
        detail: "apps/server/package.json",
        requestKind: "file-read",
        data: {
          toolName: "Read",
          input: {
            file_path: "apps/server/package.json",
            offset: 12,
            limit: 1,
          },
        },
      },
    });

    expect(compacted).toEqual({
      itemType: "dynamic_tool_call",
      providerItemId: "item-claude-read-compact",
      status: "completed",
      title: "Read file",
      detail: "apps/server/package.json",
      requestKind: "file-read",
      readPaths: ["apps/server/package.json"],
      lineSummary: "line 12",
    });
  });

  it("round-trips compact provider item ids through the tool payload reader", () => {
    const compacted = compactThreadActivityPayload({
      kind: "tool.updated",
      payload: {
        itemType: "dynamic_tool_call",
        providerItemId: "provider-item-2",
        status: "inProgress",
        title: "Tool call",
        detail: "apps/server/package.json",
        requestKind: "file-read",
      },
    });

    expect(readToolActivityPayload(compacted)).toEqual({
      itemType: "dynamic_tool_call",
      providerItemId: "provider-item-2",
      status: "inProgress",
      title: "Tool call",
      detail: "apps/server/package.json",
      requestKind: "file-read",
    });
  });

  it("compacts Claude view-range payloads from text editor tools into read-path hints", () => {
    const compacted = compactThreadActivityPayload({
      kind: "tool.updated",
      payload: {
        itemType: "dynamic_tool_call",
        status: "inProgress",
        title: "Tool call",
        data: {
          toolName: "str_replace_based_edit_tool",
          input: {
            command: "view",
            path: "apps/server/src/provider/Layers/ClaudeAdapter.ts",
            view_range: [120, 180],
          },
        },
      },
    });

    expect(compacted).toEqual({
      itemType: "dynamic_tool_call",
      status: "inProgress",
      title: "Read file",
      readPaths: ["apps/server/src/provider/Layers/ClaudeAdapter.ts"],
      lineSummary: "lines 120-180",
    });
  });

  it("compacts Claude NotebookRead payloads into read-path hints", () => {
    const compacted = compactThreadActivityPayload({
      kind: "tool.completed",
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        title: "Tool call",
        data: {
          toolName: "NotebookRead",
          input: {
            notebook_path: "notebooks/analysis.ipynb",
          },
        },
      },
    });

    expect(compacted).toEqual({
      itemType: "dynamic_tool_call",
      status: "completed",
      title: "Read file",
      readPaths: ["notebooks/analysis.ipynb"],
    });
  });

  it("compacts Claude Grep and Glob payloads into search summaries", () => {
    const grepCompacted = compactThreadActivityPayload({
      kind: "tool.completed",
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        title: "Tool call",
        data: {
          toolName: "Grep",
          input: {
            pattern: "chat\\.newLocal|chat\\.scrollToBottom|workflow\\.new|KeybindingCommand",
            path: "apps/web/src",
          },
        },
      },
    });

    expect(grepCompacted).toEqual({
      itemType: "dynamic_tool_call",
      status: "completed",
      title: "Searching apps/web/src for chat.newLocal, chat.scrollToBottom, workflow.new, …",
      searchSummary:
        "Searching apps/web/src for chat.newLocal, chat.scrollToBottom, workflow.new, …",
    });

    const globCompacted = compactThreadActivityPayload({
      kind: "tool.completed",
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        title: "Tool call",
        data: {
          toolName: "Glob",
          input: {
            pattern: "**/*.test.tsx",
            path: "apps/web/src/components",
          },
        },
      },
    });

    expect(globCompacted).toEqual({
      itemType: "dynamic_tool_call",
      status: "completed",
      title: "Searching apps/web/src/components for **/*.test.tsx",
      searchSummary: "Searching apps/web/src/components for **/*.test.tsx",
    });
  });

  it("preserves explicit provider titles while still deriving Claude search summaries", () => {
    const compacted = compactThreadActivityPayload({
      kind: "tool.completed",
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        title: "Search workspace",
        data: {
          toolName: "Grep",
          input: {
            pattern: "CommandTranscriptCard",
            path: "apps/web/src/components/chat",
          },
        },
      },
    });

    expect(compacted).toEqual({
      itemType: "dynamic_tool_call",
      status: "completed",
      title: "Search workspace",
      searchSummary: "Searching apps/web/src/components/chat for CommandTranscriptCard",
    });
  });

  it("normalizes generic LS titles without changing unrelated payload details", () => {
    const compacted = compactThreadActivityPayload({
      kind: "tool.started",
      payload: {
        itemType: "dynamic_tool_call",
        status: "inProgress",
        title: "Tool call",
        detail: '{"path":"apps/web/src"}',
        data: {
          toolName: "LS",
          input: {
            path: "apps/web/src",
          },
        },
      },
    });

    expect(compacted).toEqual({
      itemType: "dynamic_tool_call",
      status: "inProgress",
      title: "List directory",
      detail: '{"path":"apps/web/src"}',
    });
  });

  it("compacts file-change payloads using the legacy apply_patch parser", () => {
    const compacted = compactThreadActivityPayload({
      kind: "tool.completed",
      payload: {
        itemType: "file_change",
        status: "completed",
        detail: "apply_patch",
        fileChangeId: "filechange:thread-1:item-1",
        data: {
          patch: "*** Begin Patch\n*** Update File: src/example.ts\n*** End Patch\n",
        },
      },
    });

    expect(compacted).toEqual({
      itemType: "file_change",
      status: "completed",
      detail: "apply_patch",
      changedFiles: ["src/example.ts"],
      fileChangeId: "filechange:thread-1:item-1",
    });
  });

  it("compacts Claude file-change payloads from snake_case file inputs", () => {
    const compacted = compactThreadActivityPayload({
      kind: "tool.completed",
      payload: {
        itemType: "file_change",
        status: "completed",
        detail: "apps/server/notes.txt",
        fileChangeId: "filechange:thread-1:item-2",
        data: {
          toolName: "Write",
          input: {
            file_path: "apps/server/notes.txt",
            content: "hello\n",
          },
        },
      },
    });

    expect(compacted).toEqual({
      itemType: "file_change",
      status: "completed",
      detail: "apps/server/notes.txt",
      changedFiles: ["apps/server/notes.txt"],
      fileChangeId: "filechange:thread-1:item-2",
    });
  });

  it("preserves compact subagent metadata from lifecycle payloads", () => {
    const compacted = compactThreadActivityPayload({
      kind: "tool.completed",
      payload: {
        itemType: "collab_agent_tool_call",
        status: "completed",
        title: "Explore agent",
        detail: 'Task: {"description":"Survey the repo"}',
        data: {
          input: {
            subagent_type: "Explore",
            description: "Survey the repo",
            prompt: "Inspect the current implementation and report the main extension points.",
            model: "inherit",
          },
          result: {
            type: "tool_result",
            content: [{ type: "text", text: "Found three relevant entry points." }],
          },
        },
      },
    });

    expect(compacted).toEqual({
      itemType: "collab_agent_tool_call",
      status: "completed",
      title: "Explore agent",
      detail: 'Task: {"description":"Survey the repo"}',
      subagentType: "Explore",
      subagentDescription: "Survey the repo",
      subagentPrompt: "Inspect the current implementation and report the main extension points.",
      subagentResult: "Found three relevant entry points.",
      subagentModel: "inherit",
    });
  });

  it("truncates oversized subagent prompt and result text during compaction", () => {
    const oversizedPrompt = "p".repeat(4_100);
    const oversizedResult = "r".repeat(4_100);

    const compacted = compactThreadActivityPayload({
      kind: "tool.completed",
      payload: {
        itemType: "collab_agent_tool_call",
        status: "completed",
        data: {
          input: {
            subagent_type: "Explore",
            prompt: oversizedPrompt,
          },
          result: {
            type: "tool_result",
            content: oversizedResult,
          },
        },
      },
    });

    expect(typeof compacted.subagentPrompt).toBe("string");
    expect(typeof compacted.subagentResult).toBe("string");
    expect((compacted.subagentPrompt as string).length).toBe(4_000);
    expect((compacted.subagentResult as string).length).toBe(4_000);
    expect((compacted.subagentPrompt as string).endsWith("…")).toBe(true);
    expect((compacted.subagentResult as string).endsWith("…")).toBe(true);
  });

  it("compacts MCP tool payloads with parsed server, tool, input, and result fields", () => {
    const compacted = compactThreadActivityPayload({
      kind: "tool.completed",
      payload: {
        itemType: "mcp_tool_call",
        status: "completed",
        title: "MCP tool call",
        detail: 'mcp__filesystem__read_text_file: {"path":"/repo/README.md"}',
        data: {
          toolName: "mcp__filesystem__read_text_file",
          input: {
            path: "/repo/README.md",
          },
          result: {
            type: "tool_result",
            content: [{ type: "text", text: "# README\n\nLoaded successfully." }],
          },
        },
      },
    });

    expect(compacted).toEqual({
      itemType: "mcp_tool_call",
      status: "completed",
      title: "MCP tool call",
      detail: 'mcp__filesystem__read_text_file: {"path":"/repo/README.md"}',
      mcpServerName: "filesystem",
      mcpToolName: "read_text_file",
      mcpInput: ["{", '  "path": "/repo/README.md"', "}"].join("\n"),
      mcpResult: "# README\n\nLoaded successfully.",
    });
  });

  it("reads Codex-shaped MCP payloads from nested item data", () => {
    const payload = readToolActivityPayload({
      itemType: "mcp_tool_call",
      status: "completed",
      title: "MCP tool call",
      data: {
        item: {
          type: "mcpToolCall",
          server: "filesystem",
          tool: "read_text_file",
          arguments: {
            path: "/repo/README.md",
          },
          result: {
            type: "tool_result",
            content: [{ type: "text", text: "# README\n\nLoaded successfully." }],
          },
        },
      },
    });

    expect(payload).toEqual({
      itemType: "mcp_tool_call",
      status: "completed",
      title: "MCP tool call",
      mcpServerName: "filesystem",
      mcpToolName: "read_text_file",
      mcpInput: ["{", '  "path": "/repo/README.md"', "}"].join("\n"),
      mcpResult: "# README\n\nLoaded successfully.",
    });
  });

  it("compacts top-level Codex MCP payloads with structured JSON results", () => {
    const compacted = compactThreadActivityPayload({
      kind: "tool.completed",
      payload: {
        itemType: "mcp_tool_call",
        status: "completed",
        title: "MCP tool call",
        data: {
          server: "filesystem",
          tool: "list_allowed_directories",
          arguments: {
            includeHidden: true,
          },
          result: {
            directories: ["/repo", "/tmp"],
          },
        },
      },
    });

    expect(compacted).toEqual({
      itemType: "mcp_tool_call",
      status: "completed",
      title: "MCP tool call",
      mcpServerName: "filesystem",
      mcpToolName: "list_allowed_directories",
      mcpInput: ["{", '  "includeHidden": true', "}"].join("\n"),
      mcpResult: ["{", '  "directories": [', '    "/repo",', '    "/tmp"', "  ]", "}"].join("\n"),
    });
  });

  it("truncates oversized MCP input and result text during compaction", () => {
    const oversizedInput = "p".repeat(4_100);
    const oversizedResult = "r".repeat(4_100);

    const compacted = compactThreadActivityPayload({
      kind: "tool.completed",
      payload: {
        itemType: "mcp_tool_call",
        status: "completed",
        data: {
          toolName: "mcp__filesystem__read_text_file",
          input: {
            prompt: oversizedInput,
          },
          result: {
            type: "tool_result",
            content: oversizedResult,
          },
        },
      },
    });

    expect(typeof compacted.mcpInput).toBe("string");
    expect(typeof compacted.mcpResult).toBe("string");
    expect((compacted.mcpInput as string).length).toBe(4_000);
    expect((compacted.mcpResult as string).length).toBe(4_000);
    expect((compacted.mcpInput as string).endsWith("…")).toBe(true);
    expect((compacted.mcpResult as string).endsWith("…")).toBe(true);
  });

  it("serializes MCP values safely when arguments contain BigInt and circular references", () => {
    const circularInput: Record<string, unknown> = {
      nested: {
        size: 1n,
      },
    };
    circularInput.self = circularInput;

    const payload = readToolActivityPayload({
      itemType: "mcp_tool_call",
      status: "completed",
      data: {
        toolName: "mcp__filesystem__inspect",
        input: circularInput,
      },
    });

    expect(payload).toMatchObject({
      itemType: "mcp_tool_call",
      status: "completed",
      mcpServerName: "filesystem",
      mcpToolName: "inspect",
    });
    expect(payload?.mcpInput).toContain('"size": "1n"');
    expect(payload?.mcpInput).toContain('"self": "[Circular]"');
  });

  it("reads pre-compacted MCP payloads without re-parsing persisted fields", () => {
    const payload = readToolActivityPayload({
      itemType: "mcp_tool_call",
      status: "completed",
      title: "MCP tool call",
      mcpServerName: "filesystem",
      mcpToolName: "list_allowed_directories",
      mcpInput: '{\n  "includeHidden": true\n}',
      mcpResult: "- /repo\n- /tmp",
    });

    expect(payload).toEqual({
      itemType: "mcp_tool_call",
      status: "completed",
      title: "MCP tool call",
      mcpServerName: "filesystem",
      mcpToolName: "list_allowed_directories",
      mcpInput: '{\n  "includeHidden": true\n}',
      mcpResult: "- /repo\n- /tmp",
    });
  });

  it("parses MCP tool names from legacy detail-only payloads", () => {
    const payload = readToolActivityPayload({
      itemType: "mcp_tool_call",
      status: "completed",
      title: "MCP tool call",
      detail: 'mcp__filesystem__list_allowed_directories: {"includeHidden":true}',
    });

    expect(payload).toEqual({
      itemType: "mcp_tool_call",
      status: "completed",
      title: "MCP tool call",
      detail: 'mcp__filesystem__list_allowed_directories: {"includeHidden":true}',
      mcpServerName: "filesystem",
      mcpToolName: "list_allowed_directories",
      mcpInput: '{"includeHidden":true}',
    });
  });

  it("round-trips requestKind through read and compact helpers", () => {
    const read = readToolActivityPayload({
      itemType: "dynamic_tool_call",
      status: "inProgress",
      title: "File read",
      detail: "apps/server/package.json",
      requestKind: "file-read",
    });

    expect(read).toEqual({
      itemType: "dynamic_tool_call",
      status: "inProgress",
      title: "File read",
      detail: "apps/server/package.json",
      requestKind: "file-read",
    });

    const compacted = compactThreadActivityPayload({
      kind: "tool.started",
      payload: {
        itemType: "file_change",
        status: "inProgress",
        title: "File change",
        detail: "apps/server/README.md",
        requestKind: "file-change",
      },
    });

    expect(compacted).toEqual({
      itemType: "file_change",
      status: "inProgress",
      title: "File change",
      detail: "apps/server/README.md",
      requestKind: "file-change",
    });
  });

  it("ignores invalid requestKind values during read", () => {
    const read = readToolActivityPayload({
      itemType: "command_execution",
      status: "inProgress",
      requestKind: "bogus",
    });
    expect(read).toEqual({
      itemType: "command_execution",
      status: "inProgress",
    });
  });

  it("returns null when runtime.configured contains no supported fields", () => {
    expect(
      readRuntimeConfiguredPayload({
        config: {
          unknownNestedField: "value",
        },
        unknownRootField: "value",
      }),
    ).toBeNull();
  });

  it("reads runtime slash commands, including explicit empty arrays", () => {
    expect(
      readRuntimeConfiguredPayload({
        config: {
          slashCommands: [],
        },
      }),
    ).toEqual({
      slashCommands: [],
    });

    expect(
      readRuntimeConfiguredPayload({
        config: {
          slashCommands: [
            {
              name: "review",
              description: "Review the current diff",
              argumentHint: "<target>",
            },
          ],
        },
      }),
    ).toEqual({
      slashCommands: [
        {
          name: "review",
          description: "Review the current diff",
          argumentHint: "<target>",
        },
      ],
    });
  });

  it("reads Cursor runtime model option fields", () => {
    expect(
      readRuntimeConfiguredPayload({
        config: {
          model: "composer-2",
          reasoning: "high",
          context_window: "200k",
          fast_mode_state: "on",
          thinking_state: "off",
          session_id: "cursor-session-1",
        },
      }),
    ).toEqual({
      model: "composer-2",
      reasoning: "high",
      contextWindow: "200k",
      fastModeState: "on",
      thinkingState: "off",
      sessionId: "cursor-session-1",
    });
  });
});
