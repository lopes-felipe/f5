import { installHeapSnapshotSignal } from "../heapSnapshot.ts";
import { resolveOtlpConfiguration } from "@t3tools/shared/observability";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeOtlpTraceSink, otlpMetricsLayer, otlpResource } from "../OtlpExport.ts";
import { makeTraceSink } from "../TraceSink.ts";
import { Effect, FileSystem, Layer, Option, Path, Tracer } from "effect";
import { version as serverPackageVersion } from "../../../package.json" with { type: "json" };

import { ServerConfig } from "../../config.ts";
import { makeLocalFileTracer } from "../LocalFileTracer.ts";
import { makeMetricSnapshotWriter, sampleEventLoopDelay } from "../Metrics.ts";

const TRACE_MAX_BYTES = 10 * 1024 * 1024;
const TRACE_MAX_FILES = 10;
const TRACE_BATCH_WINDOW_MS = 200;
const METRIC_FLUSH_INTERVAL = "10 seconds";

export const ObservabilityLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (process.env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return Layer.empty;
    const settings = yield* Effect.serviceOption(ServerSettingsService);
    const saved = Option.isSome(settings)
      ? yield* settings.value.getSettings.pipe(Effect.result)
      : undefined;
    const remote =
      saved?._tag === "Failure"
        ? resolveOtlpConfiguration({}, { OTEL_SDK_DISABLED: "true" })
        : resolveOtlpConfiguration(saved?.success.observability, process.env);
    const resource = otlpResource(serverPackageVersion, config.profile?.id, remote.attributes);
    if (!config.observabilityEnabled && !remote.traces.url && !remote.metrics.url)
      return Layer.empty;

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const observabilityDir = path.join(config.logsDir, "observability");
    const tracePath = path.join(observabilityDir, "traces.ndjson");
    const metricsPath = path.join(observabilityDir, "metrics.ndjson");

    const tracerLayer = Layer.effect(
      Tracer.Tracer,
      Effect.gen(function* () {
        yield* fileSystem.makeDirectory(observabilityDir, { recursive: true }).pipe(Effect.ignore);
        const local = config.observabilityEnabled
          ? yield* makeTraceSink({
              filePath: tracePath,
              maxBytes: TRACE_MAX_BYTES,
              maxFiles: TRACE_MAX_FILES,
              batchWindowMs: TRACE_BATCH_WINDOW_MS,
            })
          : undefined;
        const external = remote.traces.url
          ? yield* makeOtlpTraceSink(remote.traces, resource)
          : undefined;
        const tracer = yield* makeLocalFileTracer({
          sink: {
            filePath: tracePath,
            push: (record) => {
              local?.push(record);
              external?.push(record);
            },
            flush: Effect.all([local?.flush ?? Effect.void, external?.flush ?? Effect.void], {
              discard: true,
            }),
            close: () =>
              Effect.all([local?.close() ?? Effect.void, external?.close() ?? Effect.void], {
                discard: true,
              }),
          },
          filePath: tracePath,
          maxBytes: TRACE_MAX_BYTES,
          maxFiles: TRACE_MAX_FILES,
          batchWindowMs: TRACE_BATCH_WINDOW_MS,
        });
        yield* Effect.forkScoped(
          sampleEventLoopDelay.pipe(Effect.provideService(Tracer.Tracer, tracer)),
        );
        return tracer;
      }),
    );

    const metricsLayer = !config.observabilityEnabled
      ? Layer.empty
      : Layer.effectDiscard(
          Effect.gen(function* () {
            yield* fileSystem.makeDirectory(observabilityDir, { recursive: true });
            const releaseHeapSignal = installHeapSnapshotSignal(observabilityDir, undefined, () => {
              Effect.runFork(Effect.logWarning("Heap snapshot could not be written."));
            });
            yield* Effect.addFinalizer(() => Effect.sync(releaseHeapSignal));
            const writer = yield* makeMetricSnapshotWriter({
              filePath: metricsPath,
              maxBytes: TRACE_MAX_BYTES,
              maxFiles: TRACE_MAX_FILES,
            });
            yield* Effect.addFinalizer(() => writer.close().pipe(Effect.ignore));
            yield* Effect.forkScoped(
              Effect.sleep(METRIC_FLUSH_INTERVAL).pipe(
                Effect.andThen(writer.flush),
                Effect.forever,
              ),
            );
          }).pipe(
            Effect.catch(() =>
              Effect.logWarning("Local metrics are unavailable; the server will continue."),
            ),
          ),
        );

    return Layer.mergeAll(tracerLayer, metricsLayer, otlpMetricsLayer(remote.metrics, resource));
  }),
);
