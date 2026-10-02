// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicJson, exists, readJson } from "./files";
import { readInstalled, preflightRuntime } from "./installation";
import {
  managedChild,
  parseRequest,
  performHandoff,
  recoverHandoff,
  readUpdateOutcome,
  type UpdateOutcome,
} from "./handoff";
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
interface Lease {
  pid: number;
  token: string;
  child: number | null;
}
function parseLease(value: unknown): Lease {
  if (
    !value ||
    typeof value !== "object" ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    !("token" in value) ||
    typeof value.token !== "string" ||
    !("child" in value) ||
    !(
      value.child === null ||
      (typeof value.child === "number" && Number.isSafeInteger(value.child) && value.child > 0)
    )
  )
    throw new Error("Invalid launcher lease; refusing to run a second server.");
  return { pid: value.pid, token: value.token, child: value.child };
}
export async function acquireLauncherLease(
  root: string,
): Promise<{ child(pid: number | null): Promise<void>; release(): Promise<void> }> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, "launcher.json");
  if (await exists(file)) {
    const recovery = path.join(root, ".launcher-recovery-lock");
    const claim = await fs.open(recovery, "wx", 0o600).catch(() => {
      throw new Error(
        "Launcher recovery is already running. Confirm no launcher is running before removing its recovery lock.",
      );
    });
    await claim.close();
    try {
      if (await exists(file)) {
        const lease = parseLease(await readJson(file));
        if (alive(lease.pid)) throw new Error("An F5 launcher is already running.");
        for (let attempt = 0; lease.child && alive(lease.child) && attempt < 30; attempt++)
          await delay(100);
        if (lease.child && alive(lease.child))
          throw new Error(
            "The previous server child is still alive; database recovery is blocked.",
          );
        await fs.unlink(file);
      }
    } finally {
      await fs.unlink(recovery);
    }
  }
  const lease: Lease = { pid: process.pid, token: randomUUID(), child: null };
  const handle = await fs.open(file, "wx", 0o600).catch(() => {
    throw new Error("An F5 launcher is already starting.");
  });
  try {
    await handle.writeFile(JSON.stringify(lease));
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {
    async child(pid) {
      lease.child = pid;
      await atomicJson(file, lease);
    },
    async release() {
      const value = parseLease(await readJson(file));
      if (value.token === lease.token) await fs.unlink(file);
    },
  };
}
export async function runLauncher(
  root: string,
  stateDir: string,
  args: readonly string[] = [],
): Promise<void> {
  // A launcher owns one explicit profile database. Services never auto-resolve a different profile.
  const lease = await acquireLauncherLease(root);
  let child: ReturnType<typeof managedChild> | undefined;
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const recovered = await recoverHandoff(root, path.join(stateDir, "state.sqlite"));
    const start = async (version: string, outcome?: UpdateOutcome) => {
      child = managedChild(root, version, stateDir, args, outcome);
      await lease.child(child.process.pid ?? null);
      await child.activated;
    };
    const version = (await readInstalled(root)).version;
    const outcome = recovered ?? (await readUpdateOutcome(root));
    await start(version, outcome?.version === version ? outcome : undefined);
    while (!stopping) {
      if (await exists(path.join(root, "pending.json"))) {
        const request = parseRequest(await readJson(path.join(root, "pending.json")));
        try {
          await performHandoff(root, path.join(stateDir, "state.sqlite"), request, {
            stopOld: async () => {
              await child?.stop();
              await lease.child(null);
            },
            preflight: (version) => preflightRuntime(root, version),
            trial: (version, id) => {
              child = managedChild(
                root,
                version,
                stateDir,
                args,
                { id, version, outcome: "committed" },
                true,
              );
              // The lease update must complete before any later recovery can restore the database.
              const recorded = lease.child(child.process.pid ?? null);
              const trial = child;
              return { ...trial, prepared: recorded.then(() => trial.prepared) };
            },
            restart: start,
          });
        } catch (error) {
          if (
            (await exists(path.join(root, "handoff.json"))) ||
            !child ||
            child.process.exitCode !== null ||
            child.process.signalCode !== null
          ) {
            throw new Error(
              `Update handoff stopped: ${error instanceof Error ? error.message : "unknown failure"}`,
            );
          }
          // A preflight rejection leaves the healthy child running and resolves this request.
          await atomicJson(path.join(root, "outcome.json"), {
            id: request.id,
            outcome: "rolled-back",
            version: (await readInstalled(root)).version,
          });
          await fs.rm(path.join(root, "pending.json"), { force: true });
          console.error(`F5 update ${request.id} rejected before handoff.`);
        }
      }
      if (child && (child.process.exitCode !== null || child.process.signalCode !== null))
        throw new Error("F5 server exited; restart the launcher after reviewing server logs.");
      await delay(250);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await child?.stop();
    await lease.child(null);
    await lease.release();
  }
}
