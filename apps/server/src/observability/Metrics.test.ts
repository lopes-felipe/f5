import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Metric } from "effect";

import { makeMetricSnapshotWriter, serializeMetricSnapshot, withMetrics } from "./Metrics.ts";

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
