import { describe, expect, it } from "vitest";
import {
  CODEX_HOSTED_OBSERVATIONS,
  codexHostedBranches,
  codexParentIdentifierAllowed,
  nodeReplCandidates,
  nodeReplToolApproval,
  parseSpikeProcessRows,
  statusTools,
  treeKillOrder,
  type CodexHostedObservation,
} from "./codexHostedSpike";

const NODE_REPL = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl";
const rows = parseSpikeProcessRows(
  [
    "    1     0     1 /sbin/launchd",
    "  100     1   100 /usr/local/bin/node",
    "  101   100   100 /usr/local/bin/codex",
    `  102   101   102 ${NODE_REPL}`,
    "  103   102   102 /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
    "  104   103   102 /bin/sh",
    `  200     1   200 ${NODE_REPL}`,
    "garbage",
    "  300     1   300 /Applications/Some App.app/Contents/MacOS/Some App",
  ].join("\n"),
);

describe("codexHostedSpike", () => {
  it("parses ps rows, including executables with spaces", () => {
    expect(rows).toHaveLength(8);
    expect(rows.at(-1)).toEqual({
      pid: 300,
      ppid: 1,
      pgid: 300,
      command: "/Applications/Some App.app/Contents/MacOS/Some App",
    });
  });

  it("only adopts node_repl processes below the spawned app-server", () => {
    expect(nodeReplCandidates(rows, 100, NODE_REPL).map((row) => row.pid)).toEqual([102]);
    expect(nodeReplCandidates(rows, 100, `${NODE_REPL}-other`)).toEqual([]);
    expect(nodeReplCandidates(rows, 999, NODE_REPL)).toEqual([]);
  });

  it("kills a tree deepest first", () => {
    expect(treeKillOrder(rows, 102)).toEqual([104, 103, 102]);
    expect(treeKillOrder(rows, 200)).toEqual([200]);
  });

  it("accepts only OpenAI's Codex identifiers as the parent", () => {
    expect(codexParentIdentifierAllowed("codex")).toBe(true);
    expect(codexParentIdentifierAllowed("com.openai.codex.cli")).toBe(true);
    expect(codexParentIdentifierAllowed("com.openai.codex")).toBe(false);
    expect(codexParentIdentifierAllowed("node")).toBe(false);
    expect(codexParentIdentifierAllowed("codex-evil")).toBe(false);
  });

  it("classifies node_repl tool approvals and ignores other requests", () => {
    const approval = {
      serverName: "node_repl",
      mode: "form",
      message: 'Allow the node_repl MCP server to run tool "js"?',
      _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { code: "1+1" } },
      requestedSchema: { type: "object", properties: {} },
    };
    expect(nodeReplToolApproval("mcpServer/elicitation/request", approval, "node_repl")).toEqual({
      tool: "js",
      code: "1+1",
    });
    expect(
      nodeReplToolApproval(
        "mcpServer/elicitation/request",
        { ...approval, _meta: { ...approval._meta, tool_name: "js_reset" } },
        "node_repl",
      )?.tool,
    ).toBe("js_reset");
    expect(
      nodeReplToolApproval("mcpServer/elicitation/request", approval, "other"),
    ).toBeUndefined();
    expect(
      nodeReplToolApproval(
        "mcpServer/elicitation/request",
        { ...approval, _meta: {} },
        "node_repl",
      ),
    ).toBeUndefined();
    expect(nodeReplToolApproval("item/tool/call", approval, "node_repl")).toBeUndefined();
  });

  it("reads status tools under either schema key", () => {
    expect(
      statusTools({
        name: "node_repl",
        tools: {
          js: { name: "js", description: "Run", inputSchema: { type: "object" } },
          js_reset: { input_schema: { type: "object" } },
          broken: "x",
        },
      }),
    ).toEqual([
      { name: "js", description: "Run", inputSchema: { type: "object" } },
      { name: "js_reset", inputSchema: { type: "object" } },
    ]);
    expect(statusTools({ name: "node_repl" })).toEqual([]);
  });

  it("selects the plan's branches from the observations", () => {
    const all = (value: boolean) =>
      Object.fromEntries(CODEX_HOSTED_OBSERVATIONS.map((name) => [name, value])) as Record<
        CodexHostedObservation,
        boolean
      >;
    expect(codexHostedBranches(all(true))).toEqual({
      admission: "per-call",
      kill: "group",
      idleStop: true,
      interruptDrain: "turn_ended",
    });
    expect(codexHostedBranches({ ...all(false), "codex-parent-accepted": true })).toEqual({
      admission: "session",
      kill: "tree",
      idleStop: false,
      interruptDrain: "kill",
    });
    expect(codexHostedBranches(all(false)).admission).toBe("blocked");
  });
});
