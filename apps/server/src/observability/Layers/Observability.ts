import { Effect, FileSystem, Layer, Path, Tracer } from "effect";

import { ServerConfig } from "../../config.ts";
import { makeLocalFileTracer } from "../LocalFileTracer.ts";
import { makeMetricSnapshotWriter } from "../Metrics.ts";

const TRACE_MAX_BYTES = 10 * 1024 * 1024;
const TRACE_MAX_FILES = 10;
const TRACE_BATCH_WINDOW_MS = 200;
const METRIC_FLUSH_INTERVAL = "10 seconds";

export const ObservabilityLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (!config.observabilityEnabled) {
      return Layer.empty;
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const observabilityDir = path.join(config.logsDir, "observability");
    const tracePath = path.join(observabilityDir, "traces.ndjson");
    const metricsPath = path.join(observabilityDir, "metrics.ndjson");

    const tracerLayer = Layer.effect(
      Tracer.Tracer,
      Effect.gen(function* () {
        yield* fileSystem.makeDirectory(observabilityDir, { recursive: true });
        return yield* makeLocalFileTracer({
          filePath: tracePath,
          maxBytes: TRACE_MAX_BYTES,
          maxFiles: TRACE_MAX_FILES,
          batchWindowMs: TRACE_BATCH_WINDOW_MS,
        });
      }),
    );

    const metricsLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* fileSystem.makeDirectory(observabilityDir, { recursive: true });
        const writer = yield* makeMetricSnapshotWriter({
          filePath: metricsPath,
          maxBytes: TRACE_MAX_BYTES,
          maxFiles: TRACE_MAX_FILES,
        });
        yield* Effect.addFinalizer(() => writer.close().pipe(Effect.ignore));
        yield* Effect.forkScoped(
          Effect.sleep(METRIC_FLUSH_INTERVAL).pipe(Effect.andThen(writer.flush), Effect.forever),
        );
      }),
    );

    return Layer.mergeAll(tracerLayer, metricsLayer);
  }),
);
