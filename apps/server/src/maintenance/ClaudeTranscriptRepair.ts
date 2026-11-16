import { randomUUID, createHash } from "node:crypto";
import {
  readFile,
  writeFile,
  copyFile,
  rename,
  readdir,
  chmod,
  unlink,
  stat,
} from "node:fs/promises";
import { readCompleteLogLines } from "./completeLogLines.ts";
import path from "node:path";
import {
  buildClaudeTranscriptView,
  classifyClaudeResumePoint,
  hasClaudeParentChain,
  readClaudeTranscript,
  readClaudeTranscriptLines,
  transcriptRecord as record,
} from "../provider/claudeTranscript.ts";
import { readClaudeResumeState } from "../provider/claudeResumeState.ts";

export async function inspectClaudeResumePoint(file: string, target: string) {
  const malformed: number[] = [];
  const entries = await readClaudeTranscript(file, false, {
    skipMalformed: true,
    onMalformed: (line) => malformed.push(line),
  });
  const state = classifyClaudeResumePoint(entries, target);
  return {
    reason:
      state === "off_branch"
        ? "branch_mismatch"
        : malformed.length === 0 && state !== "missing"
          ? "eligible"
          : "missing_resume_point",
  } as const;
}

/** A repaired target must exist and be on, or detached from, the chain the CLI loads. */
const isResumableClaudeTarget = (
  entries: ReadonlyMap<string, Record<string, unknown>>,
  target: string,
) => {
  const state = classifyClaudeResumePoint(entries, target);
  return state === "active" || state === "detached";
};

const uuidOf = (value: unknown) => {
  const uuid = record(value)?.uuid;
  return typeof uuid === "string" ? uuid : undefined;
};

/**
 * Find the records that make the CLI resume somewhere other than the target,
 * by record index. Each pass follows the CLI's leaf choice back to where it
 * leaves the target's lineage. A stray branch there is removed with the
 * checkpoints that point into it. When the choice starts on the lineage, an
 * older checkpoint pinned it, so that checkpoint is removed. Turns this thread
 * recorded are never removed.
 */
export function findStrayClaudeRecords(
  records: ReadonlyArray<unknown>,
  target: string,
  resumeCursor?: unknown,
): ReadonlySet<number> {
  const dropped = new Set<number>();
  const rawChildren = new Map<string, number[]>();
  records.forEach((value, index) => {
    const parent = record(value)?.parentUuid;
    if (typeof parent === "string" && uuidOf(value))
      rawChildren.set(parent, [...(rawChildren.get(parent) ?? []), index]);
  });
  const indexes = new Map<string, number[]>();
  records.forEach((value, index) => {
    const uuid = uuidOf(value);
    if (uuid) indexes.set(uuid, [...(indexes.get(uuid) ?? []), index]);
  });
  const dropRecords = (predicate: (entry: Record<string, unknown>) => boolean) =>
    records.forEach((value, index) => {
      const entry = record(value);
      if (entry && predicate(entry)) dropped.add(index);
    });
  for (let pass = 0; ; pass++) {
    const remaining = records.filter((_, index) => !dropped.has(index));
    const view = buildClaudeTranscriptView(remaining);
    const entries = new Map<string, Record<string, unknown>>();
    for (const value of remaining) {
      const uuid = uuidOf(value);
      if (uuid) entries.set(uuid, record(value)!);
    }
    if (classifyClaudeResumePoint(entries, target, view) !== "off_branch") break;
    if (pass >= 64)
      throw new Error("Could not separate Claude's transcript branches; no changes were made.");
    const lineage = new Set<string>();
    for (let cursor: string | null | undefined = target; cursor && !lineage.has(cursor); ) {
      lineage.add(cursor);
      cursor = view.parents.get(cursor);
    }
    let branchRoot: string | undefined;
    let cursor: string | null | undefined = view.start;
    const seen = new Set<string>();
    while (cursor && !lineage.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      branchRoot = cursor;
      cursor = view.parents.get(cursor);
    }
    if (branchRoot !== undefined && cursor && lineage.has(cursor)) {
      const children = new Map<string, string[]>();
      for (const [uuid, parent] of view.parents)
        if (parent !== null) children.set(parent, [...(children.get(parent) ?? []), uuid]);
      const stray = new Set<string>();
      const pending = [branchRoot];
      while (pending.length > 0) {
        const uuid = pending.pop()!;
        if (stray.has(uuid)) continue;
        stray.add(uuid);
        pending.push(...(children.get(uuid) ?? []));
        // Records the CLI does not load, such as progress, go with their parent.
        for (const index of rawChildren.get(uuid) ?? []) {
          const child = uuidOf(records[index])!;
          if (!view.parents.has(child)) pending.push(child);
        }
      }
      for (const uuid of stray) for (const index of indexes.get(uuid) ?? []) dropped.add(index);
      dropRecords((entry) => entry.type === "last-prompt" && stray.has(String(entry.leafUuid)));
    } else if (view.pickedCheckpoint && view.checkpoint) {
      const pinned = view.checkpoint;
      dropRecords((entry) => entry.type === "last-prompt" && entry.leafUuid === pinned);
    } else
      throw new Error("Could not locate where Claude's transcript forked; no changes were made.");
  }
  const owned = readClaudeResumeState(resumeCursor)?.turnBoundaries ?? [];
  if (
    owned.some((boundary) =>
      (indexes.get(boundary.assistantUuid) ?? []).some((index) => dropped.has(index)),
    )
  )
    throw new Error(
      "Both branches of Claude's transcript hold turns from this thread, so repair cannot choose one. No changes were made. Start a new thread to continue.",
    );
  return dropped;
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const note =
  "[Transcript repair] The previous attempt was interrupted. Unsaved tool output and incomplete tool calls were lost; verify the work and redo those steps.";
const branchNote =
  "[Transcript repair] Claude answered a background notification on a separate branch of this conversation, and that branch was removed. Its replies are no longer in context; check task output again if you need it.";

/** Add the branch note to the target's text, unless that would follow a tool call. */
function withBranchNote(entry: Record<string, unknown>): string | undefined {
  const message = record(entry.message);
  const content = message?.content;
  if (
    !message ||
    !Array.isArray(content) ||
    content.some((block) => record(block)?.type === "tool_use")
  )
    return undefined;
  return JSON.stringify({
    ...entry,
    message: { ...message, content: [...content, { type: "text", text: branchNote }] },
  });
}

interface TranscriptScan {
  readonly parents: ReadonlyMap<string, unknown>;
  /** The last record with a UUID, in file order. */
  readonly lastUuid: string | undefined;
  readonly malformed: number;
}

async function scanTranscript(file: string, signal?: AbortSignal): Promise<TranscriptScan> {
  const parents = new Map<string, unknown>();
  let lastUuid: string | undefined;
  let malformed = 0;
  for await (const line of readClaudeTranscriptLines(file, signal)) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown> | undefined;
    try {
      entry = record(JSON.parse(line));
    } catch {
      malformed++;
      continue;
    }
    const uuid = uuidOf(entry);
    if (!uuid) continue;
    parents.set(uuid, entry!.parentUuid);
    lastUuid = uuid;
  }
  return { parents, lastUuid, malformed };
}

const missingParentsOf = (parents: ReadonlyMap<string, unknown>) => {
  const missing = new Set<string>();
  for (const parent of parents.values())
    if (typeof parent === "string" && !parents.has(parent)) missing.add(parent);
  return missing;
};

const chainIndex = (parents: ReadonlyMap<string, unknown>) =>
  new Map([...parents].map(([uuid, parentUuid]) => [uuid, { parentUuid }]));

/** F5's own repair files: backups can hold branches that repair deliberately removed. */
const isRepairArtifact = (name: string) =>
  /\.bak-before-repair-|\.receipt$|\.pending$|\.undo-/.test(name);

const MAX_ROTATED_SIBLINGS = 8;

/** Why a moved copy did not qualify, phrased to follow "it". */
function rejectionReason(
  scan: TranscriptScan,
  missing: ReadonlySet<string>,
  known: ReadonlyMap<string, unknown>,
) {
  if (scan.malformed > 0) return "has malformed lines";
  if ([...scan.parents.keys()].some((uuid) => known.has(uuid)))
    return "repeats messages the transcript already has";
  if (![...missing].every((uuid) => scan.parents.has(uuid)))
    return "does not hold every missing message";
  if (scan.lastUuid === undefined || !missing.has(scan.lastUuid))
    return "does not end where the transcript starts";
  return undefined;
}

export type ClaudeTranscriptRejoinPlan =
  | { readonly status: "not_needed" }
  | { readonly status: "refused"; readonly reason: string }
  | {
      readonly status: "planned";
      readonly original: string;
      readonly repaired: string;
      readonly restoredMessages: number;
      readonly rejoinedFrom: ReadonlyArray<string>;
    };

export class ClaudeTranscriptRejoinCancelled extends Error {
  constructor() {
    super("Claude transcript rejoin ran out of time; no changes were made.");
  }
}

/**
 * Plan how to rejoin a transcript whose beginning another tool moved to a
 * sibling file, such as `<session>.jsonl.bak`, while the CLI kept appending to
 * the original path. A sibling is used only when it shares no UUIDs with the
 * transcript, holds every missing parent, and ends at one of them, so the join
 * adds history and cannot change it. Copies with identical bytes count once;
 * differing copies that both fit are refused rather than picked by date.
 * Nothing is written; `signal` and `deadline` stop the work with
 * ClaudeTranscriptRejoinCancelled.
 */
export async function planClaudeTranscriptRejoin(input: {
  file: string;
  target: string;
  signal?: AbortSignal;
  deadline?: number;
}): Promise<ClaudeTranscriptRejoinPlan> {
  const name = path.basename(input.file);
  const checkpoint = () => {
    if (input.signal?.aborted || (input.deadline !== undefined && Date.now() > input.deadline))
      throw new ClaudeTranscriptRejoinCancelled();
  };
  const current = await scanTranscript(input.file, input.signal);
  const parents = new Map(current.parents);
  let missing = missingParentsOf(parents);
  if (missing.size === 0) return { status: "not_needed" };
  if (current.malformed > 0)
    return {
      status: "refused",
      reason: `Claude's transcript is missing its beginning and has malformed lines, so a moved copy cannot be rejoined safely. Restore ${name} from a backup or start a new thread.`,
    };
  const directory = path.dirname(input.file);
  const candidates: Array<{ file: string; modified: number }> = [];
  for (const entry of await readdir(directory)) {
    if (!entry.startsWith(`${name}.`) || isRepairArtifact(entry)) continue;
    const file = path.join(directory, entry);
    const info = await stat(file).catch(() => undefined);
    if (info?.isFile()) candidates.push({ file, modified: info.mtimeMs });
  }
  if (candidates.length === 0)
    return {
      status: "refused",
      reason: `Claude's transcript is missing its beginning and no moved copy was found next to it. Restore ${name} from a backup or start a new thread.`,
    };
  candidates.sort((a, b) => b.modified - a.modified);
  const scans = new Map<string, TranscriptScan>();
  const digests = new Map<string, string>();
  // Oldest piece first once complete; each round finds the piece before the last.
  const pieces: string[] = [];
  let restoredMessages = 0;
  const rejected: string[] = [];
  while (missing.size > 0 && pieces.length < MAX_ROTATED_SIBLINGS) {
    const fitting: string[] = [];
    rejected.length = 0;
    for (const candidate of candidates) {
      if (pieces.includes(candidate.file)) continue;
      checkpoint();
      let scan = scans.get(candidate.file);
      if (!scan) {
        scan = await scanTranscript(candidate.file, input.signal);
        scans.set(candidate.file, scan);
      }
      const reason = rejectionReason(scan, missing, parents);
      if (reason) rejected.push(`${path.basename(candidate.file)} ${reason}`);
      else fitting.push(candidate.file);
    }
    if (fitting.length === 0)
      return {
        status: "refused",
        reason: `Claude's transcript is missing its beginning. A moved copy is next to it but cannot be rejoined: ${rejected.join("; ")}. Restore ${name} from a backup or start a new thread.`,
      };
    if (fitting.length > 1) {
      for (const file of fitting) {
        checkpoint();
        if (!digests.has(file)) digests.set(file, digest(await readFile(file, "utf8")));
      }
      if (new Set(fitting.map((file) => digests.get(file))).size > 1)
        return {
          status: "refused",
          reason: `Claude's transcript is missing its beginning, and several different moved copies could hold it (${fitting.map((file) => path.basename(file)).join(", ")}). Keep only the right copy next to ${name}, then use Repair transcript.`,
        };
    }
    const found = fitting[0]!;
    const scan = scans.get(found)!;
    pieces.unshift(found);
    for (const [uuid, parent] of scan.parents) parents.set(uuid, parent);
    restoredMessages += scan.parents.size;
    missing = missingParentsOf(parents);
  }
  if (missing.size > 0 || !hasClaudeParentChain(chainIndex(parents), input.target))
    return {
      status: "refused",
      reason: `Claude's transcript is missing its beginning, and its moved copies do not restore the conversation this thread resumes from. Restore ${name} from a backup or start a new thread.`,
    };
  checkpoint();
  const original = await readFile(input.file, "utf8");
  const texts = [...(await Promise.all(pieces.map((file) => readFile(file, "utf8")))), original];
  checkpoint();
  // A BOM is valid only at the start of the joined file.
  const repaired = texts
    .map((text, index) => (index > 0 && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text))
    .map((text, index, all) =>
      index < all.length - 1 && !text.endsWith("\n") ? `${text}\n` : text,
    )
    .join("");
  return {
    status: "planned",
    original,
    repaired,
    restoredMessages,
    rejoinedFrom: pieces.map((file) => path.basename(file)),
  };
}

/**
 * Write a planned rejoin with the usual backup, receipt, verification and
 * undo. The cursor keeps its own resume point: rejoining adds history before
 * it and gives no reason to pin a turn boundary. Refuses if the transcript
 * changed since planning.
 */
export async function commitClaudeTranscriptRejoin(
  input: { file: string; target: string; resumeCursor?: unknown },
  plan: Extract<ClaudeTranscriptRejoinPlan, { status: "planned" }>,
) {
  const result = await writeTranscriptRepair(
    input,
    plan.original,
    plan.repaired,
    input.target,
    plan.restoredMessages,
    [],
    0,
    { pin: false },
  );
  return { ...result, rejoinedFrom: plan.rejoinedFrom };
}

/** Plan and write a rejoin; see planClaudeTranscriptRejoin. */
export async function rejoinRotatedClaudeTranscript(input: {
  file: string;
  target: string;
  resumeCursor?: unknown;
  signal?: AbortSignal;
  deadline?: number;
}) {
  const plan = await planClaudeTranscriptRejoin(input);
  if (plan.status !== "planned") return plan;
  if (input.deadline !== undefined && Date.now() > input.deadline)
    throw new ClaudeTranscriptRejoinCancelled();
  return await commitClaudeTranscriptRejoin(input, plan);
}

export async function repairClaudeResumePoint(input: {
  file: string;
  target: string;
  sessionId: string;
  threadId: string;
  providerLogsDir: string;
  resumeCursor?: unknown;
}) {
  const original = await readFile(input.file, "utf8");
  const malformed: number[] = [];
  const persisted = await readClaudeTranscript(input.file, true, {
    skipMalformed: true,
    onMalformed: (line) => malformed.push(line),
  });
  // Quarantine deletes by line number, so a reader that splits lines differently
  // from split("\n") would delete valid records. Refuse instead of guessing.
  // The reader's UTF-8 decoder drops a leading BOM, which JSON.parse rejects.
  const originalLines = (original.charCodeAt(0) === 0xfeff ? original.slice(1) : original).split(
    "\n",
  );
  for (const line of malformed) {
    let parsed = false;
    try {
      JSON.parse(originalLines[line - 1] ?? "");
      parsed = true;
    } catch {
      /* Expected: the reported line is really malformed. */
    }
    if (parsed) throw new Error("Transcript line mapping is inconsistent; no changes were made.");
  }
  if (hasClaudeParentChain(persisted, input.target)) {
    const parsed = originalLines.map((line, index) =>
      malformed.includes(index + 1) || !line.trim() ? undefined : (JSON.parse(line) as unknown),
    );
    const stray = findStrayClaudeRecords(parsed, input.target, input.resumeCursor);
    if (malformed.length === 0 && stray.size === 0)
      return {
        status: "validated" as const,
        restoredMessages: 0,
        quarantinedBranchMessages: 0,
        quarantinedMalformedLines: 0,
        resumeSessionAt: input.target,
        resumeCursor: {
          ...record(input.resumeCursor),
          resumeSessionAt: input.target,
          resumeRecoveryGeneration: randomUUID(),
        },
      };
    // The removed branch can hold replies the user saw, so the model is told.
    const strayRows = [...stray].filter((index) => uuidOf(parsed[index])).length;
    const noted =
      strayRows > 0 ? parsed.findLastIndex((value) => uuidOf(value) === input.target) : -1;
    const repaired = originalLines
      .flatMap((line, index) => {
        if (malformed.includes(index + 1) || stray.has(index)) return [];
        return index === noted ? [withBranchNote(record(parsed[index])!) ?? line] : [line];
      })
      .join("\n");
    return await writeTranscriptRepair(
      input,
      original,
      repaired,
      input.target,
      0,
      malformed,
      strayRows,
    );
  }
  // A missing beginning is recoverable only from a moved copy; logs hold just the tail.
  const rejoined = await rejoinRotatedClaudeTranscript(input);
  if (rejoined.status === "repaired") return rejoined;
  const unrecoverableHead =
    rejoined.status === "refused"
      ? rejoined.reason
      : "No part of Claude's saved transcript has a complete parent chain, so repair has nothing to anchor on. Start a new thread to continue.";
  const events: Array<Record<string, unknown>> = [];
  for (const name of await readdir(input.providerLogsDir)) {
    if (name !== `${input.threadId}.log` && !name.startsWith(`${input.threadId}.log.`)) continue;
    const lines = readCompleteLogLines(path.join(input.providerLogsDir, name));
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
            event.method === "claude/user" ||
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
  const toolResults = new Map<
    string,
    { payload: Record<string, unknown>; block: Record<string, unknown>; createdAt: string }
  >();
  const incompleteTools = new Set<string>();
  const blocks = new Map<number, string>();
  for (const native of events) {
    const payload = record(native.payload)!;
    if (native.createdAt === undefined) continue;
    if (native.method === "claude/assistant" && typeof payload.uuid === "string") {
      assistants.set(payload.uuid, payload);
      assistantTimes.set(payload.uuid, String(native.createdAt));
    }
    if (native.method === "claude/user") {
      const content = record(payload.message)?.content;
      if (Array.isArray(content))
        for (const value of content) {
          const block = record(value);
          if (block?.type === "tool_result" && typeof block.tool_use_id === "string")
            toolResults.set(block.tool_use_id, {
              payload,
              block,
              createdAt: String(native.createdAt),
            });
        }
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
  if (!parent) throw new Error(unrecoverableHead);
  const anchor = persisted.get(parent)!;
  const assistantEnvelope = [...persisted.values()]
    .toReversed()
    .find((entry) => entry.type === "assistant" && entry.sessionId === input.sessionId);
  if (!assistantEnvelope)
    throw new Error(
      "No persisted assistant envelope is available; transcript cannot be repaired safely.",
    );
  const template: Record<string, unknown> = {};
  for (const field of [
    "cwd",
    "sessionId",
    "version",
    "gitBranch",
    "isSidechain",
    "userType",
  ] as const) {
    const value = anchor[field] ?? assistantEnvelope[field];
    if (value !== undefined) template[field] = value;
  }
  const targetTime = assistantTimes.get(input.target) ?? persisted.get(input.target)?.timestamp;
  const anchorTime = String(anchor.timestamp ?? "");
  if (targetTime && anchorTime > String(targetTime))
    throw new Error(
      "The repair target predates newer saved work. Recheck the current thread before repairing.",
    );

  if (!assistants.has(input.target)) {
    assistants.set(input.target, {
      uuid: input.target,
      message: record(persisted.get(input.target)?.message) ?? {
        ...record(assistantEnvelope.message),
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
    for (const id of [...pendingTools]) {
      const result = toolResults.get(id);
      if (!result || (targetTime && result.createdAt > String(targetTime))) continue;
      const uuid =
        typeof result.payload.uuid === "string" && !restored.has(result.payload.uuid)
          ? result.payload.uuid
          : randomUUID();
      append({
        ...template,
        type: "user",
        uuid,
        parentUuid: parent,
        timestamp: result.payload.timestamp ?? result.createdAt,
        message: { role: "user", content: [result.block] },
      });
    }
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
          type: "assistant",
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
      type: "assistant",
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
  const preserved = originalLines
    .filter((line, index) => {
      if (malformed.includes(index + 1)) return false;
      return !line.trim() || !replaced.has(String(record(JSON.parse(line))?.uuid));
    })
    .join("\n");
  const repaired =
    preserved.trimEnd() + "\n" + additions.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  return await writeTranscriptRepair(
    input,
    original,
    repaired,
    input.target,
    additions.length,
    malformed,
    0,
  );
}

interface RepairReceipt {
  originalHash: string;
  repairedHash: string;
  resumeCursor?: unknown;
  recoveredCursor: Record<string, unknown>;
  quarantinedLines: number[];
  createdAt: string;
  undo?: { previousCursor?: unknown; recoveredCursor: Record<string, unknown>; createdAt: string };
}

/** Write a recoverable receipt before replacing bytes; backups stay available for explicit undo. */
async function writeTranscriptRepair(
  input: { file: string; target: string; resumeCursor?: unknown },
  original: string,
  repaired: string,
  target: string,
  restoredMessages: number,
  quarantinedLines: number[],
  quarantinedBranchMessages: number,
  /** `pin: false` keeps the cursor's own resume point instead of pinning the target. */
  options: { pin: boolean } = { pin: true },
) {
  const backup = `${input.file}.bak-before-repair-${randomUUID()}`;
  const temporary = `${backup}.pending`;
  const recoveredCursor = {
    ...record(input.resumeCursor),
    ...(options.pin ? { resumeSessionAt: target } : {}),
    resumeRecoveryGeneration: randomUUID(),
    transcriptRepairBackupId: path.basename(backup),
  };
  delete (recoveredCursor as Record<string, unknown>).missingResumePoint;
  delete (recoveredCursor as Record<string, unknown>).transcriptFork;
  let replaced = false;
  try {
    await copyFile(input.file, backup);
    await chmod(backup, 0o600);
    if ((await readFile(input.file, "utf8")) !== original)
      throw new Error("Transcript changed during repair; retry after the session stops.");
    await writeFile(
      `${backup}.receipt`,
      JSON.stringify({
        originalHash: digest(original),
        repairedHash: digest(repaired),
        resumeCursor: input.resumeCursor,
        recoveredCursor,
        quarantinedLines,
        createdAt: new Date().toISOString(),
      } satisfies RepairReceipt),
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(temporary, repaired, { flag: "wx", mode: 0o600 });
    // Fence again after preparing the replacement, including external writers.
    if ((await readFile(input.file, "utf8")) !== original)
      throw new Error("Transcript changed during repair; retry after the session stops.");
    await rename(temporary, input.file);
    replaced = true;
    // Any verification failure, including a read error, must restore the backup.
    // Otherwise the file and receipt change without the cursor following them.
    let verified = false;
    try {
      let malformed = 0;
      const entries = await readClaudeTranscript(input.file, false, {
        skipMalformed: true,
        onMalformed: () => malformed++,
      });
      verified = malformed === 0 && isResumableClaudeTarget(entries, target);
    } catch {
      /* Treated as a failed verification below. */
    }
    if (!verified) {
      await copyFile(backup, input.file);
      replaced = false;
      throw new Error("Transcript verification failed; restored the backup.");
    }
  } finally {
    await unlink(temporary).catch(() => {});
    if (!replaced) {
      await unlink(`${backup}.receipt`).catch(() => {});
      await unlink(backup).catch(() => {});
    }
  }
  return {
    status: "repaired" as const,
    backupId: path.basename(backup),
    restoredMessages,
    quarantinedBranchMessages,
    quarantinedMalformedLines: quarantinedLines.length,
    resumeSessionAt: target,
    resumeCursor: recoveredCursor,
  };
}

/** Reconcile an interrupted file/cursor commit only when its hashes and old cursor still match. */
export async function recoverClaudeTranscriptCursor(
  file: string,
  cursor: unknown,
): Promise<unknown> {
  const hash = digest(await readFile(file, "utf8"));
  const names = (await readdir(path.dirname(file))).filter(
    (name) =>
      name.startsWith(`${path.basename(file)}.bak-before-repair-`) && name.endsWith(".receipt"),
  );
  const receipts: RepairReceipt[] = [];
  for (const name of names) {
    try {
      receipts.push(
        JSON.parse(await readFile(path.join(path.dirname(file), name), "utf8")) as RepairReceipt,
      );
    } catch {
      /* Incomplete preparation never authorizes a cursor change. */
    }
  }
  receipts.sort((a, b) =>
    String(b.undo?.createdAt ?? b.createdAt).localeCompare(
      String(a.undo?.createdAt ?? a.createdAt),
    ),
  );
  for (const receipt of receipts) {
    const undo = receipt.undo;
    if (undo && hash === receipt.originalHash && sameRecoveryPoint(cursor, undo.previousCursor))
      return undo.recoveredCursor;
    if (!undo && hash === receipt.repairedHash && sameRecoveryPoint(cursor, receipt.resumeCursor))
      return receipt.recoveredCursor;
  }
  return cursor;
}

function sameRecoveryPoint(left: unknown, right: unknown): boolean {
  const a = record(left);
  const b = record(right);
  return (
    a?.resume === b?.resume &&
    a?.resumeSessionAt === b?.resumeSessionAt &&
    a?.resumeRecoveryGeneration === b?.resumeRecoveryGeneration
  );
}

/** Expose undo only while the complete transcript still matches the verified replacement. */
export async function canUndoClaudeResumeRepair(file: string, backupId: string): Promise<boolean> {
  try {
    const receipt = await readRepairReceipt(file, backupId);
    return digest(await readFile(file, "utf8")) === receipt.repairedHash;
  } catch {
    return false;
  }
}

async function readRepairReceipt(file: string, backupId: string): Promise<RepairReceipt> {
  if (
    path.basename(backupId) !== backupId ||
    !backupId.startsWith(`${path.basename(file)}.bak-before-repair-`)
  )
    throw new Error("Invalid transcript backup.");
  return JSON.parse(
    await readFile(path.join(path.dirname(file), `${backupId}.receipt`), "utf8"),
  ) as RepairReceipt;
}

/** Restore exact backup bytes, journaling the cursor change and refusing newer transcript writes. */
export async function undoClaudeResumeRepair(
  file: string,
  backupId: string,
  previousCursor?: unknown,
) {
  const receipt = await readRepairReceipt(file, backupId);
  if (digest(await readFile(file, "utf8")) !== receipt.repairedHash)
    throw new Error("Transcript changed after repair; undo would discard newer work.");
  const backup = path.join(path.dirname(file), backupId);
  if (digest(await readFile(backup, "utf8")) !== receipt.originalHash)
    throw new Error("Transcript backup changed; undo cannot safely restore it.");
  const temporary = `${backup}.undo-${randomUUID()}`;
  const recoveredCursor = {
    ...record(receipt.resumeCursor),
    resumeRecoveryGeneration: randomUUID(),
  };
  receipt.undo = {
    previousCursor: previousCursor ?? receipt.recoveredCursor,
    recoveredCursor,
    createdAt: new Date().toISOString(),
  };
  const receiptTemporary = `${temporary}.receipt`;
  try {
    await writeFile(receiptTemporary, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
    await rename(receiptTemporary, `${backup}.receipt`);
    await copyFile(backup, temporary);
    if (digest(await readFile(file, "utf8")) !== receipt.repairedHash)
      throw new Error("Transcript changed after repair; undo would discard newer work.");
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
    await unlink(receiptTemporary).catch(() => {});
  }
  return previousCursor === undefined ? receipt.resumeCursor : recoveredCursor;
}
