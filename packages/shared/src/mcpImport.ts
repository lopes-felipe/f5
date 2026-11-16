import {
  McpServerDefinition,
  McpServerWriteDefinition,
  McpHttpUrl,
  type McpProjectServersConfig,
  type McpServerTransportType as TransportType,
} from "@t3tools/contracts";
import { Schema } from "effect";
import { parse as parseToml } from "smol-toml";

import { normalizeServerName, mcpServerNameKey } from "./mcpServerName";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readImportedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readImportedBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readImportedInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readImportedStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parsed = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return parsed.length > 0 || value.length === 0 ? parsed : undefined;
}

function readImportedStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const parsed = Object.fromEntries(
    Object.entries(value)
      .map(([key, entry]) => {
        if (typeof entry !== "string") {
          return null;
        }
        const normalizedKey = key.trim();
        return normalizedKey ? ([normalizedKey, entry] as const) : null;
      })
      .filter((entry): entry is readonly [string, string] => entry !== null),
  );
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function readImportedOauthConfig(value: unknown): {
  readonly clientId?: string;
  readonly callbackPort?: number;
  readonly callbackUrl?: string;
} {
  if (!isRecord(value)) {
    return {};
  }
  const clientId =
    readImportedString(value.clientId) ??
    readImportedString(value.client_id) ??
    readImportedString(value.CLIENT_ID);
  const callbackPort =
    readImportedInteger(value.callbackPort) ?? readImportedInteger(value.callback_port);
  const callbackUrl =
    readImportedString(value.callbackUrl) ?? readImportedString(value.callback_url);
  return {
    ...(clientId ? { clientId } : {}),
    ...(callbackPort !== undefined ? { callbackPort } : {}),
    ...(callbackUrl ? { callbackUrl } : {}),
  };
}

function decodeImportedServer(
  value: unknown,
  serverName: string,
): McpProjectServersConfig[string] | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawType =
    readImportedString(value.type) ??
    readImportedString(value.transport) ??
    readImportedString(value.transportType);
  if (rawType === "sdk") {
    return null;
  }

  const type: TransportType | undefined =
    rawType === "stdio" || rawType === "sse" || rawType === "http"
      ? rawType
      : readImportedString(value.command)
        ? "stdio"
        : readImportedString(value.url)
          ? "http"
          : undefined;
  if (!type) {
    return null;
  }

  if (
    type === "stdio" &&
    value.args !== undefined &&
    (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === "string"))
  ) {
    throw new Error(
      `Cannot import MCP server '${serverName}': args must be an array of strings. No arguments were imported.`,
    );
  }
  const candidate =
    type === "stdio"
      ? {
          type,
          command: readImportedString(value.command),
          ...(value.args !== undefined ? { args: value.args } : {}),
          ...(readImportedStringRecord(value.env)
            ? { env: readImportedStringRecord(value.env) }
            : {}),
          ...(readImportedString(value.cwd) ? { cwd: readImportedString(value.cwd) } : {}),
        }
      : {
          type,
          url: readImportedString(value.url),
          ...(readImportedStringRecord(value.headers ?? value.http_headers)
            ? { headers: readImportedStringRecord(value.headers ?? value.http_headers) }
            : {}),
        };

  try {
    const oauthConfig = {
      ...readImportedOauthConfig(value.auth),
      ...readImportedOauthConfig(value.oauth),
    };
    const oauthClientId =
      readImportedString(value.oauthClientId) ??
      readImportedString(value.oauth_client_id) ??
      oauthConfig.clientId;
    const oauthCallbackPort =
      readImportedInteger(value.oauthCallbackPort) ??
      readImportedInteger(value.oauth_callback_port) ??
      oauthConfig.callbackPort;
    const oauthCallbackUrl =
      readImportedString(value.oauthCallbackUrl) ??
      readImportedString(value.oauth_callback_url) ??
      oauthConfig.callbackUrl;
    return Schema.decodeUnknownSync(McpServerDefinition)({
      ...candidate,
      ...(readImportedBoolean(value.enabled) !== undefined
        ? { enabled: readImportedBoolean(value.enabled) }
        : {}),
      ...((readImportedString(value.bearerTokenEnvVar) ??
      readImportedString(value.bearer_token_env_var))
        ? {
            bearerTokenEnvVar:
              readImportedString(value.bearerTokenEnvVar) ??
              readImportedString(value.bearer_token_env_var),
          }
        : {}),
      ...((readImportedBoolean(value.supportsParallelToolCalls) ??
        readImportedBoolean(value.supports_parallel_tool_calls)) !== undefined
        ? {
            supportsParallelToolCalls:
              readImportedBoolean(value.supportsParallelToolCalls) ??
              readImportedBoolean(value.supports_parallel_tool_calls),
          }
        : {}),
      ...((readImportedInteger(value.startupTimeoutSec) ??
        readImportedInteger(value.startup_timeout_sec)) !== undefined
        ? {
            startupTimeoutSec:
              readImportedInteger(value.startupTimeoutSec) ??
              readImportedInteger(value.startup_timeout_sec),
          }
        : {}),
      ...((readImportedInteger(value.toolTimeoutSec) ??
        readImportedInteger(value.tool_timeout_sec)) !== undefined
        ? {
            toolTimeoutSec:
              readImportedInteger(value.toolTimeoutSec) ??
              readImportedInteger(value.tool_timeout_sec),
          }
        : {}),
      ...((readImportedStringArray(value.enabledTools) ??
      readImportedStringArray(value.enabled_tools))
        ? {
            enabledTools:
              readImportedStringArray(value.enabledTools) ??
              readImportedStringArray(value.enabled_tools),
          }
        : {}),
      ...((readImportedStringArray(value.disabledTools) ??
      readImportedStringArray(value.disabled_tools))
        ? {
            disabledTools:
              readImportedStringArray(value.disabledTools) ??
              readImportedStringArray(value.disabled_tools),
          }
        : {}),
      ...(readImportedStringArray(value.scopes)
        ? { scopes: readImportedStringArray(value.scopes) }
        : {}),
      ...(oauthClientId ? { oauthClientId } : {}),
      ...(oauthCallbackPort !== undefined ? { oauthCallbackPort } : {}),
      ...(oauthCallbackUrl ? { oauthCallbackUrl } : {}),
      ...((readImportedString(value.oauthResource) ?? readImportedString(value.oauth_resource))
        ? {
            oauthResource:
              readImportedString(value.oauthResource) ?? readImportedString(value.oauth_resource),
          }
        : {}),
    });
  } catch {
    return null;
  }
}

function canUseTopLevelOauthCallback(value: Record<string, unknown>): boolean {
  const rawType =
    readImportedString(value.type) ??
    readImportedString(value.transport) ??
    readImportedString(value.transportType);
  return (
    value.oauth !== undefined ||
    value.auth !== undefined ||
    value.oauthClientId !== undefined ||
    value.oauth_client_id !== undefined ||
    value.oauthCallbackUrl !== undefined ||
    value.oauth_callback_url !== undefined ||
    value.oauthResource !== undefined ||
    value.oauth_resource !== undefined ||
    rawType === "http" ||
    (!rawType && readImportedString(value.url) !== undefined)
  );
}

function hasImportedServerOauthCallbackPort(value: Record<string, unknown>): boolean {
  return (
    readImportedInteger(value.oauthCallbackPort) !== undefined ||
    readImportedInteger(value.oauth_callback_port) !== undefined ||
    readImportedOauthConfig(value.auth).callbackPort !== undefined ||
    readImportedOauthConfig(value.oauth).callbackPort !== undefined
  );
}

function hasImportedServerOauthCallbackUrl(value: Record<string, unknown>): boolean {
  return (
    readImportedString(value.oauthCallbackUrl) !== undefined ||
    readImportedString(value.oauth_callback_url) !== undefined ||
    readImportedOauthConfig(value.auth).callbackUrl !== undefined ||
    readImportedOauthConfig(value.oauth).callbackUrl !== undefined
  );
}

/** Compatibility helper for callers that only consume decoded entries. Previews use parseMcpImport. */
export function parseImportedServers(text: string): McpProjectServersConfig {
  if (!text.trim()) return {};
  if (text.includes("${f5-secret:"))
    throw new Error("Stored secret placeholders cannot be imported.");
  const result = parseMcpImport(text);
  const parseError = result.issues.find((issue) => issue.severity === "error");
  if (parseError) throw new Error(parseError.message);
  for (const candidate of result.candidates) {
    const secretIssue = candidate.issues.find((issue) =>
      issue.message.startsWith("Stored secret placeholders"),
    );
    if (secretIssue) throw new Error(secretIssue.message);
    const nameError = candidate.issues.find(
      (issue) => issue.field === "name" && issue.severity === "error",
    );
    if (nameError) throw new Error(nameError.message);
    const argsError = candidate.issues.find(
      (issue) => issue.field === "args" && issue.severity === "error",
    );
    if (argsError) throw new Error(argsError.message);
  }
  return Object.fromEntries(
    result.candidates.flatMap((candidate) =>
      candidate.server ? [[candidate.name, candidate.server]] : [],
    ),
  );
}

/** Loss-aware parsing for previews: invalid entries remain selectable only after repair. */
export function parseMcpImport(
  text: string,
  source = "Pasted configuration",
): import("@t3tools/contracts").McpListImportCandidatesResult {
  type Issue = import("@t3tools/contracts").McpImportIssue;
  const issues: Issue[] = [];
  const jsonInput = text.trim().startsWith("{");
  let document: unknown;
  try {
    document = jsonInput ? JSON.parse(text) : parseToml(text);
  } catch (error) {
    return {
      candidates: [],
      issues: [
        {
          field: "$",
          severity: "error",
          message: error instanceof Error ? error.message : "Invalid configuration.",
        },
      ],
    };
  }
  if (!isRecord(document))
    return {
      candidates: [],
      issues: [{ field: "$", severity: "error", message: "Expected a configuration object." }],
    };
  const root = isRecord(document.mcpServers)
    ? document.mcpServers
    : isRecord(document.mcp_servers)
      ? document.mcp_servers
      : jsonInput
        ? document
        : {};
  const seen = new Set<string>();
  const candidates = Object.entries(root).map(([rawName, raw], index) => {
    const name = normalizeServerName(rawName) ?? rawName;
    const entryIssues: Issue[] = [];
    const add = (field: string, message: string, severity: "warning" | "error" = "warning") =>
      entryIssues.push({ serverName: name, field, severity, message });
    if (!normalizeServerName(rawName))
      add("name", "Server name is required and must be at most 128 characters.", "error");
    if (seen.has(mcpServerNameKey(name))) add("name", "Conflicting imported server name.", "error");
    seen.add(mcpServerNameKey(name));
    let server: McpProjectServersConfig[string] | undefined;
    if (!isRecord(raw)) add("$", "Expected a server object.", "error");
    else {
      if (raw.env_http_headers !== undefined)
        add(
          "env_http_headers",
          "Environment HTTP headers cannot be imported; add values manually.",
        );
      if (raw.bearer_token !== undefined)
        add("bearer_token", "Literal bearer_token is unsupported; use bearerTokenEnvVar.");
      for (const field of ["auth", "oauth"]) {
        if (
          raw[field] !== undefined &&
          (!isRecord(raw[field]) ||
            Object.keys(raw[field]).some(
              (key) =>
                ![
                  "clientId",
                  "client_id",
                  "CLIENT_ID",
                  "callbackPort",
                  "callback_port",
                  "callbackUrl",
                  "callback_url",
                ].includes(key),
            ))
        )
          add(
            field,
            "Unknown authentication block; review and add authentication values manually.",
          );
      }
      if (raw.type === "sdk") add("type", "SDK entries cannot be imported.", "error");
      if (JSON.stringify(raw).includes("${f5-secret:"))
        add(
          "$",
          "Stored secret placeholders cannot be imported. Add secret values manually.",
          "error",
        );
      for (const field of [
        "enabled",
        "supportsParallelToolCalls",
        "supports_parallel_tool_calls",
      ]) {
        if (raw[field] !== undefined && typeof raw[field] !== "boolean")
          add(field, "Expected a boolean.", "error");
      }
      for (const field of [
        "startupTimeoutSec",
        "startup_timeout_sec",
        "toolTimeoutSec",
        "tool_timeout_sec",
        "oauthCallbackPort",
        "oauth_callback_port",
      ]) {
        if (raw[field] !== undefined && readImportedInteger(raw[field]) === undefined)
          add(field, "Expected a non-negative integer.", "error");
      }
      for (const field of [
        "enabledTools",
        "enabled_tools",
        "disabledTools",
        "disabled_tools",
        "scopes",
      ]) {
        if (
          raw[field] !== undefined &&
          (!Array.isArray(raw[field]) ||
            !(raw[field] as unknown[]).every((value) => typeof value === "string"))
        )
          add(field, "Expected an array of strings.", "error");
      }
      for (const field of ["env", "headers", "http_headers"]) {
        const values = raw[field];
        if (values !== undefined && !isRecord(values))
          add(field, "Expected key/value strings.", "error");
        else if (isRecord(values))
          for (const [key, value] of Object.entries(values))
            if (!key.trim() || typeof value !== "string")
              add(`${field}.${key}`, "Expected a non-empty key and a string value.", "error");
      }
      const rawType = raw.type ?? raw.transport ?? raw.transportType;
      if (rawType !== undefined && !["stdio", "http", "sse", "sdk"].includes(String(rawType)))
        add("type", "Unsupported transport type.", "error");
      if (typeof raw.url === "string" && !Schema.is(McpHttpUrl)(raw.url))
        add("url", "Expected an HTTP or HTTPS URL.", "error");
      const inherited = {
        ...raw,
        ...(canUseTopLevelOauthCallback(raw) &&
        !hasImportedServerOauthCallbackPort(raw) &&
        document.mcp_oauth_callback_port !== undefined
          ? { oauthCallbackPort: document.mcp_oauth_callback_port }
          : {}),
        ...(canUseTopLevelOauthCallback(raw) &&
        !hasImportedServerOauthCallbackUrl(raw) &&
        document.mcp_oauth_callback_url !== undefined
          ? { oauthCallbackUrl: document.mcp_oauth_callback_url }
          : {}),
      };
      try {
        const decoded = decodeImportedServer(inherited, name);
        if (decoded) server = decoded;
        else if (raw.type !== "sdk") add("$", "Invalid or unsupported server definition.", "error");
      } catch (error) {
        add("args", error instanceof Error ? error.message : "Invalid arguments.", "error");
      }
    }
    if (server) {
      const validation = readImportValidationIssues(server);
      for (const issue of validation) add(issue.field, issue.message, "error");
    }
    return {
      id: `${source}:${index}:${name}`,
      name,
      source,
      ...(server ? { server } : {}),
      issues: entryIssues,
    };
  });
  return { candidates, issues };
}

function readImportValidationIssues(
  server: McpProjectServersConfig[string],
): { field: string; message: string }[] {
  const result = Schema.decodeUnknownExit(McpServerWriteDefinition)(server);
  if (result._tag === "Failure")
    return [
      {
        field: server.type === "stdio" ? "command" : "url",
        message:
          "Server does not meet validation requirements. Review its URL, command, and options.",
      },
    ];
  return [];
}
