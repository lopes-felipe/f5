import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  rejoinRotatedClaudeTranscript,
  repairClaudeResumePoint,
  undoClaudeResumeRepair,
} from "./ClaudeTranscriptRepair.ts";
import { classifyClaudeResumePoint, readClaudeTranscript } from "../provider/claudeTranscript.ts";

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
  timestamp: "2026-10-29T12:00:00Z",
};
const user = (uuid: string, parentUuid: string | null) => ({
  ...envelope,
  uuid,
  parentUuid,
  type: "user",
  message: { role: "user", content: [{ type: "text", text: `user ${uuid}` }] },
});
const assistant = (uuid: string, parentUuid: string) => ({
  ...envelope,
  uuid,
  parentUuid,
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: `assistant ${uuid}` }] },
});
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

/** A transcript whose beginning another tool moved to `session.jsonl.bak` mid-turn. */
async function rotated(
  head: string | unknown[] = [user("root", null), assistant("a1", "root")],
  extra: Record<string, string> = {},
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "f5-transcript-rejoin-"));
  dirs.push(dir);
  const file = path.join(dir, "session.jsonl");
  const headText = typeof head === "string" ? head : jsonl(head);
  const tailText = jsonl([user("u2", "a1"), assistant("target", "u2")]);
  await writeFile(`${file}.bak`, headText);
  await writeFile(file, tailText);
  for (const [name, text] of Object.entries(extra)) await writeFile(path.join(dir, name), text);
  return {
    dir,
    headText,
    tailText,
    input: {
      file,
      target: "target",
      sessionId: "session",
      threadId: "thread",
      providerLogsDir: dir,
    },
  };
}

describe("rejoining a transcript whose beginning was moved", () => {
  it("prepends the moved copy, keeps it untouched and supports byte-exact undo", async () => {
    const { input, headText, tailText } = await rotated();
    const result = await repairClaudeResumePoint(input);
    expect(result).toMatchObject({
      status: "repaired",
      restoredMessages: 2,
      rejoinedFrom: ["session.jsonl.bak"],
      resumeSessionAt: "target",
    });
    expect(await readFile(input.file, "utf8")).toBe(headText + tailText);
    expect(await readFile(`${input.file}.bak`, "utf8")).toBe(headText);
    const entries = await readClaudeTranscript(input.file);
    expect(classifyClaudeResumePoint(entries, "target")).toBe("active");

    await undoClaudeResumeRepair(input.file, (result as { backupId: string }).backupId);
    expect(await readFile(input.file, "utf8")).toBe(tailText);
  });

  it("joins a chain of moved copies in order", async () => {
    const { input, tailText } = await rotated([assistant("a1", "a0")], {
      "session.jsonl.bak.1": jsonl([user("root", null), assistant("a0", "root")]),
    });
    const result = await rejoinRotatedClaudeTranscript(input);
    expect(result?.rejoinedFrom).toEqual(["session.jsonl.bak.1", "session.jsonl.bak"]);
    const joined = await readFile(input.file, "utf8");
    expect(joined).toBe(
      jsonl([user("root", null), assistant("a0", "root")]) +
        jsonl([assistant("a1", "a0")]) +
        tailText,
    );
  });

  it("adds the separating newline when the moved copy ends without one", async () => {
    const head = jsonl([user("root", null), assistant("a1", "root")]).trimEnd();
    const { input, tailText } = await rotated(head);
    await rejoinRotatedClaudeTranscript(input);
    expect(await readFile(input.file, "utf8")).toBe(`${head}\n${tailText}`);
  });

  it.each([
    [
      "shares a UUID with the transcript",
      [user("root", null), assistant("u2", "root"), assistant("a1", "root")],
    ],
    [
      "does not end at the missing parent",
      [user("root", null), assistant("a1", "root"), assistant("x", "a1")],
    ],
    [
      "has a malformed line",
      `${JSON.stringify(user("root", null))}\n{"broken"\n${JSON.stringify(assistant("a1", "root"))}\n`,
    ],
  ])("refuses a copy that %s", async (_label, head) => {
    const { input, tailText } = await rotated(head as string | unknown[]);
    expect(await rejoinRotatedClaudeTranscript(input)).toBeUndefined();
    await expect(repairClaudeResumePoint(input)).rejects.toThrow(/missing its beginning/);
    expect(await readFile(input.file, "utf8")).toBe(tailText);
  });

  it("never uses F5's own repair backups as a source", async () => {
    const { input, dir, headText, tailText } = await rotated();
    await rm(`${input.file}.bak`);
    await writeFile(path.join(dir, "session.jsonl.bak-before-repair-x"), headText);
    expect(await rejoinRotatedClaudeTranscript(input)).toBeUndefined();
    await expect(repairClaudeResumePoint(input)).rejects.toThrow(
      "Claude's transcript is missing its beginning and no moved copy was found next to it. Restore session.jsonl from a backup or start a new thread.",
    );
    expect(await readFile(input.file, "utf8")).toBe(tailText);
  });

  it("leaves an intact transcript alone and writes nothing after the deadline", async () => {
    const { input, tailText } = await rotated();
    expect(
      await rejoinRotatedClaudeTranscript({ ...input, deadline: Date.now() - 1 }),
    ).toBeUndefined();
    expect(await readFile(input.file, "utf8")).toBe(tailText);

    await rejoinRotatedClaudeTranscript(input);
    const joined = await readFile(input.file, "utf8");
    expect(await rejoinRotatedClaudeTranscript(input)).toBeUndefined();
    expect(await readFile(input.file, "utf8")).toBe(joined);
  });

  it("prefers the newest qualifying copy", async () => {
    const { input, dir } = await rotated(undefined, {
      "session.jsonl.old": jsonl([user("old-root", null), assistant("a1", "old-root")]),
    });
    const old = new Date("2026-01-01T00:00:00Z");
    await utimes(path.join(dir, "session.jsonl.old"), old, old);
    const result = await rejoinRotatedClaudeTranscript(input);
    expect(result?.rejoinedFrom).toEqual(["session.jsonl.bak"]);
  });
});
