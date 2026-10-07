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
  hasClaudeParentChain,
  readClaudeTranscript,
  selectClaudeResumePoint,
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
      selectClaudeResumePoint(entries, "absent", [
        { assistantUuid: "root" },
        { assistantUuid: "broken" },
        { assistantUuid: "cycle" },
      ]),
    ).toBe("root");
    expect(selectClaudeResumePoint(entries, "root", [], "root")).toBeUndefined();
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
    await appendFile(input.file, JSON.stringify({ uuid: "new", parentUuid: "target" }) + "\n");
    await expect(undoClaudeResumeRepair(input.file, result.backupId)).rejects.toThrow("newer work");
    await writeFile(input.file, '{invalid}\n{"uuid":"new","parentUuid":null}\n');
    await expect(readClaudeTranscript(input.file)).rejects.toThrow("malformed record");
  });
});
