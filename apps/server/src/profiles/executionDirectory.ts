import * as FS from "node:fs/promises";
import * as Path from "node:path";

export async function executionDirectoryIssue(directory: string): Promise<string | null> {
  if (!Path.isAbsolute(directory)) return "The path is not absolute on this computer.";
  try {
    return (await FS.stat(directory)).isDirectory() ? null : "The path is not a directory.";
  } catch {
    return "The directory is missing or inaccessible on this computer.";
  }
}
export async function assertExecutionDirectory(directory: string): Promise<void> {
  const issue = await executionDirectoryIssue(directory);
  if (issue)
    throw new Error(
      `${issue} ${directory} Update the project's folder or worktree before running commands.`,
    );
}
