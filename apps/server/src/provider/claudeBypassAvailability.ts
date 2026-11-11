import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveSettings, type Settings } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeBypassAvailability {
  readonly bypassDisabled: boolean;
  readonly autoDisabled: boolean;
}

export function claudeBypassAvailability(settings: unknown): ClaudeBypassAvailability {
  const value = settings as {
    disableAutoMode?: unknown;
    permissions?: { disableBypassPermissionsMode?: unknown; disableAutoMode?: unknown };
  } | null;
  return {
    bypassDisabled: value?.permissions?.disableBypassPermissionsMode === "disable",
    autoDisabled:
      value?.disableAutoMode === "disable" || value?.permissions?.disableAutoMode === "disable",
  };
}

/** Keep the isolated profile and cached remote policy in the SDK cascade. */
export async function resolveClaudeBypassAvailability(
  configDirectory: string,
  cwd: string | undefined,
): Promise<ClaudeBypassAvailability> {
  const read = async (name: string): Promise<Settings> => {
    try {
      return JSON.parse(await readFile(join(configDirectory, name), "utf8")) as Settings;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  };
  try {
    const remote = await read("remote-settings.json");
    const home = await read("settings.json");
    const resolved = await resolveSettings({
      ...(cwd ? { cwd } : {}),
      settingSources: ["project", "local"],
      serverManagedSettings: remote,
    });
    const sources = [remote, home, resolved.effective].map(claudeBypassAvailability);
    return {
      bypassDisabled: sources.some((source) => source.bypassDisabled),
      autoDisabled: sources.some((source) => source.autoDisabled),
    };
  } catch {
    // An unreadable policy must never grant bypass.
    return { bypassDisabled: true, autoDisabled: false };
  }
}
