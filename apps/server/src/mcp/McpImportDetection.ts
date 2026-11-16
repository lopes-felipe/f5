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

/** Called exclusively by the explicit Detect action; never during startup or settings reads. */
export async function detectMcpImports(input: {
  environment: NodeJS.ProcessEnv;
  cwd?: string | undefined;
}): Promise<McpListImportCandidatesResult> {
  const home = input.environment.HOME ?? homedir();
  const claudeDir = input.environment.CLAUDE_CONFIG_DIR;
  const filenames = [
    claudeDir ? path.join(claudeDir, ".claude.json") : path.join(home, ".claude.json"),
    ...(input.cwd ? [path.join(input.cwd, ".mcp.json")] : []),
    path.join(input.environment.CODEX_HOME ?? path.join(home, ".codex"), "config.toml"),
  ];
  const candidates: McpListImportCandidatesResult["candidates"][number][] = [];
  const issues: McpListImportCandidatesResult["issues"][number][] = [];
  for (const filename of filenames) {
    try {
      const text = await readMcpImportFile(filename);
      if (text === null) continue;
      if (filename.endsWith("config.toml") || filename.endsWith(".mcp.json")) {
        const parsed = parseMcpImport(text, filename);
        candidates.push(
          ...parsed.candidates.map((entry) => ({
            ...entry,
            selectedByDefault: !filename.endsWith(".mcp.json"),
          })),
        );
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
