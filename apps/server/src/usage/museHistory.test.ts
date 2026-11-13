import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, appendFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  externalMuseHistory,
  museHistoryBuckets,
  parseMuseHistoryLine,
  readMuseHistory,
  scanMuseHistory,
  museHistoryUsageRow,
  MuseHistoryReader,
} from "./museHistory.ts";
import { aggregateUsageMetrics } from "./usageSummary.ts";
import { recordedMusePredicate } from "./museRecordedIntervals.ts";

const entry = (id = "inference", session = "parent") => ({
  schema_version: 1,
  record_type: "event",
  payload_type: "runtime.session",
  payload_schema_version: 3,
  id,
  recorded_at: 1_785_578_400_123_456,
  stream: { kind: "session", id: session },
  payload: {
    source_run_record_id: id,
    event: {
      kind: "automated_review_completed",
      model: { model_id: "unknown-model" },
      usage: {
        input_tokens: 100,
        cached_input_tokens: 60,
        cache_write_tokens: 10,
        output_tokens: 20,
        reasoning_tokens: 8,
      },
    },
  },
});
const parse = (value: unknown) => parseMuseHistoryLine(JSON.stringify(value));
const historyNow = () => Date.parse("2026-11-01T00:00:00.000Z");

describe("Muse native usage", () => {
  it("uses bounded inclusive model-call intervals without suppressing reviews or independent children", () => {
    const value = entry();
    const record = parse({
      ...value,
      payload: { ...value.payload, event: { ...value.payload.event, kind: "model_completed" } },
    })!;
    const test = recordedMusePredicate([
      {
        sessionId: record.sessionId,
        startedAt: "2026-08-01T12:00:00+02:00",
        endedAt: "2026-08-01T12:01:00+02:00",
      },
    ]);
    expect(test({ ...record, timestamp: "2026-08-01T10:00:00.000Z" })).toBe(true);
    expect(test({ ...record, timestamp: "2026-08-01T10:01:00.000Z" })).toBe(true);
    expect(test({ ...record, timestamp: "2026-08-01T09:59:59.999Z" })).toBe(false);
    expect(test({ ...record, timestamp: "2026-08-01T10:01:00.001Z" })).toBe(false);
    expect(test({ ...record, kind: "automated_review_completed" })).toBe(false);
    expect(test({ ...record, sessionId: "independent-child" })).toBe(false);
  });
  it("reuses unchanged files, resumes partial appends, shares in-flight reads and replaces rotated data", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "muse-incremental-"));
    try {
      const dir = path.join(home, "sessions", "session");
      await mkdir(dir, { recursive: true });
      const filename = path.join(dir, "session.jsonl");
      await writeFile(filename, JSON.stringify(entry()) + "\n");
      // A restored file's mtime is not evidence that its events are old.
      await utimes(filename, new Date("2000-01-01"), new Date("2000-01-01"));
      let now = historyNow();
      const reader = new MuseHistoryReader(home, () => now);
      const pending = reader.read();
      expect(reader.read()).toBe(pending);
      const first = await pending;
      expect(first).toHaveLength(1);
      expect(await reader.read()).toBe(first);
      const appended = JSON.stringify(entry("next"));
      await appendFile(filename, appended.slice(0, -8));
      expect(await reader.read()).toBe(first);
      await appendFile(filename, appended.slice(-8) + "\n");
      const grown = await reader.read();
      expect(grown.map((record) => record.key)).toEqual(["inference", "next"]);
      expect(await reader.read()).toBe(grown);
      await writeFile(filename, JSON.stringify(entry("rotated")) + "\n");
      expect((await reader.read()).map((record) => record.key)).toEqual(["rotated"]);
      now = Date.parse("2027-08-01T00:00:00.000Z");
      expect(await reader.read()).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it("keeps cache and reasoning subsets, unknown models, dates and custom pricing", () => {
    const record = parse(entry())!;
    expect(record.timestamp).toBe("2026-08-01T10:00:00.123Z");
    expect(record.row).toMatchObject({
      inputTokens: 100,
      cacheReadTokens: 60,
      cacheWriteTokens: 10,
      totalTokens: 120,
    });
    expect(aggregateUsageMetrics([museHistoryUsageRow(record)]).unpricedNativeInferenceCount).toBe(
      1,
    );
    expect(aggregateUsageMetrics([museHistoryUsageRow(record)]).turnCount).toBe(0);
    expect(
      aggregateUsageMetrics(
        [museHistoryUsageRow(record)],
        [
          {
            provider: "muse",
            model: "unknown-model",
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 2,
            cacheReadUsdPerMillion: null,
            cacheWriteUsdPerMillion: null,
          },
        ],
      ).estimatedCostUsd,
    ).toBe(0.00014);
    expect(
      museHistoryBuckets(
        [record],
        [
          {
            key: "day",
            startAt: "2026-08-01T00:00:00.000Z",
            endAt: "2026-08-02T00:00:00.000Z",
          },
        ],
      ),
    ).toHaveLength(1);
    expect(
      museHistoryBuckets(
        [record],
        [
          {
            key: "day",
            startAt: "2026-08-02T00:00:00.000Z",
            endAt: "2026-08-03T00:00:00.000Z",
          },
        ],
      ),
    ).toEqual([]);
  });
  it("deduplicates copies across child sessions and F5-recorded sessions", () => {
    const records = [
      parse(entry())!,
      parse(entry("inference", "child"))!,
      parse(entry("review", "child"))!,
    ];
    expect(externalMuseHistory(records)).toHaveLength(2);
    expect(
      externalMuseHistory(records, (record) => record.sessionId === "parent").map(
        (record) => record.key,
      ),
    ).toEqual(["review"]);
  });
  it("rejects invalid schemas, timestamps, partial lines and rollups", () => {
    expect(parseMuseHistoryLine("{")).toBeNull();
    for (const value of [
      { ...entry(), schema_version: 2 },
      { ...entry(), recorded_at: -1 },
      { ...entry(), recorded_at: Number.MAX_SAFE_INTEGER + 1 },
      { ...entry(), payload_type: "run.telemetry" },
    ])
      expect(parse(value)).toBeNull();
  });
  it("streams nested sessions and retries incomplete appended records", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "muse-usage-"));
    try {
      const directory = path.join(home, "sessions", "parent", "child");
      await mkdir(directory, { recursive: true });
      const filename = path.join(directory, "session.jsonl");
      await writeFile(
        filename,
        JSON.stringify(entry()) + "\n" + JSON.stringify(entry("next")).slice(0, -1),
      );
      expect(await readMuseHistory(home, undefined, historyNow)).toHaveLength(1);
      await writeFile(
        filename,
        JSON.stringify(entry()) + "\n" + JSON.stringify(entry("next")) + "\n",
      );
      expect(await readMuseHistory(home, undefined, historyNow)).toHaveLength(2);
      const grouped = await scanMuseHistory(home, () => false, undefined, historyNow);
      expect(grouped).toHaveLength(1);
      expect(grouped[0]?.row).toMatchObject({
        nativeInferenceCount: 2,
        turnCount: 0,
        totalTokens: 240,
      });
      const external = await scanMuseHistory(
        home,
        (record) => record.key === "next",
        undefined,
        historyNow,
      );
      expect(external[0]?.row).toMatchObject({ nativeInferenceCount: 1, totalTokens: 120 });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
