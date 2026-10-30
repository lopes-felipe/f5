import { isScratchProject } from "./scratchProject";
import { projectScriptCwd, projectScriptRuntimeEnv } from "./projectScripts";
import { workspaceRelativeFilePath } from "./path";

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

/** Attachment paths may be relative only to roots owned by this thread's workspace. */
export function threadAttachmentWorkspaceRoots(
  thread: WorkspaceThread | null | undefined,
  project: WorkspaceProject | null | undefined,
): string[] {
  if (isScratchProject(project)) return thread?.scratchPath ? [thread.scratchPath] : [];
  return [thread?.worktreePath, project ? projectRoot(project) : undefined].filter(
    (root): root is string => Boolean(root),
  );
}

/** Environment shared by the terminal drawer and commands run from chat. */
export function threadTerminalRuntimeEnv(
  thread: WorkspaceThread | null | undefined,
  project: WorkspaceProject | null | undefined,
  extraEnv?: Record<string, string>,
): Record<string, string> {
  if (!project) return {};
  if (isScratchProject(project)) {
    if (!thread?.scratchPath) return {};
    const env: Record<string, string> = { ...extraEnv, T3CODE_PROJECT_ROOT: thread.scratchPath };
    delete env.T3CODE_WORKTREE_PATH;
    return env;
  }
  return projectScriptRuntimeEnv({
    project: { cwd: projectRoot(project) },
    worktreePath: thread?.worktreePath ?? null,
    ...(extraEnv ? { extraEnv } : {}),
  });
}

/** Resolve a terminal command before opening or writing any terminal. */
export function threadTerminalCommandCwd(
  thread: WorkspaceThread,
  project: WorkspaceProject,
  requestedCwd?: string,
): string {
  if (!isScratchProject(project)) {
    return (
      requestedCwd ??
      projectScriptCwd({
        project: { cwd: projectRoot(project) },
        worktreePath: thread.worktreePath ?? null,
      })
    );
  }
  const cwd = threadWorkspaceCwd(thread, project);
  if (!cwd) throw new Error("Terminal is available after the first message");
  const relative =
    requestedCwd === undefined
      ? null
      : workspaceRelativeFilePath(requestedCwd, projectRoot(project));
  if (relative !== null) {
    const depth = relative
      .split(/[\\/]/)
      .reduce(
        (depth, segment) =>
          segment === ".." ? depth - 1 : segment && segment !== "." ? depth + 1 : depth,
        0,
      );
    if (depth === 0) {
      throw new Error("The shared folder for threads without a project is not a workspace.");
    }
  }
  return requestedCwd ?? cwd;
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
