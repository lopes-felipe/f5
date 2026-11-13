import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";

import { ServerConfig } from "../src/config.ts";
import {
  inspectStuckTurns,
  repairConfirmedCompletedTurn,
  repairStaleTerminalPointer,
} from "../src/maintenance/StuckTurnRepair.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { ProviderTerminalEventRepositoryLive } from "../src/persistence/Layers/ProviderTerminalEvents.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { ProviderTerminalEventRepository } from "../src/persistence/Services/ProviderTerminalEvents.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { assertDatabaseOffline, createRepairBackup } from "../src/maintenance/offlineRepair.ts";

interface Options {
  readonly apply: boolean;
  readonly stateDir: string;
}

function defaultStateDir(): string {
  const explicit = process.env.F5_STATE_DIR?.trim() || process.env.T3CODE_STATE_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const baseDir =
    process.env.F5_HOME?.trim() ||
    process.env.T3CODE_HOME?.trim() ||
    path.join(os.homedir(), ".f5");
  return path.resolve(baseDir, "userdata");
}

function parseOptions(argv: ReadonlyArray<string>): Options {
  let apply = false;
  let stateDir = defaultStateDir();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--state-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error("--state-dir requires a path");
      stateDir = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { apply, stateDir };
}

const options = parseOptions(process.argv.slice(2));
const dbPath = path.join(options.stateDir, "state.sqlite");
const providerLogsDir = path.join(options.stateDir, "logs", "provider");
if (!existsSync(dbPath)) throw new Error(`F5 database does not exist: ${dbPath}`);

const inspections = await inspectStuckTurns({ dbPath, providerLogsDir });
for (const inspection of inspections) {
  console.log(
    JSON.stringify({
      threadId: inspection.threadId,
      title: inspection.title,
      activeTurnId: inspection.activeTurnId,
      queuedCount: inspection.queuedCount,
      repair: inspection.reason,
      eventId: inspection.event?.eventId ?? null,
    }),
  );
}
const eligible = inspections.filter(
  (inspection) =>
    (inspection.reason === "eligible" && inspection.event !== null) ||
    inspection.reason === "eligible_stale_terminal_pointer",
);
console.log(
  JSON.stringify({
    mode: options.apply ? "apply" : "dry-run",
    found: inspections.length,
    eligible: eligible.length,
  }),
);

if (!options.apply || eligible.length === 0) {
  process.exitCode = 0;
} else {
  assertDatabaseOffline(dbPath);
  const backupPath = createRepairBackup(dbPath, options.stateDir, "stuck-turn-repair");
  console.log(JSON.stringify({ backupPath }));

  const persistenceLayer = makeSqlitePersistenceLive(dbPath).pipe(
    Layer.provide(NodeServices.layer),
  );
  const engineLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  );
  const runtimeLayer = Layer.mergeAll(engineLayer, ProviderTerminalEventRepositoryLive).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), options.stateDir)),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(persistenceLayer),
  );
  const runtime = ManagedRuntime.make(runtimeLayer);
  try {
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const terminalEvents = await runtime.runPromise(
      Effect.service(ProviderTerminalEventRepository),
    );
    for (const inspection of eligible) {
      const event = inspection.event;
      const result =
        event !== null
          ? await runtime.runPromise(repairConfirmedCompletedTurn({ engine, event }))
          : await runtime.runPromise(
              repairStaleTerminalPointer({
                engine,
                threadId: inspection.threadId,
                activeTurnId: inspection.activeTurnId,
                createdAt: new Date().toISOString(),
              }),
            );
      if (
        event !== null &&
        (result.status === "repaired" || result.reason === "already_terminal")
      ) {
        await runtime.runPromise(
          terminalEvents
            .record(event)
            .pipe(Effect.andThen(terminalEvents.markApplied(event.eventId))),
        );
      }
      console.log(JSON.stringify({ threadId: inspection.threadId, ...result }));
    }
    const repairedReadModel = await runtime.runPromise(engine.getReadModel());
    const unsettled = eligible.flatMap((inspection) => {
      const thread = repairedReadModel.threads.find(
        (candidate) => candidate.id === inspection.threadId,
      );
      return thread?.session?.activeTurnId === null ? [] : [inspection.threadId];
    });
    console.log(
      JSON.stringify({
        verifiedTerminal: eligible.length - unsettled.length,
        unsettled,
      }),
    );
    if (unsettled.length > 0) {
      throw new Error(`Repair verification failed for: ${unsettled.join(", ")}`);
    }
  } finally {
    await runtime.dispose();
  }
}
