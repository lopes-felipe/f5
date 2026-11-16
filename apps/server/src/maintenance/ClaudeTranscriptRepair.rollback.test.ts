import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repairClaudeResumePoint } from "./ClaudeTranscriptRepair.ts";

// Real files cannot make the reader disagree with split("\n") or fail after the
// rename, so inject those faults into one chosen readClaudeTranscript call.
const fault = vi.hoisted(() => ({
  call: 0,
  failOn: 0,
  mode: "throw" as "throw" | "malformed",
  line: 0,
}));

vi.mock("../provider/claudeTranscript.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../provider/claudeTranscript.ts")>();
  return {
    ...actual,
    readClaudeTranscript: async (...args: Parameters<typeof actual.readClaudeTranscript>) => {
      if (++fault.call === fault.failOn) {
        if (fault.mode === "throw") throw new Error("injected read failure");
        args[2]?.onMalformed?.(fault.line);
      }
      return actual.readClaudeTranscript(...args);
    },
  };
});

const dirs: string[] = [];
beforeEach(() => {
  Object.assign(fault, { call: 0, failOn: 0, mode: "throw", line: 0 });
});
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture(lines: string[]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "f5-transcript-rollback-"));
  dirs.push(dir);
  const file = path.join(dir, "session.jsonl");
  const original = lines.join("\n") + "\n";
  await writeFile(file, original);
  return {
    dir,
    original,
    input: {
      file,
      target: "target",
      sessionId: "session",
      threadId: "thread",
      providerLogsDir: dir,
    },
  };
}

const root = JSON.stringify({ uuid: "root", parentUuid: null, type: "assistant" });
const target = JSON.stringify({ uuid: "target", parentUuid: "root", type: "user" });

describe("Claude transcript repair rollback", () => {
  it.each(["throw", "malformed"] as const)(
    "restores the original bytes and removes the backup when verification sees %s",
    async (mode) => {
      const { dir, original, input } = await fixture([root, "{truncated", target]);
      // Call 1 is the initial read; call 2 verifies the replaced file.
      Object.assign(fault, { failOn: 2, mode, line: 1 });
      await expect(repairClaudeResumePoint(input)).rejects.toThrow(
        "Transcript verification failed; restored the backup.",
      );
      expect(await readFile(input.file, "utf8")).toBe(original);
      expect(await readdir(dir)).toEqual(["session.jsonl"]);
    },
  );

  it("refuses to quarantine a reported line that parses, before writing anything", async () => {
    const { dir, original, input } = await fixture([root, target, "{truncated"]);
    Object.assign(fault, { failOn: 1, mode: "malformed", line: 2 });
    await expect(repairClaudeResumePoint(input)).rejects.toThrow(
      "Transcript line mapping is inconsistent; no changes were made.",
    );
    expect(await readFile(input.file, "utf8")).toBe(original);
    expect(await readdir(dir)).toEqual(["session.jsonl"]);
  });
});
