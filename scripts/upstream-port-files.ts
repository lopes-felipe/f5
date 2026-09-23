import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  rmdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

export interface PortFiles {
  readonly manifest: string;
  readonly ledger: string;
}
export interface PortTexts {
  readonly manifest: string;
  readonly ledger: string;
}
interface Journal extends PortTexts {
  readonly pid: number;
  readonly host: string;
  readonly paths: PortFiles;
}

function syncDirectory(directory: string): void {
  // Windows does not expose directory handles through this Node filesystem API.
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function durableWrite(file: string, text: string): void {
  const fd = openSync(file, "w", 0o600);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function pathsFor(files: PortFiles) {
  return {
    journal: `${files.ledger}.refresh-journal`,
    manifestStage: `${files.manifest}.refresh-next`,
    ledgerStage: `${files.ledger}.refresh-next`,
  };
}

function replacePair(files: PortFiles, texts: PortTexts, afterManifest?: () => void): void {
  const stages = pathsFor(files);
  durableWrite(stages.manifestStage, texts.manifest);
  durableWrite(stages.ledgerStage, texts.ledger);
  renameSync(stages.manifestStage, files.manifest);
  afterManifest?.();
  renameSync(stages.ledgerStage, files.ledger);
  for (const directory of new Set([path.dirname(files.manifest), path.dirname(files.ledger)]))
    syncDirectory(directory);
}

function finish(files: PortFiles): void {
  const paths = pathsFor(files);
  for (const stage of [paths.manifestStage, paths.ledgerStage]) {
    if (existsSync(stage)) unlinkSync(stage);
  }
  unlinkSync(paths.journal);
  syncDirectory(path.dirname(paths.journal));
}

/** Recover a killed writer before reading either file. Live writers fail closed. */
export function recoverPortFiles(files: PortFiles): void {
  const journalPath = pathsFor(files).journal;
  if (!existsSync(journalPath)) return;
  const journalText = readFileSync(journalPath, "utf8");
  const journal: unknown = JSON.parse(journalText);
  if (
    !journal ||
    typeof journal !== "object" ||
    !("pid" in journal) ||
    !("host" in journal) ||
    !("paths" in journal) ||
    !("manifest" in journal) ||
    !("ledger" in journal)
  ) {
    throw new Error(
      "incomplete refresh journal; canonical files were not replaced before the journal was synced",
    );
  }
  const value = journal as Journal;
  if (
    value.host !== hostname() ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.manifest !== "string" ||
    typeof value.ledger !== "string" ||
    value.paths?.manifest !== files.manifest ||
    value.paths?.ledger !== files.ledger
  ) {
    throw new Error("cannot recover a refresh journal from another host or file pair");
  }
  let alive = true;
  try {
    process.kill(value.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
  }
  if (alive) throw new Error(`upstream refresh is already running (pid ${value.pid})`);
  const recoveryLock = `${journalPath}.recovering`;
  mkdirSync(recoveryLock);
  try {
    // Another recovery may have finished between our initial read and this lock.
    // Never restore its stale snapshot over a subsequent writer's generation.
    if (!existsSync(journalPath)) return;
    if (readFileSync(journalPath, "utf8") !== journalText)
      throw new Error("refresh journal changed during recovery; retry");
    replacePair(files, value);
    finish(files);
  } finally {
    rmdirSync(recoveryLock);
  }
}

export function readPortFiles(files: PortFiles): PortTexts {
  recoverPortFiles(files);
  const texts = {
    manifest: readFileSync(files.manifest, "utf8"),
    ledger: readFileSync(files.ledger, "utf8"),
  };
  if (existsSync(pathsFor(files).journal))
    throw new Error("upstream refresh began while reading; retry");
  return texts;
}

/**
 * Two paths cannot be atomically renamed together. A synced undo journal makes
 * interrupted publication recoverable; readers either see a complete pair or fail
 * closed until the next invocation restores the prior pair. The hook allows tests
 * to kill a subprocess at the otherwise unobservable split-rename boundary.
 */
export function writePortFiles(
  files: PortFiles,
  expected: PortTexts,
  next: PortTexts,
  afterManifest?: () => void,
): void {
  recoverPortFiles(files);
  const journalPath = pathsFor(files).journal;
  const fd = openSync(journalPath, "wx", 0o600);
  let journalReady = false;
  let canFinish = false;
  try {
    const current = {
      manifest: readFileSync(files.manifest, "utf8"),
      ledger: readFileSync(files.ledger, "utf8"),
    };
    if (current.manifest !== expected.manifest || current.ledger !== expected.ledger)
      throw new Error("ledger changed during refresh; retry without overwriting concurrent edits");
    writeFileSync(
      fd,
      JSON.stringify({
        ...current,
        paths: files,
        pid: process.pid,
        host: hostname(),
      } satisfies Journal),
    );
    fsyncSync(fd);
    journalReady = true;
    syncDirectory(path.dirname(journalPath));
    replacePair(files, next, afterManifest);
    canFinish = true;
  } catch (error) {
    if (journalReady) replacePair(files, expected);
    canFinish = true;
    throw error;
  } finally {
    closeSync(fd);
    // If rollback itself fails, retain the journal for recovery instead of losing
    // the only durable copy of the previous pair.
    if (canFinish) finish(files);
  }
}
