// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { atomicJson, copyDurable, exclusiveJson, exists, readJson, syncDirectory } from "./files";
import { readInstalled, runtimePaths, preflightRuntime } from "./installation";
import { cliTarget, versionToken, compareCliReleaseVersions } from "@t3tools/shared/cliRelease";
export interface UpdateRequest {
  schemaVersion: 1;
  id: string;
  version: string;
}
export interface UpdateOutcome {
  id: string;
  outcome: "committed" | "rolled-back";
  version: string;
}
export async function readUpdateOutcome(root: string): Promise<UpdateOutcome | undefined> {
  const file = path.join(root, "outcome.json");
  if (!(await exists(file))) return undefined;
  const value = await readJson(file);
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    !("outcome" in value) ||
    !("version" in value) ||
    (value.outcome !== "committed" && value.outcome !== "rolled-back")
  )
    throw new Error("Invalid durable update outcome.");
  return { id: updateId(value.id), outcome: value.outcome, version: versionToken(value.version) };
}
interface Journal {
  database: string;
  schemaVersion: 1;
  id: string;
  previous: string;
  version: string;
  phase: "snapshotting" | "trial" | "committed" | "restoring";
}
const suffixes = ["", "-wal", "-shm"] as const;
function updateId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value))
    throw new Error("Invalid update identifier.");
  return value;
}
export function parseRequest(value: unknown): UpdateRequest {
  if (
    !value ||
    typeof value !== "object" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("id" in value) ||
    !("version" in value)
  )
    throw new Error("Invalid update request.");
  return { schemaVersion: 1, id: updateId(value.id), version: versionToken(value.version) };
}
function parseJournal(value: unknown): Journal {
  const request = parseRequest(value);
  if (
    !value ||
    typeof value !== "object" ||
    !("database" in value) ||
    typeof value.database !== "string" ||
    !path.isAbsolute(value.database) ||
    !("previous" in value) ||
    !("phase" in value) ||
    !["snapshotting", "trial", "committed", "restoring"].includes(String(value.phase))
  )
    throw new Error("Invalid update journal.");
  return {
    ...request,
    database: value.database,
    previous: versionToken(value.previous),
    phase: value.phase as Journal["phase"],
  };
}
export async function requestUpdate(root: string, version: string): Promise<UpdateRequest> {
  if (
    (await exists(path.join(root, "pending.json"))) ||
    (await exists(path.join(root, "handoff.json")))
  )
    throw new Error("An update is already pending. Check f5 update-status first.");
  const current = await readInstalled(root);
  if (compareCliReleaseVersions(version, current.version) <= 0)
    throw new Error(
      "Updates require a newer version; same-version updates and downgrades are rejected.",
    );
  await preflightRuntime(root, version);
  const request: UpdateRequest = {
    schemaVersion: 1,
    id: randomUUID(),
    version: versionToken(version),
  };
  await exclusiveJson(path.join(root, "pending.json"), request);
  return request;
}
export async function snapshotDatabase(database: string, backup: string): Promise<void> {
  await fs.mkdir(backup, { recursive: true, mode: 0o700 });
  const present: string[] = [];
  for (const suffix of suffixes)
    if (await exists(database + suffix)) {
      await copyDurable(database + suffix, path.join(backup, `database${suffix}`));
      present.push(suffix);
    }
  await atomicJson(path.join(backup, "complete.json"), { present });
}
export async function restoreDatabase(database: string, backup: string): Promise<void> {
  const metadata = await readJson(path.join(backup, "complete.json"));
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !("present" in metadata) ||
    !Array.isArray(metadata.present) ||
    metadata.present.some(
      (item: unknown) =>
        typeof item !== "string" || !(suffixes as readonly string[]).includes(item),
    )
  )
    throw new Error("Incomplete database snapshot; refusing to start a server.");
  await fs.mkdir(path.dirname(database), { recursive: true, mode: 0o700 });
  for (const suffix of suffixes) {
    if (metadata.present.includes(suffix)) {
      const temporary = `${database}${suffix}.restore`;
      await copyDurable(path.join(backup, `database${suffix}`), temporary);
      await fs.rename(temporary, database + suffix);
    } else await fs.rm(database + suffix, { force: true });
  }
  await syncDirectory(path.dirname(database));
}
/** Journal recovery is repeatable even if a launcher dies partway through restoration. */
export async function recoverHandoff(
  root: string,
  database: string,
): Promise<UpdateOutcome | undefined> {
  const file = path.join(root, "handoff.json");
  if (!(await exists(file))) return undefined;
  const journal = parseJournal(await readJson(file));
  database = await canonicalDatabase(database);
  if (journal.database !== database)
    throw new Error(
      "Update journal belongs to another database; restart with its original --state-dir. No database was modified.",
    );
  if (journal.phase === "committed") {
    await atomicJson(path.join(root, "current.json"), {
      schemaVersion: 1,
      version: journal.version,
      target: cliTarget(),
    });
    const outcome: UpdateOutcome = {
      id: journal.id,
      outcome: "committed",
      version: journal.version,
    };
    await atomicJson(path.join(root, "outcome.json"), outcome);
    await fs.rm(path.join(root, "pending.json"), { force: true });
    await fs.unlink(file);
    return outcome;
  }
  if (journal.phase !== "snapshotting") {
    await atomicJson(file, { ...journal, phase: "restoring" });
    await restoreDatabase(database, path.join(root, "db-backup", journal.id));
  }
  await atomicJson(path.join(root, "current.json"), {
    schemaVersion: 1,
    version: journal.previous,
    target: cliTarget(),
  });
  const outcome: UpdateOutcome = {
    id: journal.id,
    outcome: "rolled-back",
    version: journal.previous,
  };
  await atomicJson(path.join(root, "outcome.json"), outcome);
  await fs.rm(path.join(root, "pending.json"), { force: true });
  await fs.unlink(file);
  return outcome;
}
async function canonicalDatabase(database: string): Promise<string> {
  const absolute = path.resolve(database);
  try {
    return await fs.realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.join(await fs.realpath(path.dirname(absolute)), path.basename(absolute));
  }
}
export async function cleanupCommitted(root: string): Promise<void> {
  await fs.rm(path.join(root, "pending.json"), { force: true });
  await fs.unlink(path.join(root, "handoff.json"));
  await syncDirectory(root);
  const directory = path.join(root, "db-backup");
  const entries = await fs.readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const completed = await Promise.all(
    entries
      .filter((id) => /^[a-f0-9-]{36}$/.test(id))
      .map(async (id) => {
        const marker = path.join(directory, id, "complete.json");
        return await fs.stat(marker).then(
          (stat) => ({ id, at: stat.mtimeMs }),
          () => undefined,
        );
      }),
  );
  const older = completed
    .filter((entry) => entry !== undefined)
    .sort((a, b) => b.at - a.at)
    .slice(3);
  for (const entry of older) await fs.rm(path.join(directory, entry.id), { recursive: true });
}
export interface TrialChild {
  prepared: Promise<void>;
  activated: Promise<void>;
  activate(): Promise<void>;
  stop(): Promise<void>;
}
export interface HandoffDependencies {
  stopOld(): Promise<void>;
  trial(version: string, id: string): TrialChild;
  restart(version: string, outcome: UpdateOutcome): Promise<void>;
  preflight(version: string): Promise<void>;
}
export async function performHandoff(
  root: string,
  database: string,
  request: UpdateRequest,
  deps: HandoffDependencies,
): Promise<UpdateOutcome> {
  database = await canonicalDatabase(database);
  const current = await readInstalled(root);
  if (compareCliReleaseVersions(request.version, current.version) <= 0)
    throw new Error("Update is not newer than the active runtime.");
  await deps.preflight(request.version); // Never stop a healthy child for an unusable launcher.
  const file = path.join(root, "handoff.json");
  let journal: Journal = { ...request, database, previous: current.version, phase: "snapshotting" };
  let required = 8 * 1024 * 1024;
  for (const suffix of suffixes)
    required += await fs.stat(database + suffix).then(
      (stat) => stat.size,
      (error) => {
        if (error.code === "ENOENT") return 0;
        throw error;
      },
    );
  const disk = await fs.statfs(root);
  if (disk.bavail * disk.bsize < required * 1.25)
    throw new Error("Insufficient free space for a recoverable database snapshot.");
  await deps.stopOld();
  await atomicJson(file, journal);
  let child: TrialChild | undefined;
  try {
    await snapshotDatabase(database, path.join(root, "db-backup", request.id));
    journal = { ...journal, phase: "trial" };
    await atomicJson(file, journal);
    child = deps.trial(request.version, request.id);
    await child.prepared;
    // Publish the decision durably before releasing the child activation gate.
    const committed: Journal = { ...journal, phase: "committed" };
    await atomicJson(file, committed);
    journal = committed;
    await atomicJson(path.join(root, "current.json"), {
      schemaVersion: 1,
      version: request.version,
      target: cliTarget(),
    });
    const outcome: UpdateOutcome = {
      id: request.id,
      outcome: "committed",
      version: request.version,
    };
    await atomicJson(path.join(root, "outcome.json"), outcome);
    await child.activate();
    await child.activated;
    // Cleanup failure must never restore a database after activation.
    await cleanupCommitted(root).catch((error) =>
      console.error(`Committed update cleanup will retry on restart: ${String(error)}`),
    );
    return outcome;
  } catch (error) {
    if (journal.phase === "committed")
      throw new Error(
        `Update was durably committed; preserving the new database for roll-forward recovery: ${error instanceof Error ? error.message : "activation failed"}`,
      );
    // A live trial must never share the database with restoration or the old child.
    if (journal.phase !== "snapshotting") {
      journal = { ...journal, phase: "restoring" };
      await atomicJson(file, journal);
    }
    await child?.stop();
    if (journal.phase === "restoring") {
      await restoreDatabase(database, path.join(root, "db-backup", request.id));
    }
    await atomicJson(path.join(root, "current.json"), {
      schemaVersion: 1,
      version: current.version,
      target: cliTarget(),
    });
    const outcome: UpdateOutcome = {
      id: request.id,
      outcome: "rolled-back",
      version: current.version,
    };
    await atomicJson(path.join(root, "outcome.json"), outcome);
    await fs.rm(path.join(root, "pending.json"), { force: true });
    await fs.unlink(file);
    await deps.restart(current.version, outcome);
    console.error(
      `F5 update ${request.id} rolled back: ${error instanceof Error ? error.message : "trial failed"}`,
    );
    return outcome;
  }
}
function deadline(promise: Promise<void>, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server trial timed out.")), timeout);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
export function managedChild(
  root: string,
  version: string,
  stateDir: string,
  args: readonly string[],
  update?: UpdateOutcome,
  trial = false,
): TrialChild & { process: ChildProcess } {
  const child = spawn(
    runtimePaths(root, version).executable,
    ["--state-dir", stateDir, "--no-browser", ...args],
    {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        F5_LAUNCHER_CHILD: "1",
        F5_LAUNCHER_DATABASE: path.resolve(stateDir, "state.sqlite"),
        F5_PROFILE: "default",
        F5_UPDATE_TRIAL: trial ? "1" : "0",
        F5_UPDATE_ID: update?.id ?? "",
        F5_UPDATE_OUTCOME: update?.outcome ?? "",
        F5_UPDATE_VERSION: version,
      },
    },
  );
  const waitFor = (type: string) =>
    new Promise<void>((resolve, reject) => {
      const message = (value: unknown) => {
        if (
          value &&
          typeof value === "object" &&
          "type" in value &&
          value.type === type &&
          "id" in value &&
          value.id === (update?.id ?? "")
        ) {
          cleanup();
          resolve();
        }
      };
      const ended = () => {
        cleanup();
        reject(new Error("Server exited before completing startup."));
      };
      const failed = () => {
        cleanup();
        reject(new Error("Could not start server executable."));
      };
      const cleanup = () => {
        child.off("message", message);
        child.off("exit", ended);
        child.off("error", failed);
      };
      child.on("message", message);
      child.once("exit", ended);
      child.once("error", failed);
    });
  const prepared = trial ? deadline(waitFor("prepared"), 120_000) : Promise.resolve();
  const activeSignal = waitFor("active");
  let activated = activeSignal;
  // Both are installed before the process can emit; prevent unhandled rejection while awaiting prepared.
  void activated.catch(() => {});
  return {
    process: child,
    prepared,
    get activated() {
      return activated;
    },
    activate: () => {
      activated = deadline(activeSignal, 120_000);
      void activated.catch(() => {});
      return new Promise<void>((resolve, reject) =>
        child.send({ type: "activate", id: update?.id ?? "" }, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve, reject) => {
        const force = setTimeout(() => child.kill("SIGKILL"), 5000);
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Server did not exit; refusing database restoration."));
        }, 15_000);
        const exited = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          clearTimeout(force);
          clearTimeout(timeout);
          child.off("exit", exited);
        };
        child.once("exit", exited);
        child.kill("SIGTERM");
      });
    },
  };
}
