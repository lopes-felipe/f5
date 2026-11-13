import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { Option, Schema } from "effect";
import type { UsageAggregateRow, UsageBucketRange } from "../persistence/Services/UsageFacts.ts";
import { readBoundedJsonlLines } from "../provider/agentTranscript/boundedJsonl.ts";

const Entry = Schema.Struct({
  schema_version: Schema.Literal(1),
  record_type: Schema.Literal("event"),
  payload_type: Schema.Literal("runtime.session"),
  payload_schema_version: Schema.Literals([1, 3]),
  id: Schema.NonEmptyString,
  recorded_at: Schema.Number,
  stream: Schema.Struct({ kind: Schema.Literal("session"), id: Schema.NonEmptyString }),
  payload: Schema.Struct({
    source_run_record_id: Schema.optional(Schema.NonEmptyString),
    event: Schema.Struct({
      kind: Schema.Literals(["model_completed", "automated_review_completed"]),
      model: Schema.Union([
        Schema.NonEmptyString,
        Schema.Struct({ model_id: Schema.NonEmptyString }),
      ]),
      usage: Schema.Struct({
        input_tokens: Schema.optional(Schema.Unknown),
        output_tokens: Schema.optional(Schema.Unknown),
        cache_read_tokens: Schema.optional(Schema.Unknown),
        cached_input_tokens: Schema.optional(Schema.Unknown),
        cached_tokens: Schema.optional(Schema.Unknown),
        cache_write_tokens: Schema.optional(Schema.Unknown),
      }),
    }),
  }),
});
const decode = Schema.decodeUnknownOption(Entry);
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;

export interface MuseHistoryRecord {
  readonly key: string;
  readonly sessionId: string;
  readonly timestamp: string;
  readonly row: UsageAggregateRow;
}

export function parseMuseHistoryLine(line: string): MuseHistoryRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const decoded = decode(value);
  if (Option.isNone(decoded)) return null;
  const entry = decoded.value;
  if (!Number.isSafeInteger(entry.recorded_at) || entry.recorded_at < 0) return null;
  const { model, usage } = entry.payload.event;
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  if (!Number.isSafeInteger(input + output)) return null;
  if (!input && !output) return null;
  const read = Math.min(
    input,
    count(usage.cache_read_tokens ?? usage.cached_input_tokens ?? usage.cached_tokens),
  );
  const write = Math.min(input - read, count(usage.cache_write_tokens));
  return {
    key: entry.payload.source_run_record_id ?? entry.id,
    sessionId: entry.stream.id,
    timestamp: new Date(Math.trunc(entry.recorded_at / 1000)).toISOString(),
    row: {
      provider: "muse",
      model: typeof model === "string" ? model : model.model_id,
      // F5's non-Claude input counters include cache subsets.
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: read,
      cacheWriteTokens: write,
      totalTokens: input + output,
      providerReportedCostUsd: null,
      nativeInferenceCount: 1,
      unpricedNativeInferenceCount: 1,
      turnCount: 0,
      reportedTokenTurnCount: 0,
      pricedTurnCount: 0,
      unpricedTurnCount: 0,
      recordedTurnCount: 0,
      legacyCostEventCount: 0,
      inputTokenTurnCount: 0,
      outputTokenTurnCount: 0,
      cacheReadTokenTurnCount: 0,
      cacheWriteTokenTurnCount: 0,
      totalTokenTurnCount: 0,
    },
  };
}

/** Stream bounded records, including nested child sessions; never follow directory symlinks. */
export async function readMuseHistory(
  home: string,
  signal?: AbortSignal,
  visit?: (record: MuseHistoryRecord) => void,
): Promise<MuseHistoryRecord[]> {
  const records: MuseHistoryRecord[] = [];
  const directories = [path.join(home, "sessions")];
  while (directories.length) {
    signal?.throwIfAborted();
    const directory = directories.pop()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) directories.push(filename);
      if (!entry.isFile() || entry.name !== "session.jsonl") continue;
      const file = await open(filename, "r").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!file) continue;
      try {
        for await (const line of readBoundedJsonlLines(file, {
          start: 0,
          dir: "fwd",
          maxLineBytes: 8 * 1024 * 1024,
          maxScanBytes: Infinity,
          ...(signal ? { signal } : {}),
        })) {
          if (!line.terminated || !line.text) continue;
          const record = parseMuseHistoryLine(line.text);
          if (record) {
            if (visit) visit(record);
            else records.push(record);
          }
        }
      } finally {
        await file.close();
      }
    }
  }
  return records;
}

/** Keep aggregate rows per UTC minute/model; retain only minimal identity data for deduplication. */
export async function scanMuseHistory(
  home: string,
  isRecorded: (record: MuseHistoryRecord) => boolean,
  signal?: AbortSignal,
): Promise<MuseHistoryRecord[]> {
  const totals = new Map<string, MuseHistoryRecord>();
  type Counters = { group: string; input: number; output: number; read: number; write: number };
  const seen = new Map<string, Counters | null>();
  const add = (counters: Counters, sign: number) => {
    const record = totals.get(counters.group)!;
    const row = record.row;
    totals.set(counters.group, {
      ...record,
      row: {
        ...row,
        inputTokens: row.inputTokens + sign * counters.input,
        outputTokens: row.outputTokens + sign * counters.output,
        cacheReadTokens: row.cacheReadTokens + sign * counters.read,
        cacheWriteTokens: row.cacheWriteTokens + sign * counters.write,
        totalTokens: row.totalTokens + sign * (counters.input + counters.output),
        nativeInferenceCount: (row.nativeInferenceCount ?? 0) + sign,
        unpricedNativeInferenceCount: (row.unpricedNativeInferenceCount ?? 0) + sign,
      },
    });
  };
  await readMuseHistory(home, signal, (record) => {
    const previous = seen.get(record.key);
    if (isRecorded(record)) {
      if (previous) add(previous, -1);
      seen.set(record.key, null);
      return;
    }
    if (seen.has(record.key)) return;
    const timestamp = record.timestamp.slice(0, 16) + ":00.000Z";
    const group = JSON.stringify([timestamp, record.row.model]);
    const { row } = record;
    if (!totals.has(group))
      totals.set(group, {
        ...record,
        timestamp,
        row: {
          ...row,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          nativeInferenceCount: 0,
          unpricedNativeInferenceCount: 0,
        },
      });
    const counters = {
      group,
      input: row.inputTokens,
      output: row.outputTokens,
      read: row.cacheReadTokens,
      write: row.cacheWriteTokens,
    };
    seen.set(record.key, counters);
    add(counters, 1);
  });
  return [...totals.values()].filter((record) => (record.row.nativeInferenceCount ?? 0) > 0);
}

/** Copied envelopes count once; native F5 sessions already have persisted usage facts. */
export function externalMuseHistory(
  records: readonly MuseHistoryRecord[],
  isRecorded: (record: MuseHistoryRecord) => boolean = () => false,
): MuseHistoryRecord[] {
  const seen = new Set(records.filter(isRecorded).map((record) => record.key));
  return records.filter((record) => {
    if (seen.has(record.key)) return false;
    seen.add(record.key);
    return true;
  });
}

export function museHistoryBuckets(
  records: readonly MuseHistoryRecord[],
  buckets: readonly UsageBucketRange[],
) {
  const sorted = [...buckets].sort((left, right) => left.startAt.localeCompare(right.startAt));
  return records.flatMap((record) => {
    let low = 0,
      high = sorted.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (sorted[middle]!.startAt <= record.timestamp) low = middle + 1;
      else high = middle;
    }
    const bucket = sorted[low - 1];
    return bucket && record.timestamp < bucket.endAt
      ? [{ ...record.row, bucketKey: bucket.key }]
      : [];
  });
}
