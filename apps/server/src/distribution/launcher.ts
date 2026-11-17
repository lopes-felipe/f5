// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicJson, exclusiveJson, exists, readJson } from "./files";
import { processBirth, sameProcess } from "./processIdentity";
import { readInstalled, preflightRuntime } from "./installation";
import {
  managedChild,
  parseRequest,
  performHandoff,
  recoverHandoff,
  readUpdateOutcome,
  type UpdateOutcome,
} from "./handoff";
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
interface Lease {
  pid: number;
  token: string;
  child: number | null;
  birth?: string;
  childBirth?: string;
  service?: boolean;
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
  return {
    pid: value.pid,
    token: value.token,
    child: value.child,
    ...("service" in value && value.service === true ? { service: true } : {}),
    ...("birth" in value && typeof value.birth === "string" ? { birth: value.birth } : {}),
    ...("childBirth" in value && typeof value.childBirth === "string"
      ? { childBirth: value.childBirth }
      : {}),
  };
}
export async function acquireLauncherLease(
  root: string,
  probeBirth: (pid: number) => Promise<string> = processBirth,
): Promise<{
  readonly token: string;
  child(pid: number | null): Promise<void>;
  release(): Promise<void>;
}> {
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
        if (await sameProcess(lease.pid, lease.birth, probeBirth))
          throw new Error(
            "An F5 launcher is already running, or its saved PID was reused. Verify the process before manually removing launcher.json.",
          );
        for (
          let attempt = 0;
          lease.child &&
          (await sameProcess(lease.child, lease.childBirth, probeBirth)) &&
          attempt < 30;
          attempt++
        )
          await delay(100);
        if (lease.child && (await sameProcess(lease.child, lease.childBirth, probeBirth)))
          throw new Error(
            "The previous server child is still alive, or its PID was reused; database recovery is blocked. Verify the process before manually removing launcher.json.",
          );
        await fs.unlink(file);
      }
    } finally {
      await fs.unlink(recovery);
    }
  }
  const lease: Lease = {
    pid: process.pid,
    birth: await probeBirth(process.pid),
    token: randomUUID(),
    child: null,
    ...(process.env.F5_WINDOWS_SERVICE === "1" ? { service: true } : {}),
  };
  await exclusiveJson(file, lease).catch(() => {
    throw new Error("An F5 launcher is already starting.");
  });
  return {
    token: lease.token,
    async child(pid) {
      lease.child = pid;
      if (pid) lease.childBirth = await probeBirth(pid);
      else delete lease.childBirth;
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
  probeBirth: typeof processBirth = processBirth,
): Promise<void> {
  // A launcher owns one explicit profile database. Services never auto-resolve a different profile.
  let child: ReturnType<typeof managedChild> | undefined;
  let stopping = false;
  let signalStop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    signalStop = resolve;
  });
  const stop = () => {
    stopping = true;
    signalStop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const onMessage = (message: unknown) => {
    if (message && typeof message === "object" && "type" in message && message.type === "stop")
      stop();
  };
  process.on("message", onMessage);
  if (process.env.F5_LAUNCHER_SUPERVISOR === "1") process.once("disconnect", stop);
  if (process.env.F5_LAUNCHER_SUPERVISOR === "1" && !process.connected) stop();
  const lease = await acquireLauncherLease(root, probeBirth);
  // Startup can wait indefinitely for activation. Observe service stop requests independently.
  const stopWatcher = (async () => {
    while (!stopping) {
      const request = await readJson(path.join(root, "service-stop.json")).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError)
          return null;
        throw error;
      });
      if (
        request &&
        typeof request === "object" &&
        "token" in request &&
        request.token === lease.token
      )
        stop();
      if (!stopping) await Promise.race([delay(250), stopped]);
    }
  })();
  let watcherError: unknown;
  void stopWatcher.catch((error) => {
    watcherError = error;
    stop();
  });
  try {
    if (stopping) return;
    const recovered = await recoverHandoff(root, path.join(stateDir, "state.sqlite"));
    const start = async (version: string, outcome?: UpdateOutcome) => {
      child = managedChild(root, version, stateDir, args, outcome);
      await lease.child(child.process.pid ?? null);
      await Promise.race([child.activated, stopped]);
    };
    const version = (await readInstalled(root)).version;
    const outcome = recovered ?? (await readUpdateOutcome(root));
    await start(version, outcome?.version === version ? outcome : undefined);
    while (!stopping) {
      if (await exists(path.join(root, "pending.json"))) {
        let request;
        try {
          request = parseRequest(await readJson(path.join(root, "pending.json")));
        } catch (error) {
          await fs.rename(
            path.join(root, "pending.json"),
            path.join(root, `rejected-request-${randomUUID()}.json`),
          );
          console.error(
            `Rejected malformed update request; healthy server kept running: ${String(error)}`,
          );
          continue;
        }
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
              return {
                get activated() {
                  return trial.activated;
                },
                activate: () => trial.activate(),
                stop: () => trial.stop(),
                prepared: recorded.then(() => trial.prepared),
              };
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
    if (watcherError) throw watcherError;
  } finally {
    stop();
    await stopWatcher.catch(() => {});
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("message", onMessage);
    process.off("disconnect", stop);
    await child?.stop();
    await lease.child(null);
    await lease.release();
  }
}
