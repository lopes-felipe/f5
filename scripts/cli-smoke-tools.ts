// @effect-diagnostics nodeBuiltinImport:off
import { constants } from "node:fs";
import { access, symlink } from "node:fs/promises";
import { join } from "node:path";

/** Keep install prerequisites available without exposing host runtimes or provider CLIs. */
export async function stageCliSmokeArchiveTools(directory: string): Promise<void> {
  // The Windows installer already addresses the system bsdtar by its absolute path.
  if (process.platform === "win32") return;
  for (const name of ["tar", "gzip"]) {
    let source: string | undefined;
    for (const root of ["/usr/bin", "/bin"]) {
      const candidate = join(root, name);
      try {
        await access(candidate, constants.X_OK);
        source = candidate;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!source) throw new Error("CLI install smoke requires the system " + name);
    await symlink(source, join(directory, name));
  }
}
