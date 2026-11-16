import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Bounded recovery-only inspection; never follows symlinks or reads file contents. */
export async function checkoutFingerprint(
  cwd: string,
  paths: ReadonlyArray<string>,
  index: Uint8Array,
  status: string,
): Promise<string> {
  const hash = createHash("sha256").update(index).update(status);
  const seen = new Set<string>();
  const deadline = Date.now() + 5_000;
  const visit = async (path: string): Promise<void> => {
    if (seen.has(path)) return;
    if (seen.size >= 20_000 || Date.now() > deadline)
      throw new Error(
        "Too many local files to verify recovery safely. Keep the checkout and retry inspection after reducing its contents manually.",
      );
    seen.add(path);
    try {
      const stat = await lstat(join(cwd, path), { bigint: true });
      hash.update(
        JSON.stringify([
          path,
          String(stat.dev),
          String(stat.ino),
          String(stat.size),
          String(stat.mtimeNs),
          String(stat.ctimeNs),
          String(stat.mode),
        ]),
      );
      if (stat.isDirectory()) {
        for (const child of (await readdir(join(cwd, path))).sort()) await visit(join(path, child));
        // Detect a concurrent directory edit during traversal, including entries added behind us.
        const after = await lstat(join(cwd, path), { bigint: true });
        if (
          after.ino !== stat.ino ||
          after.mtimeNs !== stat.mtimeNs ||
          after.ctimeNs !== stat.ctimeNs
        )
          throw new Error("The checkout changed during inspection. Inspect it again.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        hash.update(JSON.stringify([path, "missing"]));
      else throw error;
    }
  };
  for (const path of [...new Set(paths)].sort()) await visit(path);
  return hash.digest("hex");
}
