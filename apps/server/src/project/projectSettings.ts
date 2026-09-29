import Path from "node:path";
import { Effect } from "effect";
import { type ProjectId, type ServerSettings, type ThreadEnvMode } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { makeWorkspaceAssetAuthorizer } from "../WorkspaceAssetAuthorizer";
import { makeCheckedInProjectFileService } from "./CheckedInProjectFileService";

/** Use the same bounded, symlink-safe reader as the checked-in configuration API.
 * Only the registered root supplies defaults, including while a worktree is missing.
 */
export function readProjectSettings(
  global: ServerSettings,
  project: {
    id: ProjectId;
    workspaceRoot: string;
    defaultEnvMode?: ThreadEnvMode | null | undefined;
  },
) {
  return Effect.promise(async () => {
    const files = makeCheckedInProjectFileService(
      makeWorkspaceAssetAuthorizer({
        resolveProjectWorkspaceRoot: async (id) =>
          id === project.id ? project.workspaceRoot : null,
      }),
    );
    const config = await files.load(project.id);
    return resolveProjectSettings({
      global,
      projectId: project.id,
      legacyEnvMode: project.defaultEnvMode ?? null,
      checkedIn: config.settings ?? {},
      sourceFile: config.sourceFile,
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
