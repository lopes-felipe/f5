import { mkdtemp, writeFile, readFile, rm, appendFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectClaudeResumePoint,
  repairClaudeResumePoint,
  undoClaudeResumeRepair,
} from "./StuckTurnRepair.ts";
import {
  recoverClaudeTranscriptCursor,
  canUndoClaudeResumeRepair,
} from "./ClaudeTranscriptRepair.ts";
import {
  classifyClaudeResumePoint,
  findClaudeActiveLeaf,
  hasClaudeParentChain,
  readClaudeTranscript,
  readClaudeTranscriptLines,
  resolveClaudeResumePoint,
  isClaudeMissingResumeMessageError,
} from "../provider/claudeTranscript.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const envelope = {
  cwd: "/project",
  sessionId: "session",
  version: "2.1",
  gitBranch: "main",
  isSidechain: false,
  timestamp: "2026-10-07T09:37:00Z",
};
async function fixture(
  content: unknown[] = [
    {
      ...envelope,
      uuid: "root",
      parentUuid: null,
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "saved" }] },
    },
  ],
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "f5-transcript-test-"));
  dirs.push(dir);
  const file = path.join(dir, "session.jsonl");
  await writeFile(file, content.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { file, target: "target", sessionId: "session", threadId: "thread", providerLogsDir: dir };
}
const logged = (uuid: string, content: unknown[], method = "claude/assistant") =>
  `NTIVE: ${JSON.stringify({ event: { createdAt: "2026-10-07T09:38:00Z", method, payload: { session_id: "session", uuid, message: { id: `message-${uuid}`, role: "assistant", content } } } })}\n`;

describe("Claude transcript recovery", () => {
  it("selects the newest intact boundary, rejecting missing parents and cycles", async () => {
    const input = await fixture();
    const entries = await readClaudeTranscript(input.file);
    entries.set("broken", { parentUuid: "missing" });
    entries.set("cycle", { parentUuid: "cycle" });
    expect(
      resolveClaudeResumePoint(entries, "absent", [
        { assistantUuid: "root" },
        { assistantUuid: "broken" },
        { assistantUuid: "cycle" },
      ]),
    ).toEqual({ kind: "selected", uuid: "root" });
    expect(resolveClaudeResumePoint(entries, "root", [], "root")).toEqual({ kind: "none" });
    expect(isClaudeMissingResumeMessageError("No message found with message.uuid of: target")).toBe(
      true,
    );
    expect(isClaudeMissingResumeMessageError("No conversation found: session")).toBe(false);
  });
  it("restores exact logged content and envelope, closes unsaved tools and supports byte-exact undo", async () => {
    const input = await fixture([
      {
        ...envelope,
        uuid: "root",
        parentUuid: null,
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tool", name: "Read", input: { file_path: "/project/file" } },
          ],
        },
      },
    ]);
    const original = await readFile(input.file, "utf8");
    const content = [
      { type: "thinking", thinking: "existing research", signature: "signed" },
      { type: "text", text: "interrupted answer" },
    ];
    await writeFile(path.join(input.providerLogsDir, "thread.log"), logged("target", content));
    expect(await inspectClaudeResumePoint(input.file, "target")).toEqual({
      reason: "missing_resume_point",
    });
    const result = await repairClaudeResumePoint({
      ...input,
      resumeCursor: { resumeSessionAt: "target" },
    });
    if (result.status !== "repaired") throw new Error("Expected a repaired transcript");
    const entries = await readClaudeTranscript(input.file);
    expect(hasClaudeParentChain(entries, "target")).toBe(true);
    expect(entries.get("target")).toMatchObject({
      cwd: envelope.cwd,
      sessionId: "session",
      version: "2.1",
      gitBranch: "main",
      message: {
        id: "message-target",
        content: [
          ...content,
          { type: "text", text: expect.stringContaining("[Transcript repair]") },
        ],
      },
    });
    expect([...entries.values()].find((entry) => entry.type === "user")).toMatchObject({
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool",
            is_error: true,
            content: expect.stringContaining("not saved"),
          },
        ],
      },
    });
    expect(await undoClaudeResumeRepair(input.file, result.backupId)).toEqual({
      resumeSessionAt: "target",
    });
    expect(await readFile(input.file, "utf8")).toBe(original);
  });
  it("drops a trailing tool input without a block stop, without fabricating a call", async () => {
    const input = await fixture();
    const partial = {
      createdAt: "2026-10-07T09:38:00Z",
      method: "claude/stream_event/content_block_start",
      payload: {
        session_id: "session",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "incomplete", name: "Write" },
        },
      },
    };
    await writeFile(
      path.join(input.providerLogsDir, "thread.log"),
      `NTIVE: ${JSON.stringify(partial)}\n` +
        logged("target", [{ type: "tool_use", id: "incomplete", name: "Write", input: {} }]),
    );
    await repairClaudeResumePoint(input);
    const entries = await readClaudeTranscript(input.file);
    expect(entries.get("target")).toMatchObject({
      message: {
        content: [{ type: "text", text: expect.stringContaining("incomplete tool calls") }],
      },
    });
    expect([...entries.values()].some((entry) => entry.type === "user")).toBe(false);
  });
  it("rebuilds a broken persisted parent and ignores only an incomplete final JSONL fragment", async () => {
    const input = await fixture();
    await appendFile(
      input.file,
      JSON.stringify({
        ...envelope,
        uuid: "target",
        parentUuid: "lost",
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "preserved payload" }] },
      }) + '\n{"uuid":"truncated',
    );
    await repairClaudeResumePoint(input);
    const entries = await readClaudeTranscript(input.file);
    expect(hasClaudeParentChain(entries, "target")).toBe(true);
    expect(entries.get("target")).toMatchObject({
      message: {
        content: [
          { type: "text", text: "preserved payload" },
          { type: "text", text: expect.any(String) },
        ],
      },
    });
  });
  it("refuses undo after a newer turn and refuses malformed middle records", async () => {
    const input = await fixture();
    const result = await repairClaudeResumePoint(input);
    if (result.status !== "repaired") throw new Error("Expected a repaired transcript");
    await appendFile(input.file, JSON.stringify({ uuid: "new", parentUuid: "target" }) + "\n");
    await expect(undoClaudeResumeRepair(input.file, result.backupId)).rejects.toThrow("newer work");
    await writeFile(input.file, '{invalid}\n{"uuid":"new","parentUuid":null}\n');
    await expect(readClaudeTranscript(input.file)).rejects.toThrow("malformed record");
  });
  it("never reconstructs an assistant from an unterminated crashed log record", async () => {
    const input = await fixture();
    const log = path.join(input.providerLogsDir, "thread.log");
    await writeFile(log, logged("target", [{ type: "text", text: "not committed" }]).trimEnd());
    await repairClaudeResumePoint(input);
    // The existing explicit repair may synthesize a transparent placeholder,
    // but it must never claim the uncommitted assistant text was recovered.
    expect(await readFile(input.file, "utf8")).not.toContain("not committed");
    const complete = await fixture();
    await writeFile(
      path.join(complete.providerLogsDir, "thread.log"),
      logged("target", [{ type: "text", text: "committed text" }]),
    );
    const result = await repairClaudeResumePoint(complete);
    expect(result.status).toBe("repaired");
    expect(hasClaudeParentChain(await readClaudeTranscript(complete.file), "target")).toBe(true);
    expect(await readFile(complete.file, "utf8")).toContain("committed text");
  });
  it("quarantines malformed middle records, retaining original bytes and line numbers in the backup receipt", async () => {
    const input = await fixture();
    await appendFile(
      input.file,
      '{truncated\n{"uuid":"metadata","parentUuid":"root","type":"system"}\n',
    );
    const original = await readFile(input.file, "utf8");
    await writeFile(
      path.join(input.providerLogsDir, "thread.log"),
      logged("target", [{ type: "text", text: "recovered" }]),
    );
    const result = await repairClaudeResumePoint(input);
    if (result.status !== "repaired") throw new Error("Expected repair");
    expect(hasClaudeParentChain(await readClaudeTranscript(input.file), "target")).toBe(true);
    expect(await readFile(path.join(input.providerLogsDir, result.backupId), "utf8")).toBe(
      original,
    );
    expect(
      JSON.parse(
        await readFile(path.join(input.providerLogsDir, `${result.backupId}.receipt`), "utf8"),
      ).quarantinedLines,
    ).toEqual([2]);
  });
  it("numbers transcript lines exactly like split on newline", async () => {
    const input = await fixture();
    const text = [
      `{"a":"${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}"}`,
      "",
      "lone\rcarriage-return",
      "{truncated",
      '{"b":1}',
    ].join("\n");
    await writeFile(input.file, text);
    const lines: string[] = [];
    for await (const line of readClaudeTranscriptLines(input.file)) lines.push(line);
    expect(lines).toEqual(text.split("\n"));
  });
  it("reads records containing U+2028/U+2029 as valid and keeps them eligible", async () => {
    const input = await fixture([
      {
        ...envelope,
        uuid: "target",
        parentUuid: null,
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`,
            },
          ],
        },
      },
      { uuid: "next", parentUuid: "target", type: "user" },
    ]);
    const entries = await readClaudeTranscript(input.file);
    expect([...entries.keys()]).toEqual(["target", "next"]);
    expect(await inspectClaudeResumePoint(input.file, "target")).toEqual({ reason: "eligible" });
  });
  it("quarantines only the truncated line next to a U+2028 record and keeps that record byte-exact", async () => {
    const separated = JSON.stringify({
      ...envelope,
      uuid: "root",
      parentUuid: null,
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `a${String.fromCharCode(0x2028)}b` }],
      },
    });
    const target = JSON.stringify({ uuid: "target", parentUuid: "root", type: "user" });
    const trailing = JSON.stringify({ uuid: "after", parentUuid: "target", type: "system" });
    const input = await fixture();
    await writeFile(input.file, `${separated}\n{truncated\n${target}\n${trailing}\n`);
    const result = await repairClaudeResumePoint(input);
    if (result.status !== "repaired") throw new Error("Expected repair");
    expect(await readFile(input.file, "utf8")).toBe(`${separated}\n${target}\n${trailing}\n`);
    expect(hasClaudeParentChain(await readClaudeTranscript(input.file), "target")).toBe(true);
    expect(
      JSON.parse(
        await readFile(path.join(input.providerLogsDir, `${result.backupId}.receipt`), "utf8"),
      ).quarantinedLines,
    ).toEqual([2]);
  });
  it("rebuilds a missing target in a transcript that starts with a BOM", async () => {
    const input = await fixture();
    await writeFile(input.file, String.fromCharCode(0xfeff) + (await readFile(input.file, "utf8")));
    await writeFile(
      path.join(input.providerLogsDir, "thread.log"),
      logged("target", [{ type: "text", text: "recovered" }]),
    );
    const result = await repairClaudeResumePoint(input);
    expect(result.status).toBe("repaired");
    expect(hasClaudeParentChain(await readClaudeTranscript(input.file), "target")).toBe(true);
  });
  it("revalidates an intact target without requiring an assistant envelope or rewriting bytes", async () => {
    const input = await fixture([{ uuid: "target", parentUuid: null, type: "user" }]);
    const original = await readFile(input.file, "utf8");
    const result = await repairClaudeResumePoint(input);
    expect(result.status).toBe("validated");
    expect(await readFile(input.file, "utf8")).toBe(original);
  });
  it("refuses to append an older interrupted target after newer saved work", async () => {
    const input = await fixture([
      {
        ...envelope,
        uuid: "root",
        parentUuid: null,
        type: "assistant",
        timestamp: "2026-10-07T10:00:00Z",
        message: { role: "assistant", content: [] },
      },
    ]);
    const original = await readFile(input.file, "utf8");
    await writeFile(
      path.join(input.providerLogsDir, "thread.log"),
      logged("target", [{ type: "text", text: "older" }]),
    );
    await expect(repairClaudeResumePoint(input)).rejects.toThrow("predates newer saved work");
    expect(await readFile(input.file, "utf8")).toBe(original);
  });
  it("restores logged tool results across rotated logs and copies only anchor envelope fields", async () => {
    const input = await fixture([
      {
        ...envelope,
        requestId: "stale",
        isApiErrorMessage: true,
        uuid: "root",
        parentUuid: null,
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "first",
              name: "Write",
              input: { file_path: "/project/file", content: "already written" },
            },
          ],
        },
      },
    ]);
    await writeFile(
      path.join(input.providerLogsDir, "thread.log.1"),
      logged(
        "result-first",
        [{ type: "tool_result", tool_use_id: "first", content: "saved output", is_error: false }],
        "claude/user",
      ) + logged("middle", [{ type: "tool_use", id: "second", name: "Read", input: {} }]),
    );
    await writeFile(
      path.join(input.providerLogsDir, "thread.log"),
      (
        logged(
          "result-second",
          [{ type: "tool_result", tool_use_id: "second", content: "read output" }],
          "claude/user",
        ) + logged("target", [{ type: "text", text: "answer" }])
      ).replaceAll("09:38:00", "09:39:00"),
    );
    await repairClaudeResumePoint(input);
    const entries = await readClaudeTranscript(input.file);
    expect(entries.get("target")).not.toHaveProperty("requestId");
    expect(entries.get("result-first")).not.toHaveProperty("isApiErrorMessage");
    expect(entries.get("result-first")).toMatchObject({
      message: {
        content: [
          { type: "tool_result", tool_use_id: "first", content: "saved output", is_error: false },
        ],
      },
    });
    expect(entries.get("result-second")).toMatchObject({
      parentUuid: "middle",
      message: {
        content: [{ type: "tool_result", tool_use_id: "second", content: "read output" }],
      },
    });
    expect(hasClaudeParentChain(entries, "target")).toBe(true);
  });
  it("reconciles interrupted repair and undo commits without changing an explicit rewind", async () => {
    const input = await fixture();
    const cursor = { resume: "session", resumeSessionAt: "target" };
    const result = await repairClaudeResumePoint({ ...input, resumeCursor: cursor });
    if (result.status !== "repaired") throw new Error("Expected repair");
    expect(await recoverClaudeTranscriptCursor(input.file, cursor)).toEqual(result.resumeCursor);
    const rewind = { ...cursor, resumeSessionAt: "root" };
    expect(await recoverClaudeTranscriptCursor(input.file, rewind)).toEqual(rewind);
    expect(await canUndoClaudeResumeRepair(input.file, result.backupId)).toBe(true);
    const undoCursor = await undoClaudeResumeRepair(
      input.file,
      result.backupId,
      result.resumeCursor,
    );
    expect(await recoverClaudeTranscriptCursor(input.file, result.resumeCursor)).toEqual(
      undoCursor,
    );
  });
});

describe("Claude transcript forks", () => {
  // Stable UUIDs, because the resume cursor only accepts UUID boundaries.
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const root = id(1);
  const hook1 = id(2);
  const user2 = id(3);
  const reply2 = id(4);
  const hook2 = id(5);
  const staleNote = id(6);
  const strayReply = id(7);
  const note = id(8);
  const target = id(9);
  const hookT = id(10);
  const strayLast = id(11);
  const boundary = id(12);
  const at = (second: number) => `2026-10-27T16:17:${String(second).padStart(2, "0")}.000Z`;
  const row = (uuid: string, parentUuid: string | null, type: string, second: number) => ({
    ...envelope,
    uuid,
    parentUuid,
    type,
    timestamp: at(second),
    message: { role: type === "assistant" ? "assistant" : "user", content: [] },
  });
  // The shape seen in production: two task notifications were dequeued together
  // and one was parented to the stop-hook record of an older turn. After a
  // compaction that kept a preserved segment, the CLI resolves the fork by the
  // last row, which is on the stray branch, so the thread's latest turn is hidden.
  const forked = [
    {
      ...row(boundary, null, "system", 0),
      subtype: "compact_boundary",
      compactMetadata: {
        preservedSegment: { headUuid: root, tailUuid: root, anchorUuid: boundary },
      },
    },
    row(root, boundary, "assistant", 1),
    row(hook1, root, "system", 2),
    row(user2, root, "user", 3),
    row(reply2, user2, "assistant", 4),
    row(hook2, reply2, "system", 5),
    { type: "queue-operation", operation: "enqueue", timestamp: at(6) },
    row(staleNote, hook1, "user", 6),
    row(note, hook2, "user", 6),
    row(strayReply, staleNote, "assistant", 7),
    row(target, note, "assistant", 8),
    row(hookT, target, "system", 9),
    row(strayLast, strayReply, "assistant", 10),
    { type: "last-prompt", leafUuid: strayLast },
    { type: "last-prompt", leafUuid: hookT },
  ];
  const cursor = {
    resume: "00000000-0000-4000-8000-0000000000ff",
    resumeSessionAt: target,
    turnBoundaries: [
      { turnId: "turn-1", assistantUuid: root },
      { turnId: "turn-2", assistantUuid: reply2 },
      { turnId: "turn-3", assistantUuid: target },
    ],
  };

  it("follows the last non-sidechain row in file order, not the newest timestamp", () => {
    const entries = new Map<string, Record<string, unknown>>([
      ["a", { parentUuid: null, type: "user", timestamp: at(1) }],
      ["b", { parentUuid: "a", type: "assistant", timestamp: at(9) }],
      ["c", { parentUuid: "a", type: "assistant", timestamp: at(2) }],
      ["side", { parentUuid: "a", type: "assistant", isSidechain: true }],
    ]);
    expect(findClaudeActiveLeaf(entries)).toBe("c");
    expect(classifyClaudeResumePoint(entries, "a")).toBe("active");
    expect(classifyClaudeResumePoint(entries, "b")).toBe("off_branch");
    expect(classifyClaudeResumePoint(entries, "missing")).toBe("missing");
    entries.set("compacted", { parentUuid: null, type: "assistant" });
    entries.set("tail", { parentUuid: "c", type: "user" });
    expect(classifyClaudeResumePoint(entries, "compacted")).toBe("detached");
    expect(resolveClaudeResumePoint(entries, "compacted", [])).toEqual({
      kind: "selected",
      uuid: "compacted",
    });
  });

  it("follows the last-prompt checkpoint when no compaction was relinked", async () => {
    // Observed with CLI 2.1.295: without a relinked compaction, a checkpoint on
    // the thread's branch wins even when the stray branch was written later.
    const uncompacted = forked
      .slice(1)
      .map((entry) =>
        "uuid" in entry && entry.uuid === root ? { ...entry, parentUuid: null } : entry,
      );
    const entries = await readClaudeTranscript((await fixture(uncompacted)).file, false);
    // The CLI resumes from the message above the checkpointed stop-hook record.
    expect(findClaudeActiveLeaf(entries)).toBe(target);
    expect(classifyClaudeResumePoint(entries, target)).toBe("active");
    // A non-explicit checkpoint yields to a later row that descends from it.
    const advanced = await readClaudeTranscript(
      (await fixture([...uncompacted, row(id(99), hookT, "user", 11)])).file,
      false,
    );
    expect(findClaudeActiveLeaf(advanced)).toBe(id(99));
    // A checkpoint on the stray branch hides the thread's turn.
    const stale = await readClaudeTranscript(
      (await fixture([...uncompacted, { type: "last-prompt", leafUuid: strayLast }])).file,
      false,
    );
    expect(classifyClaudeResumePoint(stale, target)).toBe("off_branch");
  });

  it("reports a fork instead of falling back past the thread's latest turn", async () => {
    const input = await fixture(forked);
    const entries = await readClaudeTranscript(input.file, false);
    expect(findClaudeActiveLeaf(entries)).toBe(strayLast);
    expect(classifyClaudeResumePoint(entries, target)).toBe("off_branch");
    expect(classifyClaudeResumePoint(entries, root)).toBe("active");
    const forkedSelection = { kind: "forked", target, activeLeaf: strayLast };
    expect(resolveClaudeResumePoint(entries, target, cursor.turnBoundaries)).toEqual(
      forkedSelection,
    );
    // The automatic retry excludes the rejected UUID; it must still not drop turns.
    expect(resolveClaudeResumePoint(entries, target, cursor.turnBoundaries, target)).toEqual(
      forkedSelection,
    );
  });

  it("repairs a fork by quarantining the stray branch, with byte-exact undo", async () => {
    const input = { ...(await fixture(forked)), target };
    const original = await readFile(input.file, "utf8");
    expect(await inspectClaudeResumePoint(input.file, target)).toEqual({
      reason: "branch_mismatch",
    });
    const result = await repairClaudeResumePoint({ ...input, resumeCursor: cursor });
    if (result.status !== "repaired") throw new Error("Expected a repaired transcript");
    expect(result.quarantinedBranchMessages).toBe(4);
    expect(result.restoredMessages).toBe(0);
    expect(result.resumeCursor).toMatchObject({ resumeSessionAt: target });
    const entries = await readClaudeTranscript(input.file);
    for (const uuid of [hook1, staleNote, strayReply, strayLast])
      expect(entries.has(uuid)).toBe(false);
    expect(classifyClaudeResumePoint(entries, target)).toBe("active");
    const repaired = await readFile(input.file, "utf8");
    expect(repaired).toContain(`"leafUuid":"${hookT}"`);
    expect(repaired).not.toContain(`"leafUuid":"${strayLast}"`);
    expect(repaired).toContain('"type":"queue-operation"');
    expect(result.quarantinedMalformedLines).toBe(0);
    // The model is told that replies on the removed branch left its context.
    const message = entries.get(target)?.message as
      | { content: Array<{ text?: string }> }
      | undefined;
    const content = message?.content ?? [];
    expect(content.at(-1)?.text).toContain("separate branch of this conversation");
    expect(await inspectClaudeResumePoint(input.file, target)).toEqual({ reason: "eligible" });
    await undoClaudeResumeRepair(input.file, result.backupId, result.resumeCursor);
    expect(await readFile(input.file, "utf8")).toBe(original);
  });

  it("refuses to quarantine a branch that holds a turn of this thread", async () => {
    const input = { ...(await fixture(forked)), target };
    const original = await readFile(input.file, "utf8");
    await expect(
      repairClaudeResumePoint({
        ...input,
        resumeCursor: {
          ...cursor,
          turnBoundaries: [
            ...cursor.turnBoundaries,
            { turnId: "stray", assistantUuid: strayReply },
          ],
        },
      }),
    ).rejects.toThrow("Both branches");
    expect(await readFile(input.file, "utf8")).toBe(original);
  });

  it("still validates an intact target on the active chain without rewriting", async () => {
    const linear = forked.filter(
      (entry) => !("uuid" in entry) || ![staleNote, strayReply, strayLast].includes(entry.uuid),
    );
    const input = { ...(await fixture(linear)), target };
    const original = await readFile(input.file, "utf8");
    const result = await repairClaudeResumePoint({ ...input, resumeCursor: cursor });
    expect(result).toMatchObject({ status: "validated", quarantinedBranchMessages: 0 });
    expect(await readFile(input.file, "utf8")).toBe(original);
  });

  // Each layout below was checked against the bundled CLI 2.1.295 with
  // --resume-session-at, and the expected verdicts are the CLI's.
  const earlier = id(20);
  const prompt = id(21);
  const side = id(22);
  const linear = [row(root, null, "user", 1), row(earlier, root, "assistant", 2)];
  const repairLayout = async (rows: unknown[]) => {
    const input = { ...(await fixture(rows)), target };
    const result = await repairClaudeResumePoint({
      ...input,
      resumeCursor: { ...cursor, turnBoundaries: [{ turnId: "turn-3", assistantUuid: target }] },
    });
    const entries = await readClaudeTranscript(input.file, false);
    return { result, entries, text: await readFile(input.file, "utf8") };
  };

  it("lets a later message override an explicit checkpoint", async () => {
    const rows = [
      ...linear,
      { type: "last-prompt", leafUuid: earlier, explicit: true },
      row(prompt, earlier, "user", 3),
      row(target, prompt, "assistant", 4),
    ];
    const entries = await readClaudeTranscript((await fixture(rows)).file, false);
    expect(findClaudeActiveLeaf(entries)).toBe(target);
    expect(classifyClaudeResumePoint(entries, target)).toBe("active");
    expect((await repairLayout(rows)).result.status).toBe("validated");
  });

  it("removes an explicit checkpoint that pins an earlier turn", async () => {
    const rows = [
      ...linear,
      row(prompt, earlier, "user", 3),
      row(target, prompt, "assistant", 4),
      { type: "last-prompt", leafUuid: earlier, explicit: true },
    ];
    const entries = await readClaudeTranscript((await fixture(rows)).file, false);
    expect(findClaudeActiveLeaf(entries)).toBe(earlier);
    expect(classifyClaudeResumePoint(entries, target)).toBe("off_branch");
    const repaired = await repairLayout(rows);
    expect(repaired.result).toMatchObject({ status: "repaired", quarantinedBranchMessages: 0 });
    expect(repaired.text).not.toContain('"last-prompt"');
    expect(classifyClaudeResumePoint(repaired.entries, target)).toBe("active");
  });

  it("removes a checkpoint before the target and a later row off its lineage", async () => {
    const rows = [
      ...linear,
      row(prompt, earlier, "user", 3),
      row(target, prompt, "assistant", 4),
      { type: "last-prompt", leafUuid: earlier },
      row(side, root, "system", 5),
    ];
    const entries = await readClaudeTranscript((await fixture(rows)).file, false);
    expect(classifyClaudeResumePoint(entries, target)).toBe("off_branch");
    const repaired = await repairLayout(rows);
    expect(repaired.result).toMatchObject({ status: "repaired", quarantinedBranchMessages: 1 });
    expect(repaired.entries.has(side)).toBe(false);
    expect(classifyClaudeResumePoint(repaired.entries, target)).toBe("active");
  });

  it("skips progress records the CLI does not load", async () => {
    const progress = { ...row(side, root, "progress", 3), data: { type: "bash_progress" } };
    const trailing = [row(root, null, "user", 1), row(target, root, "assistant", 2), progress];
    const entries = await readClaudeTranscript((await fixture(trailing)).file, false);
    expect(findClaudeActiveLeaf(entries)).toBe(target);
    expect(classifyClaudeResumePoint(entries, target)).toBe("active");
    expect((await repairLayout(trailing)).result.status).toBe("validated");
    // A row under a progress record is loaded under that record's parent.
    const forwarded = [
      row(root, null, "user", 1),
      { ...progress, timestamp: at(2) },
      row(earlier, side, "assistant", 3),
      row(prompt, root, "user", 4),
      row(target, prompt, "assistant", 5),
    ];
    const view = await readClaudeTranscript((await fixture(forwarded)).file, false);
    expect(classifyClaudeResumePoint(view, earlier)).toBe("off_branch");
    expect(classifyClaudeResumePoint(view, target)).toBe("active");
  });

  // Before the compaction: root, earlier, then the preserved prompt and reply.
  const old = id(30);
  const kept = id(31);
  const summary = id(32);
  const compactedRows = [
    row(root, null, "user", 1),
    row(earlier, root, "assistant", 2),
    row(old, earlier, "user", 3),
    row(kept, old, "assistant", 4),
    {
      ...row(boundary, null, "system", 5),
      subtype: "compact_boundary",
      compactMetadata: { preservedSegment: { headUuid: old, tailUuid: kept, anchorUuid: summary } },
    },
    { ...row(summary, boundary, "user", 6), isCompactSummary: true },
    row(prompt, kept, "user", 7),
    row(target, prompt, "assistant", 8),
  ];

  it("follows parents the CLI relinks across a preserved compaction", async () => {
    // The notification's parent is dropped with the history before the
    // compaction, so the CLI moves it under the preserved tail, beside the target.
    const rows = [
      ...compactedRows,
      row(staleNote, earlier, "user", 9),
      row(strayReply, staleNote, "assistant", 10),
    ];
    const entries = await readClaudeTranscript((await fixture(rows)).file, false);
    expect(findClaudeActiveLeaf(entries)).toBe(strayReply);
    expect(classifyClaudeResumePoint(entries, target)).toBe("off_branch");
    // History before the compaction is no longer loaded; it stays selectable.
    expect(classifyClaudeResumePoint(entries, earlier)).toBe("detached");
    const repaired = await repairLayout(rows);
    expect(repaired.result).toMatchObject({ status: "repaired", quarantinedBranchMessages: 2 });
    expect(classifyClaudeResumePoint(repaired.entries, target)).toBe("active");
  });

  it("picks among several relinked leaves by checkpoint, or the only leaf", async () => {
    const branches = [
      ...compactedRows,
      row(staleNote, kept, "user", 9),
      row(strayReply, staleNote, "assistant", 10),
    ];
    for (const explicit of [true, false]) {
      const rows = [...branches, { type: "last-prompt", leafUuid: target, explicit }];
      const entries = await readClaudeTranscript((await fixture(rows)).file, false);
      expect(findClaudeActiveLeaf(entries)).toBe(target);
    }
    // A checkpoint on a stop-hook record is not a leaf message, so the last row wins.
    const hooked = [...branches.slice(0, 8), row(hookT, target, "system", 9), ...branches.slice(8)];
    const hookedEntries = await readClaudeTranscript(
      (await fixture([...hooked, { type: "last-prompt", leafUuid: hookT }])).file,
      false,
    );
    expect(findClaudeActiveLeaf(hookedEntries)).toBe(strayReply);
    const single = await readClaudeTranscript(
      (await fixture([...compactedRows, row(hookT, target, "system", 9)])).file,
      false,
    );
    expect(findClaudeActiveLeaf(single)).toBe(target);
  });
});
