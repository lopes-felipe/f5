import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
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

/** Resolve the most specific registered root or the project owning a linked worktree. */
export const readProjectForCwd = (cwd: string) =>
  Effect.gen(function* () {
    const projects = yield* ProjectionProjectRepository;
    const threads = yield* ProjectionThreadRepository;
    const candidates = (yield* projects.listAll())
      .filter((project) => project.deletedAt === null)
      .toSorted((a, b) => b.workspaceRoot.length - a.workspaceRoot.length);
    const root = candidates.find((project) => isInsideProjectWorkspace(project.workspaceRoot, cwd));
    const linked = root ? [] : yield* threads.listProjectIdsByWorktreePath(cwd);
    return root ?? candidates.find((project) => linked.includes(project.projectId));
  });
