import { constants } from "node:fs";
import * as Fs from "node:fs/promises";
import Path from "node:path";
import { Effect } from "effect";
import { type ProjectId, type ServerSettings, type ThreadEnvMode } from "@t3tools/contracts";
import { parseCheckedInProjectFile } from "@t3tools/shared/checkedInProjectFile";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

/** Read only bounded regular project files; never execute repository configuration. */
export function readProjectSettings(
  global: ServerSettings,
  project: {
    id: ProjectId;
    workspaceRoot: string;
    defaultEnvMode?: ThreadEnvMode | null | undefined;
  },
  cwd = project.workspaceRoot,
) {
  return Effect.promise(async () => {
    for (const sourceFile of ["f5.json", "t3.json"] as const) {
      let handle: Fs.FileHandle | undefined;
      try {
        const file = Path.join(cwd, sourceFile);
        const before = await Fs.lstat(file);
        if (!before.isFile() || before.size > 65536) break;
        handle = await Fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size > 65536) break;
        const buffer = Buffer.alloc(65537);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 65536) break;
        const parsed = parseCheckedInProjectFile(buffer.subarray(0, bytesRead).toString("utf8"));
        return resolveProjectSettings({
          global,
          projectId: project.id,
          legacyEnvMode: project.defaultEnvMode ?? null,
          checkedIn: parsed.settings ?? {},
          sourceFile,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        break;
      } finally {
        await handle?.close();
      }
    }
    return resolveProjectSettings({
      global,
      projectId: project.id,
      legacyEnvMode: project.defaultEnvMode ?? null,
    });
  });
}

export function isInsideProjectWorkspace(workspaceRoot: string, cwd: string): boolean {
  const relative = Path.relative(workspaceRoot, cwd);
  return (
    relative === "" ||
    (!Path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${Path.sep}`))
  );
}
