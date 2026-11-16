import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vitest";
import * as NodeSqlite from "../../src/persistence/NodeSqliteClient.ts";
import { fixture } from "../../../../scripts/lib/performance/fixtures.ts";
import {
  measure,
  metadata,
  maximumObservation,
  type PerformanceReport,
} from "../../../../scripts/lib/performance/report.ts";

it("keeps event-loop p99 below 50 ms while checkpointing a 40 MiB WAL", async () => {
  const output = process.env.F5_PERF_REPORT;
  if (!output)
    throw new Error("Use bun run perf:server sqlite-checkpoint --output=<new-report.json>");
  const smoke = process.env.F5_PERF_SMOKE === "1";
  const method = smoke ? { ...fixture.method, warmups: 1, repetitions: 2 } : fixture.method;
  const directory = mkdtempSync(path.join(tmpdir(), "f5-checkpoint-perf-"));
  const p99: number[] = [];
  let iteration = -method.warmups;
  let feeder: DatabaseSync | undefined;
  const filename = path.join(directory, "state.sqlite");
  try {
    const samples = await measure(
      async () => {
        const histogram = monitorEventLoopDelay({
          resolution: fixture.sqliteCheckpoint.resolutionMs,
        });
        try {
          await Effect.runPromise(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              histogram.enable();
              yield* Effect.sleep("5 millis");
              histogram.reset();
              // Only checkpointing is timed: the 40 MiB write finished during setup.
              yield* sql`SELECT 1`;
              const startedAt = performance.now();
              const inspect = feeder!.prepare("PRAGMA wal_checkpoint(NOOP)");
              while (true) {
                const state = inspect.get()!;
                if (state.log === state.checkpointed && performance.now() - startedAt >= 100) break;
                if (performance.now() - startedAt > 10_000)
                  throw new Error("Checkpoint did not finish");
                yield* Effect.sleep("1 millis");
              }
              histogram.disable();
              expect(histogram.count).toBeGreaterThan(0);
              if (iteration >= 0) {
                p99.push(histogram.percentile(99) / 1_000_000);
              }
            }).pipe(Effect.provide(NodeSqlite.layer({ filename, checkpointWorker: true }))),
          );
        } finally {
          histogram.disable();
        }
        iteration++;
      },
      method,
      async () => {
        feeder?.close();
        feeder = undefined;
        for (const suffix of ["", "-wal", "-shm"]) rmSync(filename + suffix, { force: true });
        feeder = new DatabaseSync(filename);
        const version = String(feeder.prepare("SELECT sqlite_version() AS version").get()!.version)
          .split(".")
          .map(Number);
        if (version[0]! < 3 || (version[0] === 3 && version[1]! < 51))
          throw new Error("Checkpoint measurement requires SQLite 3.51 or newer");
        feeder.exec(
          `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0; CREATE TABLE payload(value BLOB); INSERT INTO payload VALUES (zeroblob(${fixture.sqliteCheckpoint.walBytes}))`,
        );
        expect(statSync(filename + "-wal").size).toBeGreaterThan(fixture.sqliteCheckpoint.walBytes);
        const state = feeder.prepare("PRAGMA wal_checkpoint(NOOP)").get()!;
        expect(Number(state.log) - Number(state.checkpointed)).toBeGreaterThan(1000);
      },
    );
    expect(p99).toHaveLength(method.repetitions);
    const report: PerformanceReport = {
      schemaVersion: 1,
      scope: "server-component",
      mode: smoke ? "smoke" : "measurement",
      metadata: metadata(fileURLToPath(new URL("../../../..", import.meta.url))),
      method: { warmups: method.warmups, repetitions: method.repetitions },
      measurements: { "sqlite.checkpoint-40MiB": samples },
      observations: [
        maximumObservation(
          "sqlite.checkpoint.eventLoopP99Ms",
          Math.max(...p99),
          fixture.sqliteCheckpoint.maximumP99Ms,
        ),
        ...p99.map((value, index) =>
          maximumObservation(
            `sqlite.checkpoint.eventLoopP99Ms.${index}`,
            value,
            fixture.sqliteCheckpoint.maximumP99Ms,
          ),
        ),
      ],
      notMeasured: [
        "Other server components and interactive workloads",
        "Comparative CPU improvement",
        "10-minute retained memory",
      ],
    };
    // Preserve the report even if the absolute latency gate fails.
    writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    expect(Math.max(...p99)).toBeLessThan(fixture.sqliteCheckpoint.maximumP99Ms);
  } finally {
    feeder?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
