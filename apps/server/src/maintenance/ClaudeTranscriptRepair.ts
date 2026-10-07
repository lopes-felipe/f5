import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, copyFile, rename, readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import path from "node:path";
import {
  hasClaudeParentChain,
  readClaudeTranscript,
  transcriptRecord as record,
} from "../provider/claudeTranscript.ts";

export async function inspectClaudeResumePoint(file: string, target: string) {
  return {
    reason: hasClaudeParentChain(await readClaudeTranscript(file), target)
      ? "eligible"
      : "missing_resume_point",
  } as const;
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const note =
  "[Transcript repair] The previous attempt was interrupted. Unsaved tool output and incomplete tool calls were lost; verify the work and redo those steps.";

export async function repairClaudeResumePoint(input: {
  file: string;
  target: string;
  sessionId: string;
  threadId: string;
  providerLogsDir: string;
  resumeCursor?: unknown;
}) {
  const original = await readFile(input.file, "utf8");
  const persisted = await readClaudeTranscript(input.file);
  if (hasClaudeParentChain(persisted, input.target))
    throw new Error("The resume point is already persisted and valid.");
  const template = [...persisted.values()].find(
    (entry) => entry.type === "assistant" && entry.sessionId === input.sessionId,
  );
  if (!template)
    throw new Error(
      "No persisted assistant envelope is available; transcript cannot be repaired safely.",
    );
  const events: Array<Record<string, unknown>> = [];
  for (const name of await readdir(input.providerLogsDir)) {
    if (name !== `${input.threadId}.log` && !name.startsWith(`${input.threadId}.log.`)) continue;
    const lines = readline.createInterface({
      input: createReadStream(path.join(input.providerLogsDir, name), { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      const index = line.indexOf("NTIVE: ");
      if (index < 0) continue;
      try {
        const outer = record(JSON.parse(line.slice(index + 7)));
        const event = record(outer?.event) ?? outer;
        const payload = record(event?.payload);
        if (
          event &&
          payload?.session_id === input.sessionId &&
          payload.parent_tool_use_id == null &&
          (event.method === "claude/assistant" ||
            record(payload.event)?.type === "content_block_start" ||
            record(payload.event)?.type === "content_block_stop")
        )
          events.push(event);
      } catch {
        /* A truncated log line provides no recoverable payload. */
      }
    }
  }
  events.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const assistants = new Map<string, Record<string, unknown>>();
  const assistantTimes = new Map<string, string>();
  const incompleteTools = new Set<string>();
  const blocks = new Map<number, string>();
  for (const native of events) {
    const payload = record(native.payload)!;
    if (native.createdAt === undefined) continue;
    if (native.method === "claude/assistant" && typeof payload.uuid === "string") {
      assistants.set(payload.uuid, payload);
      assistantTimes.set(payload.uuid, String(native.createdAt));
    }
    const event = record(payload.event);
    if (event?.type === "content_block_start") {
      const block = record(event.content_block);
      if (
        block?.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof event.index === "number"
      ) {
        blocks.set(event.index, block.id);
        incompleteTools.add(block.id);
      }
    } else if (event?.type === "content_block_stop" && typeof event.index === "number") {
      const id = blocks.get(event.index);
      if (id) incompleteTools.delete(id);
      blocks.delete(event.index);
    }
  }
  // Restore the missing tail only, anchored on the latest valid entry preceding
  // the first missing native assistant. Never turn log fragments into tool calls.
  const restored = new Map(persisted);
  const additions: Array<Record<string, unknown>> = [];
  let parent = [...persisted.keys()]
    .toReversed()
    .find((uuid) => hasClaudeParentChain(persisted, uuid));
  if (!parent) throw new Error("No intact parent chain is available to anchor the repair.");
  if (!assistants.has(input.target)) {
    assistants.set(input.target, {
      uuid: input.target,
      message: record(persisted.get(input.target)?.message) ?? {
        ...record(template.message),
        id: `msg_repair_${randomUUID()}`,
        role: "assistant",
        content: [],
      },
    });
  }
  const pendingTools = new Set<string>();
  const rootChain: Array<Record<string, unknown>> = [];
  let ancestor: unknown = parent;
  while (typeof ancestor === "string") {
    const entry = persisted.get(ancestor)!;
    rootChain.unshift(entry);
    ancestor = entry.parentUuid;
  }
  const trackTools = (entry: Record<string, unknown>) => {
    const content = record(entry.message)?.content;
    if (!Array.isArray(content)) return;
    for (const value of content) {
      const block = record(value);
      if (block?.type === "tool_use" && typeof block.id === "string") pendingTools.add(block.id);
      if (block?.type === "tool_result" && typeof block.tool_use_id === "string")
        pendingTools.delete(block.tool_use_id);
    }
  };
  rootChain.forEach(trackTools);
  const append = (entry: Record<string, unknown>) => {
    additions.push(entry);
    restored.set(String(entry.uuid), entry);
    parent = String(entry.uuid);
    trackTools(entry);
  };
  const closeTools = () => {
    if (!pendingTools.size) return;
    append({
      ...template,
      type: "user",
      uuid: randomUUID(),
      parentUuid: parent,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [...pendingTools].map((id) => ({
          type: "tool_result",
          tool_use_id: id,
          is_error: true,
          content:
            "[Transcript repair] Tool output was not saved. Verify and redo the operation if needed.",
        })),
      },
    });
  };
  const anchorTime = String(persisted.get(parent!)?.timestamp ?? "");
  const targetTime = events.find(
    (event) => record(event.payload)?.uuid === input.target,
  )?.createdAt;
  for (const [uuid, payload] of assistants) {
    const eventTime = assistantTimes.get(uuid);
    if (
      uuid !== input.target &&
      eventTime &&
      (String(eventTime) < anchorTime || (targetTime && String(eventTime) > String(targetTime)))
    )
      continue;
    if (persisted.has(uuid) && hasClaudeParentChain(persisted, uuid)) continue;
    const message = record(payload.message);
    if (!message || !Array.isArray(message.content)) continue;
    closeTools();
    const content = message.content.filter((value) => {
      const block = record(value);
      return block?.type !== "tool_use" || !incompleteTools.has(String(block.id));
    });
    if (uuid === input.target) {
      const tools = content.filter((value) => record(value)?.type === "tool_use");
      if (tools.length) {
        append({
          ...template,
          uuid: randomUUID(),
          parentUuid: parent,
          timestamp: new Date().toISOString(),
          message: { ...message, content: tools },
        });
        closeTools();
        for (let index = content.length - 1; index >= 0; index--)
          if (record(content[index])?.type === "tool_use") content.splice(index, 1);
      }
      content.push({ type: "text", text: note });
    }
    append({
      ...template,
      uuid,
      parentUuid: parent,
      timestamp: payload.timestamp ?? new Date().toISOString(),
      message: { ...message, content },
    });
    if (uuid === input.target) break;
  }
  if (!hasClaudeParentChain(restored, input.target))
    throw new Error("Repair could not reconstruct the requested parent chain.");
  // An unresolved tool at the cursor must be closed before the next user turn.
  closeTools();
  const replaced = new Set(additions.map((entry) => String(entry.uuid)));
  const originalLines = original.trimEnd().split("\n");
  try {
    JSON.parse(originalLines.at(-1)!);
  } catch {
    originalLines.pop();
  }
  const preserved = originalLines
    .join("\n")
    .split("\n")
    .filter((line) => !line.trim() || !replaced.has(String(record(JSON.parse(line))?.uuid)))
    .join("\n");
  const repaired =
    preserved.trimEnd() + "\n" + additions.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  const backup = `${input.file}.bak-before-repair-${randomUUID()}`;
  await copyFile(input.file, backup);
  if ((await readFile(input.file, "utf8")) !== original)
    throw new Error("Transcript changed during repair; retry after the session stops.");
  await writeFile(
    `${backup}.receipt`,
    JSON.stringify({ repairedHash: digest(repaired), resumeCursor: input.resumeCursor }),
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  const temporary = `${backup}.pending`;
  await writeFile(temporary, repaired, { flag: "wx", mode: 0o600 });
  await rename(temporary, input.file);
  if (!hasClaudeParentChain(await readClaudeTranscript(input.file), input.target)) {
    await copyFile(backup, input.file);
    throw new Error("Transcript verification failed; restored the backup.");
  }

  return {
    backupId: path.basename(backup),
    restoredMessages: additions.length,
    resumeSessionAt: parent!,
  };
}

export async function undoClaudeResumeRepair(file: string, backupId: string) {
  if (
    path.basename(backupId) !== backupId ||
    !backupId.startsWith(`${path.basename(file)}.bak-before-repair-`)
  )
    throw new Error("Invalid transcript backup.");
  const backup = path.join(path.dirname(file), backupId);
  const receipt = JSON.parse(await readFile(`${backup}.receipt`, "utf8")) as {
    repairedHash: string;
    resumeCursor?: unknown;
  };
  if (digest(await readFile(file, "utf8")) !== receipt.repairedHash)
    throw new Error("Transcript changed after repair; undo would discard newer work.");
  const temporary = `${backup}.undo-${randomUUID()}`;
  await copyFile(backup, temporary);
  await rename(temporary, file);
  return receipt.resumeCursor;
}
