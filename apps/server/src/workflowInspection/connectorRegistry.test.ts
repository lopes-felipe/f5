import type { McpServerDefinition, WorkflowTrustedConnectors } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  type ConnectorToolDescriptor,
  connectorConfigFingerprint,
  evaluateConnectorToolCall,
  hasMutationVerb,
  matchVerifiedConnector,
  parseConnectorToolInventory,
  pinConnectorTools,
  planWorkflowConnectors,
  toolDescriptorFingerprint,
} from "./connectorRegistry.ts";

const datadog: McpServerDefinition = {
  type: "http",
  url: "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp",
};
const internal: McpServerDefinition = { type: "http", url: "https://tools.example.com/mcp" };

const internalTools: ReadonlyArray<ConnectorToolDescriptor> = [
  { name: "lookup_order", description: "Look up an order.", readOnlyHint: true },
  { name: "purge_cache", description: "Purge.", readOnlyHint: true, destructiveHint: true },
  { name: "list_widgets", description: "List widgets." },
  { name: "update_widget", description: "Update a widget.", readOnlyHint: true },
];

function trustInternal(definition = internal): WorkflowTrustedConnectors {
  return {
    internal: {
      configFingerprint: connectorConfigFingerprint(definition),
      trustedAt: "2026-10-01T00:00:00.000Z",
      tools: pinConnectorTools(internalTools),
    },
  };
}

describe("connector registry", () => {
  it("matches verified vendors only on their exact https endpoints", () => {
    expect(matchVerifiedConnector(datadog)?.id).toBe("datadog");
    expect(
      matchVerifiedConnector({ type: "http", url: "https://acme-be.glean.com/mcp/default" })?.id,
    ).toBe("glean");
    expect(
      matchVerifiedConnector({ type: "http", url: "https://mcp.atlassian.com/v1/sse" })?.id,
    ).toBe("atlassian");
    expect(
      matchVerifiedConnector({ type: "http", url: "http://mcp.datadoghq.com/mcp" }),
    ).toBeUndefined();
    expect(
      matchVerifiedConnector({ type: "http", url: "https://mcp.datadoghq.com.evil.test/mcp" }),
    ).toBeUndefined();
    expect(matchVerifiedConnector({ type: "stdio", command: "datadog-mcp" })).toBeUndefined();
  });

  it("recognizes mutation verbs in snake and camel case", () => {
    expect(hasMutationVerb("send_message")).toBe(true);
    expect(hasMutationVerb("updateJiraIssue")).toBe(true);
    expect(hasMutationVerb("getJiraIssue")).toBe(false);
    expect(hasMutationVerb("search_datadog_logs")).toBe(false);
  });

  it("narrows verified connectors to their read operations and drops unverified ones", () => {
    const plan = planWorkflowConnectors({ servers: { datadog, internal }, trusted: undefined });
    expect(Object.keys(plan.servers)).toEqual(["datadog"]);
    expect(plan.servers.datadog?.enabledTools).toContain("search_datadog_logs");
    expect(plan.grants.datadog?.basis).toBe("verified");
    expect(plan.access.find((entry) => entry.serverName === "internal")?.state).toBe("unavailable");
  });

  it("keeps a user's narrower enabledTools for verified connectors", () => {
    const plan = planWorkflowConnectors({
      servers: { datadog: { ...datadog, enabledTools: ["get_datadog_trace", "create_monitor"] } },
      trusted: undefined,
    });
    expect(plan.servers.datadog?.enabledTools).toEqual(["get_datadog_trace"]);
  });

  it("exposes only trusted operations that declare read-only and not destructive", () => {
    const plan = planWorkflowConnectors({ servers: { internal }, trusted: trustInternal() });
    // purge_cache is destructive, list_widgets has no read-only hint, and
    // update_widget is a mutation name despite its hint.
    expect(plan.grants.internal?.operations).toEqual(["lookup_order"]);
    expect(plan.access[0]?.state).toBe("trusted");
    expect(plan.access[0]?.message).toContain(
      "relies on the connector's own read-only declarations",
    );
  });

  it("invalidates trust when the connector configuration changes", () => {
    const trusted = trustInternal();
    const moved = { ...internal, url: "https://tools.example.com/other" };
    const plan = planWorkflowConnectors({ servers: { internal: moved }, trusted });
    expect(plan.grants.internal).toBeUndefined();
    expect(plan.access[0]?.state).toBe("trust-stale");
    // Credential values are not part of identity; only header names are.
    const rotated = { ...internal, headers: { Authorization: "Bearer new" } };
    const withHeader = { ...internal, headers: { Authorization: "Bearer old" } };
    expect(connectorConfigFingerprint(rotated)).toBe(connectorConfigFingerprint(withHeader));
  });

  it("changes the plan digest when exposed capabilities change", () => {
    const base = planWorkflowConnectors({ servers: { datadog }, trusted: undefined });
    const withTrust = planWorkflowConnectors({
      servers: { datadog, internal },
      trusted: trustInternal(),
    });
    expect(base.digest).not.toBe(withTrust.digest);
  });

  it("denies trusted operations without a matching live declaration", () => {
    const plan = planWorkflowConnectors({ servers: { internal }, trusted: trustInternal() });
    const grant = plan.grants.internal;
    const live = internalTools[0]!;
    expect(
      evaluateConnectorToolCall({ grant, serverName: "internal", toolName: "lookup_order" })
        .allowed,
    ).toBe(false);
    expect(
      evaluateConnectorToolCall({ grant, serverName: "internal", toolName: "lookup_order", live })
        .allowed,
    ).toBe(true);
    expect(
      evaluateConnectorToolCall({
        grant,
        serverName: "internal",
        toolName: "lookup_order",
        live: { ...live, description: "Look up and cancel an order." },
      }).allowed,
    ).toBe(false);
    expect(
      evaluateConnectorToolCall({
        grant,
        serverName: "internal",
        toolName: "lookup_order",
        live: { ...live, destructiveHint: true },
      }).allowed,
    ).toBe(false);
  });

  it("lets verified denials win over grants, including Slack sends", () => {
    const grant = {
      serverName: "slack",
      basis: "trusted" as const,
      verifiedConnectorId: null,
      operations: ["send_message"],
      pinnedTools: {},
    };
    const decision = evaluateConnectorToolCall({
      grant,
      serverName: "slack",
      toolName: "send_message",
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("Slack");
  });

  it("parses provider tool inventories into descriptors", () => {
    const tools = parseConnectorToolInventory({
      lookup_order: {
        name: "lookup_order",
        description: "Look up an order.",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      bare: {},
    });
    expect(tools).toEqual([
      {
        name: "lookup_order",
        description: "Look up an order.",
        readOnlyHint: true,
        destructiveHint: false,
        inputSchema: { type: "object" },
      },
      { name: "bare" },
    ]);
    expect(toolDescriptorFingerprint(tools[0]!)).toBe(
      toolDescriptorFingerprint({ ...tools[0]!, inputSchema: { other: true } }),
    );
  });
});
