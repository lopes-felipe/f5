import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readClaudeTranscriptPage } from "./claudeTranscript.ts";

describe("bounded native transcript pages", () => {
  it("advances native cursors without accumulating earlier pages", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "f5-child-page-"));
    try {
      const file = path.join(directory, "agent.jsonl");
      await writeFile(
        file,
        "\n" + Array.from({ length: 5 }, (_, id) => JSON.stringify({ id })).join("\n"),
      );
      const first = await readClaudeTranscriptPage(file, 0, 2);
      const second = await readClaudeTranscriptPage(file, Number(first.nextCursor), 2);
      const third = await readClaudeTranscriptPage(file, Number(second.nextCursor), 2);
      expect(first.entries).toEqual([{ id: 0 }, { id: 1 }]);
      expect(second.entries).toEqual([{ id: 2 }, { id: 3 }]);
      expect(third.entries).toEqual([{ id: 4 }]);
      expect(third.nextCursor).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("omits oversized and malformed entries and continues after them", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "f5-child-page-"));
    try {
      const file = path.join(directory, "agent.jsonl");
      await writeFile(
        file,
        JSON.stringify({ output: "a".repeat(200_000) }) + '\ninvalid\n{"id":3}\n',
      );
      const page = await readClaudeTranscriptPage(file, 0, 3);
      expect(page.entries[0]?.omitted).toBe(true);
      expect(page.entries[1]?.omitted).toBe(true);
      expect(page.entries[2]).toEqual({ id: 3 });
      expect(JSON.stringify(page).length).toBeLessThan(1000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
