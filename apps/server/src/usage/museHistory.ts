import { open, readdir, stat } from "node:fs/promises";
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
  readonly kind: "model_completed" | "automated_review_completed";
  readonly row: Pick<
    UsageAggregateRow,
    | "model"
    | "inputTokens"
    | "outputTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "totalTokens"
  >;
}

export function parseMuseHistoryLine(line: string): MuseHistoryRecord | null {
  // Native serializers emit these literal event names. Ignore telemetry/content before JSON decoding.
  if (!line.includes('"model_completed"') && !line.includes('"automated_review_completed"'))
    return null;
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
  const { model, usage, kind } = entry.payload.event;
  const input = count(usage.input_tokens),
    output = count(usage.output_tokens);
  if (!Number.isSafeInteger(input + output) || (!input && !output)) return null;
  const read = Math.min(
    input,
    count(usage.cache_read_tokens ?? usage.cached_input_tokens ?? usage.cached_tokens),
  );
  return {
    key: entry.payload.source_run_record_id ?? entry.id,
    sessionId: entry.stream.id,
    kind,
    timestamp: new Date(Math.trunc(entry.recorded_at / 1000)).toISOString(),
    row: {
      model: typeof model === "string" ? model : model.model_id,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: read,
      cacheWriteTokens: Math.min(input - read, count(usage.cache_write_tokens)),
      totalTokens: input + output,
    },
  };
}

export function museHistoryUsageRow(record: MuseHistoryRecord): UsageAggregateRow {
  return {
    ...record.row,
    provider: "muse",
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
  };
}

// Current and previous 90-day ranges, with slack for timezone boundaries.
export const MUSE_HISTORY_LOOKBACK_MS = 182 * 24 * 60 * 60_000;
type Fingerprint = { ino: number; size: number; mtimeMs: number; ctimeMs: number };
interface CachedFile {
  fingerprint: Fingerprint | null;
  position: number;
  records: MuseHistoryRecord[];
}

/** Per-home incremental reader. Completed lines survive cancellation; partial lines are retried. */
export class MuseHistoryReader {
  private readonly files = new Map<string, CachedFile>();
  private snapshot: readonly MuseHistoryRecord[] = [];
  private dirty = false;
  private pending: Promise<readonly MuseHistoryRecord[]> | undefined;
  constructor(
    private readonly home: string,
    private readonly now = Date.now,
  ) {}

  read(signal?: AbortSignal): Promise<readonly MuseHistoryRecord[]> {
    if (this.pending) return this.pending;
    const pending = this.update(signal);
    this.pending = pending;
    void pending
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      })
      .catch(() => {});
    return pending;
  }

  private async update(signal?: AbortSignal): Promise<readonly MuseHistoryRecord[]> {
    const cutoff = new Date(this.now() - MUSE_HISTORY_LOOKBACK_MS).toISOString();
    const directories = [path.join(this.home, "sessions")];
    const visited = new Set<string>();
    let changed = this.dirty;
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
        signal?.throwIfAborted();
        visited.add(filename);
        const info = await stat(filename).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!info) continue;
        let cached = this.files.get(filename);
        const previous = cached?.fingerprint;
        const unchanged =
          previous &&
          previous.size === info.size &&
          previous.mtimeMs === info.mtimeMs &&
          previous.ctimeMs === info.ctimeMs &&
          previous.ino === info.ino;
        if (
          !cached ||
          (previous &&
            (previous.ino !== info.ino ||
              info.size < cached.position ||
              (info.size <= previous.size && !unchanged)))
        ) {
          cached = { fingerprint: null, position: 0, records: [] };
          this.files.set(filename, cached);
          changed = this.dirty = true;
        }
        const retained = cached.records.filter((record) => record.timestamp >= cutoff);
        if (retained.length !== cached.records.length) {
          cached.records = retained;
          changed = this.dirty = true;
        }
        if (unchanged) continue;
        const file = await open(filename, "r").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!file) continue;
        try {
          for await (const line of readBoundedJsonlLines(file, {
            start: cached.position,
            dir: "fwd",
            maxLineBytes: 8 * 1024 * 1024,
            maxScanBytes: Infinity,
            ...(signal ? { signal } : {}),
          })) {
            if (!line.terminated) continue;
            cached.position = line.endOffset;
            if (!line.text) continue;
            const record = parseMuseHistoryLine(line.text);
            if (record && record.timestamp >= cutoff) {
              cached.records.push(record);
              changed = this.dirty = true;
            }
          }
          cached.fingerprint = {
            ino: info.ino,
            size: info.size,
            mtimeMs: info.mtimeMs,
            ctimeMs: info.ctimeMs,
          };
        } finally {
          await file.close();
        }
      }
    }
    for (const filename of this.files.keys()) {
      if (!visited.has(filename)) {
        this.files.delete(filename);
        changed = this.dirty = true;
      }
    }
    if (changed) this.snapshot = [...this.files.values()].flatMap((file) => file.records);
    this.dirty = false;
    return this.snapshot;
  }
}

export async function readMuseHistory(
  home: string,
  signal?: AbortSignal,
  now = Date.now,
): Promise<readonly MuseHistoryRecord[]> {
  return new MuseHistoryReader(home, now).read(signal);
}

/** Copied envelopes count once, even if an excluded parent copy appears after a child copy. */
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
  const groups = new Map<string, UsageAggregateRow & { bucketKey: string }>();
  for (const record of records) {
    let low = 0,
      high = sorted.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (sorted[middle]!.startAt <= record.timestamp) low = middle + 1;
      else high = middle;
    }
    const bucket = sorted[low - 1];
    if (!bucket || record.timestamp >= bucket.endAt) continue;
    const key = JSON.stringify([bucket.key, record.row.model]);
    const row = groups.get(key);
    if (!row) {
      groups.set(key, { ...museHistoryUsageRow(record), bucketKey: bucket.key });
      continue;
    }
    groups.set(key, {
      ...row,
      inputTokens: row.inputTokens + record.row.inputTokens,
      outputTokens: row.outputTokens + record.row.outputTokens,
      cacheReadTokens: row.cacheReadTokens + record.row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens + record.row.cacheWriteTokens,
      totalTokens: row.totalTokens + record.row.totalTokens,
      nativeInferenceCount: (row.nativeInferenceCount ?? 0) + 1,
      unpricedNativeInferenceCount: (row.unpricedNativeInferenceCount ?? 0) + 1,
    });
  }
  return [...groups.values()];
}

export async function scanMuseHistory(
  home: string,
  isRecorded: (record: MuseHistoryRecord) => boolean,
  signal?: AbortSignal,
  now = Date.now,
) {
  const records = externalMuseHistory(await readMuseHistory(home, signal, now), isRecorded);
  const buckets = [...new Set(records.map((record) => record.timestamp.slice(0, 16)))].map(
    (minute) => ({
      key: minute,
      startAt: minute + ":00.000Z",
      endAt: new Date(Date.parse(minute + ":00.000Z") + 60_000).toISOString(),
    }),
  );
  return museHistoryBuckets(records, buckets).map((row) => ({ row }));
}
