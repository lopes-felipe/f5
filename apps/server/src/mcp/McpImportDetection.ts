import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import type { McpListImportCandidatesResult } from "@t3tools/contracts";
import { mcpServerNameKey } from "@t3tools/shared/mcpValidation";
import { parseMcpImport } from "@t3tools/shared/mcpImport";

const MAX_IMPORT_BYTES = 1024 * 1024;

/** Open without following a symlink, then bound the read on that same descriptor. */
export async function readMcpImportFile(filename: string): Promise<string | null> {
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Only regular files can be imported.");
    if (stat.size > MAX_IMPORT_BYTES)
      throw new Error("Configuration exceeds the 1 MiB import limit.");
    const buffer = Buffer.alloc(MAX_IMPORT_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > MAX_IMPORT_BYTES) throw new Error("Configuration exceeds the 1 MiB import limit.");
    return buffer.subarray(0, size).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    await file?.close();
  }
}

/** Cursor, VS Code, Claude Desktop, and OpenCode configuration, user level then project level. */
export function otherClientConfigFiles(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly home: string;
  readonly cwd?: string | undefined;
  readonly platform?: NodeJS.Platform;
}): string[] {
  const platform = input.platform ?? process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const appData =
    platform === "win32"
      ? (input.environment.APPDATA ?? pathApi.join(input.home, "AppData", "Roaming"))
      : platform === "darwin"
        ? pathApi.join(input.home, "Library", "Application Support")
        : (input.environment.XDG_CONFIG_HOME ?? pathApi.join(input.home, ".config"));
  const openCodeConfig = pathApi.join(
    input.environment.XDG_CONFIG_HOME ?? pathApi.join(input.home, ".config"),
    "opencode",
  );
  return [
    pathApi.join(input.home, ".cursor", "mcp.json"),
    pathApi.join(appData, "Claude", "claude_desktop_config.json"),
    pathApi.join(openCodeConfig, "opencode.json"),
    pathApi.join(openCodeConfig, "opencode.jsonc"),
    ...(input.cwd
      ? [
          pathApi.join(input.cwd, ".cursor", "mcp.json"),
          pathApi.join(input.cwd, ".vscode", "mcp.json"),
          pathApi.join(input.cwd, "opencode.json"),
          pathApi.join(input.cwd, "opencode.jsonc"),
        ]
      : []),
  ];
}

/** Called exclusively by the explicit Detect action; never during startup or settings reads. */
export async function detectMcpImports(input: {
  environment: NodeJS.ProcessEnv;
  cwd?: string | undefined;
}): Promise<McpListImportCandidatesResult> {
  const home = input.environment.HOME ?? homedir();
  const claudeDir = input.environment.CLAUDE_CONFIG_DIR;
  const claudeState = claudeDir
    ? path.join(claudeDir, ".claude.json")
    : path.join(home, ".claude.json");
  // Other clients' configuration is offered but never preselected.
  const sources: Array<{ readonly filename: string; readonly selectedByDefault: boolean }> = [
    { filename: claudeState, selectedByDefault: true },
    ...(input.cwd
      ? [{ filename: path.join(input.cwd, ".mcp.json"), selectedByDefault: false }]
      : []),
    {
      filename: path.join(input.environment.CODEX_HOME ?? path.join(home, ".codex"), "config.toml"),
      selectedByDefault: true,
    },
    ...otherClientConfigFiles({ environment: input.environment, home, cwd: input.cwd }).map(
      (filename) => ({ filename, selectedByDefault: false }),
    ),
  ];
  const candidates: McpListImportCandidatesResult["candidates"][number][] = [];
  const issues: McpListImportCandidatesResult["issues"][number][] = [];
  for (const { filename, selectedByDefault } of sources) {
    try {
      const text = await readMcpImportFile(filename);
      if (text === null) continue;
      if (filename !== claudeState) {
        const parsed = parseMcpImport(text, filename);
        candidates.push(...parsed.candidates.map((entry) => ({ ...entry, selectedByDefault })));
        issues.push(...parsed.issues);
        continue;
      }
      const state = JSON.parse(text) as Record<string, unknown>;
      const append = (servers: unknown, source: string) => {
        if (!servers || typeof servers !== "object") return;
        const parsed = parseMcpImport(JSON.stringify({ mcpServers: servers }), source);
        candidates.push(...parsed.candidates);
        issues.push(...parsed.issues);
      };
      append(state.mcpServers, filename);
      if (input.cwd && state.projects && typeof state.projects === "object") {
        for (const [project, config] of Object.entries(state.projects)) {
          if (path.resolve(project) !== path.resolve(input.cwd)) continue;
          if (config && typeof config === "object" && "mcpServers" in config)
            append(config.mcpServers, `${filename} (${project})`);
        }
      }
    } catch (error) {
      issues.push({
        field: filename,
        severity: "error",
        message: error instanceof Error ? error.message : "Could not read configuration.",
      });
    }
  }
  const names = new Map<string, string>();
  return {
    candidates: candidates.map((entry) => {
      const key = mcpServerNameKey(entry.name);
      const firstSource = names.get(key);
      names.set(key, firstSource ?? entry.source);
      return firstSource
        ? {
            ...entry,
            selectedByDefault: false,
            issues: [
              ...entry.issues,
              {
                serverName: entry.name,
                field: "name",
                severity: "warning" as const,
                message: `Duplicate name also found in ${firstSource}. Select only one candidate with this name.`,
              },
            ],
          }
        : entry;
    }),
    issues,
  };
}
