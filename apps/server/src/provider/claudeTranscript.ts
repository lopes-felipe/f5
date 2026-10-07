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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
