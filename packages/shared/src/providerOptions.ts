import { normalizeServerName } from "./mcpServerName";
import { McpProjectServersConfig as McpServersSchema } from "@t3tools/contracts";
import { Schema } from "effect";
import type {
  ClaudeThinkingOption,
  McpProjectServersConfig,
  ProviderKind,
  ProviderModelOptions,
  ProviderStartOptions,
} from "@t3tools/contracts";
import { normalizeOptionalString } from "./mcpNormalization";
import { canonicalizeClaudeLaunchArgs } from "./cliArgs";
function normalizeThinkingDisplay(value: unknown): "summarized" | "omitted" | undefined {
  return value === "summarized" || value === "omitted" ? value : undefined;
}

/** Validate a typed Claude thinking config; malformed values are dropped. */
export function normalizeClaudeThinkingOption(value: unknown): ClaudeThinkingOption | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const display = normalizeThinkingDisplay(record.display);
  switch (record.type) {
    case "disabled":
      return { type: "disabled" };
    case "adaptive":
      return { type: "adaptive", ...(display ? { display } : {}) };
    case "enabled": {
      const budget = record.budgetTokens;
      if (budget !== undefined && !(typeof budget === "number" && Number.isInteger(budget))) {
        return undefined;
      }
      if (typeof budget === "number" && budget < 1) return undefined;
      return {
        type: "enabled",
        ...(typeof budget === "number" ? { budgetTokens: budget } : {}),
        ...(display ? { display } : {}),
      };
    }
    default:
      return undefined;
  }
}

/**
 * Deterministic launch-identity component for typed thinking. Only appended to
 * the environment key when typed thinking is set, so keys (and fingerprints)
 * of sessions using only the legacy `maxThinkingTokens` never change.
 */
export function claudeThinkingEnvironmentKeyComponent(
  thinking: ClaudeThinkingOption | undefined,
): string {
  if (!thinking) return "";
  switch (thinking.type) {
    case "disabled":
      return "|thinking:disabled";
    case "adaptive":
      return `|thinking:adaptive:${thinking.display ?? ""}`;
    case "enabled":
      return `|thinking:enabled:${thinking.budgetTokens ?? ""}:${thinking.display ?? ""}`;
  }
}

function normalizeMcpServers(
  servers: McpProjectServersConfig | null | undefined,
): McpProjectServersConfig | undefined {
  if (!servers || Object.keys(servers).length === 0) return undefined;
  const result = Schema.decodeUnknownExit(McpServersSchema)(servers);
  const decoded = result._tag === "Success" ? result.value : servers;
  const entries = Object.entries(decoded).map(
    ([name, server]) => [normalizeServerName(name) ?? name, server] as const,
  );
  // Preserve legacy aliases when trimming would otherwise overwrite an entry.
  return new Set(entries.map(([name]) => name)).size === entries.length
    ? Object.fromEntries(entries)
    : decoded;
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
  options?: { readonly ignoreMcpServers?: boolean },
): ProviderStartOptions | undefined {
  const normalized = normalizeProviderStartOptions(provider, providerOptions);
  if (!normalized) {
    return undefined;
  }

  switch (provider) {
    case "codex":
      return !options?.ignoreMcpServers && normalized.mcpServers
        ? { mcpServers: normalized.mcpServers }
        : undefined;
    case "claudeAgent": {
      const claudeAgent = normalized.claudeAgent
        ? {
            ...normalized.claudeAgent,
            ...(normalized.claudeAgent.subagentsEnabled === true
              ? { subagentsEnabled: undefined }
              : {}),
            ...(normalized.claudeAgent.subagentModel === "inherit"
              ? { subagentModel: undefined }
              : {}),
          }
        : undefined;
      const compactClaudeAgent = claudeAgent
        ? Object.fromEntries(Object.entries(claudeAgent).filter(([, value]) => value !== undefined))
        : undefined;
      const result: ProviderStartOptions = {
        ...(!options?.ignoreMcpServers && normalized.mcpServers
          ? { mcpServers: normalized.mcpServers }
          : {}),
        ...(compactClaudeAgent && Object.keys(compactClaudeAgent).length > 0
          ? { claudeAgent: compactClaudeAgent }
          : {}),
      };
      return Object.keys(result).length > 0 ? result : undefined;
    }
    case "cursor":
    case "opencode":
    case "grok": {
      if (!options?.ignoreMcpServers) {
        return normalized;
      }
      const { mcpServers: _ignoredMcpServers, ...rest } = normalized;
      return Object.keys(rest).length > 0 ? rest : undefined;
    }
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
      const launchArgs = providerOptions?.codex?.launchArgs
        ?.map(normalizeOptionalString)
        .filter((value): value is string => value !== undefined);

      if (!binaryPath && !homePath && !launchArgs?.length && !hasMcpServers) {
        return undefined;
      }

      return {
        ...(hasMcpServers ? { mcpServers: normalizedMcpServers } : {}),
        ...(binaryPath || homePath || launchArgs?.length
          ? {
              codex: {
                ...(binaryPath ? { binaryPath } : {}),
                ...(homePath ? { homePath } : {}),
                ...(launchArgs?.length ? { launchArgs } : {}),
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
      const promptSuggestions = providerOptions?.claudeAgent?.promptSuggestions;
      const enableFileCheckpointing = providerOptions?.claudeAgent?.enableFileCheckpointing;
      const nativeCompaction = providerOptions?.claudeAgent?.nativeCompaction;
      const thinking = normalizeClaudeThinkingOption(providerOptions?.claudeAgent?.thinking);
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
        thinking === undefined &&
        promptSuggestions === undefined &&
        enableFileCheckpointing === undefined &&
        nativeCompaction === undefined &&
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
        thinking !== undefined ||
        promptSuggestions !== undefined ||
        enableFileCheckpointing !== undefined ||
        nativeCompaction !== undefined ||
        subagentsEnabled !== undefined ||
        subagentModel ||
        launchArgs
          ? {
              claudeAgent: {
                ...(promptSuggestions !== undefined ? { promptSuggestions } : {}),
                ...(enableFileCheckpointing !== undefined ? { enableFileCheckpointing } : {}),
                ...(nativeCompaction !== undefined ? { nativeCompaction } : {}),
                ...(binaryPath ? { binaryPath } : {}),
                ...(permissionMode ? { permissionMode } : {}),
                ...(maxThinkingTokens !== undefined ? { maxThinkingTokens } : {}),
                ...(thinking !== undefined ? { thinking } : {}),
                ...(subagentsEnabled !== undefined ? { subagentsEnabled } : {}),
                ...(subagentModel ? { subagentModel } : {}),
                ...(launchArgs ? { launchArgs } : {}),
              },
            }
          : {}),
      };
    }
    case "cursor": {
      const binaryPath = normalizeOptionalString(providerOptions?.cursor?.binaryPath);
      const apiEndpoint = normalizeOptionalString(providerOptions?.cursor?.apiEndpoint);

      if (!binaryPath && !apiEndpoint && !hasMcpServers) {
        return undefined;
      }

      return {
        ...(hasMcpServers ? { mcpServers: normalizedMcpServers } : {}),
        ...(binaryPath || apiEndpoint
          ? {
              cursor: {
                ...(binaryPath ? { binaryPath } : {}),
                ...(apiEndpoint ? { apiEndpoint } : {}),
              },
            }
          : {}),
      };
    }
    case "opencode": {
      const binaryPath = normalizeOptionalString(providerOptions?.opencode?.binaryPath);
      const serverUrl = normalizeOptionalString(providerOptions?.opencode?.serverUrl);
      const serverPassword = normalizeOptionalString(providerOptions?.opencode?.serverPassword);

      if (!binaryPath && !serverUrl && !serverPassword && !hasMcpServers) {
        return undefined;
      }

      return {
        ...(hasMcpServers ? { mcpServers: normalizedMcpServers } : {}),
        ...(binaryPath || serverUrl || serverPassword
          ? {
              opencode: {
                ...(binaryPath ? { binaryPath } : {}),
                ...(serverUrl ? { serverUrl } : {}),
                ...(serverPassword ? { serverPassword } : {}),
              },
            }
          : {}),
      };
    }
    case "grok": {
      const binaryPath = normalizeOptionalString(providerOptions?.grok?.binaryPath);

      if (!binaryPath && !hasMcpServers) {
        return undefined;
      }

      return {
        ...(hasMcpServers ? { mcpServers: normalizedMcpServers } : {}),
        ...(binaryPath
          ? {
              grok: {
                binaryPath,
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
  readonly launchArgs?: ReadonlyArray<string>;
} {
  const normalized = normalizeProviderStartOptions("codex", providerOptions);
  return {
    ...(normalized?.codex?.binaryPath ? { binaryPath: normalized.codex.binaryPath } : {}),
    ...(normalized?.codex?.homePath ? { homePath: normalized.codex.homePath } : {}),
    ...(normalized?.codex?.launchArgs ? { launchArgs: normalized.codex.launchArgs } : {}),
  };
}

export function getProviderEnvironmentKey(
  provider: ProviderKind,
  providerOptions?: ProviderStartOptions,
): string {
  const normalized = normalizeProviderStartOptions(provider, providerOptions);

  switch (provider) {
    case "codex":
      return `codex|binary:${normalized?.codex?.binaryPath ?? ""}|home:${normalized?.codex?.homePath ?? ""}|launchArgs:${JSON.stringify(normalized?.codex?.launchArgs ?? [])}`;
    case "claudeAgent": {
      const subagentsEnabled =
        normalized?.claudeAgent?.subagentsEnabled === true
          ? undefined
          : normalized?.claudeAgent?.subagentsEnabled;
      const subagentModel =
        normalized?.claudeAgent?.subagentModel === "inherit"
          ? undefined
          : normalized?.claudeAgent?.subagentModel;
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
      return `claudeAgent|binary:${normalized?.claudeAgent?.binaryPath ?? ""}|permission:${normalized?.claudeAgent?.permissionMode ?? ""}|maxThinkingTokens:${normalized?.claudeAgent?.maxThinkingTokens ?? ""}|subagentsEnabled:${subagentsEnabled ?? ""}|subagentModel:${subagentModel ?? ""}|launchArgs:${launchArgsKey}${claudeThinkingEnvironmentKeyComponent(normalized?.claudeAgent?.thinking)}${normalized?.claudeAgent?.promptSuggestions === true ? "|promptSuggestions:true" : ""}${normalized?.claudeAgent?.enableFileCheckpointing !== undefined ? `|fileCheckpointing:${normalized.claudeAgent.enableFileCheckpointing}` : ""}`;
    }
    case "cursor":
      return `cursor|binary:${normalized?.cursor?.binaryPath ?? ""}|apiEndpoint:${normalized?.cursor?.apiEndpoint ?? ""}`;
    case "opencode":
      return `opencode|binary:${normalized?.opencode?.binaryPath ?? ""}|serverUrl:${normalized?.opencode?.serverUrl ?? ""}|serverPassword:${normalized?.opencode?.serverPassword ? "__set__" : ""}`;
    case "grok":
      return `grok|binary:${normalized?.grok?.binaryPath ?? ""}`;
    case "antigravity":
      return "antigravity|managed";
    case "acp":
      return "acp|instance";
    case "pi":
      return "pi|instance";
    case "muse":
      // Binary path and credentials live on the provider instance.
      return "muse|instance";
  }
}
