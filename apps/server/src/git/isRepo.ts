import { existsSync, realpathSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

export function isGitRepository(cwd: string): boolean {
  let directory: string;
  try {
    if (!statSync(cwd).isDirectory()) return false;
    directory = realpathSync(resolve(cwd));
  } catch {
    return false;
  }
  while (true) {
    if (existsSync(join(directory, ".git"))) return true;
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}
