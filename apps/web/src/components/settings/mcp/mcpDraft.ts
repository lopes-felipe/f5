import { readMcpKeyValueRows } from "./mcpEditorValues";
import {
  McpServerWriteDefinition,
  type McpProjectServersConfig,
  type McpProjectConfigResult,
  type McpServerTransportType,
} from "@t3tools/contracts";
import { Schema } from "effect";
import { normalizeServerName, trimToUndefined } from "@t3tools/shared/mcpValidation";

export type TransportType = McpServerTransportType;

export type ServerDraft = {
  readonly original?: { readonly name: string; readonly server: McpProjectServersConfig[string] };
  readonly name: string;
  readonly type: TransportType;
  readonly enabled: boolean;
  readonly command: string;
  readonly args: string;
  readonly argsFormat: "lines" | "json";
  readonly env: string;
  readonly cwd: string;
  readonly url: string;
  readonly headers: string;
  readonly bearerTokenEnvVar: string;
  readonly supportsParallelToolCalls: "default" | "enabled" | "disabled";
  readonly startupTimeoutSec: string;
  readonly toolTimeoutSec: string;
  readonly enabledTools: string;
  readonly disabledTools: string;
  readonly scopes: string;
  readonly oauthClientId: string;
  readonly oauthCallbackPort: string;
  readonly oauthCallbackUrl: string;
  readonly oauthResource: string;
};

export function createEmptyDraft(type: TransportType = "stdio"): ServerDraft {
  return {
    name: "",
    type,
    enabled: true,
    command: "",
    args: "",
    argsFormat: "lines",
    env: "",
    cwd: "",
    url: "",
    headers: "",
    bearerTokenEnvVar: "",
    supportsParallelToolCalls: "default",
    startupTimeoutSec: "",
    toolTimeoutSec: "",
    enabledTools: "",
    disabledTools: "",
    scopes: "",
    oauthClientId: "",
    oauthCallbackPort: "",
    oauthCallbackUrl: "",
    oauthResource: "",
  };
}

export function toWritableProjectServers(
  servers: McpProjectConfigResult["servers"] | McpProjectServersConfig,
): Record<string, McpProjectServersConfig[string]> {
  return { ...servers };
}

function formatStringArray(values: ReadonlyArray<string> | undefined): string {
  return values?.join("\n") ?? "";
}

function formatStringRecord(values: Record<string, string> | undefined): string {
  if (!values) {
    return "";
  }
  if (
    Object.values(values).some(
      (value) => value.includes("\n") || value !== value.trim() || value.includes("${f5-secret:"),
    )
  )
    return JSON.stringify(values);
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function parseStringArrayInput(value: string): string[] | undefined {
  const parsed = value
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parsed.length > 0 ? parsed : undefined;
}

function parseStringRecordInput(value: string, label: string): Record<string, string> | undefined {
  if (value.trim().startsWith("[") || value.trim().startsWith("{")) {
    const rows = readMcpKeyValueRows(value);
    const result: Record<string, string> = Object.create(null);
    for (const row of rows) {
      if (typeof row.key !== "string" || !row.key.trim() || typeof row.value !== "string")
        throw new Error(`${label} requires keys and string values.`);
      if (row.secret) throw new Error(`Store the ${label.toLowerCase()} secret before saving.`);
      const key = row.key.trim();
      if (Object.hasOwn(result, key)) throw new Error(`${label} contains a duplicate key: ${key}.`);
      result[key] = row.value;
    }
    return result;
  }
  const lines = value
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (lines.length === 0) {
    return undefined;
  }

  const parsed = Object.create(null) as Record<string, string>;
  for (const line of lines) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error(`${label} entries must use KEY=value format.`);
    }
    const key = line.slice(0, separatorIndex).trim();
    const entryValue = line.slice(separatorIndex + 1);
    if (!key) {
      throw new Error(`${label} entries must include a non-empty key.`);
    }
    if (Object.hasOwn(parsed, key)) throw new Error(`${label} contains a duplicate key: ${key}.`);
    parsed[key] = entryValue;
  }
  return Object.keys(parsed).length > 0 ? { ...parsed } : undefined;
}

function parseOptionalIntegerInput(value: string, label: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^\d+$/u.test(trimmed)) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return Number.parseInt(trimmed, 10);
}

function parseOptionalHttpUrlInput(value: string, label: string): string | undefined {
  const trimmed = trimToUndefined(value);
  if (!trimmed) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be a valid HTTP or HTTPS URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http:// or https://.`);
  }
  return trimmed;
}

export function hasAdvancedFields(server: McpProjectServersConfig[string]): boolean {
  return Boolean(
    server.bearerTokenEnvVar ||
    server.supportsParallelToolCalls !== undefined ||
    server.startupTimeoutSec !== undefined ||
    server.toolTimeoutSec !== undefined ||
    server.enabledTools?.length ||
    server.disabledTools?.length ||
    server.scopes?.length ||
    server.oauthClientId ||
    server.oauthCallbackPort !== undefined ||
    server.oauthCallbackUrl ||
    server.oauthResource,
  );
}

export function draftFromServer(
  name: string,
  server: McpProjectServersConfig[string],
): ServerDraft {
  return {
    original: { name, server },
    name,
    type: server.type,
    enabled: server.enabled !== false,
    command: server.type === "stdio" ? server.command : "",
    args: server.type === "stdio" && server.args !== undefined ? JSON.stringify(server.args) : "",
    argsFormat: server.type === "stdio" && server.args !== undefined ? "json" : "lines",
    env: server.type === "stdio" ? formatStringRecord(server.env) : "",
    cwd: server.type === "stdio" ? (server.cwd ?? "") : "",
    url: server.type !== "stdio" ? server.url : "",
    headers: server.type !== "stdio" ? formatStringRecord(server.headers) : "",
    bearerTokenEnvVar: server.bearerTokenEnvVar ?? "",
    supportsParallelToolCalls:
      server.supportsParallelToolCalls === undefined
        ? "default"
        : server.supportsParallelToolCalls
          ? "enabled"
          : "disabled",
    startupTimeoutSec:
      server.startupTimeoutSec !== undefined ? String(server.startupTimeoutSec) : "",
    toolTimeoutSec: server.toolTimeoutSec !== undefined ? String(server.toolTimeoutSec) : "",
    enabledTools: formatStringArray(server.enabledTools),
    disabledTools: formatStringArray(server.disabledTools),
    scopes: formatStringArray(server.scopes),
    oauthClientId: server.oauthClientId ?? "",
    oauthCallbackPort:
      server.oauthCallbackPort !== undefined ? String(server.oauthCallbackPort) : "",
    oauthCallbackUrl: server.oauthCallbackUrl ?? "",
    oauthResource: server.oauthResource ?? "",
  };
}

export function decodeDraftServer(draft: ServerDraft): {
  readonly name: string;
  readonly server: McpProjectServersConfig[string];
} {
  const name = normalizeServerName(draft.name);
  if (!name) {
    throw new Error("Server name is required and must be 128 characters or fewer.");
  }

  const startupTimeoutSec = parseOptionalIntegerInput(draft.startupTimeoutSec, "Startup timeout");
  const toolTimeoutSec = parseOptionalIntegerInput(draft.toolTimeoutSec, "Tool timeout");
  const enabledTools = parseStringArrayInput(draft.enabledTools);
  const disabledTools = parseStringArrayInput(draft.disabledTools);
  const scopes = parseStringArrayInput(draft.scopes);
  const bearerTokenEnvVar = trimToUndefined(draft.bearerTokenEnvVar);
  const oauthClientId = trimToUndefined(draft.oauthClientId);
  const oauthCallbackPort = parseOptionalIntegerInput(
    draft.oauthCallbackPort,
    "OAuth callback port",
  );
  const oauthCallbackUrl = parseOptionalHttpUrlInput(draft.oauthCallbackUrl, "OAuth callback URL");
  const oauthResource = trimToUndefined(draft.oauthResource);
  if (oauthCallbackPort !== undefined && (oauthCallbackPort < 1 || oauthCallbackPort > 65535)) {
    throw new Error("OAuth callback port must be between 1 and 65535.");
  }

  const advanced = {
    enabled: draft.enabled,
    ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}),
    ...(oauthClientId ? { oauthClientId } : {}),
    ...(oauthCallbackPort !== undefined ? { oauthCallbackPort } : {}),
    ...(oauthCallbackUrl ? { oauthCallbackUrl } : {}),
    ...(draft.supportsParallelToolCalls !== "default"
      ? { supportsParallelToolCalls: draft.supportsParallelToolCalls === "enabled" }
      : {}),
    ...(startupTimeoutSec !== undefined ? { startupTimeoutSec } : {}),
    ...(toolTimeoutSec !== undefined ? { toolTimeoutSec } : {}),
    ...(enabledTools ? { enabledTools } : {}),
    ...(disabledTools ? { disabledTools } : {}),
    ...(scopes ? { scopes } : {}),
    ...(oauthResource ? { oauthResource } : {}),
  };

  const candidate =
    draft.type === "stdio"
      ? {
          type: "stdio" as const,
          command: draft.command,
          ...(draft.args !== ""
            ? {
                args:
                  draft.argsFormat === "json"
                    ? (JSON.parse(draft.args) as unknown)
                    : draft.args.split(/\r?\n/u),
              }
            : {}),
          ...(parseStringRecordInput(draft.env, "Environment")
            ? { env: parseStringRecordInput(draft.env, "Environment") }
            : {}),
          ...(trimToUndefined(draft.cwd) ? { cwd: trimToUndefined(draft.cwd) } : {}),
          ...advanced,
        }
      : {
          type: draft.type,
          url: draft.url,
          ...(parseStringRecordInput(draft.headers, "Headers")
            ? { headers: parseStringRecordInput(draft.headers, "Headers") }
            : {}),
          ...advanced,
        };

  const writable = { ...candidate } as Record<string, unknown>;
  if (draft.original && draft.type === draft.original.server.type) {
    const originalDraft = draftFromServer(draft.original.name, draft.original.server);
    for (const key of Object.keys({ ...draft.original.server, ...candidate })) {
      if (
        key in draft &&
        draft[key as keyof ServerDraft] === originalDraft[key as keyof ServerDraft] &&
        (key !== "args" || draft.argsFormat === originalDraft.argsFormat)
      ) {
        const value = (draft.original.server as unknown as Record<string, unknown>)[key];
        if (value === undefined) delete writable[key];
        else writable[key] = value;
      }
    }
  }
  return { name, server: Schema.decodeUnknownSync(McpServerWriteDefinition)(writable) };
}
