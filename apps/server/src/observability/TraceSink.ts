import { Effect, Metric } from "effect";
import { makeTraceFileWriter, type TraceBatchWriter } from "./TraceFileWriter.ts";
import type { TraceRecord } from "./TraceRecord.ts";

export const TRACE_BUFFER_MAX_RECORDS = 4_096;
export const TRACE_BUFFER_MAX_BYTES = 4 * 1024 * 1024;
const BATCH_RECORDS = 32;
const BATCH_BYTES = 256 * 1024;
const traceDrops = Metric.counter("f5_trace_records_dropped_total");
const traceWriteFailures = Metric.counter("f5_trace_write_failures_total");

export interface TraceSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
  readonly writer?: TraceBatchWriter;
  /** May shorten the production 2-second deadline for focused shutdown tests. */
  readonly closeTimeoutMs?: number;
}

export interface TraceSinkStatistics {
  readonly bufferedRecords: number;
  readonly bufferedBytes: number;
  readonly inFlightRecords: number;
  readonly inFlightBytes: number;
  readonly droppedRecords: number;
  readonly writeFailures: number;
}

export interface TraceSink {
  readonly filePath: string;
  push: (record: TraceRecord) => void;
  readonly flush: Effect.Effect<void>;
  close: () => Effect.Effect<void>;
  readonly statistics?: () => TraceSinkStatistics;
}

export const makeTraceSink = Effect.fn("makeTraceSink")(function* (options: TraceSinkOptions) {
  const services = yield* Effect.services<never>();
  const writer = options.writer ?? makeTraceFileWriter(options);
  const encoder = new TextEncoder();
  const buffer: Uint8Array[] = [];
  let bytes = 0;
  let inFlightRecords = 0;
  let inFlightBytes = 0;
  let droppedRecords = 0;
  let writeFailures = 0;
  let failures = 0;
  let retryAt = 0;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let closing = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let writerClose: Promise<void> | undefined;
  const closeWriter = () =>
    (writerClose ??= Promise.resolve()
      .then(() => writer.close())
      .catch(() => undefined));

  const drop = (count: number) => {
    droppedRecords += count;
    // Updating the counter directly cannot create a span or recursively trace
    // the sink's own failures.
    traceDrops.updateUnsafe(count, services);
  };
  const statistics = (): TraceSinkStatistics => ({
    bufferedRecords: buffer.length,
    bufferedBytes: bytes,
    inFlightRecords,
    inFlightBytes,
    droppedRecords,
    writeFailures,
  });
  const schedule = () => {
    if (scheduled || closed || closing || !buffer.length) return;
    scheduled = setTimeout(
      () => {
        scheduled = undefined;
        void flushUnsafe();
      },
      Math.max(retryAt - Date.now(), buffer.length >= BATCH_RECORDS ? 0 : options.batchWindowMs),
    );
    scheduled.unref();
  };
  const flushUnsafe = (): Promise<void> => {
    if (running) return running;
    if (closed || Date.now() < retryAt) {
      schedule();
      return Promise.resolve();
    }
    running = (async () => {
      while (!closed && buffer.length && Date.now() >= retryAt) {
        const batch: Uint8Array[] = [];
        let batchBytes = 0;
        while (
          buffer.length &&
          batch.length < BATCH_RECORDS &&
          (!batch.length || batchBytes + buffer[0]!.byteLength <= BATCH_BYTES)
        ) {
          const record = buffer.shift()!;
          batch.push(record);
          batchBytes += record.byteLength;
        }
        bytes -= batchBytes;
        inFlightRecords = batch.length;
        inFlightBytes = batchBytes;
        try {
          await writer.write(batch);
          failures = 0;
        } catch {
          writeFailures++;
          traceWriteFailures.updateUnsafe(1, services);
          // A failed write may have been partial. Never replay it into NDJSON.
          // Drop this oldest batch and back off before trying later records.
          drop(batch.length);
          retryAt = Date.now() + Math.min(30_000, 250 * 2 ** Math.min(failures++, 7));
        } finally {
          inFlightRecords = 0;
          inFlightBytes = 0;
        }
      }
    })().finally(() => {
      running = undefined;
      schedule();
    });
    return running;
  };
  const flush = Effect.promise(flushUnsafe).pipe(Effect.withTracerEnabled(false));
  const closeUnsafe = () =>
    (closePromise ??= (async () => {
      closing = true;
      clearTimeout(scheduled);
      scheduled = undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const shutdown = (async () => {
        await flushUnsafe();
        closed = true;
        await closeWriter();
      })();
      try {
        await Promise.race([
          shutdown,
          new Promise<void>((resolve) => {
            timer = setTimeout(
              resolve,
              Math.max(1, Math.min(2_000, options.closeTimeoutMs ?? 2_000)),
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
        closed = true;
        clearTimeout(scheduled);
        drop(buffer.length);
        buffer.length = 0;
        bytes = 0;
        // Termination rejects an outstanding batch. It is intentionally not
        // awaited again after the deadline; the writer process itself is unreferenced.
        void closeWriter();
        void shutdown.catch(() => undefined);
      }
    })());
  const close = () => Effect.promise(closeUnsafe).pipe(Effect.withTracerEnabled(false));
  yield* Effect.addFinalizer(() => close().pipe(Effect.ignore));

  return {
    filePath: options.filePath,
    push(record) {
      if (closed || closing) {
        drop(1);
        return;
      }
      let encoded: Uint8Array;
      try {
        const text = `${JSON.stringify(record)}\n`;
        if (Buffer.byteLength(text, "utf8") > TRACE_BUFFER_MAX_BYTES) {
          drop(1);
          return;
        }
        encoded = encoder.encode(text);
      } catch {
        drop(1);
        return;
      }
      while (
        buffer.length &&
        (buffer.length + inFlightRecords >= TRACE_BUFFER_MAX_RECORDS ||
          bytes + inFlightBytes + encoded.byteLength > TRACE_BUFFER_MAX_BYTES)
      ) {
        bytes -= buffer.shift()!.byteLength;
        drop(1);
      }
      // A dispatched batch cannot be reclaimed while the disk owns it.
      if (
        buffer.length + inFlightRecords >= TRACE_BUFFER_MAX_RECORDS ||
        bytes + inFlightBytes + encoded.byteLength > TRACE_BUFFER_MAX_BYTES
      ) {
        drop(1);
        return;
      }
      buffer.push(encoded);
      bytes += encoded.byteLength;
      schedule();
    },
    flush,
    close,
    statistics,
  } satisfies TraceSink;
});
