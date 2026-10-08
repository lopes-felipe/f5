/**
 * Read-only inventory of one Codex instance through a short-lived app-server
 * control client: `hooks/list`, `plugin/list` (installed, local marketplaces
 * only), `app/list` and `mcpServerStatus/list`, with MCP sources taken from
 * `config/read` origins. The client runs with the instance's own CODEX_HOME,
 * so entries never come from another profile. F5 never edits them.
 *
 * @module provider/codexInventory
 */
import type {
  ProviderInventoryConnector,
  ProviderInventoryHook,
  ProviderInventoryPlugin,
  ProviderInventorySource,
} from "@t3tools/contracts";

import {
  CodexControlClient,
  type CodexControlEnvironmentConfig,
} from "../codex/CodexControlClient.ts";
import { hookProgramName } from "./claudeInventory.ts";

export const CODEX_INVENTORY_TIMEOUT_MS = 10_000;
const MAX_TEXT = 512;

export interface CodexInventory {
  readonly hooks: ReadonlyArray<ProviderInventoryHook>;
  readonly plugins: ReadonlyArray<ProviderInventoryPlugin>;
  readonly connectors: ReadonlyArray<ProviderInventoryConnector>;
  readonly warnings: ReadonlyArray<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bounded(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT - 1).trimEnd()}…` : trimmed;
}

/** Hook `source` (HookSource) or config layer `type` (ConfigLayerSource) to an owner. */
export function codexInventorySource(value: unknown): ProviderInventorySource {
  switch (value) {
    case "user":
    case "sessionFlags":
      return "instance";
    case "project":
      return "project";
    case "plugin":
      return "plugin";
    case "system":
    case "mdm":
    case "enterpriseManaged":
    case "cloudRequirements":
    case "cloudManagedConfig":
    case "legacyManagedConfigFile":
    case "legacyManagedConfigMdm":
    case "legacyManagedConfigTomlFromFile":
    case "legacyManagedConfigTomlFromMdm":
      return "managed";
    default:
      return "unknown";
  }
}

export function parseCodexHooks(
  entries: ReadonlyArray<unknown>,
): ReadonlyArray<ProviderInventoryHook> {
  const seen = new Set<string>();
  const result: ProviderInventoryHook[] = [];
  for (const entry of entries) {
    const hooks = isRecord(entry) && Array.isArray(entry.hooks) ? entry.hooks : [];
    for (const hook of hooks) {
      if (!isRecord(hook)) continue;
      const event = bounded(hook.eventName);
      if (!event) continue;
      const key = typeof hook.key === "string" ? hook.key : undefined;
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      const matcher = bounded(hook.matcher);
      const handlerType = bounded(hook.handlerType);
      const program = hookProgramName(hook.command);
      const sourcePath = bounded(hook.sourcePath);
      const pluginId = bounded(hook.pluginId);
      result.push({
        event,
        ...(matcher ? { matcher } : {}),
        ...(handlerType ? { handlerType } : {}),
        ...(program ? { program } : {}),
        source: hook.isManaged === true ? "managed" : codexInventorySource(hook.source),
        ...(sourcePath ? { sourcePath } : {}),
        ...(typeof hook.enabled === "boolean" ? { enabled: hook.enabled } : {}),
        ...(pluginId ? { pluginId } : {}),
      });
    }
  }
  return result;
}

export function parseCodexPlugins(response: unknown): ReadonlyArray<ProviderInventoryPlugin> {
  const marketplaces =
    isRecord(response) && Array.isArray(response.marketplaces) ? response.marketplaces : [];
  const result: ProviderInventoryPlugin[] = [];
  for (const marketplace of marketplaces) {
    if (!isRecord(marketplace) || !Array.isArray(marketplace.plugins)) continue;
    const marketplaceName = bounded(marketplace.name);
    for (const plugin of marketplace.plugins) {
      if (!isRecord(plugin) || plugin.installed !== true) continue;
      const id = bounded(plugin.id);
      const name = bounded(plugin.name) ?? id;
      if (!id || !name) continue;
      const version = bounded(plugin.localVersion) ?? bounded(plugin.version);
      const sourcePath = bounded(marketplace.path);
      result.push({
        id,
        name,
        ...(version ? { version } : {}),
        ...(marketplaceName ? { marketplace: marketplaceName } : {}),
        ...(typeof plugin.enabled === "boolean" ? { enabled: plugin.enabled } : {}),
        source: "instance",
        ...(sourcePath ? { sourcePath } : {}),
      });
    }
  }
  return result;
}

export function parseCodexApps(
  entries: ReadonlyArray<unknown>,
): ReadonlyArray<ProviderInventoryConnector> {
  const result: ProviderInventoryConnector[] = [];
  for (const app of entries) {
    if (!isRecord(app)) continue;
    const name = bounded(app.name) ?? bounded(app.id);
    if (!name) continue;
    result.push({
      name,
      kind: "app",
      ...(typeof app.isEnabled === "boolean" ? { enabled: app.isEnabled } : {}),
      ...(app.isAccessible === false ? { status: "inaccessible" } : {}),
      source: "instance",
    });
  }
  return result;
}

/** Owner of each `mcp_servers.<name>` table from `config/read` origins. */
export function codexMcpServerOrigins(
  origins: Record<string, unknown> | undefined,
): ReadonlyMap<string, ProviderInventorySource> {
  const result = new Map<string, ProviderInventorySource>();
  for (const [keyPath, origin] of Object.entries(origins ?? {})) {
    const match = /^mcp_servers\.([^.]+)/.exec(keyPath);
    if (!match?.[1] || result.has(match[1])) continue;
    const layer = isRecord(origin) && isRecord(origin.name) ? origin.name.type : undefined;
    result.set(match[1], codexInventorySource(layer));
  }
  return result;
}

export function parseCodexMcpServers(
  statuses: ReadonlyArray<unknown>,
  config: Record<string, unknown> | undefined,
  origins: ReadonlyMap<string, ProviderInventorySource>,
): ReadonlyArray<ProviderInventoryConnector> {
  const configured = config && isRecord(config.mcp_servers) ? config.mcp_servers : {};
  const byName = new Map<string, ProviderInventoryConnector>();
  for (const status of statuses) {
    if (!isRecord(status)) continue;
    const name = bounded(status.name);
    if (!name || byName.has(name)) continue;
    const entry = configured[name];
    const startup = bounded(status.startupStatus) ?? bounded(status.authStatus);
    byName.set(name, {
      name,
      kind: isRecord(entry) && typeof entry.url === "string" ? "http" : "stdio",
      ...(isRecord(entry) && entry.enabled === false ? { enabled: false } : {}),
      ...(startup ? { status: startup } : {}),
      source: origins.get(name) ?? "unknown",
    });
  }
  // Configured but not reported (disabled servers are not started).
  for (const [serverName, entry] of Object.entries(configured)) {
    const name = bounded(serverName);
    if (!name || byName.has(name) || !isRecord(entry)) continue;
    byName.set(name, {
      name,
      kind: typeof entry.url === "string" ? "http" : "stdio",
      ...(entry.enabled === false ? { enabled: false } : {}),
      source: origins.get(name) ?? "unknown",
    });
  }
  return [...byName.values()];
}

async function attempt<T>(
  warnings: string[],
  label: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warnings.push(bounded(`${label}: ${detail}`) ?? label);
    return undefined;
  }
}

/**
 * Opens a control client for the instance, reads each list independently (a
 * method the executable lacks becomes a warning), and always closes it.
 */
export async function readCodexInventory(
  environment: CodexControlEnvironmentConfig,
  input: { readonly projectRoot?: string | undefined },
  timeoutMs = CODEX_INVENTORY_TIMEOUT_MS,
): Promise<CodexInventory> {
  const signal = AbortSignal.timeout(timeoutMs);
  let client: CodexControlClient | undefined;
  try {
    client = await CodexControlClient.create(
      { ...environment, cwd: input.projectRoot ?? environment.cwd },
      signal,
    );
    const opened = client;
    const cwds = input.projectRoot ? [input.projectRoot] : [];
    const listed = (async (): Promise<CodexInventory> => {
      const warnings: string[] = [];
      const hooks = await attempt(warnings, "hooks/list", () => opened.listHooks(cwds));
      const plugins = await attempt(warnings, "plugin/list", () => opened.listPlugins(cwds));
      const apps = await attempt(warnings, "app/list", () => opened.listApps());
      const config = await attempt(warnings, "config/read", () => opened.readConfig());
      const mcp = await attempt(warnings, "mcpServerStatus/list", () =>
        opened.listMcpServerStatus(),
      );
      return {
        hooks: parseCodexHooks(hooks ?? []),
        plugins: parseCodexPlugins(plugins),
        connectors: [
          ...parseCodexMcpServers(
            mcp?.data ?? [],
            config?.config,
            codexMcpServerOrigins(config?.origins),
          ),
          ...parseCodexApps(apps ?? []),
        ],
        warnings,
      };
    })();
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(new Error("Codex inventory timed out."));
      if (signal.aborted) fail();
      signal.addEventListener("abort", fail, { once: true });
    });
    return await Promise.race([listed, aborted]);
  } finally {
    await client?.closeAndWait();
  }
}
