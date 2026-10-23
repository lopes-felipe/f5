import { isScratchProject } from "./scratchProject";

export interface WorkspaceThread {
  readonly worktreePath: string | null | undefined;
  readonly scratchPath?: string | null | undefined;
}

/** Server projects name their root `workspaceRoot`; the web store names it `cwd`. */
export type WorkspaceProject = { readonly kind?: string | undefined } & (
  | { readonly workspaceRoot: string }
  | { readonly cwd: string }
);

function projectRoot(project: WorkspaceProject): string {
  return "workspaceRoot" in project ? project.workspaceRoot : project.cwd;
}

/**
 * The one answer to where a thread's agent, terminal, files and Git work happen: its scratch
 * folder, then its worktree, then its project root. A scratch thread whose folder is not
 * allocated yet resolves to nothing, never to the shared scratch root.
 */
export function threadWorkspaceCwd(
  thread: WorkspaceThread | null | undefined,
  project: WorkspaceProject | null | undefined,
): string | undefined {
  if (thread?.scratchPath) return thread.scratchPath;
  if (isScratchProject(project)) return undefined;
  if (thread?.worktreePath) return thread.worktreePath;
  return project ? projectRoot(project) : undefined;
}

/** {@link threadWorkspaceCwd} for a thread whose project is looked up by id. */
export function resolveThreadWorkspaceCwd(input: {
  readonly thread: WorkspaceThread & { readonly projectId: string };
  readonly projects: ReadonlyArray<WorkspaceProject & { readonly id: string }>;
}): string | undefined {
  return threadWorkspaceCwd(
    input.thread,
    input.projects.find((project) => project.id === input.thread.projectId),
  );
}
