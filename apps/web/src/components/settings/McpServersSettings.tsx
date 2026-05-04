import {
  type McpConfigScope,
  type McpCommonConfigResult,
  type McpLoginStatusResult,
  type McpProviderStatusResult,
  type McpProjectConfigResult,
  McpServerDefinition,
  McpProjectServersConfig,
  type ProjectId,
  type ProviderKind,
  type McpServerStatusEntry,
} from "@t3tools/contracts";
import { formatMcpServersAsJson } from "@t3tools/shared/mcpConfig";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { useEffect, useMemo, useState } from "react";

import { ensureNativeApi } from "../../nativeApi";
import {
  mcpCommonConfigQueryOptions,
  mcpEffectiveConfigQueryOptions,
  mcpLoginStatusQueryOptions,
  mcpProviderStatusQueryOptions,
  mcpProjectConfigQueryOptions,
  mcpQueryKeys,
  mcpServerStatusesQueryOptions,
} from "../../lib/mcpReactQuery";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type ProjectSummary = {
  readonly id: ProjectId;
  readonly name: string;
};

type TransportType = "stdio" | "sse" | "http";

type ServerDraft = {
  readonly name: string;
  readonly type: TransportType;
  readonly enabled: boolean;
  readonly command: string;
  readonly args: string;
  readonly env: string;
  readonly cwd: string;
  readonly url: string;
  readonly headers: string;
  readonly bearerTokenEnvVar: string;
  readonly supportsParallelToolCalls: boolean;
  readonly startupTimeoutSec: string;
  readonly toolTimeoutSec: string;
  readonly enabledTools: string;
  readonly disabledTools: string;
  readonly scopes: string;
  readonly oauthResource: string;
};

const MAX_SERVER_COUNT = 16;
const MAX_SERVER_NAME_LENGTH = 128;
const EMPTY_PROJECT_SERVERS: McpProjectServersConfig = {};

function createEmptyDraft(type: TransportType = "stdio"): ServerDraft {
  return {
    name: "",
    type,
    enabled: true,
    command: "",
    args: "",
    env: "",
    cwd: "",
    url: "",
    headers: "",
    bearerTokenEnvVar: "",
    supportsParallelToolCalls: false,
    startupTimeoutSec: "",
    toolTimeoutSec: "",
    enabledTools: "",
    disabledTools: "",
    scopes: "",
    oauthResource: "",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function trimToUndefined(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function normalizeServerName(name: string): string | undefined {
  const normalized = trimToUndefined(name);
  if (!normalized || normalized.length > MAX_SERVER_NAME_LENGTH) {
    return undefined;
  }
  return normalized;
}

function normalizeMcpServersRecord(
  value:
    | Record<string, McpProjectServersConfig[string]>
    | McpProjectConfigResult["servers"]
    | null
    | undefined,
): McpProjectServersConfig {
  if (!value) {
    return {};
  }

  const normalized: Record<string, McpProjectServersConfig[string]> = {};
  let count = 0;

  for (const [name, server] of Object.entries(value)) {
    if (count >= MAX_SERVER_COUNT) {
      break;
    }
    const normalizedName = normalizeServerName(name);
    if (!normalizedName) {
      continue;
    }
    normalized[normalizedName] = server;
    count += 1;
  }

  return Schema.decodeUnknownSync(McpProjectServersConfig)(normalized);
}

function toWritableProjectServers(
  servers: McpProjectConfigResult["servers"] | McpProjectServersConfig,
): Record<string, McpProjectServersConfig[string]> {
  return { ...Schema.decodeUnknownSync(McpProjectServersConfig)(servers) };
}

function formatStringArray(values: ReadonlyArray<string> | undefined): string {
  return values?.join("\n") ?? "";
}

function formatStringRecord(values: Record<string, string> | undefined): string {
  if (!values) {
    return "";
  }
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
  const lines = value
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (lines.length === 0) {
    return undefined;
  }

  const parsed: Record<string, string> = {};
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
    parsed[key] = entryValue;
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
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

function hasAdvancedFields(server: McpProjectServersConfig[string]): boolean {
  return Boolean(
    server.bearerTokenEnvVar ||
    server.supportsParallelToolCalls !== undefined ||
    server.startupTimeoutSec !== undefined ||
    server.toolTimeoutSec !== undefined ||
    server.enabledTools?.length ||
    server.disabledTools?.length ||
    server.scopes?.length ||
    server.oauthResource,
  );
}

function draftFromServer(name: string, server: McpProjectServersConfig[string]): ServerDraft {
  return {
    name,
    type: server.type,
    enabled: server.enabled !== false,
    command: server.type === "stdio" ? server.command : "",
    args: server.type === "stdio" ? formatStringArray(server.args) : "",
    env: server.type === "stdio" ? formatStringRecord(server.env) : "",
    cwd: server.type === "stdio" ? (server.cwd ?? "") : "",
    url: server.type !== "stdio" ? server.url : "",
    headers: server.type !== "stdio" ? formatStringRecord(server.headers) : "",
    bearerTokenEnvVar: server.bearerTokenEnvVar ?? "",
    supportsParallelToolCalls: server.supportsParallelToolCalls === true,
    startupTimeoutSec:
      server.startupTimeoutSec !== undefined ? String(server.startupTimeoutSec) : "",
    toolTimeoutSec: server.toolTimeoutSec !== undefined ? String(server.toolTimeoutSec) : "",
    enabledTools: formatStringArray(server.enabledTools),
    disabledTools: formatStringArray(server.disabledTools),
    scopes: formatStringArray(server.scopes),
    oauthResource: server.oauthResource ?? "",
  };
}

function decodeDraftServer(draft: ServerDraft): {
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
  const oauthResource = trimToUndefined(draft.oauthResource);

  const advanced = {
    enabled: draft.enabled,
    ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}),
    ...(draft.supportsParallelToolCalls ? { supportsParallelToolCalls: true } : {}),
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
          ...(parseStringArrayInput(draft.args) ? { args: parseStringArrayInput(draft.args) } : {}),
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

  return {
    name,
    server: Schema.decodeUnknownSync(McpServerDefinition)(candidate),
  };
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
  return parsed.length > 0 ? parsed : undefined;
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

function decodeImportedServer(value: unknown): McpProjectServersConfig[string] | null {
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

  const candidate =
    type === "stdio"
      ? {
          type,
          command: readImportedString(value.command),
          ...(readImportedStringArray(value.args)
            ? { args: readImportedStringArray(value.args) }
            : {}),
          ...(readImportedStringRecord(value.env)
            ? { env: readImportedStringRecord(value.env) }
            : {}),
          ...(readImportedString(value.cwd) ? { cwd: readImportedString(value.cwd) } : {}),
        }
      : {
          type,
          url: readImportedString(value.url),
          ...(readImportedStringRecord(value.headers)
            ? { headers: readImportedStringRecord(value.headers) }
            : {}),
        };

  try {
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
      readImportedBoolean(value.supports_parallel_tool_calls))
        ? {
            supportsParallelToolCalls:
              readImportedBoolean(value.supportsParallelToolCalls) ??
              readImportedBoolean(value.supports_parallel_tool_calls),
          }
        : {}),
      ...((readImportedInteger(value.startupTimeoutSec) ??
      readImportedInteger(value.startup_timeout_sec))
        ? {
            startupTimeoutSec:
              readImportedInteger(value.startupTimeoutSec) ??
              readImportedInteger(value.startup_timeout_sec),
          }
        : {}),
      ...((readImportedInteger(value.toolTimeoutSec) ?? readImportedInteger(value.tool_timeout_sec))
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

function stripTomlComment(line: string): string {
  let currentQuote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if ((character === '"' || character === "'") && line[index - 1] !== "\\") {
      currentQuote = currentQuote === character ? null : (currentQuote ?? character);
      continue;
    }
    if (character === "#" && currentQuote === null) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseTomlString(value: string): string {
  if (value.startsWith('"')) {
    return JSON.parse(value) as string;
  }
  return value.slice(1, -1);
}

function splitTomlArrayItems(value: string): string[] {
  const items: string[] = [];
  let current = "";
  let currentQuote: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ((character === '"' || character === "'") && value[index - 1] !== "\\") {
      currentQuote = currentQuote === character ? null : (currentQuote ?? character);
      current += character;
      continue;
    }
    if (character === "," && currentQuote === null) {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim().length > 0) {
    items.push(current.trim());
  }
  return items;
}

function parseTomlValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return parseTomlString(trimmed);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
      return [];
    }
    return splitTomlArrayItems(inner).map((entry) => parseTomlValue(entry));
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (/^-?\d+$/u.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  return trimmed;
}

function parseCodexTomlServers(text: string): McpProjectServersConfig {
  const parsed: Record<string, Record<string, unknown>> = {};
  let currentSection: { serverName: string; kind: "root" | "env" | "headers" } | null = null;

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) {
      continue;
    }

    const sectionMatch = /^\[(.+)\]$/u.exec(line);
    if (sectionMatch) {
      const rawSection = sectionMatch[1]?.trim();
      const serverMatch = rawSection
        ? /^mcp_servers\.(?:"([^"]+)"|'([^']+)'|([^.]+))(?:\.(env|headers))?$/u.exec(rawSection)
        : null;
      currentSection = serverMatch
        ? {
            serverName:
              serverMatch[1]?.trim() || serverMatch[2]?.trim() || serverMatch[3]?.trim() || "",
            kind:
              serverMatch[4] === "env" || serverMatch[4] === "headers" ? serverMatch[4] : "root",
          }
        : null;
      continue;
    }

    if (!currentSection) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1);
    if (!key) {
      continue;
    }

    const server = (parsed[currentSection.serverName] ??= {});
    if (currentSection.kind === "root") {
      server[key] = parseTomlValue(rawValue);
      continue;
    }

    const nestedKey = currentSection.kind;
    const nested = isRecord(server[nestedKey]) ? server[nestedKey] : {};
    nested[key] = String(parseTomlValue(rawValue) ?? "");
    server[nestedKey] = nested;
  }

  return normalizeMcpServersRecord(
    Object.fromEntries(
      Object.entries(parsed)
        .map(([name, value]) => {
          const decoded = decodeImportedServer(value);
          return decoded ? ([name, decoded] as const) : null;
        })
        .filter(
          (entry): entry is readonly [string, McpProjectServersConfig[string]] => entry !== null,
        ),
    ),
  );
}

function parseJsonServers(text: string): McpProjectServersConfig {
  const parsed = JSON.parse(text) as unknown;
  const root = isRecord(parsed)
    ? isRecord(parsed.mcpServers)
      ? parsed.mcpServers
      : isRecord(parsed.mcp_servers)
        ? parsed.mcp_servers
        : parsed
    : null;
  if (!root) {
    return {};
  }

  return normalizeMcpServersRecord(
    Object.fromEntries(
      Object.entries(root)
        .map(([name, value]) => {
          const decoded = decodeImportedServer(value);
          return decoded ? ([name, decoded] as const) : null;
        })
        .filter(
          (entry): entry is readonly [string, McpProjectServersConfig[string]] => entry !== null,
        ),
    ),
  );
}

function parseImportedServers(text: string): McpProjectServersConfig {
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }
  if (trimmed.startsWith("{")) {
    return parseJsonServers(trimmed);
  }
  return parseCodexTomlServers(trimmed);
}

function providerStatusBadge(
  provider: ProviderKind,
  status: McpProviderStatusResult | undefined,
  options: {
    readonly isLoading: boolean;
    readonly isApplying: boolean;
  },
) {
  if (options.isApplying) {
    return <Badge variant="info">Applying...</Badge>;
  }
  if (options.isLoading) {
    return <Badge variant="outline">Checking...</Badge>;
  }
  if (!status) {
    return <Badge variant="outline">Unknown</Badge>;
  }

  switch (provider) {
    case "claudeAgent":
      if (!status.available) {
        return <Badge variant="error">Unavailable</Badge>;
      }
      if (status.authStatus === "authenticated") {
        return <Badge variant="success">Authenticated</Badge>;
      }
      if (status.authStatus === "unauthenticated") {
        return <Badge variant="warning">Login required</Badge>;
      }
      return <Badge variant="outline">Unknown</Badge>;
    case "codex":
      if (status.support === "supported") {
        return <Badge variant="success">Control ready</Badge>;
      }
      if (status.support === "unsupported") {
        return <Badge variant="warning">Unsupported</Badge>;
      }
      return <Badge variant="error">Unavailable</Badge>;
  }
}

function serverStatusBadge(
  provider: ProviderKind,
  status: McpServerStatusEntry | undefined,
  loginStatus: McpLoginStatusResult | undefined,
  options?: {
    readonly isOverridden?: boolean;
  },
) {
  if (options?.isOverridden) {
    return <Badge variant="outline">Overridden</Badge>;
  }
  if (loginStatus?.status === "pending") {
    return (
      <Badge variant="info">{loginStatus.mode === "oauth" ? "Connecting" : "Logging in"}</Badge>
    );
  }
  if (!status) {
    return <Badge variant="outline">Unknown</Badge>;
  }
  if (
    provider === "claudeAgent" &&
    status.state === "unknown" &&
    status.authStatus === "authenticated"
  ) {
    return <Badge variant="outline">Configured</Badge>;
  }
  switch (status.state) {
    case "disabled":
      return <Badge variant="warning">Disabled</Badge>;
    case "ready":
      return <Badge variant="success">Ready</Badge>;
    case "starting":
      return <Badge variant="info">Starting</Badge>;
    case "login-required":
      return <Badge variant="warning">Login required</Badge>;
    case "failed":
      return <Badge variant="error">Failed</Badge>;
    default:
      return <Badge variant="outline">Unknown</Badge>;
  }
}

function McpServerRow(props: {
  readonly selectedProvider: ProviderKind;
  readonly projectId: ProjectId | null;
  readonly binaryPath: string | undefined;
  readonly homePath: string | undefined;
  readonly name: string;
  readonly server: McpProjectServersConfig[string];
  readonly providerStatus: McpProviderStatusResult | undefined;
  readonly serverStatus: McpServerStatusEntry | undefined;
  readonly isOverridden: boolean;
  readonly overrideTargetEnabled: boolean | undefined;
  readonly onToggleEnabled: (checked: boolean) => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const queryClient = useQueryClient();
  const [loginError, setLoginError] = useState<string | null>(null);
  const loginStatusQuery = useQuery(
    mcpLoginStatusQueryOptions({
      provider: props.selectedProvider,
      projectId: props.projectId,
      serverName: props.selectedProvider === "codex" ? props.name : null,
      ...(props.binaryPath ? { binaryPath: props.binaryPath } : {}),
      ...(props.homePath ? { homePath: props.homePath } : {}),
      enabled:
        props.selectedProvider === "codex" && props.projectId !== null && !props.isOverridden,
      refetchInterval:
        props.selectedProvider === "codex" && props.projectId !== null && !props.isOverridden
          ? 2_000
          : false,
    }),
  );

  const isCodexProvider = props.selectedProvider === "codex";
  const loginModeHint =
    loginStatusQuery.data?.mode ??
    (props.server.type === "http" || props.server.oauthResource ? "oauth" : "cli");
  const shouldShowLoginAction =
    isCodexProvider &&
    !props.isOverridden &&
    (props.serverStatus?.state === "login-required" ||
      loginStatusQuery.data?.status === "pending" ||
      loginStatusQuery.data?.status === "failed");
  const loginDisabledReason = !isCodexProvider
    ? null
    : props.projectId === null
      ? "Select a project to manage shared MCP login."
      : props.isOverridden
        ? props.overrideTargetEnabled === false
          ? "This common-scope entry is overridden by a disabled project-scoped server with the same name."
          : "This common-scope entry is overridden by a project-scoped server with the same name."
        : props.server.enabled === false
          ? "Enable this server before starting MCP login."
          : props.providerStatus?.support !== "supported"
            ? "Codex MCP login requires MCP control/status support."
            : null;

  const loginButton = (
    <Button
      size="xs"
      variant="outline"
      disabled={loginDisabledReason !== null || loginStatusQuery.data?.status === "pending"}
      onClick={() => {
        if (!props.projectId || loginDisabledReason !== null) {
          return;
        }
        setLoginError(null);
        void ensureNativeApi()
          .mcp.startLogin({
            provider: props.selectedProvider,
            projectId: props.projectId,
            serverName: props.name,
            ...(props.binaryPath ? { binaryPath: props.binaryPath } : {}),
            ...(props.homePath ? { homePath: props.homePath } : {}),
          })
          .then(async (result) => {
            if (result.authorizationUrl) {
              await ensureNativeApi().shell.openExternal(result.authorizationUrl);
            }
            await queryClient.invalidateQueries({ queryKey: mcpQueryKeys.all });
          })
          .catch((error) => {
            setLoginError(readErrorMessage(error, "Failed to start MCP login."));
          });
      }}
    >
      {loginStatusQuery.data?.status === "pending"
        ? loginModeHint === "oauth"
          ? "Connecting..."
          : "Logging in..."
        : loginModeHint === "oauth"
          ? "Connect"
          : "Login"}
    </Button>
  );

  return (
    <div className="space-y-2 rounded-lg border border-border bg-background px-3 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium text-foreground">{props.name}</p>
            <Badge variant="outline">{props.server.type}</Badge>
            {serverStatusBadge(props.selectedProvider, props.serverStatus, loginStatusQuery.data, {
              isOverridden: props.isOverridden,
            })}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {props.server.type === "stdio" ? props.server.command : props.server.url}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1">
            <span className="text-[11px] text-muted-foreground">Enabled</span>
            <Switch
              checked={props.server.enabled !== false}
              onCheckedChange={(checked) => props.onToggleEnabled(Boolean(checked))}
              aria-label={`Enable MCP server ${props.name}`}
            />
          </div>
          {isCodexProvider && shouldShowLoginAction ? (
            loginDisabledReason ? (
              <Tooltip>
                <TooltipTrigger render={loginButton} />
                <TooltipPopup side="top">{loginDisabledReason}</TooltipPopup>
              </Tooltip>
            ) : (
              loginButton
            )
          ) : null}
          <Button size="xs" variant="outline" onClick={props.onEdit}>
            Edit
          </Button>
          <Button size="xs" variant="outline" onClick={props.onRemove}>
            Remove
          </Button>
        </div>
      </div>
      {loginError ? <p className="text-xs text-destructive">{loginError}</p> : null}
      {loginStatusQuery.data?.error ? (
        <p className="text-xs text-destructive">{loginStatusQuery.data.error}</p>
      ) : null}
      {loginStatusQuery.data?.message ? (
        <p className="text-xs text-muted-foreground">{loginStatusQuery.data.message}</p>
      ) : null}
      {loginStatusQuery.error ? (
        <p className="text-xs text-destructive">
          {readErrorMessage(loginStatusQuery.error, "Failed to read MCP login status.")}
        </p>
      ) : null}
      {props.serverStatus?.message ? (
        <p className="text-xs text-muted-foreground">{props.serverStatus.message}</p>
      ) : null}
      {props.isOverridden ? (
        <p className="text-xs text-muted-foreground">
          {props.overrideTargetEnabled === false
            ? "This common-scope entry is overridden by the selected project, and the project-scoped server is currently disabled."
            : "This common-scope entry is overridden by the selected project. Live status and login actions apply to the project-scoped server instead."}
        </p>
      ) : null}
    </div>
  );
}

export function McpServersSettings(props: {
  readonly selectedProject: ProjectSummary | null;
  readonly hasProjects: boolean;
  readonly codexBinaryPath: string;
  readonly codexHomePath: string;
  readonly claudeBinaryPath: string;
}) {
  const queryClient = useQueryClient();
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: (error: Error) => {
      console.error(error);
    },
  });
  const [selectedScope, setSelectedScope] = useState<McpConfigScope>(
    props.selectedProject ? "project" : "common",
  );
  const [selectedProvider, setSelectedProvider] = useState<ProviderKind>("codex");
  const [editingServerName, setEditingServerName] = useState<string | null>(null);
  const [draft, setDraft] = useState<ServerDraft>(createEmptyDraft());
  const [formError, setFormError] = useState<string | null>(null);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [projectActionError, setProjectActionError] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);

  const selectedProject = props.selectedProject;
  const selectedProjectId = selectedProject?.id ?? null;
  const codexBinaryPath = trimToUndefined(props.codexBinaryPath);
  const codexHomePath = trimToUndefined(props.codexHomePath);
  const claudeBinaryPath = trimToUndefined(props.claudeBinaryPath);
  const selectedBinaryPath = selectedProvider === "codex" ? codexBinaryPath : claudeBinaryPath;
  const selectedHomePath = selectedProvider === "codex" ? codexHomePath : undefined;

  const commonConfigQuery = useQuery(mcpCommonConfigQueryOptions());
  const projectConfigQuery = useQuery(
    mcpProjectConfigQueryOptions({
      projectId: selectedProjectId,
      enabled: selectedProject !== null,
    }),
  );
  const effectiveConfigQuery = useQuery(
    mcpEffectiveConfigQueryOptions({
      projectId: selectedProjectId,
      enabled: selectedProject !== null,
    }),
  );
  const providerStatusQuery = useQuery(
    mcpProviderStatusQueryOptions({
      provider: selectedProvider,
      projectId: selectedProjectId,
      ...(selectedBinaryPath ? { binaryPath: selectedBinaryPath } : {}),
      ...(selectedHomePath ? { homePath: selectedHomePath } : {}),
      enabled: selectedProject !== null,
    }),
  );
  const serverStatusesQuery = useQuery(
    mcpServerStatusesQueryOptions({
      provider: selectedProvider,
      projectId: selectedProjectId,
      ...(selectedBinaryPath ? { binaryPath: selectedBinaryPath } : {}),
      ...(selectedHomePath ? { homePath: selectedHomePath } : {}),
      enabled: selectedProject !== null,
    }),
  );

  useEffect(() => {
    if (!selectedProjectId && selectedScope === "project") {
      setSelectedScope("common");
    }
  }, [selectedProjectId, selectedScope]);

  useEffect(() => {
    setEditingServerName(null);
    setDraft(createEmptyDraft());
    setFormError(null);
    setImportError(null);
    setProjectActionError(null);
    setIsAdvancedOpen(false);
  }, [selectedProjectId]);

  const activeConfig =
    selectedScope === "common" ? commonConfigQuery.data : projectConfigQuery.data;
  const activeServers = activeConfig?.servers ?? EMPTY_PROJECT_SERVERS;
  const orderedServers = useMemo(
    () =>
      (Object.entries(activeServers) as Array<[string, McpProjectServersConfig[string]]>).toSorted(
        ([leftName], [rightName]) => leftName.localeCompare(rightName),
      ),
    [activeServers],
  );
  const effectiveJson =
    selectedProject && effectiveConfigQuery.data
      ? formatMcpServersAsJson(effectiveConfigQuery.data.servers)
      : "";
  const serverStatusByName = useMemo(
    () =>
      new Map((serverStatusesQuery.data?.statuses ?? []).map((status) => [status.name, status])),
    [serverStatusesQuery.data],
  );
  const overriddenServerNames = useMemo(() => {
    if (selectedScope !== "common" || !selectedProjectId) {
      return new Set<string>();
    }
    return new Set(Object.keys(projectConfigQuery.data?.servers ?? EMPTY_PROJECT_SERVERS));
  }, [projectConfigQuery.data, selectedProjectId, selectedScope]);
  const overriddenServersByName = useMemo(() => {
    if (selectedScope !== "common" || !selectedProjectId) {
      return new Map<string, McpProjectServersConfig[string]>();
    }
    return new Map(Object.entries(projectConfigQuery.data?.servers ?? EMPTY_PROJECT_SERVERS));
  }, [projectConfigQuery.data, selectedProjectId, selectedScope]);

  useEffect(() => {
    if (selectedScope === "project" && !selectedProjectId) {
      setEditingServerName(null);
      setDraft(createEmptyDraft());
      setIsAdvancedOpen(false);
      return;
    }
    if (editingServerName && !activeServers[editingServerName]) {
      setEditingServerName(null);
      setDraft(createEmptyDraft());
      setIsAdvancedOpen(false);
    }
  }, [activeServers, editingServerName, selectedProjectId, selectedScope]);

  useEffect(
    () =>
      ensureNativeApi().mcp.onStatusUpdated(() => {
        void queryClient.invalidateQueries({ queryKey: mcpQueryKeys.all });
      }),
    [queryClient],
  );

  const persistScopeServers = async (
    nextServers: McpProjectServersConfig,
  ): Promise<McpCommonConfigResult | McpProjectConfigResult> => {
    setProjectActionError(null);
    setIsSavingConfig(true);
    try {
      if (selectedScope === "common") {
        const result = await ensureNativeApi().mcp.replaceCommonConfig({
          expectedVersion: commonConfigQuery.data?.version,
          servers: nextServers,
        });
        queryClient.setQueryData(mcpQueryKeys.commonConfig(), result);
        await queryClient.invalidateQueries({ queryKey: mcpQueryKeys.all });
        return result;
      }

      if (!selectedProject) {
        throw new Error("Select a project before editing project-scoped MCP servers.");
      }

      const result = await ensureNativeApi().mcp.replaceProjectConfig({
        projectId: selectedProject.id,
        expectedVersion: projectConfigQuery.data?.version,
        servers: nextServers,
      });
      queryClient.setQueryData(mcpQueryKeys.projectConfig(selectedProject.id), result);
      await queryClient.invalidateQueries({ queryKey: mcpQueryKeys.all });
      return result;
    } finally {
      setIsSavingConfig(false);
    }
  };

  const beginCreate = () => {
    setEditingServerName(null);
    setDraft(createEmptyDraft());
    setFormError(null);
    setProjectActionError(null);
    setIsAdvancedOpen(false);
  };

  const beginEdit = (name: string, server: McpProjectServersConfig[string]) => {
    setEditingServerName(name);
    setDraft(draftFromServer(name, server));
    setFormError(null);
    setProjectActionError(null);
    setIsAdvancedOpen(hasAdvancedFields(server));
  };

  const removeServer = (name: string) => {
    const nextServers = toWritableProjectServers(activeServers);
    delete nextServers[name];
    void persistScopeServers(normalizeMcpServersRecord(nextServers))
      .then(() => {
        if (editingServerName === name) {
          beginCreate();
        }
      })
      .catch((error) => {
        setProjectActionError(readErrorMessage(error, "Failed to remove MCP server."));
      });
  };

  const saveDraft = () => {
    try {
      const { name, server } = decodeDraftServer(draft);
      const nextServers = toWritableProjectServers(activeServers);
      if (
        editingServerName === null &&
        !nextServers[name] &&
        Object.keys(nextServers).length >= MAX_SERVER_COUNT
      ) {
        throw new Error(`You can save at most ${MAX_SERVER_COUNT} MCP servers per scope.`);
      }
      if (editingServerName && editingServerName !== name) {
        delete nextServers[editingServerName];
      }
      nextServers[name] = server;
      const normalized = normalizeMcpServersRecord(nextServers);
      if (!normalized[name]) {
        throw new Error("The MCP server configuration is invalid.");
      }

      setFormError(null);
      void persistScopeServers(normalized)
        .then((result) => {
          setEditingServerName(name);
          const savedServer = result.servers[name];
          setDraft(
            savedServer ? draftFromServer(name, savedServer) : draftFromServer(name, server),
          );
        })
        .catch((error) => {
          setFormError(readErrorMessage(error, "Failed to save MCP server."));
        });
    } catch (error) {
      setFormError(readErrorMessage(error, "Failed to save MCP server."));
    }
  };

  const importServers = () => {
    try {
      if (selectedScope === "project" && !selectedProject) {
        throw new Error("Select a project before importing project-scoped MCP servers.");
      }
      const imported = parseImportedServers(importText);
      if (Object.keys(imported).length === 0) {
        throw new Error("No importable MCP servers were found.");
      }

      const merged = normalizeMcpServersRecord({
        ...toWritableProjectServers(activeServers),
        ...imported,
      });
      if (Object.keys(merged).length > MAX_SERVER_COUNT) {
        throw new Error(`Import would exceed the ${MAX_SERVER_COUNT}-server scope limit.`);
      }

      setImportError(null);
      void persistScopeServers(merged)
        .then(() => {
          setImportText("");
        })
        .catch((error) => {
          setImportError(readErrorMessage(error, "Failed to import MCP servers."));
        });
    } catch (error) {
      setImportError(readErrorMessage(error, "Failed to import MCP servers."));
    }
  };

  const handleExportJson = () => {
    if (!effectiveJson || !selectedProject) {
      return;
    }
    const filenameBase =
      selectedProject.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "mcp-config";
    const blob = new Blob([effectiveJson], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${filenameBase}.json`;
    anchor.click();
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  };

  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-medium text-foreground">MCP servers</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Configure MCP in a shared common scope or a project scope. Project entries override
            common entries with the same name when the server resolves the effective config.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {providerStatusBadge(selectedProvider, providerStatusQuery.data, {
            isLoading: providerStatusQuery.isPending && !providerStatusQuery.data,
            isApplying,
          })}
          <Button
            size="xs"
            variant="outline"
            disabled={(selectedScope === "project" && !selectedProject) || isApplying}
            onClick={() => {
              if (selectedScope === "project" && !selectedProject) {
                return;
              }
              setProjectActionError(null);
              setIsApplying(true);
              void ensureNativeApi()
                .mcp.applyToLiveSessions({
                  scope: selectedScope,
                  ...(selectedScope === "project" && selectedProject?.id
                    ? { projectId: selectedProject.id }
                    : {}),
                  ...(codexBinaryPath ? { binaryPath: codexBinaryPath } : {}),
                  ...(codexHomePath ? { homePath: codexHomePath } : {}),
                })
                .then(async () => {
                  await queryClient.invalidateQueries({ queryKey: mcpQueryKeys.all });
                })
                .catch((error) => {
                  setProjectActionError(
                    readErrorMessage(error, "Failed to apply MCP configuration to live sessions."),
                  );
                })
                .finally(() => {
                  setIsApplying(false);
                });
            }}
          >
            Apply to live sessions
          </Button>
        </div>
      </div>

      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="space-y-2">
            <span className="text-xs font-medium text-foreground">Scope</span>
            <ToggleGroup
              variant="outline"
              size="xs"
              value={[selectedScope]}
              onValueChange={(value) => {
                const nextScope = value[0];
                if (nextScope !== "common" && nextScope !== "project") {
                  return;
                }
                if (nextScope === "project" && !selectedProject) {
                  return;
                }
                setSelectedScope(nextScope);
                setEditingServerName(null);
                setDraft(createEmptyDraft());
                setFormError(null);
                setImportError(null);
                setProjectActionError(null);
                setIsAdvancedOpen(false);
              }}
            >
              <Toggle value="project" disabled={!selectedProject}>
                Project
              </Toggle>
              <Toggle value="common">Common</Toggle>
            </ToggleGroup>
          </label>

          <label className="space-y-2">
            <span className="text-xs font-medium text-foreground">Provider</span>
            <ToggleGroup
              variant="outline"
              size="xs"
              value={[selectedProvider]}
              onValueChange={(value) => {
                const nextProvider = value[0];
                if (nextProvider !== "codex" && nextProvider !== "claudeAgent") {
                  return;
                }
                setSelectedProvider(nextProvider);
                setProjectActionError(null);
              }}
            >
              <Toggle value="codex">Codex</Toggle>
              <Toggle value="claudeAgent">Claude</Toggle>
            </ToggleGroup>
          </label>

          {props.hasProjects ? (
            <div className="space-y-2">
              <span className="text-xs font-medium text-foreground">Selected project</span>
              <div className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground">
                {selectedProject?.name ?? "No project selected"}
              </div>
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-border bg-background px-3 py-2 text-xs text-muted-foreground">
              No projects yet. You can still edit common MCP configuration now.
            </p>
          )}
        </div>

        <p className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
          Edit the shared MCP config once here. Provider switching only changes the live
          status/login pane, not the stored config.
        </p>

        {selectedProject === null ? (
          <p className="rounded-lg border border-dashed border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            Select a project to inspect provider-specific live status and the effective merged JSON.
          </p>
        ) : null}

        {providerStatusQuery.data?.supportMessage ? (
          <p className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            {providerStatusQuery.data.supportMessage}
          </p>
        ) : null}
        {selectedProvider === "claudeAgent" ? (
          <p className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            Claude uses the same shared MCP config. Per-server Claude readiness is not surfaced here
            yet. If Claude shows <strong>Login required</strong>, run <code>claude auth login</code>{" "}
            in a terminal and then refresh this page.
          </p>
        ) : null}
        {(selectedScope === "common" ? commonConfigQuery.error : projectConfigQuery.error) ? (
          <p className="text-xs text-destructive">
            {readErrorMessage(
              selectedScope === "common" ? commonConfigQuery.error : projectConfigQuery.error,
              `Failed to load MCP ${selectedScope} configuration.`,
            )}
          </p>
        ) : null}
        {providerStatusQuery.error ? (
          <p className="text-xs text-destructive">
            {readErrorMessage(providerStatusQuery.error, "Failed to load MCP provider status.")}
          </p>
        ) : null}
        {serverStatusesQuery.error ? (
          <p className="text-xs text-destructive">
            {readErrorMessage(serverStatusesQuery.error, "Failed to load MCP server statuses.")}
          </p>
        ) : null}
        {effectiveConfigQuery.error ? (
          <p className="text-xs text-destructive">
            {readErrorMessage(
              effectiveConfigQuery.error,
              "Failed to load effective MCP configuration.",
            )}
          </p>
        ) : null}
        {projectActionError ? (
          <p className="text-xs text-destructive">{projectActionError}</p>
        ) : null}

        {selectedScope === "common" || selectedProject ? (
          <>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-foreground">
                  {selectedScope === "common" ? "Common servers" : "Project servers"} (
                  {orderedServers.length}/{MAX_SERVER_COUNT})
                </p>
                <Button size="xs" variant="outline" onClick={beginCreate} disabled={isSavingConfig}>
                  Add server
                </Button>
              </div>

              {(
                selectedScope === "common"
                  ? commonConfigQuery.isPending && !commonConfigQuery.data
                  : projectConfigQuery.isPending && !projectConfigQuery.data
              ) ? (
                <p className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                  Loading MCP servers for this scope...
                </p>
              ) : orderedServers.length > 0 ? (
                <div className="space-y-3">
                  {orderedServers.map(([name, server]) => (
                    <McpServerRow
                      key={name}
                      selectedProvider={selectedProvider}
                      projectId={selectedProject?.id ?? null}
                      binaryPath={selectedBinaryPath}
                      homePath={selectedHomePath}
                      name={name}
                      server={server}
                      providerStatus={providerStatusQuery.data}
                      serverStatus={serverStatusByName.get(name)}
                      isOverridden={selectedScope === "common" && overriddenServerNames.has(name)}
                      overrideTargetEnabled={overriddenServersByName.get(name)?.enabled !== false}
                      onToggleEnabled={(checked) => {
                        const nextServers = toWritableProjectServers(activeServers);
                        const currentServer = nextServers[name];
                        if (!currentServer) {
                          return;
                        }
                        nextServers[name] = { ...currentServer, enabled: checked };
                        void persistScopeServers(normalizeMcpServersRecord(nextServers))
                          .then(() => {
                            if (editingServerName === name) {
                              setDraft((current) => ({ ...current, enabled: checked }));
                            }
                          })
                          .catch((error) => {
                            setProjectActionError(
                              readErrorMessage(error, "Failed to update MCP server."),
                            );
                          });
                      }}
                      onEdit={() => beginEdit(name, server)}
                      onRemove={() => removeServer(name)}
                    />
                  ))}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                  No MCP servers configured for this scope.
                </p>
              )}
            </div>

            <div className="space-y-3 rounded-lg border border-border bg-background p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {editingServerName ? `Edit ${editingServerName}` : "Add MCP server"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Shared fields apply to all providers. Codex-only options stay saved in either
                    scope but Claude ignores them today.
                  </p>
                </div>
                {editingServerName ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={beginCreate}
                    disabled={isSavingConfig}
                  >
                    New server
                  </Button>
                ) : null}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-xs font-medium text-foreground">Name</span>
                  <Input
                    value={draft.name}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, name: event.target.value }));
                      setFormError(null);
                    }}
                    placeholder="filesystem"
                  />
                </label>

                <label className="space-y-1">
                  <span className="text-xs font-medium text-foreground">Transport</span>
                  <Select
                    value={draft.type}
                    onValueChange={(value) => {
                      if (value !== "stdio" && value !== "sse" && value !== "http") {
                        return;
                      }
                      setDraft((current) => ({ ...current, type: value }));
                      setFormError(null);
                    }}
                  >
                    <SelectTrigger aria-label="MCP transport type">
                      <SelectValue>{draft.type}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="stdio">stdio</SelectItem>
                      <SelectItem value="sse">sse</SelectItem>
                      <SelectItem value="http">http</SelectItem>
                    </SelectPopup>
                  </Select>
                </label>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border/70 bg-card/40 px-3 py-3">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-foreground">Enabled</p>
                  <p className="text-xs text-muted-foreground">
                    Disabled servers stay saved but are excluded from provider startup.
                  </p>
                </div>
                <Switch
                  checked={draft.enabled}
                  onCheckedChange={(checked) => {
                    setDraft((current) => ({ ...current, enabled: Boolean(checked) }));
                    setFormError(null);
                  }}
                  aria-label="Enable MCP server"
                />
              </div>

              {draft.type === "stdio" ? (
                <div className="space-y-3">
                  <label className="space-y-1">
                    <span className="text-xs font-medium text-foreground">Command</span>
                    <Input
                      value={draft.command}
                      onChange={(event) => {
                        setDraft((current) => ({ ...current, command: event.target.value }));
                        setFormError(null);
                      }}
                      placeholder="npx"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs font-medium text-foreground">Args</span>
                    <Textarea
                      value={draft.args}
                      onChange={(event) => {
                        setDraft((current) => ({ ...current, args: event.target.value }));
                        setFormError(null);
                      }}
                      className="min-h-20"
                      placeholder="@modelcontextprotocol/server-filesystem&#10;/path/to/project"
                    />
                    <span className="text-xs text-muted-foreground">One argument per line.</span>
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1">
                      <span className="text-xs font-medium text-foreground">Environment</span>
                      <Textarea
                        value={draft.env}
                        onChange={(event) => {
                          setDraft((current) => ({ ...current, env: event.target.value }));
                          setFormError(null);
                        }}
                        className="min-h-24"
                        placeholder="API_KEY=secret"
                      />
                      <span className="text-xs text-muted-foreground">Use KEY=value per line.</span>
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs font-medium text-foreground">Working directory</span>
                      <Input
                        value={draft.cwd}
                        onChange={(event) => {
                          setDraft((current) => ({ ...current, cwd: event.target.value }));
                          setFormError(null);
                        }}
                        placeholder="/path/to/project"
                      />
                    </label>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <label className="space-y-1">
                    <span className="text-xs font-medium text-foreground">URL</span>
                    <Input
                      value={draft.url}
                      onChange={(event) => {
                        setDraft((current) => ({ ...current, url: event.target.value }));
                        setFormError(null);
                      }}
                      placeholder="https://example.com/mcp"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs font-medium text-foreground">Headers</span>
                    <Textarea
                      value={draft.headers}
                      onChange={(event) => {
                        setDraft((current) => ({ ...current, headers: event.target.value }));
                        setFormError(null);
                      }}
                      className="min-h-24"
                      placeholder="Authorization=Bearer ..."
                    />
                    <span className="text-xs text-muted-foreground">Use KEY=value per line.</span>
                  </label>
                </div>
              )}

              <Collapsible open={isAdvancedOpen} onOpenChange={setIsAdvancedOpen}>
                <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg border border-border px-3 py-2 text-left">
                  <span>
                    <span className="block text-xs font-medium text-foreground">
                      Codex-only options
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Optional OAuth, timeout, tool-filter, and bearer-token settings.
                    </span>
                  </span>
                  <Badge variant="outline">{isAdvancedOpen ? "Hide" : "Show"}</Badge>
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <div className="mt-3 space-y-3 rounded-lg border border-border/70 bg-card/40 p-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="space-y-1">
                        <span className="text-xs font-medium text-foreground">
                          Bearer token env var
                        </span>
                        <Input
                          value={draft.bearerTokenEnvVar}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              bearerTokenEnvVar: event.target.value,
                            }))
                          }
                          placeholder="MCP_AUTH_TOKEN"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-xs font-medium text-foreground">OAuth resource</span>
                        <Input
                          value={draft.oauthResource}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              oauthResource: event.target.value,
                            }))
                          }
                          placeholder="https://example.com"
                        />
                      </label>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="space-y-1">
                        <span className="text-xs font-medium text-foreground">
                          Startup timeout (sec)
                        </span>
                        <Input
                          value={draft.startupTimeoutSec}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              startupTimeoutSec: event.target.value,
                            }))
                          }
                          placeholder="30"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-xs font-medium text-foreground">
                          Tool timeout (sec)
                        </span>
                        <Input
                          value={draft.toolTimeoutSec}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              toolTimeoutSec: event.target.value,
                            }))
                          }
                          placeholder="60"
                        />
                      </label>
                    </div>

                    <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                      <div>
                        <p className="text-xs font-medium text-foreground">Parallel tool calls</p>
                        <p className="text-xs text-muted-foreground">
                          Declare that this server supports concurrent tool execution.
                        </p>
                      </div>
                      <Switch
                        checked={draft.supportsParallelToolCalls}
                        onCheckedChange={(checked) =>
                          setDraft((current) => ({
                            ...current,
                            supportsParallelToolCalls: Boolean(checked),
                          }))
                        }
                        aria-label="Supports parallel tool calls"
                      />
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="space-y-1">
                        <span className="text-xs font-medium text-foreground">Enabled tools</span>
                        <Textarea
                          value={draft.enabledTools}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              enabledTools: event.target.value,
                            }))
                          }
                          className="min-h-20"
                          placeholder="search&#10;read_file"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-xs font-medium text-foreground">Disabled tools</span>
                        <Textarea
                          value={draft.disabledTools}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              disabledTools: event.target.value,
                            }))
                          }
                          className="min-h-20"
                          placeholder="dangerous_tool"
                        />
                      </label>
                    </div>

                    <label className="space-y-1">
                      <span className="text-xs font-medium text-foreground">Scopes</span>
                      <Textarea
                        value={draft.scopes}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, scopes: event.target.value }))
                        }
                        className="min-h-20"
                        placeholder="read&#10;write"
                      />
                    </label>
                  </div>
                </CollapsiblePanel>
              </Collapsible>

              <div className="flex items-center justify-between gap-3">
                {formError ? (
                  <p className="text-xs text-destructive">{formError}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Names are trimmed and capped at 128 characters. Saving replaces the full
                    configuration for the selected scope.
                  </p>
                )}
                <div className="flex items-center gap-2">
                  {editingServerName ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={beginCreate}
                      disabled={isSavingConfig}
                    >
                      Cancel
                    </Button>
                  ) : null}
                  <Button size="sm" onClick={saveDraft} disabled={isSavingConfig}>
                    {editingServerName ? "Save changes" : "Add server"}
                  </Button>
                </div>
              </div>
            </div>

            <div className="space-y-3 rounded-lg border border-border bg-background p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">Effective JSON export</p>
                  <p className="text-xs text-muted-foreground">
                    Export the canonical merged JSON for the selected project in{" "}
                    <code>{'{ "mcpServers": { ... } }'}</code> format.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!effectiveJson}
                    onClick={() => {
                      if (!effectiveJson) {
                        return;
                      }
                      copyToClipboard(effectiveJson, undefined);
                    }}
                  >
                    {isCopied ? "Copied" : "Copy JSON"}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!effectiveJson || !selectedProject}
                    onClick={handleExportJson}
                  >
                    Export JSON
                  </Button>
                </div>
              </div>
              {selectedProject && effectiveJson ? (
                <Textarea readOnly value={effectiveJson} className="min-h-44 font-mono text-xs" />
              ) : (
                <p className="rounded-lg border border-dashed border-border bg-card/40 px-3 py-4 text-xs text-muted-foreground">
                  Select a project to resolve and export the effective merged MCP configuration.
                </p>
              )}
            </div>

            <div className="space-y-3 rounded-lg border border-border bg-background p-4">
              <div>
                <p className="text-sm font-medium text-foreground">Import configuration</p>
                <p className="text-xs text-muted-foreground">
                  Paste Claude JSON or Codex <code>config.toml</code> MCP sections into the selected
                  scope. SDK entries are skipped. Codex TOML import supports basic sectioned
                  key/value data only.
                </p>
              </div>
              <Textarea
                value={importText}
                onChange={(event) => {
                  setImportText(event.target.value);
                  setImportError(null);
                }}
                className="min-h-36 font-mono text-xs"
                placeholder='{"mcpServers":{"filesystem":{"type":"stdio","command":"npx","args":["@modelcontextprotocol/server-filesystem"]}}}'
              />
              <div className="flex items-center justify-between gap-3">
                {importError ? (
                  <p className="text-xs text-destructive">{importError}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Imported servers replace matching names and use the same validation as manual
                    edits. Multi-line TOML strings, inline tables, and arrays of tables are ignored.
                  </p>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={importServers}
                  disabled={!importText.trim() || isSavingConfig}
                >
                  Import
                </Button>
              </div>
            </div>
          </>
        ) : (
          <p className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
            Select a project to edit project-scoped MCP servers.
          </p>
        )}
      </div>
    </section>
  );
}
