import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Utf8Lines } from "@t3tools/shared/utf8Lines";
import {
  buildClaudeTranscriptView,
  ClaudeTranscriptLoader,
  type ClaudeTranscriptView,
} from "./claudeTranscriptLoader.ts";

export { buildClaudeTranscriptView, type ClaudeTranscriptView };

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

const views = new WeakMap<ReadonlyMap<string, unknown>, ClaudeTranscriptView>();

/**
 * How the CLI loads this transcript. Indexes from readClaudeTranscript carry
 * the view built from every record in file order. Other maps are read as rows
 * in insertion order, without checkpoints.
 */
export function claudeTranscriptView(
  entries: ReadonlyMap<string, Record<string, unknown>>,
): ClaudeTranscriptView {
  return (
    views.get(entries) ??
    buildClaudeTranscriptView(
      [...entries].map(([uuid, entry]) => ({ ...entry, uuid })),
      true,
    )
  );
}

/** Stream a UUID index; repair may quarantine malformed records reported by line number. */
export async function readClaudeTranscript(
  file: string,
  includePayload = true,
  options?: { skipMalformed?: boolean; onMalformed?: (line: number) => void; signal?: AbortSignal },
) {
  const entries = new Map<string, Record<string, unknown>>();
  const loader = new ClaudeTranscriptLoader();
  let malformedTail = false;
  let lineNumber = 0;
  for await (const line of readClaudeTranscriptLines(file, options?.signal)) {
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
    loader.add(entry);
    if (typeof entry?.uuid === "string")
      entries.set(
        entry.uuid,
        includePayload
          ? entry
          : {
              uuid: entry.uuid,
              parentUuid: entry.parentUuid,
              type: entry.type,
              isSidechain: entry.isSidechain,
            },
      );
  }
  views.set(entries, loader.finish());
  return entries;
}

/**
 * Yield JSONL lines split on "\n" only, including an unterminated final line.
 * node:readline also ends lines at U+2028, U+2029 and a lone "\r", which
 * JSON.stringify leaves unescaped inside strings. Line N here is always line N
 * of `text.split("\n")`, which repair relies on to quarantine by line number.
 * Content can differ only by a leading BOM and a trailing "\r", both removed.
 */
export async function* readClaudeTranscriptLines(
  file: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const input = createReadStream(file, signal ? { signal } : {});
  const lines = new Utf8Lines();
  try {
    for await (const chunk of input) yield* lines.push(chunk as Buffer);
    yield* lines.finish();
  } finally {
    input.destroy();
  }
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

/**
 * The message whose parent chain the CLI loads on resume. It looks for
 * `resumeSessionAt` on that chain only, so a UUID on another branch is "not
 * found" even though it is saved. See claudeTranscriptLoader.ts for the rules.
 */
export const findClaudeActiveLeaf = (entries: ReadonlyMap<string, Record<string, unknown>>) =>
  claudeTranscriptView(entries).leaf;

/**
 * - active: the CLI will find it.
 * - off_branch: saved, but on a branch that forks off the active chain, so the
 *   CLI rejects it. Repair must restore the branch.
 * - detached: under a different root, such as history before a compaction.
 *   Kept selectable as before.
 * - missing: absent or without a complete parent chain.
 */
export type ClaudeResumePointState = "active" | "off_branch" | "detached" | "missing";

export function classifyClaudeResumePoint(
  entries: ReadonlyMap<string, Record<string, unknown>>,
  uuid: string,
  view: ClaudeTranscriptView = claudeTranscriptView(entries),
): ClaudeResumePointState {
  if (!hasClaudeParentChain(entries, uuid)) return "missing";
  if (view.chain.has(uuid)) return "active";
  // Parents as loaded: the CLI skips progress records and relinks compactions.
  const seen = new Set<string>();
  for (let cursor = view.parents.get(uuid); typeof cursor === "string"; ) {
    if (view.chain.has(cursor)) return "off_branch";
    if (seen.has(cursor)) break;
    seen.add(cursor);
    cursor = view.parents.get(cursor);
  }
  return "detached";
}

export type ClaudeResumePointSelection =
  | { readonly kind: "selected"; readonly uuid: string }
  | { readonly kind: "forked"; readonly target: string; readonly activeLeaf: string | undefined }
  | { readonly kind: "none" };

/**
 * Pick the newest resumable candidate. Stop at the first candidate on a forked
 * branch instead of falling back past it: an older boundary would silently drop
 * turns the user already saw.
 */
export function resolveClaudeResumePoint(
  entries: ReadonlyMap<string, Record<string, unknown>>,
  target: string | undefined,
  boundaries: ReadonlyArray<{ assistantUuid: string }>,
  excluded?: string,
): ClaudeResumePointSelection {
  const view = claudeTranscriptView(entries);
  const candidates = [target, ...boundaries.toReversed().map((boundary) => boundary.assistantUuid)];
  for (const uuid of new Set(candidates)) {
    if (typeof uuid !== "string") continue;
    const state = classifyClaudeResumePoint(entries, uuid, view);
    if (state === "off_branch") return { kind: "forked", target: uuid, activeLeaf: view.leaf };
    if (uuid === excluded || state === "missing") continue;
    return { kind: "selected", uuid };
  }
  return { kind: "none" };
}

export const CLAUDE_TRANSCRIPT_FORKED_MESSAGE =
  "Claude's transcript forked. Use Repair transcript to restore the branch this thread is on.";

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
