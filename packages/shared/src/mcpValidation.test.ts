import { describe, expect, it } from "vitest";
import type { McpProjectServersConfig } from "@t3tools/contracts";
import {
  assertMcpServerLimit,
  MCP_RUNTIME_SERVER_LIMIT,
  normalizeMcpServersRecord,
  readMcpValidationIssues,
  validateMcpLayerWrite,
  validateMcpLayerMerge,
} from "./mcpValidation";
import { areProviderStartOptionsEqual, getProviderSessionRestartOptions } from "./providerOptions";
import { translateMcpForClaudeAgent, translateMcpForCodex } from "./mcpTranslation";

const server = { type: "stdio" as const, command: "node" };
const entries = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`s${i}`, server]));

describe("MCP configuration correctness", () => {
  it("rejects a seventeenth scope entry and preserves 32 effective and 36 runtime entries", () => {
    expect(() => validateMcpLayerWrite({}, entries(17))).toThrow("16");
    expect(Object.keys(normalizeMcpServersRecord(entries(32)))).toHaveLength(32);
    expect(() => assertMcpServerLimit(entries(36), MCP_RUNTIME_SERVER_LIMIT)).not.toThrow();
    expect(() => assertMcpServerLimit(entries(37), MCP_RUNTIME_SERVER_LIMIT)).toThrow("36");
    expect(() => assertMcpServerLimit(entries(33))).toThrow("32");
  });
  it("includes changes after entry sixteen in restart equality", () => {
    const before = entries(32);
    const after = { ...before, s31: { ...server, args: ["changed"] } };
    expect(
      areProviderStartOptionsEqual(
        getProviderSessionRestartOptions("codex", { mcpServers: before }),
        getProviderSessionRestartOptions("codex", { mcpServers: after }),
      ),
    ).toBe(false);
  });
  it("keeps arguments and explicit empty lists through normalization and translation", () => {
    const servers: McpProjectServersConfig = {
      shell: {
        ...server,
        args: ["  space  ", "", "a\nb"],
        enabledTools: [],
        disabledTools: [],
        scopes: [],
        supportsParallelToolCalls: false,
        startupTimeoutSec: 0,
      },
    };
    expect(getProviderSessionRestartOptions("codex", { mcpServers: servers })?.mcpServers).toEqual(
      servers,
    );
    expect(translateMcpForClaudeAgent(servers)?.shell).toMatchObject({ args: servers.shell!.args });
    expect(translateMcpForCodex(servers)?.shell).toMatchObject({
      args: servers.shell!.args,
      enabled_tools: [],
      disabled_tools: [],
      scopes: [],
      supports_parallel_tool_calls: false,
      startup_timeout_sec: 0,
    });
  });
  it("allows edits and removals in oversized legacy layers but rejects additions and renames", () => {
    const base = entries(18);
    const edited: McpProjectServersConfig = { ...base, s17: { ...server, enabled: false } };
    expect(Object.keys(validateMcpLayerWrite(base, edited))).toHaveLength(18);
    const removed = { ...edited };
    delete removed.s0;
    expect(Object.keys(validateMcpLayerWrite(base, removed))).toHaveLength(17);
    expect(() => validateMcpLayerWrite(base, { ...removed, renamed: server })).toThrow("new names");
  });
  it("preserves unchanged invalid URLs and accepts HTTP localhost repairs", () => {
    const legacy: McpProjectServersConfig = {
      legacy: { type: "http", url: "invalid" },
      good: server,
    };
    expect(
      validateMcpLayerWrite(legacy, { ...legacy, good: { ...server, args: [] } }).legacy,
    ).toEqual(legacy.legacy);
    expect(readMcpValidationIssues(legacy)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "validation", serverName: "legacy" }),
      ]),
    );
    expect(() =>
      validateMcpLayerWrite(legacy, {
        ...legacy,
        legacy: { type: "http", url: "file:///tmp/mcp" },
      }),
    ).toThrow();
    expect(
      validateMcpLayerWrite(legacy, {
        ...legacy,
        legacy: { type: "http", url: "http://localhost:3000" },
      }).legacy?.url,
    ).toBe("http://localhost:3000");
  });
  it("rejects new aliases, allows exact overrides, and repairs legacy collisions step by step", () => {
    expect(() => validateMcpLayerWrite({}, { GitHub: server, github: server })).toThrow(
      "Conflicting",
    );
    const base = { GitHub: server, github: server, GITHUB: server };
    expect(validateMcpLayerWrite(base, { ...base })).toEqual(base);
    expect(
      validateMcpLayerWrite(base, { GitHub: server, github: { ...server, args: [] } }),
    ).toHaveProperty("github");
    expect(() => validateMcpLayerWrite(base, { ...base, github: { ...server, args: [] } })).toThrow(
      "Conflicting",
    );
    expect(() =>
      validateMcpLayerMerge({
        baseCommon: {},
        baseProject: {},
        common: { GitHub: server },
        project: { github: server },
      }),
    ).toThrow("exact name");
    expect(() =>
      validateMcpLayerMerge({
        baseCommon: {},
        baseProject: {},
        common: { GitHub: server },
        project: { GitHub: server },
      }),
    ).not.toThrow();
  });
  it("allows a cross-layer legacy collision group to shrink while repairing a survivor", () => {
    expect(() =>
      validateMcpLayerMerge({
        baseCommon: { GitHub: server },
        baseProject: { github: server, GITHUB: server },
        common: { GitHub: server },
        project: { github: { ...server, args: [] } },
      }),
    ).not.toThrow();
  });
  it("preserves names that match Object prototype properties", () => {
    const servers = Object.fromEntries([
      ["__proto__", server],
      ["constructor", server],
    ]);
    expect(Object.keys(validateMcpLayerWrite({}, servers))).toEqual(["__proto__", "constructor"]);
    expect(Object.keys(translateMcpForClaudeAgent(servers)!)).toEqual(["__proto__", "constructor"]);
    expect(Object.keys(translateMcpForCodex(servers)!)).toEqual(["__proto__", "constructor"]);
  });
});
