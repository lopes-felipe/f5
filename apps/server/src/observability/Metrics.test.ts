import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Metric, Tracer } from "effect";

import {
  eventLoopDelay,
  recordEventLoopStall,
  recentEventLoopStalls,
  increment,
  makeMetricSnapshotWriter,
  previewRecordingFramesDroppedTotal,
  sampleEventLoopDelay,
  serializeMetricSnapshot,
  withMetrics,
} from "./Metrics.ts";

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

describe("withMetrics", () => {
  it.effect("supports pipe-style usage", () =>
    Effect.gen(function* () {
      const counter = Metric.counter("with_metrics_pipe_total");
      const timer = Metric.timer("with_metrics_pipe_duration");

      const result = yield* Effect.succeed("ok").pipe(
        withMetrics({
          counter,
          timer,
          attributes: {
            operation: "pipe",
          },
        }),
      );

      assert.equal(result, "ok");

      const snapshots = yield* Metric.snapshot;
      assert.equal(
        hasMetricSnapshot(snapshots, "with_metrics_pipe_total", {
          operation: "pipe",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "with_metrics_pipe_duration", {
          operation: "pipe",
        }),
        true,
      );
    }),
  );

  it.effect("supports direct invocation", () =>
    Effect.gen(function* () {
      const counter = Metric.counter("with_metrics_direct_total");

      yield* withMetrics(Effect.fail("boom"), {
        counter,
        attributes: {
          operation: "direct",
        },
      }).pipe(Effect.exit);

      const snapshots = yield* Metric.snapshot;
      assert.equal(
        hasMetricSnapshot(snapshots, "with_metrics_direct_total", {
          operation: "direct",
          outcome: "failure",
        }),
        true,
      );
    }),
  );

  it.effect("evaluates attributes lazily after the wrapped effect runs", () =>
    Effect.gen(function* () {
      const counter = Metric.counter("with_metrics_lazy_total");
      const timer = Metric.timer("with_metrics_lazy_duration");
      let provider = "unknown";

      yield* Effect.sync(() => {
        provider = "codex";
      }).pipe(
        withMetrics({
          counter,
          timer,
          attributes: () => ({
            provider,
            operation: "lazy",
          }),
        }),
      );

      const snapshots = yield* Metric.snapshot;
      assert.equal(
        hasMetricSnapshot(snapshots, "with_metrics_lazy_total", {
          provider: "codex",
          operation: "lazy",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "with_metrics_lazy_duration", {
          provider: "codex",
          operation: "lazy",
        }),
        true,
      );
    }),
  );
});

describe("metric snapshot writer", () => {
  it.effect("serializes only t3 metrics and skips unchanged snapshots", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-metric-writer-"));
      const metricsPath = path.join(tempDir, "metrics.ndjson");

      try {
        const metric = Metric.counter("t3_test_writer_total");
        const otherMetric = Metric.counter("other_metric_total");
        yield* Metric.update(metric, 1);
        yield* Metric.update(otherMetric, 99);

        const writer = yield* makeMetricSnapshotWriter({
          filePath: metricsPath,
          maxBytes: 1024 * 1024,
          maxFiles: 2,
        });

        yield* writer.flush;
        yield* writer.flush;
        yield* writer.close();

        const lines = fs
          .readFileSync(metricsPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as ReturnType<typeof serializeMetricSnapshot>);

        assert.equal(lines.length, 1);
        assert.deepStrictEqual(lines[0]?.metrics, [
          {
            id: "t3_test_writer_total",
            kind: "counter",
            attributes: {},
            value: 1,
          },
        ]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});

describe("event loop delay sampler", () => {
  it.live("records how long a blocked event loop delays the sampling timer", () =>
    Effect.gen(function* () {
      const before = yield* Metric.value(eventLoopDelay);
      const sampler = yield* Effect.forkChild(sampleEventLoopDelay);
      yield* Effect.sleep("20 millis");
      // Block synchronously so the sampler's timer fires late.
      const blockedUntil = performance.now() + 400;
      while (performance.now() < blockedUntil) {}
      yield* Effect.sleep("300 millis");
      yield* Fiber.interrupt(sampler);

      // The timer is process-global, so compare against this test's starting state.
      const after = yield* Metric.value(eventLoopDelay);
      assert.isAbove(after.count, before.count);
      assert.isAtLeast(after.sum - before.sum, 100);
    }),
  );
});

describe("preview metrics", () => {
  it.effect("records dropped preview recording frames in the server metrics stream", () =>
    Effect.gen(function* () {
      yield* increment(previewRecordingFramesDroppedTotal, {}, 3);

      const snapshots = yield* Metric.snapshot;
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_preview_recording_frames_dropped_total", {}),
        true,
      );
    }),
  );
});

it.effect(
  "records actual stall duration on independent spans and bounds its retained history",
  () =>
    Effect.gen(function* () {
      const spans: Array<Parameters<Tracer.Tracer["span"]>[0]> = [];
      const tracer = Tracer.make({
        span(options) {
          spans.push(options);
          return new Tracer.NativeSpan(options);
        },
      });
      yield* recordEventLoopStall(49).pipe(Effect.provideService(Tracer.Tracer, tracer));
      assert.equal(spans.length, 0);
      yield* Effect.forEach(
        Array.from({ length: 150 }, (_, index) => index + 50),
        (duration) =>
          recordEventLoopStall(duration).pipe(Effect.provideService(Tracer.Tracer, tracer)),
        { discard: true },
      );
      assert.equal(spans.length, 150);
      assert.equal(spans[0]?.name, "event-loop.stall");
      assert.isUndefined(spans[0]?.parent);
      assert.equal(recentEventLoopStalls().length, 128);
      assert.equal(recentEventLoopStalls().at(-1)?.durationMs, 199);
    }),
);
