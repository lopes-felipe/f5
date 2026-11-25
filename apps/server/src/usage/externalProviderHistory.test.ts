import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { readAntigravityUsage } from "./antigravityUsageReader.ts";
import { readCursorAccountUsage } from "./cursorUsageReader.ts";
import { readOpenCodeUsage } from "./opencodeUsageReader.ts";

it("reads OpenCode SQLite and JSON without counting a migrated message twice", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "f5-opencode-usage-"));
  try {
    const jsonStore = path.join(root, "storage", "message", "session");
    await mkdir(jsonStore, { recursive: true });
    const data = JSON.stringify({
      role: "assistant",
      modelID: "test-model",
      sessionID: "session",
      time: { created: 2_000 },
      tokens: { input: 30, output: 12, reasoning: 4, cache: { read: 15, write: 5 } },
      cost: 0.05,
    });
    const db = new DatabaseSync(path.join(root, "opencode.db"));
    try {
      db.exec("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER)");
      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("migrated", "session", data, 2_000);
    } finally {
      db.close();
    }
    await writeFile(path.join(jsonStore, "migrated.json"), data);
    await writeFile(path.join(jsonStore, "legacy-only.json"), data);
    const result = await readOpenCodeUsage(root, 1_000);
    expect(result.error).toBe(false);
    const records = result.files.flatMap((file) => file.records);
    expect(records.map((record) => record.dedupeKey)).toEqual([
      "opencode:migrated",
      "opencode:legacy-only",
    ]);
    expect(records[0]).toMatchObject({
      totals: {
        uncachedInputTokens: 30,
        cachedInputTokens: 15,
        cacheCreationTokens: 5,
        outputTokens: 16,
      },
      reportedCostUsd: 0.05,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reads Antigravity generation metadata from a read-only trajectory database", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "f5-antigravity-usage-"));
  try {
    const nested = (id: number, bytes: number[]) => [(id << 3) | 2, bytes.length, ...bytes];
    const usage = [2 << 3, 20, 3 << 3, 5, 5 << 3, 10];
    const timestamp = nested(9, nested(4, [1 << 3, 100]));
    const model = Buffer.from("gemini-test");
    const metadata = nested(1, [...nested(4, usage), ...timestamp, ...nested(19, [...model])]);
    // Field 19's tag occupies two varint bytes.
    const tag19 = metadata.indexOf((19 << 3) | 2);
    metadata.splice(tag19, 1, 0x9a, 0x01);
    metadata[1]! += 1;
    const db = new DatabaseSync(path.join(root, "conversation.db"));
    try {
      db.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
      db.prepare("INSERT INTO gen_metadata VALUES (?, ?)").run(0, Buffer.from(metadata));
    } finally {
      db.close();
    }
    const result = await readAntigravityUsage(root, 50_000);
    expect(result.errors).toEqual([]);
    expect(result.files.flatMap((file) => file.records)).toMatchObject([
      {
        model: "gemini-test",
        sessionId: "conversation",
        timestampMs: 100_000,
        totals: { uncachedInputTokens: 20, cachedInputTokens: 10, outputTokens: 5 },
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("uses Cursor account events from the fixed origin and preserves reported costs", async () => {
  const token = `f5-test.${Buffer.from(JSON.stringify({ sub: "auth|f5-test" })).toString("base64url")}.fixture`;
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      totalUsageEventsCount: 1,
      usageEventsDisplay: [
        {
          timestamp: "2000",
          model: "test-model",
          conversationId: "conversation",
          tokenUsage: { inputTokens: 30, outputTokens: 10, cacheReadTokens: 50, totalCents: 7 },
        },
      ],
    }),
  );
  const result = await readCursorAccountUsage(token, 1_000, 3_000, request);
  expect(result.error).toBeNull();
  expect(request).toHaveBeenCalledWith(
    "https://cursor.com/api/dashboard/get-filtered-usage-events",
    expect.objectContaining({ redirect: "error" }),
  );
  expect(result.records).toMatchObject([
    {
      provider: "cursor",
      model: "test-model",
      reportedCostUsd: 0.07,
      totals: { uncachedInputTokens: 30, cachedInputTokens: 50, outputTokens: 10 },
    },
  ]);
});
