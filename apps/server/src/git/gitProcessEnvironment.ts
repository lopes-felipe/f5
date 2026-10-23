import { appendGitConfigPairs } from "./gitConfigEnvironment.ts";

/** Includes gh because checkout and clone can start their own Git processes. */
export function isManagedGitCommand(command: string): boolean {
  const name = command
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.(exe|cmd|bat)$/i, "")
    .toLowerCase();
  return name === "git" || name === "gh";
}

/** App-owned overrides follow inherited config without changing the caller's environment. */
export function managedGitProcessEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return appendGitConfigPairs(
    { ...environment, GIT_OPTIONAL_LOCKS: "0" },
    [
      // Git 2.38+ refuses repository-shaped project content unless explicitly selected.
      ["safe.bareRepository", "explicit"],
      ...(platform === "win32" ? [["core.longpaths", "true"] as const] : []),
    ],
    platform,
  );
}
