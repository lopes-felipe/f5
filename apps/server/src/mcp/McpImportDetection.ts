import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import * as path from "node:path";
import type { McpListImportCandidatesResult } from "@t3tools/contracts";
import { mcpServerNameKey } from "@t3tools/shared/mcpValidation";
import { parseMcpImport } from "@t3tools/shared/mcpImport";

const MAX_IMPORT_BYTES = 1024 * 1024;

/**
 * Open without following a symlink, then bound the read on that same descriptor. The
 * identity (device and inode) tells two spellings of one file apart from two files.
 */
async function readMcpImportFileWithIdentity(
  filename: string,
  /** A file already read under another spelling is skipped before its contents are read. */
  alreadyRead: (identity: string) => boolean = () => false,
): Promise<{ readonly identity: string; readonly text?: string } | null> {
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile()) throw new Error("Only regular files can be imported.");
    // Some filesystems report no inode; fall back to the resolved path there.
    const identity = stat.ino ? `${stat.dev}:${stat.ino}` : path.resolve(filename);
    if (alreadyRead(identity)) return { identity };
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
    return { identity, text: buffer.subarray(0, size).toString("utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    await file?.close();
  }
}

/** Open without following a symlink, then bound the read on that same descriptor. */
export async function readMcpImportFile(filename: string): Promise<string | null> {
  return (await readMcpImportFileWithIdentity(filename))?.text ?? null;
}

/** An environment value, or undefined when it is unset or blank (never a relative path). */
const nonEmpty = (value: string | undefined) => value?.trim() || undefined;

/** Cursor, VS Code, Claude Desktop, and OpenCode configuration, user level then project level. */
export function otherClientConfigFiles(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly home: string;
  readonly cwd?: string | undefined;
  readonly platform?: NodeJS.Platform;
}): string[] {
  const platform = input.platform ?? process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const xdgConfig = nonEmpty(input.environment.XDG_CONFIG_HOME);
  const appData =
    platform === "win32"
      ? (nonEmpty(input.environment.APPDATA) ?? pathApi.join(input.home, "AppData", "Roaming"))
      : platform === "darwin"
        ? pathApi.join(input.home, "Library", "Application Support")
        : (xdgConfig ?? pathApi.join(input.home, ".config"));
  const openCodeConfig = pathApi.join(xdgConfig ?? pathApi.join(input.home, ".config"), "opencode");
  return [
    pathApi.join(input.home, ".cursor", "mcp.json"),
    pathApi.join(appData, "Code", "User", "mcp.json"),
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

export interface McpUserConfigLocation {
  readonly home: string;
  readonly environment: NodeJS.ProcessEnv;
}

/**
 * The F5 server's own user. A separate profile changes HOME only for the processes F5
 * starts, so the server's environment still names the user's home. HOME wins, as it does
 * everywhere else in the server; the account database is the fallback when HOME is blank.
 */
export function serverUserConfigLocation(
  environment: NodeJS.ProcessEnv = process.env,
  readAccountHome: () => string = () => userInfo().homedir,
): McpUserConfigLocation {
  let home = nonEmpty(environment.HOME);
  if (!home) {
    try {
      home = nonEmpty(readAccountHome());
    } catch {
      home = undefined;
    }
  }
  return { home: home ?? homedir(), environment };
}

const claudeStateFile = (environment: NodeJS.ProcessEnv, home: string) =>
  path.join(nonEmpty(environment.CLAUDE_CONFIG_DIR) ?? home, ".claude.json");
const codexConfigFile = (environment: NodeJS.ProcessEnv, home: string) =>
  path.join(nonEmpty(environment.CODEX_HOME) ?? path.join(home, ".codex"), "config.toml");

/** Called exclusively by the explicit Detect action; never during startup or settings reads. */
export async function detectMcpImports(input: {
  /** The selected account's environment; in a separate profile, HOME is the profile's own folder. */
  environment: NodeJS.ProcessEnv;
  cwd?: string | undefined;
  /**
   * In a separate profile, also read the user's own home folder: other clients'
   * configuration, and Claude and Codex configuration made outside F5. It can hold keys
   * the profile never sees otherwise, so it is read only when the user asks.
   */
  includeUserHome?: boolean | undefined;
  /** Where the user's own configuration lives; tests replace it. */
  userLocation?: (() => McpUserConfigLocation) | undefined;
}): Promise<McpListImportCandidatesResult> {
  const home = nonEmpty(input.environment.HOME) ?? homedir();
  // Outside a separate profile the account's home is the user's, so nothing changes.
  const separateProfile = input.environment.F5_PROFILE_ISOLATED === "1";
  const userLocation = separateProfile
    ? (input.userLocation ?? serverUserConfigLocation)()
    : undefined;
  const user = input.includeUserHome ? userLocation : undefined;
  const otherClientsLocation = user ?? { home, environment: input.environment };
  // Other clients' configuration, and the user's own Claude and Codex configuration in a
  // separate profile, is offered but never preselected.
  const sources: Array<{
    readonly filename: string;
    readonly selectedByDefault: boolean;
    readonly claudeState?: boolean;
  }> = [
    {
      filename: claudeStateFile(input.environment, home),
      selectedByDefault: true,
      claudeState: true,
    },
    ...(input.cwd
      ? [{ filename: path.join(input.cwd, ".mcp.json"), selectedByDefault: false }]
      : []),
    { filename: codexConfigFile(input.environment, home), selectedByDefault: true },
    ...(user
      ? [
          {
            filename: claudeStateFile(user.environment, user.home),
            selectedByDefault: false,
            claudeState: true,
          },
          { filename: codexConfigFile(user.environment, user.home), selectedByDefault: false },
        ]
      : []),
    ...otherClientConfigFiles({ ...otherClientsLocation, cwd: input.cwd }).map((filename) => ({
      filename,
      selectedByDefault: false,
    })),
  ];
  const candidates: McpListImportCandidatesResult["candidates"][number][] = [];
  const issues: McpListImportCandidatesResult["issues"][number][] = [];
  const readFiles: string[] = [];
  // A file reached by two spellings (case, a symlinked folder) is read under the first.
  const seen = new Set<string>();
  for (const { filename, selectedByDefault, claudeState } of sources) {
    try {
      const file = await readMcpImportFileWithIdentity(filename, (identity) => seen.has(identity));
      if (file?.text === undefined) continue;
      seen.add(file.identity);
      readFiles.push(filename);
      const text = file.text;
      if (!claudeState) {
        const parsed = parseMcpImport(text, filename, { requireServerMap: true });
        candidates.push(...parsed.candidates.map((entry) => ({ ...entry, selectedByDefault })));
        issues.push(...parsed.issues);
        continue;
      }
      const state = JSON.parse(text) as Record<string, unknown>;
      const append = (servers: unknown, source: string) => {
        if (!servers || typeof servers !== "object") return;
        const parsed = parseMcpImport(JSON.stringify({ mcpServers: servers }), source);
        candidates.push(
          ...parsed.candidates.map((entry) =>
            selectedByDefault ? entry : { ...entry, selectedByDefault },
          ),
        );
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
    readFiles,
    ...(userLocation
      ? { userHome: { path: userLocation.home, included: user !== undefined } }
      : {}),
  };
}
