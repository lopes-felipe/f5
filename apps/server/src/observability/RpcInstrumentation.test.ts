import { assert, describe, it } from "@effect/vitest";
import { Effect, Metric } from "effect";

import { observeRpcEffect } from "./RpcInstrumentation.ts";

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

describe("RpcInstrumentation", () => {
  it.effect("records success metrics for unary RPC handlers", () =>
    Effect.gen(function* () {
      yield* observeRpcEffect("rpc.instrumentation.success", Effect.succeed("ok"), {
        "rpc.aggregate": "test",
      }).pipe(Effect.withSpan("rpc.instrumentation.success.span"));

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_requests_total", {
          method: "rpc.instrumentation.success",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_request_duration", {
          method: "rpc.instrumentation.success",
        }),
        true,
      );
    }),
  );

  it.effect("records failure outcomes for unary RPC handlers", () =>
    Effect.gen(function* () {
      yield* Effect.exit(
        observeRpcEffect("rpc.instrumentation.failure", Effect.fail("boom"), {
          "rpc.aggregate": "test",
        }).pipe(Effect.withSpan("rpc.instrumentation.failure.span")),
      );

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_requests_total", {
          method: "rpc.instrumentation.failure",
          outcome: "failure",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_request_duration", {
          method: "rpc.instrumentation.failure",
        }),
        true,
      );
    }),
  );
});
