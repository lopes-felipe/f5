/**
 * Opens a raw SQLite handle with the current runtime's driver. `node:sqlite`
 * is not a Bun built-in, so it must never be imported eagerly from modules
 * that `bun run` loads.
 */
export interface RuntimeSqliteDatabase {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    /** Bun returns `null` and Node returns `undefined` when no row matches. */
    get(...params: unknown[]): unknown;
  };
  exec(sql: string): unknown;
  close(): void;
}

export async function openRuntimeSqliteDatabase(
  path: string,
  options: { readonly readOnly: boolean },
): Promise<RuntimeSqliteDatabase> {
  if (process.versions.bun !== undefined) {
    const { Database } = await import("bun:sqlite");
    return new Database(path, {
      readonly: options.readOnly,
      readwrite: !options.readOnly,
    }) as unknown as RuntimeSqliteDatabase;
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(path, { readOnly: options.readOnly }) as unknown as RuntimeSqliteDatabase;
}
