import { getHeapStatistics } from "node:v8";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Path } from "effect";
import { it, assert } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, beforeEach, vi } from "vitest";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { TraceRecord } from "../TraceRecord.ts";
import { ObservabilityLive } from "./Observability.ts";

vi.mock("node:v8", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:v8")>();
  return { ...actual, getHeapStatistics: vi.fn(actual.getHeapStatistics) };
});

beforeEach(() => {
  vi.stubEnv("OTEL_SDK_DISABLED", undefined);
  vi.stubEnv("OTEL_TRACES_EXPORTER", "none");
  vi.stubEnv("OTEL_METRICS_EXPORTER", "none");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(getHeapStatistics).mockReset();
});

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "f5-observability-fail-open-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("observability", (it) => {
  it.effect("keeps server work running when the logs destination cannot be created", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const blocked = path.join(config.stateDir, "not-a-directory");
      yield* fs.writeFileString(blocked, "fixture");
      const result = yield* Effect.succeed("server work completed").pipe(
        Effect.withSpan("server.continues"),
        Effect.provide(ObservabilityLive),
        Effect.provideService(ServerConfig, {
          ...config,
          logsDir: blocked,
          observabilityEnabled: true,
        }),
      );
      assert.equal(result, "server work completed");
      assert.equal(yield* fs.readFileString(blocked), "fixture");
    }),
  );

  it.effect("exports heap growth to the local trace and stops sampling on shutdown", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stats = getHeapStatistics();
      let heap = stats.used_heap_size;
      const readHeap = vi.mocked(getHeapStatistics);
      readHeap.mockImplementation(() => ({ ...stats, used_heap_size: heap }));

      yield* Effect.gen(function* () {
        const reads = readHeap.mock.calls.length;
        yield* TestClock.adjust("2 seconds");
        assert.isAbove(readHeap.mock.calls.length, reads);
        yield* Effect.sync(() => {
          heap += 8 * 1024 * 1024;
        }).pipe(Effect.withSpan("server.heap.fixture"));
      }).pipe(
        Effect.provide(ObservabilityLive),
        Effect.provideService(ServerConfig, { ...config, observabilityEnabled: true }),
      );

      const readsAfterClose = readHeap.mock.calls.length;
      yield* TestClock.adjust("2 seconds");
      assert.equal(readHeap.mock.calls.length, readsAfterClose);

      const traces = yield* fs.readFileString(
        path.join(config.logsDir, "observability", "traces.ndjson"),
      );
      const span = traces
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as TraceRecord)
        .find((record) => record.name === "server.heap.fixture");
      assert.equal(span?.attributes["memory.heap_growth_bytes"], 8 * 1024 * 1024);
    }),
  );

  it.effect("keeps heap attribution off in metrics-only mode", () =>
    Effect.gen(function* () {
      vi.stubEnv("OTEL_METRICS_EXPORTER", "otlp");
      vi.stubEnv("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "http/protobuf");
      const fetch = vi.fn(async () => new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetch);

      yield* TestClock.adjust("11 seconds").pipe(
        Effect.withSpan("server.metrics.fixture"),
        Effect.provide(
          ObservabilityLive.pipe(
            Layer.provide(
              ServerSettingsService.layerTest({
                observability: { otlpMetricsUrl: "http://127.0.0.1:4318/v1/metrics" },
              }),
            ),
          ),
        ),
      );
      assert.isAbove(fetch.mock.calls.length, 0);
      assert.equal(vi.mocked(getHeapStatistics).mock.calls.length, 0);
    }),
  );

  it.effect("exports nothing to a collector named only by inherited OTEL variables", () =>
    Effect.gen(function* () {
      vi.stubEnv("OTEL_TRACES_EXPORTER", "otlp");
      vi.stubEnv("OTEL_METRICS_EXPORTER", "otlp");
      vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318");
      const fetch = vi.fn(async () => new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetch);

      yield* TestClock.adjust("11 seconds").pipe(
        Effect.withSpan("server.env-collector.fixture"),
        Effect.provide(ObservabilityLive.pipe(Layer.provide(ServerSettingsService.layerTest()))),
      );
      assert.equal(fetch.mock.calls.length, 0);
    }),
  );
});
