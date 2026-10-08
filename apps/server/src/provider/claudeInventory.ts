/**
 * Read-only inventory of what one Claude instance has configured: hooks,
 * installed plugins, MCP connectors and sub-agent definitions with their
 * memory scopes.
 *
 * Every instance-private path (settings, plugins, user agents, user agent
 * memory, `.claude.json`) resolves through the instance's Claude config dir
 * (`resolveClaudeConfigDir` over the instance process environment), never the
 * server's `os.homedir()`, so two isolated profiles never see each other's
 * entries. Project entries come from repository files only. F5 never writes
 * any of these files.
 *
 * @module provider/claudeInventory
 */
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  ClaudeAgentMemoryScope,
  ProviderInventoryAgent,
  ProviderInventoryConnector,
  ProviderInventoryHook,
  ProviderInventoryPlugin,
  ProviderInventorySource,
} from "@t3tools/contracts";
import { parseDocument } from "yaml";

const MAX_TEXT = 512;
const MAX_AGENT_FILES = 200;
const MAX_FILE_BYTES = 1024 * 1024;

export interface ClaudeInventoryInput {
  /** The instance's Claude config dir (`resolveClaudeConfigDir`). */
  readonly configDir: string;
  /** Where `.claude.json` lives: `configDir` with CLAUDE_CONFIG_DIR, else the child home. */
  readonly userStatePath: string;
  readonly projectRoot?: string | undefined;
  readonly platform?: NodeJS.Platform;
  /** Overrides the managed-settings file (mirrors CLAUDE_CODE_MANAGED_SETTINGS_PATH). */
  readonly managedSettingsPath?: string | undefined;
}

export interface ClaudeInventory {
  readonly hooks: ReadonlyArray<ProviderInventoryHook>;
  readonly plugins: ReadonlyArray<ProviderInventoryPlugin>;
  readonly connectors: ReadonlyArray<ProviderInventoryConnector>;
  readonly agents: ReadonlyArray<ProviderInventoryAgent>;
  readonly warnings: ReadonlyArray<string>;
}

/** `.claude.json` sits in the config dir only when CLAUDE_CONFIG_DIR is set. */
export function resolveClaudeUserStatePath(
  env: NodeJS.ProcessEnv,
  configDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.CLAUDE_CONFIG_DIR) return NodePath.join(configDir, ".claude.json");
  // Without CLAUDE_CONFIG_DIR the config dir is `<home>/.claude`.
  return NodePath.join(
    platform === "win32" ? NodePath.win32.dirname(configDir) : NodePath.dirname(configDir),
    ".claude.json",
  );
}

export function claudeManagedSettingsDir(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode";
    case "win32":
      return "C:\\Program Files\\ClaudeCode";
    default:
      return "/etc/claude-code";
  }
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

/**
 * The program a hook command runs, without arguments (they may carry tokens).
 * Leading `VAR=value` assignments are skipped.
 */
export function hookProgramName(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  const tokens = command.trim().split(/\s+/);
  const program = tokens.find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  if (!program) return undefined;
  const unquoted = program.replace(/^["']|["']$/g, "");
  return bounded(unquoted.split(/[\\/]/).pop());
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    return bounded(new URL(url).host);
  } catch {
    return undefined;
  }
}

class InventoryReader {
  readonly warnings: string[] = [];

  async readJson(path: string): Promise<Record<string, unknown> | undefined> {
    let text: string;
    try {
      const stat = await NodeFs.stat(path);
      if (!stat.isFile()) return undefined;
      if (stat.size > MAX_FILE_BYTES) {
        this.warn(`${path} is too large to read.`);
        return undefined;
      }
      text = await NodeFs.readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      this.warn(`Could not read ${path}.`);
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) return parsed;
      this.warn(`${path} is not a JSON object.`);
    } catch {
      this.warn(`${path} is not valid JSON.`);
    }
    return undefined;
  }

  async listMarkdown(dir: string): Promise<ReadonlyArray<string>> {
    try {
      const entries = await NodeFs.readdir(dir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => NodePath.join(dir, entry.name))
        .toSorted()
        .slice(0, MAX_AGENT_FILES);
    } catch (error) {
      if (!isMissing(error)) this.warn(`Could not list ${dir}.`);
      return [];
    }
  }

  async readText(path: string): Promise<string | undefined> {
    try {
      const stat = await NodeFs.stat(path);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
      return await NodeFs.readFile(path, "utf8");
    } catch (error) {
      if (!isMissing(error)) this.warn(`Could not read ${path}.`);
      return undefined;
    }
  }

  warn(message: string): void {
    const text = bounded(message);
    if (text && !this.warnings.includes(text)) this.warnings.push(text);
  }
}

function isMissing(error: unknown): boolean {
  const code = isRecord(error) ? error.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await NodeFs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Hooks from a settings-style `{ hooks: { Event: [{ matcher, hooks: [...] }] } }` object. */
export function parseClaudeHooks(
  hooks: unknown,
  origin: {
    readonly source: ProviderInventorySource;
    readonly sourcePath: string;
    readonly pluginId?: string;
  },
): ReadonlyArray<ProviderInventoryHook> {
  if (!isRecord(hooks)) return [];
  const result: ProviderInventoryHook[] = [];
  for (const [eventName, matchers] of Object.entries(hooks)) {
    const event = bounded(eventName);
    if (!event || !Array.isArray(matchers)) continue;
    for (const group of matchers) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      const matcher = bounded(group.matcher);
      for (const handler of group.hooks) {
        if (!isRecord(handler)) continue;
        const handlerType = bounded(handler.type);
        const program =
          handler.type === "command"
            ? hookProgramName(handler.command)
            : handler.type === "http"
              ? hostOf(handler.url)
              : undefined;
        const sourcePath = bounded(origin.sourcePath);
        const pluginId = bounded(origin.pluginId);
        result.push({
          event,
          ...(matcher ? { matcher } : {}),
          ...(handlerType ? { handlerType } : {}),
          ...(program ? { program } : {}),
          source: origin.source,
          ...(sourcePath ? { sourcePath } : {}),
          ...(pluginId ? { pluginId } : {}),
        });
      }
    }
  }
  return result;
}

/** MCP servers from an `mcpServers` map; env, headers and args are never read. */
export function parseClaudeMcpServers(
  servers: unknown,
  origin: { readonly source: ProviderInventorySource; readonly sourcePath: string },
  disabled: ReadonlySet<string> = new Set(),
): ReadonlyArray<ProviderInventoryConnector> {
  if (!isRecord(servers)) return [];
  const result: ProviderInventoryConnector[] = [];
  for (const [serverName, config] of Object.entries(servers)) {
    const name = bounded(serverName);
    if (!name || !isRecord(config)) continue;
    const kind = bounded(config.type) ?? (typeof config.command === "string" ? "stdio" : undefined);
    const sourcePath = bounded(origin.sourcePath);
    result.push({
      name,
      ...(kind ? { kind } : {}),
      ...(disabled.has(serverName) ? { enabled: false } : {}),
      source: origin.source,
      ...(sourcePath ? { sourcePath } : {}),
    });
  }
  return result;
}

interface InstalledPluginEntry {
  readonly key: string;
  readonly version?: string;
  readonly installPath?: string;
  readonly scope?: string;
  readonly projectPath?: string;
}

/** `installed_plugins.json`, v1 (`{key: entry}`) or v2 (`{key: entry[]}`). */
export function parseInstalledPlugins(
  document: Record<string, unknown> | undefined,
): ReadonlyArray<InstalledPluginEntry> {
  const plugins = document && isRecord(document.plugins) ? document.plugins : {};
  const result: InstalledPluginEntry[] = [];
  for (const [key, value] of Object.entries(plugins)) {
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const version = bounded(entry.version);
      const installPath = typeof entry.installPath === "string" ? entry.installPath : undefined;
      const scope = typeof entry.scope === "string" ? entry.scope : undefined;
      const projectPath = typeof entry.projectPath === "string" ? entry.projectPath : undefined;
      result.push({
        key,
        ...(version ? { version } : {}),
        ...(installPath ? { installPath } : {}),
        ...(scope ? { scope } : {}),
        ...(projectPath ? { projectPath } : {}),
      });
    }
  }
  return result;
}

interface AgentFrontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly memory?: ClaudeAgentMemoryScope;
}

export function parseClaudeAgentFrontmatter(text: string): AgentFrontmatter | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text.replace(/^\uFEFF/, ""));
  if (!match?.[1]) return undefined;
  const document = parseDocument(match[1]);
  if (document.errors.length > 0) return undefined;
  const parsed: unknown = document.toJS();
  if (!isRecord(parsed)) return undefined;
  const memory =
    parsed.memory === "user" || parsed.memory === "project" || parsed.memory === "local"
      ? parsed.memory
      : undefined;
  const name = bounded(parsed.name);
  const description = bounded(parsed.description);
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(memory ? { memory } : {}),
  };
}

/**
 * Directory a sub-agent's memory lives in. `user` resolves through the
 * instance config dir; `project` and `local` need a project root.
 */
export function claudeAgentMemoryPath(input: {
  readonly scope: ClaudeAgentMemoryScope;
  readonly agentName: string;
  readonly configDir: string;
  readonly projectRoot?: string | undefined;
}): string | undefined {
  // Agent names are file-name safe in Claude; refuse anything that is not.
  if (!/^[A-Za-z0-9._-]+$/.test(input.agentName) || input.agentName.startsWith(".")) {
    return undefined;
  }
  switch (input.scope) {
    case "user":
      return NodePath.join(input.configDir, "agent-memory", input.agentName);
    case "project":
      return input.projectRoot
        ? NodePath.join(input.projectRoot, ".claude", "agent-memory", input.agentName)
        : undefined;
    case "local":
      return input.projectRoot
        ? NodePath.join(input.projectRoot, ".claude", "agent-memory-local", input.agentName)
        : undefined;
  }
}

async function readAgents(
  reader: InventoryReader,
  dir: string,
  source: ProviderInventorySource,
  input: ClaudeInventoryInput,
): Promise<ReadonlyArray<ProviderInventoryAgent>> {
  const agents: ProviderInventoryAgent[] = [];
  for (const file of await reader.listMarkdown(dir)) {
    const text = await reader.readText(file);
    if (text === undefined) continue;
    const frontmatter = parseClaudeAgentFrontmatter(text);
    const name = frontmatter?.name ?? bounded(NodePath.basename(file, ".md"));
    const definitionPath = bounded(file);
    if (!name || !definitionPath) continue;
    const memoryScope = frontmatter?.memory;
    const memoryPath = memoryScope
      ? claudeAgentMemoryPath({
          scope: memoryScope,
          agentName: name,
          configDir: input.configDir,
          projectRoot: input.projectRoot,
        })
      : undefined;
    const boundedMemoryPath = bounded(memoryPath);
    agents.push({
      name,
      ...(frontmatter?.description ? { description: frontmatter.description } : {}),
      source,
      definitionPath,
      ...(memoryScope ? { memoryScope } : {}),
      ...(boundedMemoryPath
        ? { memoryPath: boundedMemoryPath, memoryExists: await directoryExists(boundedMemoryPath) }
        : {}),
    });
  }
  return agents;
}

function enabledPluginMap(settings: ReadonlyArray<Record<string, unknown> | undefined>) {
  const enabled = new Map<string, boolean>();
  // Later layers (project, local, managed) override earlier ones.
  for (const document of settings) {
    const map = document && isRecord(document.enabledPlugins) ? document.enabledPlugins : {};
    for (const [key, value] of Object.entries(map)) {
      if (typeof value === "boolean") enabled.set(key, value);
    }
  }
  return enabled;
}

function pathIsWithin(child: string, parent: string): boolean {
  const relative = NodePath.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

export async function readClaudeInventory(input: ClaudeInventoryInput): Promise<ClaudeInventory> {
  const reader = new InventoryReader();
  const platform = input.platform ?? process.platform;
  const managedDir = claudeManagedSettingsDir(platform);
  const managedSettingsPath =
    input.managedSettingsPath ?? NodePath.join(managedDir, "managed-settings.json");
  const managedMcpPath = NodePath.join(
    input.managedSettingsPath ? NodePath.dirname(input.managedSettingsPath) : managedDir,
    "managed-mcp.json",
  );
  const root = input.projectRoot;

  const instanceSettingsPath = NodePath.join(input.configDir, "settings.json");
  const projectSettingsPath = root ? NodePath.join(root, ".claude", "settings.json") : undefined;
  const localSettingsPath = root
    ? NodePath.join(root, ".claude", "settings.local.json")
    : undefined;

  const [instanceSettings, projectSettings, localSettings, managedSettings] = await Promise.all([
    reader.readJson(instanceSettingsPath),
    projectSettingsPath ? reader.readJson(projectSettingsPath) : undefined,
    localSettingsPath ? reader.readJson(localSettingsPath) : undefined,
    reader.readJson(managedSettingsPath),
  ]);

  const hooks: ProviderInventoryHook[] = [
    ...parseClaudeHooks(instanceSettings?.hooks, {
      source: "instance",
      sourcePath: instanceSettingsPath,
    }),
    ...(projectSettingsPath
      ? parseClaudeHooks(projectSettings?.hooks, {
          source: "project",
          sourcePath: projectSettingsPath,
        })
      : []),
    ...(localSettingsPath
      ? parseClaudeHooks(localSettings?.hooks, { source: "local", sourcePath: localSettingsPath })
      : []),
    ...parseClaudeHooks(managedSettings?.hooks, {
      source: "managed",
      sourcePath: managedSettingsPath,
    }),
  ];

  const agents: ProviderInventoryAgent[] = [
    ...(await readAgents(reader, NodePath.join(input.configDir, "agents"), "instance", input)),
    ...(root
      ? await readAgents(reader, NodePath.join(root, ".claude", "agents"), "project", input)
      : []),
  ];

  // Plugins are installed into the instance config dir. Project-scoped
  // installs only apply to their own project.
  const installedPath = NodePath.join(input.configDir, "plugins", "installed_plugins.json");
  const installed = parseInstalledPlugins(await reader.readJson(installedPath)).filter(
    (entry) =>
      !entry.projectPath ||
      (root !== undefined && NodePath.resolve(entry.projectPath) === NodePath.resolve(root)),
  );
  const enabled = enabledPluginMap([
    instanceSettings,
    projectSettings,
    localSettings,
    managedSettings,
  ]);
  const plugins: ProviderInventoryPlugin[] = [];
  const pluginConnectors: ProviderInventoryConnector[] = [];
  const pluginsRoot = NodePath.join(input.configDir, "plugins");
  for (const entry of installed) {
    const [pluginName, marketplace] = entry.key.split("@");
    const id = bounded(entry.key);
    const name = bounded(pluginName) ?? id;
    if (!id || !name) continue;
    const isEnabled = enabled.get(entry.key);
    const source: ProviderInventorySource =
      entry.scope === "project" ? "project" : entry.scope === "local" ? "local" : "instance";
    const sourcePath = bounded(entry.installPath);
    const boundedMarketplace = bounded(marketplace);
    plugins.push({
      id,
      name,
      ...(entry.version ? { version: entry.version } : {}),
      ...(boundedMarketplace ? { marketplace: boundedMarketplace } : {}),
      ...(isEnabled !== undefined ? { enabled: isEnabled } : {}),
      source,
      ...(sourcePath ? { sourcePath } : {}),
    });
    // Only read contributed files from installs inside this instance's plugin dir.
    if (!entry.installPath || isEnabled === false) continue;
    const installPath = NodePath.resolve(entry.installPath);
    if (!pathIsWithin(installPath, pluginsRoot)) continue;
    const pluginHooksPath = NodePath.join(installPath, "hooks", "hooks.json");
    const pluginHooks = await reader.readJson(pluginHooksPath);
    hooks.push(
      ...parseClaudeHooks(pluginHooks?.hooks, {
        source: "plugin",
        sourcePath: pluginHooksPath,
        pluginId: entry.key,
      }),
    );
    const pluginMcpPath = NodePath.join(installPath, ".mcp.json");
    const pluginMcp = await reader.readJson(pluginMcpPath);
    pluginConnectors.push(
      ...parseClaudeMcpServers(pluginMcp?.mcpServers ?? pluginMcp, {
        source: "plugin",
        sourcePath: pluginMcpPath,
      }),
    );
    agents.push(
      ...(await readAgents(reader, NodePath.join(installPath, "agents"), "plugin", input)),
    );
  }

  const userState = await reader.readJson(input.userStatePath);
  const projectState =
    root && userState && isRecord(userState.projects)
      ? userState.projects[NodePath.resolve(root)]
      : undefined;
  const disabledProjectServers = new Set(
    isRecord(projectState) && Array.isArray(projectState.disabledMcpjsonServers)
      ? projectState.disabledMcpjsonServers.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );
  const projectMcpPath = root ? NodePath.join(root, ".mcp.json") : undefined;
  const projectMcp = projectMcpPath ? await reader.readJson(projectMcpPath) : undefined;
  const managedMcp = await reader.readJson(managedMcpPath);

  const connectors: ProviderInventoryConnector[] = [
    ...parseClaudeMcpServers(userState?.mcpServers, {
      source: "instance",
      sourcePath: input.userStatePath,
    }),
    ...(isRecord(projectState)
      ? parseClaudeMcpServers(projectState.mcpServers, {
          source: "local",
          sourcePath: input.userStatePath,
        })
      : []),
    ...(projectMcpPath
      ? parseClaudeMcpServers(
          projectMcp?.mcpServers,
          { source: "project", sourcePath: projectMcpPath },
          disabledProjectServers,
        )
      : []),
    ...parseClaudeMcpServers(managedMcp?.mcpServers, {
      source: "managed",
      sourcePath: managedMcpPath,
    }),
    ...pluginConnectors,
  ];

  return { hooks, plugins, connectors, agents, warnings: reader.warnings };
}
