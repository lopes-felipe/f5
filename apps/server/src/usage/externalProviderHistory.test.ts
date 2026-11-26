import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { readAntigravityUsage } from "./antigravityUsageReader.ts";
import { readCursorAccountUsage } from "./cursorUsageReader.ts";
import { readOpenCodeUsage } from "./opencodeUsageReader.ts";
import { recordedExternalPredicate } from "./museRecordedIntervals.ts";

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
    await writeFile(path.join(root, "opencode.db"), "unreadable SQLite data");
    const partial = await readOpenCodeUsage(root, 1_000);
    expect(partial.error).toBe(true);
    expect(partial.files.flatMap((file) => file.records)).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reads Antigravity metadata and resolves bare, effort-suffixed and numeric model names", async () => {
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
    const namedModel = (name: string, idBytes: number[]) =>
      nested(1, [3 << 3, ...idBytes, 0x9a, 0x01, name.length, ...Buffer.from(name)]);
    const db = new DatabaseSync(path.join(root, "conversation.db"));
    try {
      db.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
      db.prepare("INSERT INTO gen_metadata VALUES (?, ?)").run(0, Buffer.from(metadata));
      db.prepare("INSERT INTO gen_metadata VALUES (?, ?)").run(
        1,
        Buffer.from(namedModel("gemini-3.8-flash", [0xa6, 0x0a])),
      );
      db.prepare("INSERT INTO gen_metadata VALUES (?, ?)").run(
        2,
        Buffer.from(namedModel("gemini-3.8-flash-high", [0xa6, 0x0a])),
      );
    } finally {
      db.close();
    }
    const steps = new DatabaseSync(path.join(root, "a-steps.db"));
    try {
      steps.exec("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
      const insert = steps.prepare("INSERT INTO steps VALUES (?, ?)");
      insert.run(3, Buffer.from(nested(9, [1 << 3, 0xa6, 0x0a, 2 << 3, 7])));
      insert.run(4, Buffer.from(nested(9, [1 << 3, 0xf5, 0x0b, 2 << 3, 9])));
    } finally {
      steps.close();
    }
    const result = await readAntigravityUsage(root, 50_000);
    expect(result.errors).toEqual([]);
    const records = result.files.flatMap((file) => file.records);
    expect(records).toHaveLength(3);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: "gemini-3.8-flash",
          totals: expect.objectContaining({ uncachedInputTokens: 7 }),
        }),
        expect.objectContaining({
          model: "gemini-4-hydrogen",
          totals: expect.objectContaining({ uncachedInputTokens: 9 }),
        }),
        expect.objectContaining({
          model: "gemini-test",
          sessionId: "conversation",
          timestampMs: 100_000,
          totals: expect.objectContaining({
            uncachedInputTokens: 20,
            cachedInputTokens: 10,
            outputTokens: 5,
          }),
        }),
      ]),
    );
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

it.each(["exact", "overlap", "changed"] as const)(
  "completes Cursor pagination for %s pages",
  async (mode) => {
    const token = `test.${Buffer.from(JSON.stringify({ sub: "auth|fixture" })).toString("base64url")}.fixture`;
    const events = Array.from({ length: 1002 }, (_, index) => ({
      timestamp: 1000 + index,
      model: "test-model",
      tokenUsage: { inputTokens: 1 },
    }));
    const response = (count: number, rows: typeof events) =>
      Response.json({ totalUsageEventsCount: count, usageEventsDisplay: rows });
    const request = vi.fn<typeof fetch>();
    request.mockResolvedValueOnce(response(mode === "exact" ? 1000 : 1002, events.slice(0, 1000)));
    if (mode === "overlap") request.mockResolvedValueOnce(response(1002, events.slice(999)));
    if (mode === "changed") {
      request.mockResolvedValueOnce(response(1003, events.slice(1000)));
      request.mockResolvedValueOnce(response(1002, events.slice(0, 1000)));
      request.mockResolvedValueOnce(response(1002, events.slice(1000)));
    }
    const result = await readCursorAccountUsage(token, 0, 3_000, request);
    expect(result.error).toBeNull();
    expect(result.records).toHaveLength(mode === "exact" ? 1000 : 1002);
    expect(request).toHaveBeenCalledTimes(mode === "exact" ? 1 : mode === "overlap" ? 2 : 4);
  },
);

it.each(["antigravity", "cursor", "opencode"] as const)(
  "reconciles %s records using exact session identity",
  (provider) => {
    const recorded = recordedExternalPredicate([
      {
        provider,
        sessionId: "native-session",
        startedAt: "2026-11-01T00:00:00.000Z",
        endedAt: "2026-11-01T00:01:00.000Z",
      },
    ]);
    const record = {
      provider,
      sessionId: "native-session",
      model: "test-model",
      dedupeKey: null,
      reportedCostUsd: null,
      totals: {
        uncachedInputTokens: 1,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
      },
      timestampMs: Date.parse(
        provider === "cursor" ? "2026-11-01T00:01:02.000Z" : "2026-11-01T00:00:30.000Z",
      ),
    };
    expect(recorded(record)).toBe(true);
    expect(recorded({ ...record, sessionId: "other-session" })).toBe(false);
    expect(recorded({ ...record, timestampMs: record.timestampMs + 120_000 })).toBe(false);
  },
);
