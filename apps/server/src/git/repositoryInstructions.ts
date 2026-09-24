import { open, realpath } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_SERVER_SETTINGS, type SourceControlWritingSettings } from "@t3tools/contracts";

const MAX_INSTRUCTION_BYTES = 20_000;

async function readInstructions(cwd: string, name: string): Promise<string> {
  try {
    const root = await realpath(cwd);
    const target = await realpath(path.join(root, name));
    if (!target.startsWith(root + path.sep)) return "";
    const file = await open(target, "r");
    try {
      if (!(await file.stat()).isFile()) return "";
      const buffer = Buffer.alloc(MAX_INSTRUCTION_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_INSTRUCTION_BYTES) return "";
      return buffer.subarray(0, bytesRead).toString("utf8").trim();
    } finally {
      await file.close();
    }
  } catch {
    return "";
  }
}

/** Local writing guidance is included explicitly even when generation runs without tools. */
export async function repositoryWritingPreferences(
  cwd: string,
  driverKind: string,
  preferences?: SourceControlWritingSettings,
): Promise<SourceControlWritingSettings> {
  const names = driverKind === "claudeAgent" ? ["AGENTS.md", "CLAUDE.md"] : ["AGENTS.md"];
  const instructions = await Promise.all(
    names.map(async (name) => {
      const text = await readInstructions(cwd, name);
      return text ? `Repository ${name}:\n${text}` : "";
    }),
  );
  const current = preferences ?? DEFAULT_SERVER_SETTINGS.sourceControlWriting;
  return {
    ...current,
    customInstructions: [...instructions.filter(Boolean), current.customInstructions]
      .filter(Boolean)
      .join("\n\n"),
  };
}
