import { summarizeMcpTools } from "@t3tools/shared/mcpTools";
import type { McpServerStatusEntry, McpProjectServersConfig } from "@t3tools/contracts";
import { createMcpDiagnosticsSanitizer, isMcpCredentialKey } from "@t3tools/shared/mcpDiagnostics";
import { mcpServerNameKey } from "@t3tools/shared/mcpValidation";
import type { McpAdapterObservation, ObservedMcpServer } from "../provider/mcpObservation.ts";
import { CODEX_SSE_TRANSPORT_HINT } from "@t3tools/shared/mcpTranslation";

export const CLAUDE_MCP_AUTH_MESSAGE =
  "Claude reports this server needs sign-in. Click Sign in to authenticate in your browser.";

export function projectMcpStatuses(
  servers: McpProjectServersConfig,
  observation: McpAdapterObservation | undefined,
  provider: string,
): McpServerStatusEntry[] {
  const sanitizer = createMcpDiagnosticsSanitizer(servers);
  const entry = (server: ObservedMcpServer): McpServerStatusEntry => ({
    name: server.name,
    ownership: server.ownership ?? "external",
    ...(server.origin ? { origin: sanitizer.text(server.origin) } : {}),
    state:
      server.status === "connected"
        ? "ready"
        : server.status === "pending"
          ? "starting"
          : server.status === "needs-auth"
            ? "needs-auth"
            : server.status === "disabled"
              ? "disabled"
              : server.status === "failed"
                ? "failed"
                : "unknown",
    authStatus:
      server.status === "needs-auth" ? "unauthenticated" : (server.authStatus ?? "unknown"),
    ...(server.tools
      ? {
          tools: summarizeMcpTools(server.tools).map((tool) => ({
            ...tool,
            ...(tool.description
              ? { description: sanitizer.text(tool.description).slice(0, 300) }
              : {}),
          })),
        }
      : {}),
    toolCount: server.toolCount ?? server.tools?.length ?? 0,
    resourceCount: server.resources?.length ?? 0,
    resourceTemplateCount: server.resourceTemplates?.length ?? 0,
    ...(server.error ? { message: sanitizer.text(server.error) } : {}),
    ...(server.status === "needs-auth" && provider === "claudeAgent"
      ? { message: CLAUDE_MCP_AUTH_MESSAGE }
      : {}),
    ...(server.status === "unknown" && !server.error
      ? {
          message:
            "No startup or capability evidence is available. A server with zero reported tools may still be connected; click Refresh to check again.",
        }
      : {}),
  });
  const results = Object.entries(servers).map(([name, config]): McpServerStatusEntry => {
    const matches =
      observation?.servers.filter(
        (server) =>
          server.ownership === "managed" &&
          mcpServerNameKey(server.name) === mcpServerNameKey(name),
      ) ?? [];
    const ambiguous =
      (observation?.servers.filter(
        (server) => mcpServerNameKey(server.name) === mcpServerNameKey(name),
      ).length ?? 0) > 1;
    let result: McpServerStatusEntry =
      matches.length === 1 && !ambiguous
        ? { ...entry(matches[0]!), name }
        : {
            name,
            ownership: "managed",
            state: config.enabled === false && !observation ? "disabled" : "unknown",
            authStatus: "unknown",
            toolCount: 0,
            resourceCount: 0,
            resourceTemplateCount: 0,
            message: ambiguous
              ? `Provider reports conflicting names: ${observation?.servers
                  .filter((server) => mcpServerNameKey(server.name) === mcpServerNameKey(name))
                  .map((server) => server.name)
                  .join(", ")}. No observation can be assigned to this configured server.`
              : !observation && provider === "claudeAgent"
                ? "Live status appears while a Claude session for this account runs in this project."
                : observation?.complete === false
                  ? "The listing is incomplete; the server's presence is unknown."
                  : "The provider did not report an F5-managed server with this name.",
          };
    result = { ...result, desiredEnabled: config.enabled !== false };
    if (config.enabled === false && result.state !== "disabled" && observation)
      result = {
        ...result,
        message: `Disabled in saved configuration; ${result.state === "ready" ? "still connected" : result.state} in this conversation; apply pending.${result.message ? ` ${result.message}` : ""}`,
      };
    if (provider === "codex" && config.type === "sse" && result.state !== "ready")
      result = { ...result, message: `${result.message ?? ""} ${CODEX_SSE_TRANSPORT_HINT}`.trim() };
    return result;
  });
  return [
    ...results,
    ...(observation?.servers
      .filter(
        (server) =>
          server.ownership !== "managed" ||
          !Object.keys(servers).some(
            (name) => mcpServerNameKey(name) === mcpServerNameKey(server.name),
          ),
      )
      .map((server) =>
        server.ownership === "managed"
          ? {
              ...entry(server),
              desiredEnabled: false,
              message: `Removed from saved configuration; ${server.status === "connected" ? "still connected" : server.status} in this conversation; removal pending. Apply the saved configuration.${server.error ? ` ${sanitizer.text(server.error)}` : ""}`,
            }
          : entry(server),
      ) ?? []),
  ];
}

/** A single bounded projection for both wire responses and Copy diagnostics. */
export function boundMcpObservation(
  observation: McpAdapterObservation,
  config: McpProjectServersConfig,
  additionalValues: ReadonlyArray<string> = [],
): McpAdapterObservation {
  const sanitizer = createMcpDiagnosticsSanitizer(config, additionalValues);
  const omissions = new Set(observation.omissions ?? []);
  let remainingBytes = 2 * 1024 * 1024 - 128 * 1024;
  let remainingItems = 1000;
  const boundedJson = (value: unknown, limit: number) => {
    let bytes = 0;
    let omitted = false;
    const visit = (node: unknown, depth: number): unknown => {
      if (depth > 32 || bytes >= limit) {
        omitted = true;
        return null;
      }
      if (typeof node === "string") {
        const safe = sanitizer.text(node);
        bytes += Buffer.byteLength(JSON.stringify(safe));
        if (bytes >= limit) {
          omitted = true;
          return null;
        }
        if (safe.length < node.length && node.length > 8192) omitted = true;
        return safe;
      }
      if (node === null || typeof node === "number" || typeof node === "boolean") {
        bytes += 8;
        return node;
      }
      if (Array.isArray(node)) {
        const result: unknown[] = [];
        for (const child of node) {
          if (bytes >= limit) {
            omitted = true;
            break;
          }
          bytes += 2;
          result.push(visit(child, depth + 1));
        }
        return result;
      }
      if (node && typeof node === "object") {
        const result: Record<string, unknown> = Object.create(null);
        for (const [key, child] of Object.entries(node)) {
          bytes += Buffer.byteLength(JSON.stringify(key)) + 4;
          if (bytes >= limit) {
            omitted = true;
            break;
          }
          result[key] = isMcpCredentialKey(key) ? "[redacted]" : visit(child, depth + 1);
        }
        return result;
      }
      return null;
    };
    const result = visit(value, 0);
    if (omitted || Buffer.byteLength(JSON.stringify(result)) > limit) {
      omissions.add(
        "Schema, output byte, or nesting depth limit reached (64 KiB per schema; 2 MiB total; depth 32).",
      );
      return null;
    }
    return result;
  };
  const consume = <T>(value: T): T | undefined => {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > remainingBytes || remainingItems <= 0) {
      omissions.add("Output item (1,000) or byte (2 MiB) limit reached.");
      return undefined;
    }
    remainingBytes -= bytes;
    remainingItems--;
    return value;
  };
  const list = <T, R>(items: ReadonlyArray<T>, project: (item: T) => R): R[] => {
    const result: R[] = [];
    for (const item of items) {
      if (remainingItems <= 0 || remainingBytes <= 0) {
        omissions.add("Output item (1,000) or byte (2 MiB) limit reached.");
        break;
      }
      const safe = consume(project(item));
      if (safe !== undefined) result.push(safe);
      else break;
    }
    return result;
  };
  const servers: ObservedMcpServer[] = [];
  for (const server of observation.servers) {
    const metadata = {
      name: sanitizer.text(server.name).slice(0, 2048) || "(unnamed)",
      status: server.status,
      ownership: server.ownership ?? "external",
      ...(server.origin ? { origin: sanitizer.text(server.origin).slice(0, 128) } : {}),
      ...(server.error ? { error: sanitizer.text(server.error).slice(0, 2000) } : {}),
      ...(server.toolCount !== undefined ? { toolCount: server.toolCount } : {}),
      ...(server.authStatus ? { authStatus: server.authStatus } : {}),
    };
    const metadataBytes = Buffer.byteLength(JSON.stringify(metadata)) + 64;
    if (metadataBytes > remainingBytes || servers.length >= 1000) {
      omissions.add("Output server or byte limit reached.");
      break;
    }
    remainingBytes -= metadataBytes;
    servers.push({
      ...metadata,
      tools: list(server.tools ?? [], (tool) => ({
        name: sanitizer.text(tool.name).slice(0, 256),
        ...(tool.description ? { description: sanitizer.text(tool.description) } : {}),
        ...(tool.annotations !== undefined
          ? { annotations: boundedJson(tool.annotations, Math.min(65536, remainingBytes)) }
          : {}),
        ...(tool.inputSchema !== undefined
          ? { inputSchema: boundedJson(tool.inputSchema, Math.min(65536, remainingBytes)) }
          : {}),
      })),
      resources: list(server.resources ?? [], (resource) =>
        boundedJson(resourceMetadata(resource), remainingBytes),
      ),
      resourceTemplates: list(server.resourceTemplates ?? [], (resource) =>
        boundedJson(resourceMetadata(resource), remainingBytes),
      ),
    });
  }
  return {
    servers,
    capabilities: observation.capabilities,
    complete: observation.complete && omissions.size === 0,
    ...(omissions.size ? { omissions: [...omissions] } : {}),
  };
}

function resourceMetadata(value: unknown) {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    ["name", "title", "uri", "uriTemplate", "description", "mimeType"].flatMap((key) =>
      typeof record[key] === "string" ? [[key, record[key]]] : [],
    ),
  );
}

/** Bound the final envelope as well as provider metadata, including historical diagnostics. */
export function capMcpResponse<T extends import("@t3tools/contracts").McpServerStatusesResult>(
  result: T,
): T {
  const output: Record<string, unknown> = { ...result };
  const omissions = [...(result.omissions ?? [])];
  let items = 1000;
  for (const key of [
    "statuses",
    "tools",
    "resources",
    "resourceTemplates",
    "diagnostics",
    "sessions",
  ] as const) {
    const values = output[key];
    if (!Array.isArray(values)) continue;
    if (values.length > items) {
      output[key] = values.slice(0, items);
      omissions.push(`${key}: output item limit reached.`);
    }
    items -= Math.min(values.length, items);
  }
  const byteSize = () => Buffer.byteLength(JSON.stringify(output));
  for (const key of [
    "diagnostics",
    "tools",
    "resources",
    "resourceTemplates",
    "sessions",
    "statuses",
  ]) {
    const values = output[key];
    if (!Array.isArray(values)) continue;
    let retained = values;
    while (retained.length && byteSize() > 2 * 1024 * 1024 - 4096) {
      retained = retained.slice(0, Math.floor(retained.length / 2));
      output[key] = retained;
      omissions.push(`${key}: output byte limit reached.`);
    }
  }
  if (omissions.length) {
    output.complete = false;
    output.omissions = [...new Set(omissions)];
  }
  return output as T;
}
