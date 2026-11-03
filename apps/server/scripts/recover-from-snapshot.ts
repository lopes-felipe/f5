/**
 * Rebuilds an F5 profile database from an exported orchestration snapshot.
 *
 *   bun scripts/recover-from-snapshot.ts --snapshot work-snapshot.json --out /tmp/recovered.sqlite
 *
 * Requires Bun: the server sources import contracts without file extensions,
 * which Node's loader rejects.
 *
 * The snapshot is the `orchestration.getSnapshot` response saved from a still
 * running backend after its database was destroyed. The database is built at
 * `<out>.partial` and renamed to `--out` only after the integrity check and
 * the content comparison pass; a failed run leaves nothing behind. Pass
 * `--allow-mismatches` to keep a database whose comparison found differences
 * after reviewing the report, which is always written in full to
 * `<out>.report.json`. Swap the result in manually with F5 quit.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  readonly allowMismatches: boolean;
}

const SQLITE_SUFFIXES = ["", "-wal", "-shm"] as const;

function parseOptions(argv: ReadonlyArray<string>): Options {
  let snapshot: string | undefined;
  let out: string | undefined;
  let allowMismatches = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-mismatches") {
      allowMismatches = true;
      continue;
    }
    const value = argv[index + 1];
    if (argument === "--snapshot" && value) snapshot = path.resolve(value);
    else if (argument === "--out" && value) out = path.resolve(value);
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
    index += 1;
  }
  if (!snapshot || !out) {
    throw new Error("Usage: --snapshot <json> --out <new.sqlite> [--allow-mismatches]");
  }
  return { snapshot, out, allowMismatches };
}

/** Resolves symlinks in the longest existing prefix of `target`. */
function canonicalPath(target: string): string {
  let existing = path.resolve(target);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return path.resolve(target);
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync(existing), ...rest);
}

/** Every directory a running F5 backend may use for state, as the server resolves it. */
function liveStateRoots(): string[] {
  const homes = new Set([os.homedir()]);
  try {
    homes.add(os.userInfo().homedir);
  } catch {
    // No passwd entry; HOME still applies.
  }
  const roots = [...homes].flatMap((home) => [path.join(home, ".f5"), path.join(home, ".t3")]);
  for (const name of ["F5_HOME", "T3CODE_HOME", "F5_STATE_DIR", "T3CODE_STATE_DIR"]) {
    const value = process.env[name]?.trim();
    if (value) roots.push(path.resolve(value));
  }
  return roots;
}

function isSameOrInside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function assertSafeOutput(out: string): void {
  for (const suffix of SQLITE_SUFFIXES) {
    for (const file of [out + suffix, `${out}.partial${suffix}`]) {
      if (existsSync(file)) throw new Error(`Refusing to overwrite ${file}`);
    }
  }
  // Recovering straight into a live state directory would race the backend,
  // and when the database is missing no existing-file check protects it.
  const target = canonicalPath(out);
  for (const root of liveStateRoots()) {
    if (isSameOrInside(target, canonicalPath(root))) {
      throw new Error(`Refusing to write inside live F5 state (${root}); pick another directory.`);
    }
  }
}

function removeDatabase(file: string): void {
  for (const suffix of SQLITE_SUFFIXES) rmSync(file + suffix, { force: true });
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

const partial = `${options.out}.partial`;
// Paths derived from the scratch state directory only feed services this
// script never starts; the database itself is the partial output file.
const scratchStateDir = mkdtempSync(path.join(os.tmpdir(), "f5-recovery-state-"));
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    OrchestrationProjectionPipelineLive,
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), scratchStateDir)),
    Layer.provideMerge(makeSqlitePersistenceLive(partial)),
    Layer.provideMerge(NodeServices.layer),
  ),
);
let publish = false;
try {
  const report = await runtime.runPromise(rebuildFromSnapshot(model));
  writeFileSync(`${options.out}.report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, mismatches: report.mismatches.slice(0, 50) }, null, 2));
  console.log(`Full report: ${options.out}.report.json`);
  if (report.integrity !== "ok") {
    console.error(`Verification failed: integrity=${report.integrity}`);
  } else if (report.mismatches.length > 0 && !options.allowMismatches) {
    console.error(
      `Verification failed: ${report.mismatches.length} mismatches. ` +
        "Review them and rerun with --allow-mismatches to keep the database anyway.",
    );
  } else {
    publish = true;
  }
} finally {
  await runtime.dispose();
  rmSync(scratchStateDir, { recursive: true, force: true });
  if (publish) {
    // The WAL and its index are named after the database; move them together.
    for (const suffix of SQLITE_SUFFIXES) {
      if (existsSync(partial + suffix)) renameSync(partial + suffix, options.out + suffix);
    }
    console.log(`Recovered database written to ${options.out}`);
  } else {
    removeDatabase(partial);
    process.exitCode = 1;
  }
}
