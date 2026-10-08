/**
 * Connector capability decisions for read-only workflow stages.
 *
 * A connector tool is reachable from a read-only stage only when either:
 * - the connector is verified (an exact endpoint F5 recognizes) and the tool is
 *   one of its known read operations, or
 * - the user explicitly trusted the connector for this project, the trust still
 *   matches the connector configuration and pinned tool fingerprints, and the
 *   tool declares `readOnlyHint=true` without `destructiveHint=true`.
 *
 * Verified denials override both paths. Trusting a connector trusts its own
 * declaration; it is never described as a verified guarantee.
 */
import { createHash } from "node:crypto";

import type {
  McpProjectServersConfig,
  McpServerDefinition,
  WorkflowConnectorAccessEntry,
  WorkflowConnectorTrust,
  WorkflowConnectorTrustedTool,
  WorkflowTrustedConnectors,
} from "@t3tools/contracts";

export interface ConnectorToolDescriptor {
  readonly name: string;
  readonly description?: string | undefined;
  readonly readOnlyHint?: boolean | undefined;
  readonly destructiveHint?: boolean | undefined;
  /** Absent when the provider does not report input schemas (Claude). */
  readonly inputSchema?: unknown;
}

interface VerifiedConnectorDefinition {
  readonly id: string;
  readonly label: string;
  readonly matchesEndpoint: (url: URL) => boolean;
  readonly readOperations: ReadonlySet<string>;
}

/**
 * Exact endpoints and operation names. A gateway or self-hosted proxy for the
 * same vendor is not verified; users can trust it explicitly instead.
 */
export const VERIFIED_CONNECTORS: ReadonlyArray<VerifiedConnectorDefinition> = [
  {
    id: "glean",
    label: "Glean",
    matchesEndpoint: (url) =>
      /^[a-z0-9-]+-be\.glean\.com$/.test(url.hostname) && url.pathname.startsWith("/mcp/"),
    readOperations: new Set(["search", "read_document"]),
  },
  {
    id: "atlassian",
    label: "Atlassian",
    matchesEndpoint: (url) => url.hostname === "mcp.atlassian.com",
    readOperations: new Set([
      "getAccessibleAtlassianResources",
      "search",
      "fetch",
      "searchConfluenceUsingCql",
      "getConfluenceSpaces",
      "getConfluencePage",
      "getPagesInConfluenceSpace",
      "getConfluencePageDescendants",
      "getConfluencePageFooterComments",
      "getConfluencePageInlineComments",
      "searchJiraIssuesUsingJql",
      "getJiraIssue",
      "getJiraIssueRemoteIssueLinks",
      "getVisibleJiraProjects",
    ]),
  },
  {
    id: "datadog",
    label: "Datadog",
    matchesEndpoint: (url) =>
      /^mcp\.(?:[a-z0-9]+\.)?datadoghq\.(?:com|eu)$/.test(url.hostname) ||
      url.hostname === "mcp.ddog-gov.com",
    readOperations: new Set([
      "search_datadog_logs",
      "analyze_datadog_logs",
      "get_datadog_metric",
      "search_datadog_metrics",
      "get_datadog_trace",
      "search_datadog_spans",
      "search_datadog_dashboards",
      "get_datadog_dashboard",
    ]),
  },
];

const MUTATION_VERBS = new Set([
  "add",
  "append",
  "approve",
  "archive",
  "assign",
  "close",
  "comment",
  "create",
  "delete",
  "deploy",
  "dismiss",
  "edit",
  "execute",
  "insert",
  "invite",
  "join",
  "kick",
  "leave",
  "merge",
  "move",
  "mute",
  "pin",
  "post",
  "publish",
  "put",
  "react",
  "remove",
  "rename",
  "reply",
  "resolve",
  "restart",
  "run",
  "schedule",
  "send",
  "set",
  "share",
  "transition",
  "trigger",
  "unarchive",
  "unpin",
  "update",
  "upload",
  "upsert",
  "write",
]);

function toolNameTokens(toolName: string): ReadonlyArray<string> {
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** True when any word in the tool name is a mutation verb (`send_message`, `updateIssue`). */
export function hasMutationVerb(toolName: string): boolean {
  return toolNameTokens(toolName).some((token) => MUTATION_VERBS.has(token));
}

function remoteUrl(definition: McpServerDefinition): URL | null {
  if (definition.type === "stdio") return null;
  try {
    const url = new URL(definition.url);
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function isSlackConnector(serverName: string, definition: McpServerDefinition | undefined) {
  const url = definition ? remoteUrl(definition) : null;
  return (
    /slack/i.test(serverName) ||
    (url !== null && (url.hostname === "slack.com" || url.hostname.endsWith(".slack.com")))
  );
}

/**
 * Denials that no verification or trust can override. Returns the reason, or
 * undefined when no rule matches.
 */
export function verifiedConnectorDenial(input: {
  readonly serverName: string;
  readonly definition?: McpServerDefinition | undefined;
  readonly toolName: string;
}): string | undefined {
  const slack =
    isSlackConnector(input.serverName, input.definition) || /slack/i.test(input.toolName);
  if (slack && hasMutationVerb(input.toolName)) {
    return `Slack operation '${input.toolName}' changes workspace state and is never available in read-only workflow stages.`;
  }
  if (hasMutationVerb(input.toolName)) {
    return `Connector operation '${input.toolName}' is named as a mutation and is never available in read-only workflow stages.`;
  }
  return undefined;
}

export function matchVerifiedConnector(
  definition: McpServerDefinition,
): VerifiedConnectorDefinition | undefined {
  const url = remoteUrl(definition);
  return url ? VERIFIED_CONNECTORS.find((entry) => entry.matchesEndpoint(url)) : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Connector identity: transport, endpoint or command, and the names (never the
 * values) of credentials. Rotating a token keeps trust; repointing it voids it.
 */
export function connectorConfigFingerprint(definition: McpServerDefinition): string {
  const identity =
    definition.type === "stdio"
      ? {
          type: "stdio",
          command: definition.command,
          args: definition.args ?? [],
          cwd: definition.cwd ?? null,
          envNames: Object.keys(definition.env ?? {}).toSorted(),
        }
      : {
          type: definition.type,
          url: definition.url,
          headerNames: Object.keys(definition.headers ?? {})
            .map((name) => name.toLowerCase())
            .toSorted(),
          bearerTokenEnvVar: definition.bearerTokenEnvVar ?? null,
        };
  return sha256(
    `f5.connector.v1\0${canonicalJson({
      ...identity,
      oauthClientId: definition.oauthClientId ?? null,
      oauthResource: definition.oauthResource ?? null,
    })}`,
  );
}

const DESCRIPTION_FINGERPRINT_CHARS = 1024;

/** Comparable across providers: Claude reports descriptions and hints but no schemas. */
export function toolDescriptorFingerprint(tool: ConnectorToolDescriptor): string {
  return sha256(
    `f5.connector-tool.v1\0${canonicalJson({
      name: tool.name,
      description: (tool.description ?? "").trim().slice(0, DESCRIPTION_FINGERPRINT_CHARS),
      readOnlyHint: tool.readOnlyHint ?? null,
      destructiveHint: tool.destructiveHint ?? null,
    })}`,
  );
}

export function toolSchemaFingerprint(inputSchema: unknown): string | null {
  return inputSchema === undefined
    ? null
    : sha256(`f5.connector-schema.v1\0${canonicalJson(inputSchema)}`);
}

export function pinConnectorTools(
  tools: ReadonlyArray<ConnectorToolDescriptor>,
): ReadonlyArray<WorkflowConnectorTrustedTool> {
  return tools
    .map((tool) => ({
      name: tool.name,
      descriptorFingerprint: toolDescriptorFingerprint(tool),
      schemaFingerprint: toolSchemaFingerprint(tool.inputSchema),
      readOnlyHint: tool.readOnlyHint === true,
      destructiveHint: tool.destructiveHint === true,
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export interface WorkflowConnectorGrant {
  readonly serverName: string;
  readonly basis: "verified" | "trusted";
  readonly verifiedConnectorId: string | null;
  /** Exact operation names the host exposes for this connector. */
  readonly operations: ReadonlyArray<string>;
  /** Pinned declarations for trusted operations, keyed by tool name. */
  readonly pinnedTools: Readonly<Record<string, WorkflowConnectorTrustedTool>>;
}

function trustedOperations(
  serverName: string,
  definition: McpServerDefinition,
  trust: WorkflowConnectorTrust,
): ReadonlyArray<WorkflowConnectorTrustedTool> {
  return trust.tools.filter(
    (tool) =>
      tool.readOnlyHint &&
      !tool.destructiveHint &&
      verifiedConnectorDenial({ serverName, definition, toolName: tool.name }) === undefined,
  );
}

function narrowEnabledTools(
  definition: McpServerDefinition,
  operations: ReadonlyArray<string>,
): McpServerDefinition {
  const configured = definition.enabledTools ? new Set(definition.enabledTools) : null;
  const disabled = new Set(definition.disabledTools ?? []);
  const enabledTools = operations.filter(
    (name) => (configured === null || configured.has(name)) && !disabled.has(name),
  );
  return { ...definition, enabledTools };
}

export interface WorkflowConnectorPlan {
  /** Only connectors with at least one exposed operation, narrowed to those operations. */
  readonly servers: McpProjectServersConfig;
  readonly grants: Readonly<Record<string, WorkflowConnectorGrant>>;
  readonly access: ReadonlyArray<WorkflowConnectorAccessEntry>;
  /** Changes whenever any exposed capability changes; part of the launch fingerprint. */
  readonly digest: string;
}

export function planWorkflowConnectors(input: {
  readonly servers: McpProjectServersConfig | null | undefined;
  readonly trusted: WorkflowTrustedConnectors | null | undefined;
}): WorkflowConnectorPlan {
  const servers: Record<string, McpServerDefinition> = {};
  const grants: Record<string, WorkflowConnectorGrant> = {};
  const access: WorkflowConnectorAccessEntry[] = [];
  for (const [serverName, definition] of Object.entries(input.servers ?? {}).toSorted(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (definition.enabled === false) continue;
    const verified = matchVerifiedConnector(definition);
    const trust = input.trusted?.[serverName];
    const trustCurrent =
      trust !== undefined && trust.configFingerprint === connectorConfigFingerprint(definition);
    const verifiedOperations = verified
      ? [...verified.readOperations].filter((toolName) => {
          const configured = definition.enabledTools;
          return configured === undefined || configured.includes(toolName);
        })
      : [];
    const pinned = trustCurrent ? trustedOperations(serverName, definition, trust) : [];
    const operations = [
      ...new Set([...verifiedOperations, ...pinned.map((tool) => tool.name)]),
    ].toSorted();
    const narrowed = narrowEnabledTools(definition, operations);
    const exposed = narrowed.enabledTools ?? [];
    if (exposed.length > 0) {
      servers[serverName] = narrowed;
      grants[serverName] = {
        serverName,
        basis: verified ? "verified" : "trusted",
        verifiedConnectorId: verified?.id ?? null,
        operations: exposed,
        pinnedTools: Object.fromEntries(
          pinned.filter((tool) => exposed.includes(tool.name)).map((tool) => [tool.name, tool]),
        ),
      };
    }
    const state: WorkflowConnectorAccessEntry["state"] =
      exposed.length === 0
        ? trust !== undefined && !trustCurrent
          ? "trust-stale"
          : "unavailable"
        : verified
          ? "verified"
          : "trusted";
    access.push({
      serverName,
      state,
      verifiedConnector: verified?.label ?? null,
      operations: exposed,
      trustedAt: trust?.trustedAt ?? null,
      ...(state === "trust-stale"
        ? {
            message:
              "The connector configuration changed after it was trusted. Trust it again to use it in read-only workflows.",
          }
        : state === "trusted"
          ? {
              message:
                "Trusted by you: F5 relies on the connector's own read-only declarations for these operations.",
            }
          : {}),
    });
  }
  return {
    servers,
    grants,
    access,
    digest: sha256(`f5.connector-plan.v1\0${canonicalJson({ servers, grants })}`),
  };
}

/**
 * Parse a provider-reported tool inventory (MCP `Tool` objects keyed by name)
 * into descriptors. Entries without a usable name are dropped.
 */
export function parseConnectorToolInventory(
  tools: Readonly<Record<string, unknown>> | undefined,
): ReadonlyArray<ConnectorToolDescriptor> {
  const descriptors: ConnectorToolDescriptor[] = [];
  for (const [key, value] of Object.entries(tools ?? {})) {
    const tool =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const name = typeof tool.name === "string" && tool.name.length > 0 ? tool.name : key;
    if (name.length === 0) continue;
    const annotations =
      tool.annotations && typeof tool.annotations === "object"
        ? (tool.annotations as Record<string, unknown>)
        : {};
    descriptors.push({
      name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(typeof annotations.readOnlyHint === "boolean"
        ? { readOnlyHint: annotations.readOnlyHint }
        : {}),
      ...(typeof annotations.destructiveHint === "boolean"
        ? { destructiveHint: annotations.destructiveHint }
        : {}),
      ...("inputSchema" in tool ? { inputSchema: tool.inputSchema } : {}),
    });
  }
  return descriptors;
}

export type ConnectorToolDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/**
 * Execution-time decision. `live` is the connector's current declaration when
 * the provider can report it; trusted operations require it.
 */
export function evaluateConnectorToolCall(input: {
  readonly grant: WorkflowConnectorGrant | undefined;
  readonly serverName: string;
  readonly toolName: string;
  readonly live?: ConnectorToolDescriptor | undefined;
}): ConnectorToolDecision {
  const denial = verifiedConnectorDenial({
    serverName: input.serverName,
    toolName: input.toolName,
  });
  if (denial) return { allowed: false, reason: denial };
  const grant = input.grant;
  if (!grant || !grant.operations.includes(input.toolName)) {
    return {
      allowed: false,
      reason: `Connector operation '${input.serverName}/${input.toolName}' is not verified as read-only and the connector is not trusted for read-only workflows in this project.`,
    };
  }
  if (input.live?.destructiveHint === true) {
    return {
      allowed: false,
      reason: `Connector operation '${input.serverName}/${input.toolName}' now declares itself destructive, so it is not available in read-only workflow stages.`,
    };
  }
  const pinned = grant.pinnedTools[input.toolName];
  if (!pinned) return { allowed: true };
  // Trusted operation: the current declaration must still match what the user trusted.
  if (!input.live) {
    return {
      allowed: false,
      reason: `F5 could not read the current declaration of '${input.serverName}/${input.toolName}', so its trusted read-only status cannot be confirmed.`,
    };
  }
  const schemaFingerprint = toolSchemaFingerprint(input.live.inputSchema);
  if (
    input.live.readOnlyHint !== true ||
    toolDescriptorFingerprint(input.live) !== pinned.descriptorFingerprint ||
    (schemaFingerprint !== null &&
      pinned.schemaFingerprint !== null &&
      schemaFingerprint !== pinned.schemaFingerprint)
  ) {
    return {
      allowed: false,
      reason: `Connector operation '${input.serverName}/${input.toolName}' changed after the connector was trusted. Trust the connector again to use it in read-only workflows.`,
    };
  }
  return { allowed: true };
}
