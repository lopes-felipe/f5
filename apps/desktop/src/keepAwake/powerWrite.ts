import { spawn } from "node:child_process";

export const POWER_COMMAND_ENV = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "C",
  LC_ALL: "C",
  TZ: "UTC",
};
export function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}
export interface CommandResult {
  ok: boolean;
  output: string;
  error: string;
}

/** Never reports completion until the entire write group has exited. A timeout
 * requests termination; it does not prove a privileged child stopped writing. */
export async function runTrackedPowerWrite(
  file: string,
  args: string[],
  register: (pid: number) => Promise<void>,
  timeout = 10_000,
): Promise<CommandResult> {
  const child = spawn(
    "/bin/sh",
    [
      "-c",
      'IFS= read -r committed || exit 1\n[ "$committed" = run ] || exit 1\ntrap \'exit 143\' TERM INT\n"$@"\nstatus=$?\nexit "$status"',
      "sh",
      file,
      ...args,
    ],
    { detached: true, stdio: ["pipe", "pipe", "pipe"], env: POWER_COMMAND_ENV },
  );
  let output = "",
    error = "",
    failed = false;
  const terminate = () => {
    failed = true;
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* Already exited or privileged. */
      }
    }
  };
  const closed = new Promise<number | null>((resolve) => {
    child.once("error", (cause) => {
      error = String(cause);
      failed = true;
      resolve(null);
    });
    child.once("close", resolve);
  });
  child.stdin.on("error", () => {
    failed = true;
  });
  for (const [stream, stderr] of [
    [child.stdout, false],
    [child.stderr, true],
  ] as const) {
    stream.on("data", (data) => {
      const value = String(data);
      if (stderr) error = (error + value).slice(0, 65536);
      else output = (output + value).slice(0, 65536);
      if (output.length + error.length >= 65536) terminate();
    });
  }
  const timer = setTimeout(terminate, timeout);
  try {
    if (!child.pid) throw new Error("Power writer did not start");
    // The shell cannot execute sudo until its identity has been persisted.
    await register(child.pid);
    if (!failed) child.stdin.end("run\n");
    else child.stdin.destroy();
  } catch (cause) {
    error = String(cause);
    child.stdin.destroy();
    terminate();
  }
  const code = await closed;
  clearTimeout(timer);
  // The watchdog has the same durable group identity and waits as well if the
  // main process exits before this loop completes.
  if (child.pid)
    while (processGroupAlive(child.pid)) await new Promise((resolve) => setTimeout(resolve, 50));
  return { ok: code === 0 && !failed, output, error };
}
