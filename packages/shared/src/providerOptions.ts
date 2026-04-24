import type {
  McpProjectServersConfig,
  McpServerDefinition,
  ProviderKind,
  ProviderModelOptions,
  ProviderStartOptions,
} from "@t3tools/contracts";
import { canonicalizeClaudeLaunchArgs } from "./cliArgs";
import {
  normalizeOptionalString,
  normalizeOptionalStringArray,
  normalizeStringRecord,
} from "./mcpNormalization";

const MAX_MCP_SERVER_COUNT = 16;
const MAX_MCP_SERVER_NAME_LENGTH = 128;

function normalizeNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function normalizeMcpServerName(name: string): string | undefined {
  const normalized = normalizeOptionalString(name);
  if (!normalized || normalized.length > MAX_MCP_SERVER_NAME_LENGTH) {
    return undefined;
  }
  return normalized;
}

function normalizeMcpServerDefinition(
  server: McpServerDefinition | null | undefined,
): McpServerDefinition | undefined {
  if (!server) {
    return undefined;
  }

  const common = {
    ...(typeof server.enabled === "boolean" ? { enabled: server.enabled } : {}),
    ...(normalizeOptionalStringArray(server.enabledTools)
      ? { enabledTools: normalizeOptionalStringArray(server.enabledTools)! }
      : {}),
    ...(normalizeOptionalStringArray(server.disabledTools)
      ? { disabledTools: normalizeOptionalStringArray(server.disabledTools)! }
      : {}),
    ...(normalizeOptionalStringArray(server.scopes)
      ? { scopes: normalizeOptionalStringArray(server.scopes)! }
      : {}),
    ...(normalizeOptionalString(server.bearerTokenEnvVar)
      ? { bearerTokenEnvVar: normalizeOptionalString(server.bearerTokenEnvVar)! }
      : {}),
    ...(typeof server.supportsParallelToolCalls === "boolean"
      ? { supportsParallelToolCalls: server.supportsParallelToolCalls }
      : {}),
    ...(normalizeNonNegativeInt(server.startupTimeoutSec) !== undefined
      ? { startupTimeoutSec: normalizeNonNegativeInt(server.startupTimeoutSec)! }
      : {}),
    ...(normalizeNonNegativeInt(server.toolTimeoutSec) !== undefined
      ? { toolTimeoutSec: normalizeNonNegativeInt(server.toolTimeoutSec)! }
      : {}),
    ...(normalizeOptionalString(server.oauthResource)
      ? { oauthResource: normalizeOptionalString(server.oauthResource)! }
      : {}),
  } satisfies Partial<McpServerDefinition>;

  if (server.type === "stdio") {
    const command = normalizeOptionalString(server.command);
    if (!command) {
      return undefined;
    }
    return {
      type: "stdio",
      command,
      ...(normalizeOptionalStringArray(server.args)
        ? { args: normalizeOptionalStringArray(server.args)! }
        : {}),
      ...(normalizeStringRecord(server.env) ? { env: normalizeStringRecord(server.env)! } : {}),
      ...(normalizeOptionalString(server.cwd) ? { cwd: normalizeOptionalString(server.cwd)! } : {}),
      ...common,
    };
  }

  if (server.type === "sse" || server.type === "http") {
    const url = normalizeOptionalString(server.url);
    if (!url) {
      return undefined;
    }
    return {
      type: server.type,
      url,
      ...(normalizeStringRecord(server.headers)
        ? { headers: normalizeStringRecord(server.headers)! }
        : {}),
      ...common,
    };
  }

  return undefined;
}

function normalizeMcpServers(
  servers: McpProjectServersConfig | null | undefined,
): McpProjectServersConfig | undefined {
  if (!servers) {
    return undefined;
  }

  const normalized = Object.fromEntries(
    Object.entries(servers)
      .slice(0, MAX_MCP_SERVER_COUNT)
      .map(([name, server]) => {
        const normalizedName = normalizeMcpServerName(name);
        const normalizedServer = normalizeMcpServerDefinition(server);
        if (!normalizedName || !normalizedServer) {
          return null;
        }
        return [normalizedName, normalizedServer] as const;
      })
      .filter((entry): entry is readonly [string, McpServerDefinition] => entry !== null),
  );

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function arePlainObjectEntriesEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftKeys = Object.keys(left).toSorted();
  const rightKeys = Object.keys(right).toSorted();
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  for (let index = 0; index < leftKeys.length; index += 1) {
    const leftKey = leftKeys[index];
    if (!leftKey || leftKey !== rightKeys[index]) {
      return false;
    }
    if (!areUnknownValuesEqual(left[leftKey], right[leftKey])) {
      return false;
    }
  }

  return true;
}

function areUnknownValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (left === null || right === null) {
    return left === right;
  }
  if (typeof left !== typeof right) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => areUnknownValuesEqual(value, right[index]));
  }
  if (typeof left === "object" && typeof right === "object") {
    return arePlainObjectEntriesEqual(
      left as Record<string, unknown>,
      right as Record<string, unknown>,
    );
  }
  return false;
}

export function areProviderModelOptionsEqual(
  left: ProviderModelOptions | null | undefined,
  right: ProviderModelOptions | null | undefined,
): boolean {
  return areUnknownValuesEqual(left ?? null, right ?? null);
}

export function areProviderStartOptionsEqual(
  left: ProviderStartOptions | null | undefined,
  right: ProviderStartOptions | null | undefined,
): boolean {
  return areUnknownValuesEqual(left ?? null, right ?? null);
}

export function getProviderSessionRestartOptions(
  provider: ProviderKind,
  providerOptions?: ProviderStartOptions,
): ProviderStartOptions | undefined {
  const normalized = normalizeProviderStartOptions(provider, providerOptions);
  if (!normalized) {
    return undefined;
  }

  switch (provider) {
    case "codex":
      return normalized.mcpServers ? { mcpServers: normalized.mcpServers } : undefined;
    case "claudeAgent":
      return normalized;
  }
}

export function normalizeProviderStartOptions(
  provider: ProviderKind,
  providerOptions?: ProviderStartOptions,
): ProviderStartOptions | undefined {
  const normalizedMcpServers = normalizeMcpServers(providerOptions?.mcpServers);
  const hasMcpServers = normalizedMcpServers !== undefined;

  switch (provider) {
    case "codex": {
      const binaryPath = normalizeOptionalString(providerOptions?.codex?.binaryPath);
      const homePath = normalizeOptionalString(providerOptions?.codex?.homePath);

      if (!binaryPath && !homePath && !hasMcpServers) {
        return undefined;
      }

      return {
        ...(hasMcpServers ? { mcpServers: normalizedMcpServers } : {}),
        ...(binaryPath || homePath
          ? {
              codex: {
                ...(binaryPath ? { binaryPath } : {}),
                ...(homePath ? { homePath } : {}),
              },
            }
          : {}),
      };
    }
    case "claudeAgent": {
      const binaryPath = normalizeOptionalString(providerOptions?.claudeAgent?.binaryPath);
      const permissionMode = normalizeOptionalString(providerOptions?.claudeAgent?.permissionMode);
      const maxThinkingTokens =
        typeof providerOptions?.claudeAgent?.maxThinkingTokens === "number" &&
        Number.isInteger(providerOptions.claudeAgent.maxThinkingTokens) &&
        providerOptions.claudeAgent.maxThinkingTokens >= 0
          ? providerOptions.claudeAgent.maxThinkingTokens
          : undefined;
      const subagentsEnabled =
        typeof providerOptions?.claudeAgent?.subagentsEnabled === "boolean"
          ? providerOptions.claudeAgent.subagentsEnabled
          : undefined;
      const subagentModel = normalizeOptionalString(providerOptions?.claudeAgent?.subagentModel);
      const launchArgs = canonicalizeClaudeLaunchArgs(providerOptions?.claudeAgent?.launchArgs);

      if (
        !binaryPath &&
        !permissionMode &&
        maxThinkingTokens === undefined &&
        subagentsEnabled === undefined &&
        !subagentModel &&
        !launchArgs &&
        !hasMcpServers
      ) {
        return undefined;
      }

      return {
        ...(hasMcpServers ? { mcpServers: normalizedMcpServers } : {}),
        ...(binaryPath ||
        permissionMode ||
        maxThinkingTokens !== undefined ||
        subagentsEnabled !== undefined ||
        subagentModel ||
        launchArgs
          ? {
              claudeAgent: {
                ...(binaryPath ? { binaryPath } : {}),
                ...(permissionMode ? { permissionMode } : {}),
                ...(maxThinkingTokens !== undefined ? { maxThinkingTokens } : {}),
                ...(subagentsEnabled !== undefined ? { subagentsEnabled } : {}),
                ...(subagentModel ? { subagentModel } : {}),
                ...(launchArgs ? { launchArgs } : {}),
              },
            }
          : {}),
      };
    }
  }
}

export function readCodexEnvironmentOptions(providerOptions?: ProviderStartOptions): {
  readonly binaryPath?: string;
  readonly homePath?: string;
} {
  const normalized = normalizeProviderStartOptions("codex", providerOptions);
  return {
    ...(normalized?.codex?.binaryPath ? { binaryPath: normalized.codex.binaryPath } : {}),
    ...(normalized?.codex?.homePath ? { homePath: normalized.codex.homePath } : {}),
  };
}

export function getProviderEnvironmentKey(
  provider: ProviderKind,
  providerOptions?: ProviderStartOptions,
): string {
  const normalized = normalizeProviderStartOptions(provider, providerOptions);

  switch (provider) {
    case "codex":
      return `codex|binary:${normalized?.codex?.binaryPath ?? ""}|home:${normalized?.codex?.homePath ?? ""}`;
    case "claudeAgent": {
      const launchArgs = normalized?.claudeAgent?.launchArgs;
      const launchArgsKey = launchArgs
        ? Object.keys(launchArgs)
            .toSorted()
            .map((key) => {
              const value = launchArgs[key];
              return `${key}=${value === null ? "__FLAG__" : value}`;
            })
            .join(",")
        : "";
      return `claudeAgent|binary:${normalized?.claudeAgent?.binaryPath ?? ""}|permission:${normalized?.claudeAgent?.permissionMode ?? ""}|maxThinkingTokens:${normalized?.claudeAgent?.maxThinkingTokens ?? ""}|subagentsEnabled:${normalized?.claudeAgent?.subagentsEnabled ?? ""}|subagentModel:${normalized?.claudeAgent?.subagentModel ?? ""}|launchArgs:${launchArgsKey}`;
    }
  }
}
