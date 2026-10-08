import { describe, expect, it } from "vitest";

import {
  evaluateWorkflowToolCall,
  nativeOnlyWorkflowGrant,
  resolveMcpToolTarget,
  type WorkflowCapabilityGrant,
} from "./capabilityPolicy.ts";

const grant: WorkflowCapabilityGrant = {
  profile: "unattended-readonly",
  inspectionServerName: "f5_inspect",
  connectors: {
    datadog: {
      serverName: "datadog",
      basis: "verified",
      verifiedConnectorId: "datadog",
      operations: ["search_datadog_logs"],
      pinnedTools: {},
    },
    f5: {
      serverName: "f5",
      basis: "verified",
      verifiedConnectorId: "glean",
      operations: ["search"],
      pinnedTools: {},
    },
  },
};

function decide(providerToolName: string, origin?: { name: string; source?: string }) {
  return evaluateWorkflowToolCall({ grant, providerToolName, origin }).kind;
}

describe("workflow capability policy", () => {
  it("allows native reads and denies shell, edits, and web access", () => {
    expect(decide("Read")).toBe("allow");
    expect(decide("Grep")).toBe("allow");
    expect(decide("Bash")).toBe("deny");
    expect(decide("Edit")).toBe("deny");
    expect(decide("Write")).toBe("deny");
    expect(decide("WebFetch")).toBe("deny");
    expect(decide("Agent")).toBe("deny");
  });

  it("allows questions only in attended stages and always captures plans", () => {
    expect(decide("AskUserQuestion")).toBe("deny");
    const attended = { ...grant, profile: "attended-readonly" as const };
    expect(
      evaluateWorkflowToolCall({ grant: attended, providerToolName: "AskUserQuestion" }).kind,
    ).toBe("allow");
    expect(
      evaluateWorkflowToolCall({ grant: attended, providerToolName: "ExitPlanMode" }).kind,
    ).toBe("deny");
  });

  it("allows the host inspection server and verified connector reads", () => {
    expect(decide("mcp__f5_inspect__read_file", { name: "f5_inspect", source: "dynamic" })).toBe(
      "allow",
    );
    expect(decide("mcp__f5_inspect__git_diff")).toBe("allow");
    expect(decide("mcp__datadog__search_datadog_logs")).toBe("allow");
    expect(decide("mcp__datadog__create_monitor")).toBe("deny");
  });

  it("denies MCP servers the host did not register", () => {
    expect(decide("mcp__f5_inspect__read_file", { name: "f5_inspect", source: "user" })).toBe(
      "deny",
    );
    expect(decide("mcp__unknown__anything")).toBe("deny");
  });

  it("resolves the longest server prefix so one server cannot shadow another", () => {
    // `f5` is a prefix of `f5_inspect`; the tool belongs to the inspection server.
    expect(resolveMcpToolTarget(grant, "mcp__f5_inspect__read_file", undefined)).toEqual({
      serverName: "f5_inspect",
      toolName: "read_file",
    });
    expect(resolveMcpToolTarget(grant, "mcp__f5__search", undefined)).toEqual({
      serverName: "f5",
      toolName: "search",
    });
  });

  it("offers only native reads without a facade", () => {
    const nativeOnly = nativeOnlyWorkflowGrant("unattended-readonly");
    expect(evaluateWorkflowToolCall({ grant: nativeOnly, providerToolName: "Read" }).kind).toBe(
      "allow",
    );
    expect(
      evaluateWorkflowToolCall({
        grant: nativeOnly,
        providerToolName: "mcp__f5_inspect__read_file",
      }).kind,
    ).toBe("deny");
  });
});
