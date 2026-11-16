import { openRuntimeSqliteDatabase } from "./persistence/runtimeSqlite.ts";
import { LATEST_MIGRATION_ID } from "./persistence/Migrations.ts";

export async function validateBackupDatabase(path: string): Promise<void> {
  const database = await openRuntimeSqliteDatabase(path, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").all() as Array<
      Record<string, unknown>
    >;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error("Backup database integrity check failed.");
    }
    const migrationTable = database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'",
      )
      .get() as { present?: number } | null | undefined;
    if (!migrationTable?.present) throw new Error("Backup database migration metadata is missing.");
    const latest = database
      .prepare("SELECT max(migration_id) AS version FROM effect_sql_migrations")
      .get() as { version?: number | null } | null | undefined;
    if ((latest?.version ?? 0) > LATEST_MIGRATION_ID) {
      throw new Error(
        `Backup schema version ${latest?.version} is newer than supported version ${LATEST_MIGRATION_ID}.`,
      );
    }
  } finally {
    database.close();
  }
}
