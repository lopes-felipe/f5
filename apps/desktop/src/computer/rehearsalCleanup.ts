import type { ChildProcess } from "node:child_process";

/** Callers retain ownership until this confirms exit; a timeout fails the rehearsal. */
export async function requireRehearsalChildExit(
  child: ChildProcess,
  timeoutMs = 2000,
): Promise<void> {
  if (!(await closeRehearsalChild(child, timeoutMs)))
    throw new Error("Owned rehearsal fixture did not exit.");
}

/** Only for owned test processes. A sent signal alone is not an exit receipt. */
export async function closeRehearsalChild(
  child: ChildProcess | undefined,
  timeoutMs = 2000,
): Promise<boolean> {
  if (!child) return true;
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((done) => {
    const finish = (closed: boolean) => {
      clearTimeout(timer);
      child.off("exit", exited);
      done(closed);
    };
    const exited = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", exited);
    child.kill();
  });
}
