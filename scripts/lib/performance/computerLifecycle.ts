/** Run every owned cleanup step even when an earlier callback throws or hangs. */
export async function cleanupComputerRehearsal(
  steps: ReadonlyArray<{ name: string; run: () => unknown | Promise<unknown> }>,
  timeoutMs = 3000,
): Promise<string[]> {
  const failed: string[] = [];
  for (const step of steps) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(step.run),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Cleanup timed out.")), timeoutMs);
        }),
      ]);
    } catch {
      failed.push(step.name);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return failed;
}
import { rm } from "node:fs/promises";

/** Interruption owns the placeholder and scratch directory; always exit after cleanup. */
export async function interruptComputerRehearsal(
  cleanup: () => Promise<unknown>,
  scratch: string,
  output: string,
  exit: (code: number) => void,
) {
  try {
    // The supplied owned-resource cleanup is itself bounded per step. Do not
    // abandon that sequence halfway through and leave later children running.
    try {
      await cleanup();
    } catch {
      /* Remove owned files even after a cleanup defect. */
    }
    await cleanupComputerRehearsal([
      { name: "scratch", run: () => rm(scratch, { recursive: true, force: true }) },
      { name: "placeholder", run: () => rm(output, { force: true }) },
    ]);
  } finally {
    exit(1);
  }
}
