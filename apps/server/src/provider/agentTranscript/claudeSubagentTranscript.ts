import * as fs from "node:fs/promises";
import path from "node:path";
import { findClaudeTranscript } from "../claudeTranscript.ts";

export async function resolveClaudeSubagentFile(input: {
  configDir: string;
  sessionId: string;
  agentId: string;
}): Promise<{ kind: "file"; path: string } | { kind: "missing" }> {
  if (!/^[a-zA-Z0-9_-]+$/.test(input.agentId) || !/^[a-f0-9-]+$/i.test(input.sessionId))
    throw new Error("Invalid native child identity.");
  try {
    const parent = await findClaudeTranscript(input.configDir, input.sessionId);
    const directory = path.join(path.dirname(parent), input.sessionId, "subagents");
    const realConfig = await fs.realpath(input.configDir);
    const realDirectory = await fs.realpath(directory);
    const relative = path.relative(realConfig, realDirectory);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep))
      throw new Error("Native output escapes its isolated store.");
    const file = path.join(directory, "agent-" + input.agentId + ".jsonl");
    const realFile = await fs.realpath(file);
    if (path.dirname(realFile) !== realDirectory || !(await fs.lstat(file)).isFile())
      throw new Error("Native output is not a regular isolated transcript.");
    return { kind: "file", path: realFile };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw cause;
  }
}
