import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { ensureWorkspaceDirectory } from "./workspaceDirectory.ts";

it("names missing directories and plain files before a provider is spawned", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f5-workspace-"));
  try {
    await expect(Effect.runPromise(ensureWorkspaceDirectory(root))).resolves.toBeUndefined();
    for (const kind of ["missing", "file"]) {
      const target = path.join(root, kind);
      if (kind === "file") fs.writeFileSync(target, "not a directory");
      await expect(Effect.runPromise(ensureWorkspaceDirectory(target))).rejects.toThrow(
        `Workspace folder is missing: ${target}`,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
