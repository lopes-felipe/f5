import * as FS from "node:fs/promises";
import * as Path from "node:path";
import type { Stats, Dirent } from "node:fs";
import type { StoragePathWarning } from "@t3tools/contracts";

const SKIP = new Set([
  ".git",
  "node_modules",
  "vendor",
  ".venv",
  "target",
  "build",
  "dist",
  ".cache",
  ".turbo",
  ".terraform",
]);
/** Walk only explicit roots, stop at repositories, never cross mounts or symlinks. */
export async function discoverRepositories(
  roots: ReadonlyArray<string>,
  options: {
    readonly rootBudgetMs?: number;
    readonly fs?: {
      lstat: (path: string) => Promise<Stats>;
      realpath: (path: string) => Promise<string>;
      readdir: (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>;
    };
  } = {},
) {
  const fs = options.fs ?? FS;
  const repositories: string[] = [],
    warnings: StoragePathWarning[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    try {
      const work = async () => {
        if (!Path.isAbsolute(root)) throw new Error("Repository search folders must be absolute.");
        const rootStat = await fs.lstat(root);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
          throw new Error("Repository search folder must be a real directory.");
        const visit = async (directory: string, depth: number): Promise<void> => {
          if (expired) return;
          const real = await fs.realpath(directory);
          if (expired) return;
          if (seen.has(real)) return;
          seen.add(real);
          const stat = await fs.lstat(directory);
          if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== rootStat.dev) return;
          const marker = await fs
            .lstat(Path.join(directory, ".git"))
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
          if (marker && !marker.isSymbolicLink() && (marker.isFile() || marker.isDirectory())) {
            if (expired) return;
            repositories.push(real);
            return;
          }
          if (depth >= 4) {
            warnings.push({ path: directory, reason: "Repository discovery depth limit reached." });
            return;
          }
          for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            if (expired) return;
            if (repositories.length >= 1000) throw new Error("Repository discovery limit reached.");
            if (entry.isDirectory() && !SKIP.has(entry.name)) {
              try {
                await visit(Path.join(directory, entry.name), depth + 1);
              } catch (error) {
                warnings.push({ path: Path.join(directory, entry.name), reason: String(error) });
              }
            }
          }
        };
        await visit(root, 0);
      };
      await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(new Error("Repository discovery time budget reached; results are partial."));
          }, options.rootBudgetMs ?? 25_000);
        }),
      ]);
    } catch (error) {
      warnings.push({ path: root, reason: String(error) });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { repositories, warnings };
}
