import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveSettings, type Settings } from "@anthropic-ai/claude-agent-sdk";
import { Schema } from "effect";
import { fromLenientJson } from "@t3tools/shared/schemaJson";

export interface ClaudeBypassAvailability {
  readonly bypassDisabled: boolean;
  readonly autoDisabled: boolean;
}
export interface ClaudeBypassResolution extends ClaudeBypassAvailability {
  /** Fail closed for this turn, but retry rather than caching a read failure. */
  readonly failureReason?: string;
}
const decodeSettings = Schema.decodeUnknownSync(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);

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
): Promise<ClaudeBypassResolution> {
  const read = async (name: string): Promise<Settings> => {
    let content: string;
    try {
      content = await readFile(join(configDirectory, name), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("Could not read " + name + ".");
    }
    try {
      return decodeSettings(content) as Settings;
    } catch {
      // Schema errors can include the input settings, which must not enter a warning.
      throw new Error("Could not parse " + name + " as a settings object.");
    }
  };
  try {
    const remote = await read("remote-settings.json");
    const home = await read("settings.json");
    const resolved = await resolveSettings({
      ...(cwd ? { cwd } : {}),
      settingSources: ["project", "local"],
      serverManagedSettings: remote,
    }).catch(() => {
      throw new Error("Claude's effective settings resolver failed.");
    });
    const sources = [remote, home, resolved.effective].map(claudeBypassAvailability);
    return {
      bypassDisabled: sources.some((source) => source.bypassDisabled),
      autoDisabled: sources.some((source) => source.autoDisabled),
    };
  } catch (error) {
    // An unreadable policy must never grant bypass.
    return { bypassDisabled: true, autoDisabled: false, failureReason: String(error) };
  }
}
