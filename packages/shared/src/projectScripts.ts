import { type ProjectScript } from "@t3tools/contracts";

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

export function projectScriptCwd(input: {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
}): string {
  return input.worktreePath ?? input.project.cwd;
}

/** Variables F5 sets for every project script and thread terminal. */
export const PROJECT_SCRIPT_ENV_NAMES = ["T3CODE_PROJECT_ROOT", "T3CODE_WORKTREE_PATH"] as const;

export function projectScriptRuntimeEnv(
  input: ProjectScriptRuntimeEnvInput,
): Record<string, string> {
  const [projectRootName, worktreePathName] = PROJECT_SCRIPT_ENV_NAMES;
  const env: Record<string, string> = {
    [projectRootName]: input.project.cwd,
  };
  if (input.worktreePath) {
    env[worktreePathName] = input.worktreePath;
  }
  if (input.extraEnv) {
    return { ...env, ...input.extraEnv };
  }
  return env;
}

export function setupProjectScript(scripts: ReadonlyArray<ProjectScript>): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}
