import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");

/**
 * The F5 commit a live run exercised. Records cite it as `evidenceCommit`; a dirty or
 * unreadable checkout is reported as dirty and certifies nothing. Keep spike files and
 * reports in progress outside the checkout, or commit them first.
 */
export function evidenceSource(
  run: (args: ReadonlyArray<string>) => string = (args) =>
    execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }),
): { readonly sourceCommit?: string; readonly dirty: boolean } {
  try {
    const sourceCommit = run(["rev-parse", "HEAD"]).trim();
    const dirty = run(["status", "--porcelain", "--untracked-files=normal"]).trim() !== "";
    return /^[a-f0-9]{40}$/.test(sourceCommit) ? { sourceCommit, dirty } : { dirty: true };
  } catch {
    return { dirty: true };
  }
}
