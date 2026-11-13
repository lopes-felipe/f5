import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ServerConfig } from "../src/config.ts";
import {
  inspectClaudeCommandOutputs,
  repairClaudeCommandOutput,
  type ClaudeCommandOutputCandidate,
  CLAUDE_COMMAND_OUTPUT_CANDIDATES_SQL,
} from "../src/maintenance/ClaudeCommandOutputRepair.ts";
import { assertDatabaseOffline, createRepairBackup } from "./lib/offlineRepair.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { ProjectionThreadCommandExecutionRepositoryLive } from "../src/persistence/Layers/ProjectionThreadCommandExecutions.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ThreadCommandExecutionQueryLive } from "../src/orchestration/Layers/ThreadCommandExecutionQuery.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { ThreadCommandExecutionQuery } from "../src/orchestration/Services/ThreadCommandExecutionQuery.ts";

let apply = false;
let threadId: string | undefined;
let stateDir = path.resolve(
  process.env.F5_STATE_DIR?.trim() ||
    process.env.T3CODE_STATE_DIR?.trim() ||
    path.join(
      process.env.F5_HOME?.trim() ||
        process.env.T3CODE_HOME?.trim() ||
        path.join(os.homedir(), ".f5"),
      "userdata",
    ),
);
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--help") {
    console.log(
      "Usage: bun run repair:claude-command-output [--state-dir PATH] [--thread-id ID] [--apply]\n" +
        "Defaults to a read-only dry-run. Apply requires F5 to be stopped and creates a database backup.\n" +
        "Repairs only empty completed command transcripts; launch-only or other nonempty output is preserved.",
    );
    process.exit(0);
  }
  if (arg === "--apply") apply = true;
  else if (arg === "--state-dir" || arg === "--thread-id") {
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--state-dir") stateDir = path.resolve(value);
    else threadId = value;
  } else throw new Error(`Unknown argument: ${arg}`);
}
const dbPath = path.join(stateDir, "state.sqlite");
if (!existsSync(dbPath)) throw new Error(`F5 database does not exist: ${dbPath}`);
const database = new Database(dbPath, { readonly: true });
let candidates: ClaudeCommandOutputCandidate[];
try {
  candidates = database
    .query<ClaudeCommandOutputCandidate, [string | null, string | null]>(
      CLAUDE_COMMAND_OUTPUT_CANDIDATES_SQL,
    )
    .all(threadId ?? null, threadId ?? null);
} finally {
  database.close();
}
const inspections = await inspectClaudeCommandOutputs({
  candidates,
  providerLogsDir: path.join(stateDir, "logs", "provider"),
});
for (const inspection of inspections) {
  console.log(
    JSON.stringify({
      ...inspection.candidate,
      reason: inspection.reason,
      outputBytes: Buffer.byteLength(inspection.output, "utf8"),
      outputTruncated: inspection.outputTruncated,
    }),
  );
}
console.log(
  JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    found: inspections.length,
    eligible: inspections.filter((entry) => entry.reason === "eligible").length,
  }),
);
if (apply && inspections.some((entry) => entry.reason === "eligible")) {
  assertDatabaseOffline(dbPath);
  console.log(
    JSON.stringify({
      backupPath: createRepairBackup(dbPath, stateDir, "claude-command-output-repair"),
    }),
  );
  const persistence = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
  const engine = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  );
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      engine,
      ThreadCommandExecutionQueryLive.pipe(
        Layer.provide(ProjectionThreadCommandExecutionRepositoryLive),
      ),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), stateDir)),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(persistence),
    ),
  );
  try {
    const engineService = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const query = await runtime.runPromise(Effect.service(ThreadCommandExecutionQuery));
    for (const inspection of inspections.filter((entry) => entry.reason === "eligible")) {
      const status = await runtime.runPromise(
        repairClaudeCommandOutput({
          inspection,
          engine: engineService,
          query,
          apply: true,
        }),
      );
      console.log(
        JSON.stringify({ commandExecutionId: inspection.candidate.commandExecutionId, status }),
      );
    }
  } finally {
    await runtime.dispose();
  }
}
