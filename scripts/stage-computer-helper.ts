import { lstatSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Publish a fresh inode instead of overwriting an executable an existing app
 * may still have mapped. A failed build always leaves the previous helper intact. */
export function stageComputerHelper(binary: string, build: (staged: string) => boolean): boolean {
  const directory = mkdtempSync(join(dirname(binary), ".f5-helper-build-"));
  try {
    const staged = join(directory, basename(binary));
    if (!build(staged)) return false;
    if (!lstatSync(staged).isFile()) throw new Error("Helper build did not produce a regular file");
    renameSync(staged, binary);
    return true;
  } finally {
    // This directory was created exclusively by this invocation.
    rmSync(directory, { recursive: true, force: true });
  }
}
