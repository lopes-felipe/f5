import { writeHeapSnapshot } from "node:v8";
import { join } from "node:path";

/** Explicit operator signal only; one snapshot at a time and no handler after scope release. */
export function installHeapSnapshotSignal(
  directory: string,
  write: (filename: string) => unknown = writeHeapSnapshot,
  report: () => void = () => undefined,
): () => void {
  if (process.platform === "win32") return () => undefined;
  let writing = false;
  const handler = () => {
    if (writing) return;
    writing = true;
    try {
      write(join(directory, `heap-${new Date().toISOString().replaceAll(":", "-")}.heapsnapshot`));
    } catch {
      report();
    } finally {
      writing = false;
    }
  };
  process.on("SIGUSR2", handler);
  return () => {
    process.off("SIGUSR2", handler);
  };
}
