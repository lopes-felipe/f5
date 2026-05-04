import * as FS from "node:fs";
import * as Path from "node:path";

import { Data, Effect } from "effect";
import {
  STATE_DB_FILE_NAME,
  USERDATA_STATE_DIR_NAME,
  defaultF5UserdataStateDir,
  legacyT3UserdataStateDir,
} from "@t3tools/shared/appStatePaths";

export class LegacyStateMigrationError extends Data.TaggedError("LegacyStateMigrationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const LEGACY_STATE_MIGRATION_FAILURE_SENTINEL = ".legacy-t3-migration-failed.json";

export type LegacyStateMigrationResult =
  | {
      readonly status: "migrated";
      readonly legacyStateDir: string;
      readonly targetStateDir: string;
    }
  | {
      readonly status: "skipped";
      readonly reason: "target-db-exists" | "legacy-db-missing" | "same-path" | "previous-failure";
    };

export interface LegacyStateMigrationInput {
  readonly legacyStateDir?: string | undefined;
  readonly targetStateDir?: string | undefined;
  readonly dbFileName?: string | undefined;
  readonly cloneSqliteDatabase?: SqliteDatabaseCloner | undefined;
}

type SqliteDatabaseCloner = (sourceDbPath: string, targetDbPath: string) => Promise<void>;

interface ResolvedLegacyStateMigrationInput {
  readonly legacyStateDir: string;
  readonly targetStateDir: string;
  readonly dbFileName: string;
  readonly cloneSqliteDatabase: SqliteDatabaseCloner;
}

const sqliteStringLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const databaseSidecarNames = (dbFileName: string): ReadonlySet<string> =>
  new Set([dbFileName, `${dbFileName}-wal`, `${dbFileName}-shm`, `${dbFileName}-journal`]);

const ignorableTargetStateEntries = new Set([".DS_Store"]);

function formatUnknownCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function shouldMigrateLegacyT3State(input: {
  readonly stateDir: string;
  readonly baseDir: string;
  readonly hasExplicitStateDir: boolean;
  readonly devUrl: URL | undefined;
}): boolean {
  if (input.hasExplicitStateDir || input.devUrl !== undefined) {
    return false;
  }
  return (
    Path.resolve(input.stateDir) === Path.resolve(Path.join(input.baseDir, USERDATA_STATE_DIR_NAME))
  );
}

async function cloneWithNodeSqlite(sourceDbPath: string, targetDbPath: string): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(sourceDbPath, { readOnly: true });
  try {
    database.exec(`VACUUM INTO ${sqliteStringLiteral(targetDbPath)}`);
  } finally {
    database.close();
  }
}

async function cloneWithBunSqlite(sourceDbPath: string, targetDbPath: string): Promise<void> {
  const { Database } = await import("bun:sqlite");
  const database = new Database(sourceDbPath, { readonly: true });
  try {
    database.exec(`VACUUM INTO ${sqliteStringLiteral(targetDbPath)}`);
  } finally {
    database.close();
  }
}

export async function cloneSqliteDatabase(
  sourceDbPath: string,
  targetDbPath: string,
): Promise<void> {
  if (process.versions.bun !== undefined) {
    await cloneWithBunSqlite(sourceDbPath, targetDbPath);
    return;
  }
  await cloneWithNodeSqlite(sourceDbPath, targetDbPath);
}

function copyNonDatabaseEntries(
  legacyStateDir: string,
  tempStateDir: string,
  dbFileName: string,
): void {
  const sidecars = databaseSidecarNames(dbFileName);
  for (const entry of FS.readdirSync(legacyStateDir, { withFileTypes: true })) {
    if (sidecars.has(entry.name)) {
      continue;
    }

    FS.cpSync(Path.join(legacyStateDir, entry.name), Path.join(tempStateDir, entry.name), {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
  }
}

async function migrateLegacyT3StateInternal(
  input: ResolvedLegacyStateMigrationInput,
): Promise<LegacyStateMigrationResult> {
  const legacyStateDir = Path.resolve(input.legacyStateDir);
  const targetStateDir = Path.resolve(input.targetStateDir);
  const legacyDbPath = Path.join(legacyStateDir, input.dbFileName);
  const targetDbPath = Path.join(targetStateDir, input.dbFileName);
  const failureSentinelPath = Path.join(targetStateDir, LEGACY_STATE_MIGRATION_FAILURE_SENTINEL);

  if (legacyStateDir === targetStateDir) {
    return { status: "skipped", reason: "same-path" };
  }

  if (FS.existsSync(failureSentinelPath)) {
    return { status: "skipped", reason: "previous-failure" };
  }

  if (FS.existsSync(targetDbPath)) {
    return { status: "skipped", reason: "target-db-exists" };
  }

  if (!FS.existsSync(legacyDbPath)) {
    return { status: "skipped", reason: "legacy-db-missing" };
  }

  const targetParentDir = Path.dirname(targetStateDir);
  FS.mkdirSync(targetParentDir, { recursive: true });
  const tempStateDir = FS.mkdtempSync(
    Path.join(targetParentDir, `.${Path.basename(targetStateDir)}.legacy-migration-`),
  );

  try {
    copyNonDatabaseEntries(legacyStateDir, tempStateDir, input.dbFileName);
    await input.cloneSqliteDatabase(legacyDbPath, Path.join(tempStateDir, input.dbFileName));

    if (FS.existsSync(targetStateDir)) {
      if (FS.existsSync(targetDbPath)) {
        FS.rmSync(tempStateDir, { recursive: true, force: true });
        return { status: "skipped", reason: "target-db-exists" };
      }

      const targetEntries = FS.readdirSync(targetStateDir).filter(
        (entry) => !ignorableTargetStateEntries.has(entry),
      );
      if (targetEntries.length > 0) {
        throw new Error(
          `Target state directory already exists and is not empty: ${targetStateDir}`,
        );
      }
      FS.rmSync(targetStateDir, { recursive: true, force: true });
    }

    try {
      FS.renameSync(tempStateDir, targetStateDir);
    } catch (error) {
      if (FS.existsSync(targetDbPath)) {
        FS.rmSync(tempStateDir, { recursive: true, force: true });
        return { status: "skipped", reason: "target-db-exists" };
      }
      throw error;
    }
    return { status: "migrated", legacyStateDir, targetStateDir };
  } catch (error) {
    FS.rmSync(tempStateDir, { recursive: true, force: true });
    throw error;
  }
}

export const migrateLegacyT3StateIfNeeded = (input: LegacyStateMigrationInput = {}) =>
  Effect.tryPromise({
    try: () =>
      migrateLegacyT3StateInternal({
        legacyStateDir: input.legacyStateDir ?? legacyT3UserdataStateDir(),
        targetStateDir: input.targetStateDir ?? defaultF5UserdataStateDir(),
        dbFileName: input.dbFileName ?? STATE_DB_FILE_NAME,
        cloneSqliteDatabase: input.cloneSqliteDatabase ?? cloneSqliteDatabase,
      }),
    catch: (cause) =>
      new LegacyStateMigrationError({
        message:
          "Failed to copy legacy T3 state into the F5 state directory. " +
          "The legacy T3 directory was left untouched.",
        cause,
      }),
  });

export const writeLegacyStateMigrationFailureSentinel = (input: {
  readonly targetStateDir?: string | undefined;
  readonly cause: unknown;
}) =>
  Effect.tryPromise({
    try: async () => {
      const targetStateDir = Path.resolve(input.targetStateDir ?? defaultF5UserdataStateDir());
      FS.mkdirSync(targetStateDir, { recursive: true });
      FS.writeFileSync(
        Path.join(targetStateDir, LEGACY_STATE_MIGRATION_FAILURE_SENTINEL),
        `${JSON.stringify(
          {
            createdAt: new Date().toISOString(),
            message: formatUnknownCause(input.cause),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    },
    catch: (cause) =>
      new LegacyStateMigrationError({
        message: "Failed to write the legacy T3 state migration failure sentinel.",
        cause,
      }),
  });
