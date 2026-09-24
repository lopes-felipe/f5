import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A read sees the old or new complete file, independent of writer locks. */
export function readLedgerText(file: string): string {
  return readFileSync(file, "utf8");
}

/** Shared by refresh, classification and migration. Never steal even a stale lock. */
export function withLedgerLock<T>(file: string, operation: () => T): T {
  const lock = `${file}.lock`;
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `Ledger writer lock exists: ${lock}. Inspect it and ${file}; after confirming no writer is active, remove ${lock} and any ${file}.tmp-* files, then retry. Locks are never stolen automatically.`,
      );
    throw error;
  }
  try {
    writeFileSync(
      fd,
      JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }),
    );
    fsyncSync(fd);
    return operation();
  } finally {
    closeSync(fd);
    unlinkSync(lock);
    syncDirectory(path.dirname(file));
  }
}

/** Caller owns the lock. Hooks exercise process death on either side of the rename. */
export function publishLedgerText(
  file: string,
  expected: string,
  next: string,
  hooks?: { beforeRename?: () => void; afterRename?: () => void },
): void {
  const stage = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let staged = false;
  try {
    if (readLedgerText(file) !== expected)
      throw new Error(
        "ledger changed during publication; retry without overwriting concurrent edits",
      );
    const mode = statSync(file).mode & 0o777;
    const fd = openSync(stage, "wx", mode);
    staged = true;
    try {
      fchmodSync(fd, mode);
      writeFileSync(fd, next);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    hooks?.beforeRename?.();
    if (readLedgerText(file) !== expected)
      throw new Error(
        "ledger changed during publication; retry without overwriting concurrent edits",
      );
    renameSync(stage, file);
    staged = false;
    hooks?.afterRename?.();
    syncDirectory(path.dirname(file));
  } finally {
    if (staged && existsSync(stage)) unlinkSync(stage);
  }
}
export function writeLedgerText(
  file: string,
  expected: string,
  next: string,
  hooks?: Parameters<typeof publishLedgerText>[3],
): void {
  withLedgerLock(file, () => publishLedgerText(file, expected, next, hooks));
}
