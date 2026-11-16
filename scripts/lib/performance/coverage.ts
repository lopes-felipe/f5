import { retainedMemoryObservations, type PerformanceReport } from "./report.ts";

const required = {
  "server-component": [
    "terminal.ingest-20",
    "terminal.persist-reconnect-20",
    "replay.20000",
    "replay.slow-reader-with-writer",
    "replay.cancel-after-1000-with-writer",
    "git.status-large-nested-submodules",
    "upload.decode-persist-release-8MiB",
    "orchestration.assistant-stream",
    "orchestration.assistant-stream-claude-uncoalesced",
  ],
  interactive: [
    "transport.slow-disconnecting-client",
    "browser.startup-small",
    "browser.warm-switch-large",
    "browser.composer-input",
    "browser.composer-input-streaming",
  ],
} as const;

/**
 * Server-component resource bounds; the harness reports against these same values.
 * The stream and read-model ceilings are about 3x the pre-P1 smoke baseline. The
 * event-loop bound is the 100 ms threshold for the SQLite helper-process decision.
 */
export const SERVER_COMPONENT_BOUNDS = {
  "terminal.historyBytes": 4194304,
  "replay.pageEvents": 200,
  "replay.pageSerializedBytes": 1048576,
  "upload.decodedBuffersBytes": 83886080,
  "sqlite.concurrentWriterFailures": 0,
  "stream.deltaLatencyP50Ms": 250,
  "stream.deltaLatencyP95Ms": 350,
  "stream.eventRowsWritten": 6500,
  "stream.domainEvents": 6500,
  "stream.sqlStatements": 350000,
  "stream.projectionSqlStatements": 200000,
  "stream.eventLoopDelayP99Ms": 100,
  "readModel.heapBytes": 157286400,
  "readModel.rssBytes": 943718400,
} as const;

/** Measurement completeness is separate from passing the measured performance gates. */
export function validateCoverage(reports: readonly PerformanceReport[]): string[] {
  const errors: string[] = [];
  if (reports.length !== 2) errors.push("Complete coverage requires exactly two reports");
  for (const scope of ["server-component", "interactive"] as const) {
    const matches = reports.filter((report) => report.scope === scope);
    if (matches.length !== 1) {
      errors.push(`Expected exactly one ${scope} report`);
      continue;
    }
    const report = matches[0]!;
    if (
      report.mode !== "measurement" ||
      report.method.warmups !== 5 ||
      report.method.repetitions !== 30
    )
      errors.push(`Incomplete method: ${scope}`);
    for (const name of required[scope]) {
      const samples = report.measurements[name];
      if (
        !samples ||
        [samples.wallMs, samples.cpuMs].some(
          (values) => values.length !== 30 || values.some((n) => !Number.isFinite(n) || n < 0),
        )
      )
        errors.push(`Incomplete measurement: ${name}`);
    }
    const bounds: Record<string, number> =
      scope === "server-component"
        ? SERVER_COMPONENT_BOUNDS
        : {
            "transport.logicalBufferedBytes": 8388608,
            "transport.pendingFrames": 2000,
            "transport.pushQueueEvents": 2000,
            "terminal.nativeHistoryBytes": 4194304,
            "browser.composerInputP95Ms": 100,
            "browser.streamingComposerInputP95Ms": 100,
            "browser.warmSwitchP95Ms": 500,
          };
    for (const [name, maximum] of Object.entries(bounds)) {
      const found = report.observations.filter((item) => item.name === name);
      if (
        found.length !== 1 ||
        found[0]!.maximum !== maximum ||
        !Number.isFinite(found[0]!.actual) ||
        found[0]!.actual < 0 ||
        found[0]!.passed !== found[0]!.actual <= maximum
      )
        errors.push(`Missing or invalid bound: ${name}`);
    }
    if (scope === "interactive") {
      try {
        retainedMemoryObservations(report.memory ?? []);
      } catch {
        errors.push("Incomplete 10-minute memory measurement");
      }
    }
  }
  const first = reports[0];
  if (first)
    for (const report of reports.slice(1)) {
      for (const key of [
        "sourceCommit",
        "fixtureDigest",
        "harnessDigest",
        "hardware",
        "os",
        "dependencyLockDigest",
        "dependencies",
        "runtime",
      ] as const)
        if (JSON.stringify(first.metadata[key]) !== JSON.stringify(report.metadata[key]))
          errors.push(`Coverage reports disagree: ${key}`);
    }
  return errors;
}
