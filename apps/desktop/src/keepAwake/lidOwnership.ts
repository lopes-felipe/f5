import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { atomicWrite } from "./preferences";
import { run } from "./macPower";
import { processGroupAlive, runTrackedPowerWrite, POWER_COMMAND_ENV } from "./powerWrite";

export interface LidMarker {
  gen: string;
  ownerPid: number;
  ownerStart: string;
  watchdogPid: number;
  watchdogStart: string;
  engagedAt: number;
  /** v2 watchdogs cannot write until their process group is durably recorded. */
  protocol: 2;
  bootTime?: number | null;
  writerPid?: number;
  writerStart?: string;
}
export const WATCHDOG = String.raw`
owner=$1
started=$2
marker=$3
gen=$4
sudo=$5
pmset=$6
ps=$7
# Defer shell termination until the foreground reset returns. The shell remains
# a fence even if sudo runs its privileged command in another process group.
trap 'exit 0' TERM INT
matches() { /usr/bin/grep -Fq "\"gen\":\"$gen\"" "$marker" 2>/dev/null; }
reset_verified() {
  "$sudo" -n "$pmset" -a disablesleep 0 || return 1
  settings=$("$pmset" -g) || return 1
  printf '%s\n' "$settings" | /usr/bin/awk '
    /^System-wide power settings:$/ { section=1; seen=1; next }
    section && /^[^[:space:]].*:$/ { section=0 }
    section && $1 == "SleepDisabled" {
      count++; if (NF != 2 || $2 !~ /^[01]$/) invalid=1; value=$2
    }
    END { exit !(seen && !invalid && count <= 1 && (count == 0 || value == 0)) }
  '
}
writer_busy() {
  writer=$(/usr/bin/sed -n 's/.*"writerPid":\([0-9][0-9]*\).*/\1/p' "$marker")
  [ -n "$writer" ] && [ "$writer" != 0 ] || return 1
  groups=$("$ps" -axo pgid= 2>/dev/null) || return 0
  printf '%s\n' "$groups" | /usr/bin/awk -v id="$writer" '$1 == id {found=1} END {exit !found}'
}
printf 'armed\n'
# EOF before commitment (including a main-process crash) leaves this watchdog inert.
IFS= read -r committed || exit 0
[ "$committed" = "$gen" ] || exit 0
while matches; do
  current=$("$ps" -o lstart= -p "$owner" 2>/dev/null | /usr/bin/sed 's/[[:space:]]*$//')
  if [ "$current" != "$started" ]; then
    if matches && ! writer_busy && reset_verified; then
      matches && /bin/rm -f "$marker"
      exit 0
    fi
  fi
  /bin/sleep 5
done
`;
export async function processStart(pid: number): Promise<string> {
  const result = await run("/bin/ps", ["-o", "lstart=", "-p", String(pid)], 2000);
  return result.ok ? result.output.trimEnd() : "";
}
export async function readBootTime(): Promise<number | null> {
  const result = await run("/usr/sbin/sysctl", ["-n", "kern.boottime"], 2000);
  const match = result.ok ? /\bsec\s*=\s*(\d+)/.exec(result.output) : null;
  return match ? Number(match[1]) * 1000 : null;
}
export function createLidOwnership(
  path: string,
  binaries: { sudo: string; pmset: string; ps?: string } = {
    sudo: "/usr/bin/sudo",
    pmset: "/usr/bin/pmset",
  },
  identity = processStart,
  bootTime = readBootTime,
) {
  async function read(): Promise<LidMarker | null> {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (
        typeof value.gen !== "string" ||
        !/^[a-f0-9-]{36}$/.test(value.gen) ||
        !Number.isSafeInteger(value.ownerPid) ||
        value.ownerPid <= 0 ||
        !Number.isSafeInteger(value.watchdogPid) ||
        value.watchdogPid < 0 ||
        typeof value.ownerStart !== "string" ||
        typeof value.watchdogStart !== "string" ||
        value.protocol !== 2 ||
        !Number.isFinite(value.engagedAt) ||
        (value.writerPid !== undefined &&
          (!Number.isSafeInteger(value.writerPid) || value.writerPid < 0))
      )
        throw new Error("Invalid lid recovery marker");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  const write = (marker: LidMarker) => atomicWrite(path, marker);
  let boot: Promise<number | null> | undefined;
  const currentBoot = () => (boot ??= bootTime());
  const remove = async () => {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  };
  const fromEarlierBoot = async (marker: LidMarker) => {
    const started = await currentBoot();
    return (
      started !== null &&
      (marker.bootTime !== undefined && marker.bootTime !== null
        ? marker.bootTime !== started
        : marker.engagedAt < started)
    );
  };
  const watchdogAlive = async (marker: LidMarker) => {
    if (marker.watchdogPid <= 0 || (await fromEarlierBoot(marker))) return false;
    const current = await identity(marker.watchdogPid);
    return (
      (current === "" || current === marker.watchdogStart) && processGroupAlive(marker.watchdogPid)
    );
  };
  const stopGroup = async (pid: number, start: string) => {
    if (!pid) return;
    const current = await identity(pid);
    if (current && current !== start) {
      // Never signal a reused PID. Refuse to proceed while its group exists.
      if (processGroupAlive(pid)) throw new Error("Power process identity changed");
      return;
    }
    if (processGroupAlive(pid)) {
      // sudo/pmset inherit this detached process group. Signalling just the
      // shell allows a delayed child to reset a subsequent generation.
      try {
        if (current === start) process.kill(-pid, "SIGTERM");
      } catch (error) {
        if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && processGroupAlive(pid))
        await new Promise((resolve) => setTimeout(resolve, 50));
      // A privileged child might reject our signal. Keep ownership and retry
      // later; no new flag write is safe until every old reset process exits.
      if (processGroupAlive(pid)) throw new Error("Power processes have not exited");
    }
  };
  const killWatchdog = async (marker: LidMarker) => {
    const persisted = await read();
    if (persisted?.gen === marker.gen) marker = persisted;
    if (await fromEarlierBoot(marker)) return;
    // Fence the enable writer before any reset or a new generation.
    await stopGroup(marker.writerPid ?? 0, marker.writerStart ?? "");
    await stopGroup(marker.watchdogPid, marker.watchdogStart);
  };
  async function armWatchdog(marker: LidMarker): Promise<LidMarker> {
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        WATCHDOG,
        "sh",
        String(marker.ownerPid),
        marker.ownerStart,
        path,
        marker.gen,
        binaries.sudo,
        binaries.pmset,
        binaries.ps ?? "/bin/ps",
      ],
      {
        detached: true,
        stdio: ["pipe", "pipe", "ignore"],
        env: POWER_COMMAND_ENV,
      },
    );
    child.stdin.on("error", () => {
      /* Commitment failure is handled below. */
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.stdin.destroy();
          child.kill();
          reject(new Error("Watchdog did not arm"));
        }, 3000);
        let output = "";
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("Watchdog exited"));
        });
        child.stdout.on("data", (data) => {
          output += String(data);
          if (output.includes("armed\n")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      const latest = await read();
      if (latest?.gen !== marker.gen)
        throw new Error("Watchdog ownership changed before commitment");
      const next = {
        ...latest,
        bootTime: await currentBoot(),
        watchdogPid: child.pid!,
        watchdogStart: await identity(child.pid!),
      };
      if (!next.watchdogStart) throw new Error("Watchdog identity unavailable");
      await write(next);
      // Only now may the watchdog run reset commands. A crash before this
      // point closes stdin; a crash after it leaves a recorded process group.
      await new Promise<void>((resolve, reject) =>
        child.stdin.end(marker.gen + "\n", (error?: Error | null) =>
          error ? reject(error) : resolve(),
        ),
      );
      child.stdout.destroy();
      child.unref();
      return next;
    } catch (error) {
      child.stdin.destroy();
      child.stdout.destroy();
      child.kill();
      throw error;
    }
  }
  return {
    read,
    write,
    remove,
    armWatchdog,
    watchdogAlive,
    killWatchdog,
    async runWrite(file: string, args: string[], timeout = 10_000) {
      const marker = await read();
      if (!marker) throw new Error("Power writes require a recovery marker");
      const result = await runTrackedPowerWrite(
        file,
        args,
        async (pid) => {
          const writerStart = await identity(pid);
          if (!writerStart) throw new Error("Power writer identity unavailable");
          const latest = await read();
          if (latest?.gen !== marker.gen) throw new Error("Power ownership changed");
          await write({ ...latest, writerPid: pid, writerStart });
        },
        timeout,
      );
      const latest = await read();
      if (latest?.gen === marker.gen) await write({ ...latest, writerPid: 0, writerStart: "" });
      return result;
    },
    async newMarker(): Promise<LidMarker> {
      const ownerStart = await identity(process.pid);
      if (!ownerStart) throw new Error("Owner identity unavailable");
      return {
        gen: randomUUID(),
        ownerPid: process.pid,
        ownerStart,
        watchdogPid: 0,
        watchdogStart: "",
        engagedAt: Date.now(),
        protocol: 2,
      };
    },
  };
}
export type LidOwnership = ReturnType<typeof createLidOwnership>;
