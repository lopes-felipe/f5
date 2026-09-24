import { execFileSync } from "node:child_process";
import { sha256, SHA256_PATTERN } from "./upstream-port-ledger.ts";
import {
  closeSync,
  existsSync,
  fsyncSync,
  fchmodSync,
  statSync,
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
  readonly processStart?: string;
  readonly nextDigest?: PortTexts;
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

function durableWrite(file: string, text: string, mode: number): void {
  const fd = openSync(file, "w", mode);
  try {
    fchmodSync(fd, mode);
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
  durableWrite(stages.manifestStage, texts.manifest, statSync(files.manifest).mode & 0o777);
  durableWrite(stages.ledgerStage, texts.ledger, statSync(files.ledger).mode & 0o777);
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

/** Use OS process creation time, not PID alone, to distinguish a reused PID. */
function processStart(pid: number): string {
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${ticks}`;
  }
  const value =
    process.platform === "win32"
      ? execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
          ],
          { encoding: "utf8" },
        )
      : execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
          encoding: "utf8",
          env: { ...process.env, LC_ALL: "C" },
        });
  if (!value.trim()) throw new Error(`cannot determine start time for process ${pid}`);
  return value.trim();
}

function manualRecovery(journalPath: string): string {
  return `Inspect ${journalPath} and the canonical files; after confirming no writer or recovery is active and repairing the pair if necessary, remove ${journalPath} and ${journalPath}.recovering if present, then retry.`;
}

/** Recover a killed writer before reading either file. Live writers fail closed. */
export function recoverPortFiles(files: PortFiles): void {
  const journalPath = pathsFor(files).journal;
  if (!existsSync(journalPath)) return;
  const journalText = readFileSync(journalPath, "utf8");
  let journal: unknown;
  try {
    journal = JSON.parse(journalText);
  } catch {
    throw new Error(`empty or truncated refresh journal. ${manualRecovery(journalPath)}`);
  }
  if (
    !journal ||
    typeof journal !== "object" ||
    !("pid" in journal) ||
    !("host" in journal) ||
    !("paths" in journal) ||
    !("manifest" in journal) ||
    !("ledger" in journal)
  ) {
    throw new Error(`incomplete refresh journal. ${manualRecovery(journalPath)}`);
  }
  const value = journal as Journal;
  if (
    value.host !== hostname() ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.manifest !== "string" ||
    typeof value.ledger !== "string" ||
    (value.processStart !== undefined &&
      (typeof value.processStart !== "string" || !value.processStart.trim())) ||
    (value.nextDigest !== undefined &&
      (!value.nextDigest ||
        typeof value.nextDigest !== "object" ||
        !SHA256_PATTERN.test(value.nextDigest.ledger) ||
        !SHA256_PATTERN.test(value.nextDigest.manifest))) ||
    value.paths?.manifest !== files.manifest ||
    value.paths?.ledger !== files.ledger
  ) {
    throw new Error(
      `cannot recover a refresh journal from another host or file pair. ${manualRecovery(journalPath)}`,
    );
  }
  let alive = true;
  try {
    process.kill(value.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
  }
  if (alive && value.processStart) {
    try {
      alive = processStart(value.pid) === value.processStart;
    } catch {
      throw new Error(`cannot verify refresh process identity. ${manualRecovery(journalPath)}`);
    }
  }
  if (alive)
    throw new Error(
      `upstream refresh is already running (pid ${value.pid}); journal: ${journalPath}. ${manualRecovery(journalPath)}`,
    );
  const recoveryLock = `${journalPath}.recovering`;
  try {
    mkdirSync(recoveryLock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `refresh recovery lock exists: ${recoveryLock}. ${manualRecovery(journalPath)}`,
      );
    throw error;
  }
  try {
    // Another recovery may have finished between our initial read and this lock.
    // Never restore its stale snapshot over a subsequent writer's generation.
    if (!existsSync(journalPath)) return;
    if (readFileSync(journalPath, "utf8") !== journalText)
      throw new Error("refresh journal changed during recovery; retry");
    // Both renames may have completed before cleanup was interrupted. Preserve
    // that published generation rather than restoring the undo snapshot.
    const completed =
      value.nextDigest &&
      sha256(readFileSync(files.manifest, "utf8")) === value.nextDigest.manifest &&
      sha256(readFileSync(files.ledger, "utf8")) === value.nextDigest.ledger;
    if (!completed) replacePair(files, value);
    else
      for (const directory of new Set([path.dirname(files.manifest), path.dirname(files.ledger)]))
        syncDirectory(directory);
    finish(files);
  } finally {
    rmdirSync(recoveryLock);
  }
}

export function readPortFiles(files: PortFiles): PortTexts {
  const journalPath = pathsFor(files).journal;
  if (existsSync(journalPath))
    throw new Error(
      `refresh journal exists: ${journalPath}; validation is read-only. Run the refresh or classification command to recover it. ${manualRecovery(journalPath)}`,
    );
  const texts = {
    manifest: readFileSync(files.manifest, "utf8"),
    ledger: readFileSync(files.ledger, "utf8"),
  };
  if (existsSync(pathsFor(files).journal))
    throw new Error("upstream refresh began while reading; retry");
  return texts;
}
