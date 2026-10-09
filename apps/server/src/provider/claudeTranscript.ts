import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

/** Read object-shaped JSON without accepting arrays as transcript envelopes. */
export function transcriptRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Locate the session in the CLI store, including hashed project directory names. */
export async function findClaudeTranscript(
  home: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!/^[a-f0-9-]+$/i.test(sessionId)) throw new Error("Invalid Claude session ID.");
  const projects = path.join(home, "projects");
  const matches: string[] = [];
  for (const entry of await readdir(projects)) {
    signal?.throwIfAborted();
    const candidate = path.join(projects, entry, `${sessionId}.jsonl`);
    try {
      if ((await stat(candidate)).isFile()) matches.push(candidate);
    } catch (error) {
      // The store can contain regular files such as macOS's .DS_Store.
      // ENOTDIR means this entry cannot contain the session, just like ENOENT.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
  if (matches.length === 0)
    throw Object.assign(new Error("Claude transcript does not exist yet."), { code: "ENOENT" });
  if (matches.length !== 1) throw new Error("Claude transcript was not uniquely located.");
  return matches[0]!;
}

/** Stream a UUID index; repair may quarantine malformed records reported by line number. */
export async function readClaudeTranscript(
  file: string,
  includePayload = true,
  options?: { skipMalformed?: boolean; onMalformed?: (line: number) => void; signal?: AbortSignal },
) {
  const entries = new Map<string, Record<string, unknown>>();
  const input = createReadStream(file, {
    encoding: "utf8",
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  const lines = readline.createInterface({
    input,
    crlfDelay: Infinity,
  });
  let malformedTail = false;
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) continue;
      if (malformedTail)
        throw new Error(
          "Claude transcript contains a malformed record before its end. Use Repair transcript.",
        );
      let entry: Record<string, unknown> | undefined;
      try {
        entry = transcriptRecord(JSON.parse(line));
      } catch {
        options?.onMalformed?.(lineNumber);
        malformedTail = !options?.skipMalformed;
        continue;
      }
      if (typeof entry?.uuid === "string")
        entries.set(
          entry.uuid,
          includePayload ? entry : { uuid: entry.uuid, parentUuid: entry.parentUuid },
        );
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return entries;
}

/** Validate iteratively so long transcripts and cyclic chains cannot exhaust the stack. */
export function hasClaudeParentChain(
  entries: ReadonlyMap<string, Record<string, unknown>>,
  target: string,
): boolean {
  const seen = new Set<string>();
  let cursor: unknown = target;
  while (typeof cursor === "string") {
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    const entry = entries.get(cursor);
    if (!entry) return false;
    cursor = entry.parentUuid;
  }
  return cursor === null;
}

export function selectClaudeResumePoint(
  entries: ReadonlyMap<string, Record<string, unknown>>,
  target: string | undefined,
  boundaries: ReadonlyArray<{ assistantUuid: string }>,
  excluded?: string,
): string | undefined {
  const candidates = [target, ...boundaries.toReversed().map((boundary) => boundary.assistantUuid)];
  return candidates.find(
    (uuid): uuid is string =>
      typeof uuid === "string" && uuid !== excluded && hasClaudeParentChain(entries, uuid),
  );
}

export function isClaudeMissingResumeMessageError(text: string): boolean {
  return /no message found with message\.uuid of:/i.test(text);
}

const transcriptMaintenance = new Set<string>();
export const isClaudeTranscriptUnderMaintenance = (sessionId: string) =>
  transcriptMaintenance.has(sessionId);
export function beginClaudeTranscriptMaintenance(sessionId: string): () => void {
  if (transcriptMaintenance.has(sessionId))
    throw new Error("Claude transcript repair is already in progress.");
  transcriptMaintenance.add(sessionId);
  return () => {
    transcriptMaintenance.delete(sessionId);
  };
}

/** A bounded native page from an already authorized isolated transcript. */
export async function readClaudeTranscriptPage(
  file: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
) {
  const input = createReadStream(file, signal ? { signal } : {});
  // Cap the retained line before parsing it. readline would allocate an entire
  // oversized tool-output line before we could decide to omit it.
  async function* boundedLines(): AsyncGenerator<string | null> {
    let parts: Buffer[] = [];
    let size = 0;
    let oversized = false;
    for await (const value of input) {
      const chunk = value as Buffer;
      let start = 0;
      while (start < chunk.length) {
        const end = chunk.indexOf(10, start);
        const segment = chunk.subarray(start, end < 0 ? chunk.length : end);
        size += segment.length;
        if (size > 64 * 1024) {
          oversized = true;
          parts = [];
        } else if (!oversized) parts.push(segment);
        if (end < 0) break;
        yield oversized ? null : Buffer.concat(parts).toString("utf8");
        parts = [];
        size = 0;
        oversized = false;
        start = end + 1;
      }
    }
    if (size || oversized) yield oversized ? null : Buffer.concat(parts).toString("utf8");
  }
  const entries: Record<string, unknown>[] = [];
  let index = 0;
  let bytes = 0;
  let hasMore = false;
  try {
    for await (const line of boundedLines()) {
      if (line !== null && !line.trim()) continue;
      if (index++ < offset) continue;
      if (entries.length >= limit) {
        hasMore = true;
        break;
      }
      if (line === null || bytes + Buffer.byteLength(line) > 256 * 1024)
        entries.push({ omitted: true, reason: "Native output exceeds the page limit." });
      else {
        try {
          entries.push(
            transcriptRecord(JSON.parse(line)) ?? {
              omitted: true,
              reason: "Malformed native output.",
            },
          );
          bytes += Buffer.byteLength(line);
        } catch {
          entries.push({ omitted: true, reason: "Malformed native output." });
        }
      }
    }
  } finally {
    input.destroy();
  }
  return { entries, nextCursor: hasMore ? String(index - 1) : null };
}
