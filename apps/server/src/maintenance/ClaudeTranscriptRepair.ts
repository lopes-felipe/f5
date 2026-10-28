import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, copyFile, rename, readdir, chmod, unlink } from "node:fs/promises";
import { readCompleteLogLines } from "./completeLogLines.ts";
import path from "node:path";
import {
  claudeTranscriptLeafHints,
  classifyClaudeResumePoint,
  findClaudeActiveLeaf,
  hasClaudeParentChain,
  readClaudeTranscript,
  transcriptRecord as record,
  withClaudeTranscriptLeafHints,
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

/**
 * Collect the branches that fork off the target's lineage and outrank it as the
 * CLI's resume leaf. Each pass removes the subtree that holds the current active
 * leaf, starting at the first entry below the fork point, until the target is on
 * the active chain again. Turns this thread recorded are never removed.
 */
export function findStrayClaudeBranches(
  entries: ReadonlyMap<string, Record<string, unknown>>,
  target: string,
  resumeCursor?: unknown,
): ReadonlySet<string> {
  const stray = new Set<string>();
  if (classifyClaudeResumePoint(entries, target) !== "off_branch") return stray;
  const lineage = new Set<string>();
  for (let cursor: unknown = target; typeof cursor === "string" && !lineage.has(cursor); ) {
    lineage.add(cursor);
    cursor = entries.get(cursor)?.parentUuid;
  }
  const children = new Map<string, string[]>();
  for (const [uuid, entry] of entries)
    if (typeof entry.parentUuid === "string")
      children.set(entry.parentUuid, [...(children.get(entry.parentUuid) ?? []), uuid]);
  // Checkpoints into quarantined entries leave the file with them.
  const hints = claudeTranscriptLeafHints(entries);
  const remaining = new Map(entries);
  const resync = () =>
    withClaudeTranscriptLeafHints(
      remaining,
      hints && {
        ...hints,
        checkpoints: hints.checkpoints.filter((row) => !row.leafUuid || !stray.has(row.leafUuid)),
      },
    );
  while (classifyClaudeResumePoint(resync(), target) === "off_branch") {
    let branchRoot: string | undefined;
    let cursor: unknown = findClaudeActiveLeaf(remaining);
    const seen = new Set<string>();
    while (typeof cursor === "string" && !lineage.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      branchRoot = cursor;
      cursor = remaining.get(cursor)?.parentUuid;
    }
    if (typeof cursor !== "string" || !lineage.has(cursor) || branchRoot === undefined)
      throw new Error("Could not locate where Claude's transcript forked; no changes were made.");
    const pending = [branchRoot];
    while (pending.length > 0) {
      const uuid = pending.pop()!;
      if (!remaining.delete(uuid)) continue;
      stray.add(uuid);
      pending.push(...(children.get(uuid) ?? []));
    }
  }
  const owned = readClaudeResumeState(resumeCursor)?.turnBoundaries ?? [];
  if (owned.some((boundary) => stray.has(boundary.assistantUuid)))
    throw new Error(
      "Both branches of Claude's transcript hold turns from this thread; no changes were made.",
    );
  return stray;
}

/** Stray records, plus `last-prompt` pointers to them, leave the main transcript. */
function isStrayClaudeLine(line: string, stray: ReadonlySet<string>): boolean {
  if (stray.size === 0 || !line.trim()) return false;
  const entry = record(JSON.parse(line));
  return (
    stray.has(String(entry?.uuid)) ||
    (entry?.type === "last-prompt" && stray.has(String(entry.leafUuid)))
  );
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
    const stray = findStrayClaudeBranches(persisted, input.target, input.resumeCursor);
    if (malformed.length === 0 && stray.size === 0)
      return {
        status: "validated" as const,
        restoredMessages: 0,
        quarantinedBranchMessages: 0,
        resumeSessionAt: input.target,
        resumeCursor: {
          ...record(input.resumeCursor),
          resumeSessionAt: input.target,
          resumeRecoveryGeneration: randomUUID(),
        },
      };
    const repaired = originalLines
      .filter((line, index) => !malformed.includes(index + 1) && !isStrayClaudeLine(line, stray))
      .join("\n");
    return await writeTranscriptRepair(
      input,
      original,
      repaired,
      input.target,
      0,
      malformed,
      stray.size,
    );
  }
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
  if (!parent) throw new Error("No intact parent chain is available to anchor the repair.");
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
) {
  const backup = `${input.file}.bak-before-repair-${randomUUID()}`;
  const temporary = `${backup}.pending`;
  const recoveredCursor = {
    ...record(input.resumeCursor),
    resumeSessionAt: target,
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
