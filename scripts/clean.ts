import { readdir, rm } from "node:fs/promises";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const targets = [path.join(repoRoot, "node_modules"), path.join(repoRoot, ".turbo")];

for (const workspaceRoot of ["apps", "packages"] as const) {
  const root = path.join(repoRoot, workspaceRoot);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspace = path.join(root, entry.name);
    targets.push(
      path.join(workspace, "node_modules"),
      path.join(workspace, "dist"),
      path.join(workspace, ".turbo"),
    );
    if (workspaceRoot === "apps") targets.push(path.join(workspace, "dist-electron"));
  }
}

await Promise.all(targets.map((target) => rm(target, { recursive: true, force: true })));
