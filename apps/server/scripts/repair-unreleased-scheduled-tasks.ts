import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeRuntimeSqliteLayer } from "../src/persistence/Layers/Sqlite.ts";
import { repairUnreleasedScheduledTaskMigrations } from "../src/persistence/repairUnreleasedScheduledTaskMigrations.ts";
import { runMigrations } from "../src/persistence/Migrations.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const paths = args.filter((arg) => arg !== "--apply");
if (paths.length !== 1 || paths[0]!.startsWith("--"))
  throw new Error(
    "Usage: bun apps/server/scripts/repair-unreleased-scheduled-tasks.ts /path/to/state.sqlite [--apply]. Stop F5 before applying.",
  );
const filename = resolve(paths[0]!);
if (!existsSync(filename)) throw new Error("Database does not exist.");
if (apply) {
  // Refuse to modify a live F5 database. A missing lsof also fails closed.
  try {
    const holders = execFileSync("lsof", ["-t", "--", filename], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (holders)
      throw new Error("Stop F5 and all other database users before applying this repair.");
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw error;
  }
}
await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT migration_id,name FROM effect_sql_migrations
    WHERE (migration_id IN(124,127,128,129,137) AND name='ScheduledTasks') OR (migration_id IN(129,130,138) AND name='ScheduledTaskQuarantine') ORDER BY migration_id`;
    console.log(JSON.stringify({ mode: apply ? "apply" : "inspect", migrations: rows }));
    if (!apply || !rows.length) return;
    const backup = `${filename}.before-scheduled-task-repair-${Date.now()}.sqlite`;
    yield* sql`VACUUM INTO ${backup}`;
    console.log(JSON.stringify({ backup }));
    yield* repairUnreleasedScheduledTaskMigrations;
    yield* runMigrations;
  }).pipe(Effect.provide(makeRuntimeSqliteLayer({ filename })), Effect.scoped),
);
