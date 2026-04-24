import { RotatingFileSink } from "@t3tools/shared/logging";
import { Duration, Effect, Exit, Metric } from "effect";
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

export const providerTurnsTotal = Metric.counter("t3_provider_turns_total", {
  description: "Total provider turn lifecycle operations.",
});

export const providerTurnDuration = Metric.timer("t3_provider_turn_duration", {
  description: "Provider turn request duration.",
});

export const providerRuntimeEventsTotal = Metric.counter("t3_provider_runtime_events_total", {
  description: "Total canonical provider runtime events processed.",
});

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
      .filter((snapshot) => snapshot.id.startsWith("t3_"))
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
