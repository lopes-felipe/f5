import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import type {
  AgentsReadTranscriptInput,
  AgentTranscriptPage,
  AgentTranscriptItem,
} from "@t3tools/contracts";
import { decodeCursor, encodeCursor } from "./agentTranscriptCursor.ts";
import { readBoundedJsonlLines } from "./boundedJsonl.ts";
import { resolveClaudeSubagentFile } from "./claudeSubagentTranscript.ts";
import { normalizeClaudeSubagentRecord } from "./normalizeClaudeSubagentRecord.ts";

const cache = new Map<string, { path: string | null; expires: number }>();
export const emptyTranscriptPage = (): AgentTranscriptPage => ({
  availability: "ok",
  items: [],
  nextCursor: null,
  earlierCursor: null,
  tailCursor: null,
  pendingTail: false,
  reset: false,
});
export function unavailable(
  reason: NonNullable<AgentTranscriptPage["reason"]>,
): AgentTranscriptPage {
  return { ...emptyTranscriptPage(), availability: "unavailable", reason };
}
export async function readClaudeAgentTranscript(
  input: AgentsReadTranscriptInput,
  identity: { configDir: string; sessionId: string; agentId: string; active: boolean },
  signal?: AbortSignal,
): Promise<AgentTranscriptPage> {
  // A run suffix identifies the agent, not a branch inside its JSONL file.
  const key = JSON.stringify([
    input.threadId,
    identity.configDir,
    identity.sessionId,
    identity.agentId,
  ]);
  const cached = cache.get(key);
  let filePath = cached && cached.expires > Date.now() ? cached.path : undefined;
  cache.delete(key);
  if (filePath === undefined) {
    const resolved = await resolveClaudeSubagentFile(identity);
    filePath = resolved.kind === "file" ? resolved.path : null;
  }
  cache.set(key, { path: filePath, expires: filePath ? Infinity : Date.now() + 5000 });
  if (cache.size > 256) cache.delete(cache.keys().next().value!);
  if (!filePath) return unavailable(identity.active ? "not-started" : "not-found");
  // Revalidate cached paths, including replacement by a symlink.
  let realConfig: string, realFile: string;
  try {
    realConfig = await fs.realpath(identity.configDir);
    realFile = await fs.realpath(filePath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      cache.delete(key);
      return unavailable(identity.active ? "not-started" : "not-found");
    }
    throw cause;
  }
  const relative = path.relative(realConfig, realFile);
  if (
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative) ||
    path.dirname(realFile) !== path.dirname(filePath) ||
    !(await fs.lstat(filePath)).isFile()
  )
    throw new Error("Invalid isolated transcript.");
  let file: fs.FileHandle;
  try {
    file = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      cache.delete(key);
      return unavailable(identity.active ? "not-started" : "not-found");
    }
    throw cause;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Invalid transcript.");
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    if (cursor && cursor.p !== "claude") throw new Error("Wrong provider cursor.");
    if (cursor) {
      const byte = Buffer.alloc(1);
      if (cursor.o) await file.read(byte, 0, 1, cursor.o - 1);
      if (
        cursor.ino !== stat.ino ||
        cursor.dev !== stat.dev ||
        cursor.o > stat.size ||
        (cursor.o !== 0 && byte[0] !== 10)
      )
        return { ...emptyTranscriptPage(), reset: true };
    }
    const dir = cursor?.dir ?? (input.anchor === "start" ? "fwd" : "back");
    let offset = cursor?.o ?? (dir === "back" ? stat.size : 0);
    let first = offset,
      last = offset,
      bytes = 0,
      pendingTail = false;
    const items: AgentTranscriptItem[] = [];
    const limit = input.limit ?? 200;
    for await (const line of readBoundedJsonlLines(file, {
      start: offset,
      dir,
      maxLineBytes: 1024 * 1024,
      ...(signal ? { signal } : {}),
    })) {
      if (!line.terminated) {
        pendingTail = true;
        first = Math.min(first, line.startOffset);
        last = line.startOffset;
        if (dir === "fwd") break;
        continue;
      }
      const atRecord = (o: number) =>
        encodeCursor({ v: 1, p: "claude", dir: "back", o, ino: stat.ino, dev: stat.dev });
      let recordItems: AgentTranscriptItem[];
      try {
        recordItems =
          line.text !== null && !line.text.trim()
            ? []
            : line.text === null
              ? [
                  {
                    id: "notice:" + line.startOffset,
                    createdAt: null,
                    kind: "notice",
                    text: "Record too large to display",
                  },
                ]
              : normalizeClaudeSubagentRecord(JSON.parse(line.text), line.startOffset);
      } catch {
        recordItems = [
          {
            id: "notice:" + line.startOffset,
            createdAt: null,
            kind: "notice",
            text: "Malformed transcript record",
          },
        ];
      }
      if (recordItems.length > 64)
        recordItems = [
          ...recordItems.slice(0, 63),
          {
            id: "notice:" + line.startOffset + ":overflow",
            createdAt: null,
            kind: "notice",
            text: "Additional record content omitted",
          },
        ];
      recordItems = recordItems.map((item, index) => ({
        ...item,
        position: { offset: line.startOffset, index },
        earlierCursor:
          index === 0
            ? line.startOffset > 0
              ? atRecord(line.startOffset)
              : null
            : atRecord(line.endOffset),
      }));
      const cost = Buffer.byteLength(JSON.stringify(recordItems));
      if (items.length && (items.length + recordItems.length > limit || bytes + cost > 1024 * 1024))
        break;
      if (dir === "back") items.unshift(...recordItems);
      else items.push(...recordItems);
      bytes += cost;
      first = Math.min(first, line.startOffset);
      last = dir === "back" ? Math.max(last, line.endOffset) : line.endOffset;
      offset = dir === "back" ? line.startOffset : line.endOffset;
      if (items.length >= limit) break;
    }
    const at = (o: number, direction: "fwd" | "back" = "fwd") =>
      encodeCursor({ v: 1, p: "claude", dir: direction, o, ino: stat.ino, dev: stat.dev });
    return {
      ...emptyTranscriptPage(),
      items,
      pendingTail,
      earlierCursor: first > 0 ? at(first, "back") : null,
      nextCursor: dir === "fwd" && last < stat.size && !pendingTail ? at(offset) : null,
      tailCursor: at(last),
    };
  } finally {
    await file.close();
  }
}
