import { execFileSync } from "node:child_process";
import { constants as fsConstants, copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";

/** Bun-only maintenance scripts must close F5 before mutating its database. */
export function assertDatabaseOffline(dbPath: string): void {
  try {
    const output = execFileSync("lsof", ["-t", "--", dbPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (output.length > 0) {
      throw new Error(
        `Refusing to repair an open database (${dbPath}); stop F5 first. Holder PIDs: ${output}`,
      );
    }
  } catch (error) {
    if ((error as { status?: unknown }).status === 1) return;
    throw error;
  }
}

export function createRepairBackup(dbPath: string, stateDir: string, name: string): string {
  const backupDir = path.join(stateDir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const backupPath = path.join(backupDir, `state-before-${name}-${timestamp}.sqlite`);
  const source = new Database(dbPath);
  try {
    const checkpoint = source.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
      readonly busy: number;
    };
    if (checkpoint.busy !== 0)
      throw new Error("Could not checkpoint the F5 database before backup");
  } finally {
    source.close();
  }
  copyFileSync(dbPath, backupPath, fsConstants.COPYFILE_FICLONE);
  return backupPath;
}
