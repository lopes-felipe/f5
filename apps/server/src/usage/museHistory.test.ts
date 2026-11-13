import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  externalMuseHistory,
  museHistoryBuckets,
  parseMuseHistoryLine,
  readMuseHistory,
  scanMuseHistory,
} from "./museHistory.ts";
import { aggregateUsageMetrics } from "./usageSummary.ts";

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

describe("Muse native usage", () => {
  it("keeps cache and reasoning subsets, unknown models, dates and custom pricing", () => {
    const record = parse(entry())!;
    expect(record.timestamp).toBe("2026-08-01T10:00:00.123Z");
    expect(record.row).toMatchObject({
      inputTokens: 100,
      cacheReadTokens: 60,
      cacheWriteTokens: 10,
      totalTokens: 120,
    });
    expect(aggregateUsageMetrics([record.row]).unpricedNativeInferenceCount).toBe(1);
    expect(aggregateUsageMetrics([record.row]).turnCount).toBe(0);
    expect(
      aggregateUsageMetrics(
        [record.row],
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
      expect(await readMuseHistory(home)).toHaveLength(1);
      await writeFile(
        filename,
        JSON.stringify(entry()) + "\n" + JSON.stringify(entry("next")) + "\n",
      );
      expect(await readMuseHistory(home)).toHaveLength(2);
      const grouped = await scanMuseHistory(home, () => false);
      expect(grouped).toHaveLength(1);
      expect(grouped[0]?.row).toMatchObject({
        nativeInferenceCount: 2,
        turnCount: 0,
        totalTokens: 240,
      });
      const external = await scanMuseHistory(home, (record) => record.key === "next");
      expect(external[0]?.row).toMatchObject({ nativeInferenceCount: 1, totalTokens: 120 });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
