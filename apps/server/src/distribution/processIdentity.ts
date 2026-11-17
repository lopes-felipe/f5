// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runWindowsPowerShell } from "../windowsPowerShell";

const execute = promisify(execFile);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
export async function processBirth(pid: number): Promise<string> {
  if (process.platform === "linux") {
    const [stat, boot] = await Promise.all([
      fs.readFile("/proc/" + pid + "/stat", "utf8"),
      fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    ]);
    return boot.trim() + ":" + stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  }
  const result =
    process.platform === "win32"
      ? await runWindowsPowerShell(
          "[Console]::Write([System.Diagnostics.Process]::GetProcessById(" +
            pid +
            ").StartTime.ToUniversalTime().Ticks)",
          { timeoutMs: 10_000, maxBuffer: 4096 },
        )
      : await execute("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
          timeout: 5000,
          maxBuffer: 4096,
        });
  if (!result.stdout.trim()) throw new Error("Process identity is unavailable.");
  return result.stdout.trim();
}
/** Never mistake an unverifiable live PID for a dead owner. */
export async function sameProcess(
  pid: number,
  birth: string | undefined,
  probeBirth: typeof processBirth = processBirth,
): Promise<boolean> {
  if (!alive(pid)) return false;
  if (!birth) return true;
  try {
    return (await probeBirth(pid)) === birth;
  } catch {
    return alive(pid);
  }
}
