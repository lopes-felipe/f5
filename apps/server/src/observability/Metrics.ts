import { getDrainableWorkerSnapshots } from "@t3tools/shared/DrainableWorker";
import { RotatingFileSink } from "@t3tools/shared/logging";
import { Clock, Duration, Effect, Exit, Metric, ServiceMap, Tracer } from "effect";
import { dual } from "effect/Function";

import {
  compactMetricAttributes,
  normalizeModelMetricLabel,
  outcomeFromExit,
  type MetricAttributes,
} from "./Attributes.ts";

export const rpcRequestsTotal = Metric.counter("t3_rpc_requests_total", {
  description: "Total RPC requests handled by the websocket server.",
});

export const rpcRequestDuration = Metric.timer("t3_rpc_request_duration", {
  description: "RPC request handling duration.",
});

export const orchestrationCommandsTotal = Metric.counter("t3_orchestration_commands_total", {
  description: "Total orchestration commands dispatched.",
});

export const orchestrationCommandDuration = Metric.timer("t3_orchestration_command_duration", {
  description: "Orchestration command dispatch duration.",
});

export const orchestrationCommandAckDuration = Metric.timer(
  "t3_orchestration_command_ack_duration",
  {
    description:
      "Time from orchestration command dispatch to the first committed domain event emitted for that command.",
  },
);

export const orchestrationEventsProcessedTotal = Metric.counter(
  "t3_orchestration_events_processed_total",
  {
    description: "Total orchestration intent events processed by runtime reactors.",
  },
);

export const providerSessionsTotal = Metric.counter("t3_provider_sessions_total", {
  description: "Total provider session lifecycle operations.",
});

export const providerSessionContextResetsTotal = Metric.counter(
  "t3_provider_session_context_resets_total",
  {
    description: "Total provider session replacements that reset conversation context.",
  },
);

export const providerTurnsTotal = Metric.counter("t3_provider_turns_total", {
  description: "Total provider turn lifecycle operations.",
});

export const providerTurnDuration = Metric.timer("t3_provider_turn_duration", {
  description: "Provider turn request duration.",
});

export const providerRuntimeEventsTotal = Metric.counter("t3_provider_runtime_events_total", {
  description: "Total canonical provider runtime events processed.",
});

export const providerRuntimeEventsDroppedTotal = Metric.counter(
  "t3_provider_runtime_events_dropped_total",
  {
    description: "Total provider runtime events dropped before canonical publication.",
  },
);

export const providerProjectionWriteFailuresTotal = Metric.counter(
  "f5_provider_projection_write_failures_total",
  {
    description: "Provider runtime projection writes that failed and require degraded handling.",
  },
);

export const acpResumeTotal = Metric.counter("t3_acp_resume_total", {
  description: "Total ACP resume outcomes while hardening is enabled.",
});

export const acpEventBarrierTotal = Metric.counter("t3_acp_event_barrier_total", {
  description: "Total ACP event-stream barriers drained before turn completion.",
});

export const acpCursorSerializationWaitsTotal = Metric.counter(
  "t3_acp_cursor_serialization_waits_total",
  {
    description: "Total Cursor sends that waited behind another send for the same thread.",
  },
);

export const gitCommandsTotal = Metric.counter("t3_git_commands_total", {
  description: "Total git commands executed by the server runtime.",
});

export const gitCommandDuration = Metric.timer("t3_git_command_duration", {
  description: "Git command execution duration.",
});

export const terminalSessionsTotal = Metric.counter("t3_terminal_sessions_total", {
  description: "Total terminal sessions started.",
});

export const terminalRestartsTotal = Metric.counter("t3_terminal_restarts_total", {
  description: "Total terminal restart requests handled.",
});

export const bootstrapTurnStartDuration = Metric.timer("t3_bootstrap_turn_start_duration", {
  description: "Bootstrap turn start duration.",
});

export const bootstrapStageTotal = Metric.counter("t3_bootstrap_stage_total", {
  description: "Bootstrap stage executions.",
});

export const setupScriptLaunchTotal = Metric.counter("t3_setup_script_launch_total", {
  description: "Project setup script launch attempts during bootstrap.",
});

export const editorLaunchTotal = Metric.counter("t3_editor_launch_total", {
  description: "Editor launch attempts.",
});

export const websocketConnectionsTotal = Metric.counter("t3_websocket_connections_total", {
  description: "WebSocket connection lifecycle events.",
});

export const previewRecordingFramesDroppedTotal = Metric.counter(
  "t3_preview_recording_frames_dropped_total",
  {
    description: "Total preview recording frames dropped under renderer backpressure.",
  },
);

export const wsSlowClientClosesTotal = Metric.counter("f5_ws_slow_client_closes_total", {
  description: "Outbound clients closed after send failure or backlog overflow.",
});
export const wsCoalescedPushesReplacedTotal = Metric.counter(
  "f5_ws_coalesced_pushes_replaced_total",
  {
    description: "Pending latest-state pushes replaced or subsumed by another invalidation.",
  },
);
export const wsPushFrameBytes = Metric.histogram("f5_ws_push_frame_bytes", {
  description: "Encoded push frame bytes before compression.",
  boundaries: Metric.exponentialBoundaries({ start: 128, factor: 2, count: 20 }),
});
export const wsPushQueueDepth = Metric.gauge("f5_ws_push_queue_depth", {
  description: "Push bus queue entries, sampled every 250 milliseconds.",
});

export const eventLoopDelay = Metric.timer("t3_event_loop_delay", {
  // One sample per 250 ms sleep, so a short stall between samples can be missed. Its
  // percentiles are not comparable with the perf harness's monitorEventLoopDelay p99.
  description: "Lateness of a 250 ms sleep, sampling event-loop blocking.",
});

export const sqlExecutionDuration = Metric.timer("t3_sql_execution_duration", {
  description: "Synchronous SQLite statement execution time on the application connection.",
});

export const sqlConnectionWaitDuration = Metric.timer("t3_sql_connection_wait_duration", {
  description: "Time spent waiting for the application SQLite connection or a transaction.",
});

export const deliveryOutboxRowsDecoded = Metric.histogram("t3_delivery_outbox_rows_decoded", {
  description: "Provider delivery outbox rows read and decoded by one actionable scan.",
  boundaries: Metric.exponentialBoundaries({ start: 1, factor: 2, count: 14 }),
});

export const deliveryAttemptsActive = Metric.gauge("t3_delivery_attempts_active", {
  description: "Claimed provider delivery attempts whose outcome is still being settled.",
});

export const deliveryAmbiguousTotal = Metric.counter("t3_delivery_ambiguous_total", {
  description: "Provider deliveries recorded as ambiguous (sent with unknown outcome).",
});

const retainedEventLoopStalls: Array<{ recordedAt: string; durationMs: number }> = [];
export const recentEventLoopStalls = () => retainedEventLoopStalls.map((entry) => ({ ...entry }));

/** Independent root spans measure the stall itself, not the cost of reporting it. */
export const recordEventLoopStall = (durationMs: number) =>
  Effect.gen(function* () {
    if (!Number.isFinite(durationMs) || durationMs < 50) return;
    retainedEventLoopStalls.push({ recordedAt: new Date().toISOString(), durationMs });
    if (retainedEventLoopStalls.length > 128) retainedEventLoopStalls.shift();
    const clock = yield* Clock.Clock;
    const tracer = yield* Tracer.Tracer;
    const end = clock.currentTimeNanosUnsafe();
    const span = tracer.span({
      name: "event-loop.stall",
      parent: undefined,
      annotations: ServiceMap.empty(),
      links: [],
      startTime: end - BigInt(Math.round(durationMs * 1_000_000)),
      kind: "internal",
      root: true,
      sampled: true,
    });
    span.attribute("event_loop.delay_ms", durationMs);
    span.end(end, Exit.void);
  });
export const workerQueueEntries = Metric.gauge("f5_worker_queue_entries");
export const workerQueueBytes = Metric.gauge("f5_worker_queue_bytes");
export const workerQueueOldestAgeMs = Metric.gauge("f5_worker_queue_oldest_age_ms");
export const workerFailures = Metric.gauge("f5_worker_failures");

type QueueResources = { entries: number; bytes: number; oldestAgeMs: number };
const notificationQueues = new Set<() => QueueResources>();
const runtimeFanouts = new Set<() => Effect.Effect<number>>();
export const providerRuntimeFanoutBacklog = Metric.gauge("f5_provider_runtime_fanout_backlog");
export const providerNotificationOverflows = Metric.counter(
  "f5_provider_notification_overflows_total",
);
export function registerProviderRuntimeFanout(read: () => Effect.Effect<number>) {
  runtimeFanouts.add(read);
  return () => {
    runtimeFanouts.delete(read);
  };
}
/** Static family only; instance/thread identities never become metric labels. */
export function registerNotificationQueueResources(read: () => QueueResources) {
  notificationQueues.add(read);
  return () => {
    notificationQueues.delete(read);
  };
}

const EVENT_LOOP_DELAY_SAMPLE_INTERVAL_MS = 250;

/**
 * Records how late a fixed sleep wakes up. Runs until interrupted; fork it in the
 * scope that owns metric collection.
 */
export const sampleEventLoopDelay = Effect.gen(function* () {
  const startedAt = performance.now();
  yield* Effect.sleep(Duration.millis(EVENT_LOOP_DELAY_SAMPLE_INTERVAL_MS));
  const lateness = performance.now() - startedAt - EVENT_LOOP_DELAY_SAMPLE_INTERVAL_MS;
  yield* Metric.update(eventLoopDelay, Duration.millis(Math.max(0, lateness)));
  yield* recordEventLoopStall(lateness);
  let fanoutBacklog = 0;
  for (const read of runtimeFanouts) {
    const result = yield* Effect.exit(read());
    if (Exit.isSuccess(result)) fanoutBacklog += result.value;
  }
  yield* Metric.update(providerRuntimeFanoutBacklog, fanoutBacklog);
  const resources = [...notificationQueues].map((read) => read());
  const notificationAttributes = { worker: "codex-notifications" };
  yield* Metric.update(
    Metric.withAttributes(workerQueueEntries, notificationAttributes),
    resources.reduce((sum, resource) => sum + resource.entries, 0),
  );
  yield* Metric.update(
    Metric.withAttributes(workerQueueBytes, notificationAttributes),
    resources.reduce((sum, resource) => sum + resource.bytes, 0),
  );
  yield* Metric.update(
    Metric.withAttributes(workerQueueOldestAgeMs, notificationAttributes),
    Math.max(0, ...resources.map((resource) => resource.oldestAgeMs)),
  );
  for (const worker of getDrainableWorkerSnapshots()) {
    const attributes = { worker: worker.name };
    yield* Metric.update(Metric.withAttributes(workerQueueEntries, attributes), worker.entries);
    yield* Metric.update(Metric.withAttributes(workerQueueBytes, attributes), worker.bytes);
    yield* Metric.update(
      Metric.withAttributes(workerQueueOldestAgeMs, attributes),
      worker.oldestAgeMs,
    );
    yield* Metric.update(Metric.withAttributes(workerFailures, attributes), worker.failures);
  }
}).pipe(Effect.forever, Effect.withTracerEnabled(false));

export const metricAttributes = (attributes: Readonly<Record<string, unknown>>): MetricAttributes =>
  compactMetricAttributes(attributes);

export const increment = (
  metric: Metric.Metric<number, unknown>,
  attributes: Readonly<Record<string, unknown>>,
  amount = 1,
) => Metric.update(Metric.withAttributes(metric, metricAttributes(attributes)), amount);

export interface WithMetricsOptions {
  readonly counter?: Metric.Metric<number, unknown>;
  readonly timer?: Metric.Metric<Duration.Duration, unknown>;
  readonly attributes?:
    | Readonly<Record<string, unknown>>
    | (() => Readonly<Record<string, unknown>>);
  readonly outcomeAttributes?: (
    outcome: ReturnType<typeof outcomeFromExit>,
  ) => Readonly<Record<string, unknown>>;
}

const withMetricsImpl = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: WithMetricsOptions,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    const exit = yield* Effect.exit(effect);
    const duration = Duration.millis(Math.max(0, Date.now() - startedAt));
    const baseAttributes =
      typeof options.attributes === "function" ? options.attributes() : (options.attributes ?? {});

    if (options.timer) {
      yield* Metric.update(
        Metric.withAttributes(options.timer, metricAttributes(baseAttributes)),
        duration,
      );
    }

    if (options.counter) {
      const outcome = outcomeFromExit(exit);
      yield* Metric.update(
        Metric.withAttributes(
          options.counter,
          metricAttributes({
            ...baseAttributes,
            outcome,
            ...(options.outcomeAttributes ? options.outcomeAttributes(outcome) : {}),
          }),
        ),
        1,
      );
    }

    if (Exit.isSuccess(exit)) {
      return exit.value;
    }
    return yield* Effect.failCause(exit.cause);
  });

export const withMetrics: {
  <A, E, R>(
    options: WithMetricsOptions,
  ): (effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  <A, E, R>(effect: Effect.Effect<A, E, R>, options: WithMetricsOptions): Effect.Effect<A, E, R>;
} = dual(2, withMetricsImpl);

export const providerMetricAttributes = (
  provider: string,
  extra?: Readonly<Record<string, unknown>>,
) =>
  compactMetricAttributes({
    provider,
    ...extra,
  });

export const providerTurnMetricAttributes = (input: {
  readonly provider: string;
  readonly model: string | null | undefined;
  readonly extra?: Readonly<Record<string, unknown>>;
}) => {
  const modelFamily = normalizeModelMetricLabel(input.model);
  return compactMetricAttributes({
    provider: input.provider,
    ...(modelFamily ? { modelFamily } : {}),
    ...input.extra,
  });
};

type LocalMetricRecord =
  | {
      readonly id: string;
      readonly kind: "counter";
      readonly attributes: MetricAttributes;
      readonly value: number;
    }
  | {
      readonly id: string;
      readonly kind: "gauge";
      readonly attributes: MetricAttributes;
      readonly value: number;
    }
  | {
      readonly id: string;
      readonly kind: "histogram" | "summary";
      readonly attributes: MetricAttributes;
      readonly count: number;
      readonly sumMs: number;
      readonly minMs: number;
      readonly maxMs: number;
    }
  | {
      readonly id: string;
      readonly kind: "frequency";
      readonly attributes: MetricAttributes;
      readonly value: Readonly<Record<string, number>>;
    };

export interface MetricSnapshotRecord {
  readonly type: "metric-snapshot";
  readonly recordedAt: string;
  readonly metrics: ReadonlyArray<LocalMetricRecord>;
}

function normalizeMetricNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function sortMetricAttributes(
  attributes: Readonly<Record<string, string>> | undefined,
): MetricAttributes {
  return Object.fromEntries(
    Object.entries(attributes ?? {}).toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotToRecord(snapshot: Metric.Metric.Snapshot): LocalMetricRecord | null {
  const attributes = sortMetricAttributes(snapshot.attributes);

  switch (snapshot.type) {
    case "Counter":
      return {
        id: snapshot.id,
        kind: "counter",
        attributes,
        value: normalizeMetricNumber(snapshot.state.count),
      };
    case "Gauge":
      return {
        id: snapshot.id,
        kind: "gauge",
        attributes,
        value: normalizeMetricNumber(snapshot.state.value),
      };
    case "Histogram":
      return {
        id: snapshot.id,
        kind: "histogram",
        attributes,
        count: snapshot.state.count,
        sumMs: snapshot.state.sum,
        minMs: snapshot.state.min,
        maxMs: snapshot.state.max,
      };
    case "Summary":
      return {
        id: snapshot.id,
        kind: "summary",
        attributes,
        count: snapshot.state.count,
        sumMs: snapshot.state.sum,
        minMs: snapshot.state.min,
        maxMs: snapshot.state.max,
      };
    case "Frequency":
      return {
        id: snapshot.id,
        kind: "frequency",
        attributes,
        value: Object.fromEntries(
          Array.from(snapshot.state.occurrences.entries()).toSorted(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      };
    default:
      return null;
  }
}

export function serializeMetricSnapshot(
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  recordedAt = new Date().toISOString(),
): MetricSnapshotRecord {
  return {
    type: "metric-snapshot",
    recordedAt,
    metrics: snapshots
      .filter((snapshot) => snapshot.id.startsWith("t3_") || snapshot.id.startsWith("f5_"))
      .map(snapshotToRecord)
      .filter((record): record is LocalMetricRecord => record !== null)
      .toSorted((left, right) => {
        const idComparison = left.id.localeCompare(right.id);
        if (idComparison !== 0) {
          return idComparison;
        }
        return JSON.stringify(left.attributes).localeCompare(JSON.stringify(right.attributes));
      }),
  };
}

export interface MetricSnapshotWriterOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
}

export interface MetricSnapshotWriter {
  readonly filePath: string;
  readonly flush: Effect.Effect<void>;
  close: () => Effect.Effect<void>;
}

export const makeMetricSnapshotWriter = Effect.fn("makeMetricSnapshotWriter")(function* (
  options: MetricSnapshotWriterOptions,
) {
  yield* Effect.void;
  const sink = new RotatingFileSink({
    filePath: options.filePath,
    maxBytes: options.maxBytes,
    maxFiles: options.maxFiles,
  });

  let previousMetricsPayload: string | null = null;

  const flush = Effect.gen(function* () {
    const snapshots = yield* Metric.snapshot;
    const record = serializeMetricSnapshot(snapshots);
    if (record.metrics.length === 0) {
      return;
    }
    const metricsPayload = JSON.stringify(record.metrics);
    if (metricsPayload === previousMetricsPayload) {
      return;
    }
    previousMetricsPayload = metricsPayload;
    yield* Effect.sync(() => {
      sink.write(`${JSON.stringify(record)}\n`);
    }).pipe(Effect.withTracerEnabled(false));
  }).pipe(Effect.withTracerEnabled(false));

  return {
    filePath: options.filePath,
    flush,
    close: () => flush,
  } satisfies MetricSnapshotWriter;
});

export const rpcBusyTotal = Metric.counter("f5_rpc_busy_total", {
  description: "RPCs rejected before execution because their lane or byte budget is full.",
});
export const terminalSnapshotsTotal = Metric.counter("f5_terminal_snapshots_total", {
  description: "Read-only terminal recovery snapshots.",
});
export const terminalStateChangesTotal = Metric.counter("f5_terminal_state_changes_total", {
  description: "Published terminal state revisions.",
});

export const scheduledRunTransitionsTotal = Metric.counter("f5_scheduled_run_transitions_total", {
  description: "Scheduled execution transitions, grouped by bounded outcome and reason.",
});
export const snapshotReadDuration = Metric.timer("f5_snapshot_read_duration", {
  description: "Consistent snapshot transaction duration, including admission.",
});
export const snapshotReadOverruns = Metric.counter("f5_snapshot_read_overruns_total", {
  description: "Snapshot reads exceeding their cooperative deadline.",
});

/** Optional deterministic-harness hook; production does no stage timing work when absent. */
export const PerformanceStageProbe = ServiceMap.Reference<
  ((stage: string, durationMs: number) => void) | null
>("t3/observability/PerformanceStageProbe", { defaultValue: () => null });
export const measurePerformanceStage = <A, E, R>(
  probe: ((stage: string, durationMs: number) => void) | null,
  stage: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  probe === null
    ? effect
    : Effect.suspend(() => {
        const started = performance.now();
        return effect.pipe(
          Effect.ensuring(Effect.sync(() => probe(stage, performance.now() - started))),
        );
      });

export const terminalReceiptExhaustedTotal = Metric.counter(
  "f5_terminal_receipts_exhausted_total",
  {
    description: "Terminal receipts retained for explicit repair after bounded retries.",
  },
);
export const terminalReceiptOldestPendingMs = Metric.gauge(
  "f5_terminal_receipt_oldest_pending_ms",
  {
    description: "Age of the oldest terminal receipt eligible for automatic retry.",
  },
);
