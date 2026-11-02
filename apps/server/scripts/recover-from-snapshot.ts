/**
 * Rebuilds an F5 profile database from an exported orchestration snapshot.
 *
 *   node scripts/recover-from-snapshot.ts --snapshot work-snapshot.json --out /tmp/recovered.sqlite
 *
 * The snapshot is the `orchestration.getSnapshot` response saved from a still
 * running backend after its database was destroyed. The output is a new file;
 * swap it in manually with F5 quit. Exits non-zero when verification fails.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Layer, ManagedRuntime } from "effect";

import { ServerConfig } from "../src/config.ts";
import {
  decodeRecoverySnapshot,
  rebuildFromSnapshot,
} from "../src/maintenance/SnapshotRecovery.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";

interface Options {
  readonly snapshot: string;
  readonly out: string;
}

function parseOptions(argv: ReadonlyArray<string>): Options {
  let snapshot: string | undefined;
  let out: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--snapshot" && value) snapshot = path.resolve(value);
    else if (argument === "--out" && value) out = path.resolve(value);
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
    index += 1;
  }
  if (!snapshot || !out) throw new Error("Usage: --snapshot <json> --out <new.sqlite>");
  return { snapshot, out };
}

function assertSafeOutput(out: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(out + suffix)) throw new Error(`Refusing to overwrite ${out + suffix}`);
  }
  const parent = realpathSync(path.dirname(out));
  const home = os.userInfo().homedir;
  // Recovering straight into a live state directory would race the backend.
  for (const live of [path.join(home, ".f5"), path.join(home, ".t3")]) {
    const relative = path.relative(live, parent);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      throw new Error(`Refusing to write inside live F5 state (${live}); pick another directory.`);
    }
  }
}

const options = parseOptions(process.argv.slice(2));
assertSafeOutput(options.out);
const model = decodeRecoverySnapshot(JSON.parse(readFileSync(options.snapshot, "utf8")));
console.log(
  JSON.stringify({
    snapshot: options.snapshot,
    projects: model.projects.length,
    threads: model.threads.length,
    planningWorkflows: model.planningWorkflows.length,
    codeReviewWorkflows: model.codeReviewWorkflows.length,
    investigationWorkflows: model.investigationWorkflows.length,
  }),
);

// Paths derived from the scratch state directory only feed services this
// script never starts; the database itself is the --out file.
const scratchStateDir = path.join(path.dirname(options.out), ".recovery-state");
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    OrchestrationProjectionPipelineLive,
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), scratchStateDir)),
    Layer.provideMerge(makeSqlitePersistenceLive(options.out)),
    Layer.provideMerge(NodeServices.layer),
  ),
);
try {
  const report = await runtime.runPromise(rebuildFromSnapshot(model));
  console.log(JSON.stringify({ ...report, mismatches: report.mismatches.slice(0, 50) }, null, 2));
  if (report.integrity !== "ok" || report.mismatches.length > 0) {
    console.error(
      `Verification failed: integrity=${report.integrity}, mismatches=${report.mismatches.length}`,
    );
    process.exitCode = 1;
  } else {
    console.log(`Recovered database written to ${options.out}`);
  }
} finally {
  await runtime.dispose();
}
