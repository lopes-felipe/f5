import type { ReportClientDiagnosticsInput } from "@t3tools/contracts";
import { Effect, Metric } from "effect";

const counterNames = [
  "snapshotSyncs",
  "gapRecoveries",
  "bufferOverflows",
  "poisonBatches",
  "connectedMs",
] as const;
const metrics = Object.fromEntries(
  counterNames.map((name) => [name, Metric.counter(`f5_client_${name}_total`)]),
) as Record<(typeof counterNames)[number], Metric.Metric<number, unknown>>;
const buckets = Metric.counter("f5_client_apply_batch_bucket_total");
const bounds = ["1", "2", "4", "8", "16", "32", "64", "128", "+Inf"];
const rpcCounterNames = [
  "rpcBusy",
  "rpcServerStarting",
  "rpcTimeouts",
  "rpcQueueExpired",
  "rpcBackgroundShed",
  "rpcOrphanReleased",
  "rpcConnectionNotReady",
] as const;
const rpcMetrics = Object.fromEntries(
  rpcCounterNames.map((name) => [name, Metric.counter(`f5_client_${name}_total`)]),
) as Record<(typeof rpcCounterNames)[number], Metric.Metric<number, unknown>>;
const rpcQueueWaitBuckets = Metric.counter("f5_client_rpc_queue_wait_bucket_total");
/** Upper bounds (ms) of the client's send-wait buckets. */
const rpcQueueWaitBounds = ["50", "100", "250", "500", "1000", "2500", "10000", "30000", "+Inf"];
const delta = (current: number, previous = 0) =>
  current >= previous ? current - previous : current;

/** Page/session identifiers never enter metric labels. */
export function makeClientDiagnosticsReporter() {
  const sessions = new Map<string, ReportClientDiagnosticsInput>();
  const accept = (report: ReportClientDiagnosticsInput) => {
    const previous = sessions.get(report.sessionId);
    if (previous && report.reportSeq <= previous.reportSeq) return null;
    sessions.delete(report.sessionId);
    sessions.set(report.sessionId, report);
    if (sessions.size > 256) sessions.delete(sessions.keys().next().value!);
    const base = previous?.clientKind === report.clientKind ? previous : undefined;
    return {
      counters: Object.fromEntries(
        counterNames.map((name) => [name, delta(report.counters[name], base?.counters[name])]),
      ) as Record<(typeof counterNames)[number], number>,
      buckets: report.applyBatchBuckets.map((count, index) =>
        delta(count, base?.applyBatchBuckets[index]),
      ),
      rpcCounters: Object.fromEntries(
        rpcCounterNames.map((name) => [
          name,
          delta(report.rpcCounters?.[name] ?? 0, base?.rpcCounters?.[name]),
        ]),
      ) as Record<(typeof rpcCounterNames)[number], number>,
      rpcQueueWaitBuckets: (report.rpcQueueWaitBuckets ?? []).map((count, index) =>
        delta(count, base?.rpcQueueWaitBuckets?.[index]),
      ),
    };
  };
  return {
    accept,
    get size() {
      return sessions.size;
    },
    report: (report: ReportClientDiagnosticsInput) =>
      Effect.suspend(() => {
        const changes = accept(report);
        if (!changes) return Effect.void;
        return Effect.gen(function* () {
          for (const name of counterNames)
            yield* Metric.update(
              Metric.withAttributes(metrics[name], { clientKind: report.clientKind }),
              changes.counters[name],
            );
          let cumulative = 0;
          for (let index = 0; index < bounds.length; index++) {
            cumulative += changes.buckets[index]!;
            yield* Metric.update(
              Metric.withAttributes(buckets, { clientKind: report.clientKind, le: bounds[index]! }),
              cumulative,
            );
          }
          for (const name of rpcCounterNames)
            yield* Metric.update(
              Metric.withAttributes(rpcMetrics[name], { clientKind: report.clientKind }),
              changes.rpcCounters[name],
            );
          let waited = 0;
          for (let index = 0; index < changes.rpcQueueWaitBuckets.length; index++) {
            waited += changes.rpcQueueWaitBuckets[index]!;
            yield* Metric.update(
              Metric.withAttributes(rpcQueueWaitBuckets, {
                clientKind: report.clientKind,
                le: rpcQueueWaitBounds[index]!,
              }),
              waited,
            );
          }
        });
      }),
  };
}
