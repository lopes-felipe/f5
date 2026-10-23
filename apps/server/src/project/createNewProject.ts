import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expandHomePathSync } from "../os-jank.ts";
import { runProcess } from "../processRunner";

const MAX_FOLDER_ATTEMPTS = 100;
const MAX_SLUG_LENGTH = 64;

/** A folder name from a project name: lowercase words joined by dashes. */
export function projectFolderSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "project";
}

/**
 * Where new projects are created. An explicit setting wins; otherwise `~/f5-projects`, with the
 * profile id appended outside the default profile so profiles never share a folder.
 */
export function resolveProjectsRoot(input: {
  readonly setting: string;
  readonly profileId: string;
  readonly isDefaultProfile: boolean;
  readonly homeDir?: string;
}): string {
  const setting = input.setting.trim();
  if (setting.length > 0) {
    const expanded = expandHomePathSync(setting);
    // Resolving a relative path would use the backend's working directory, which in a packaged
    // app is not anything the user chose.
    if (!NodePath.isAbsolute(expanded))
      throw new Error(
        `The projects folder setting must be an absolute path or start with ~, not "${setting}".`,
      );
    return NodePath.resolve(expanded);
  }
  const home = input.homeDir ?? NodeOS.homedir();
  return NodePath.join(
    home,
    input.isDefaultProfile ? "f5-projects" : `f5-projects-${projectFolderSlug(input.profileId)}`,
  );
}

/**
 * Creates `<root>/<slug>`, or `<slug>-2`, `<slug>-3` and so on when taken. A non-recursive mkdir
 * either creates the folder or fails, so two concurrent creates never share one.
 */
export async function reserveProjectFolder(root: string, slug: string): Promise<string> {
  await NodeFS.mkdir(root, { recursive: true });
  for (let attempt = 1; attempt <= MAX_FOLDER_ATTEMPTS; attempt += 1) {
    const folder = NodePath.join(root, attempt === 1 ? slug : `${slug}-${attempt}`);
    try {
      await NodeFS.mkdir(folder);
      return folder;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
  }
  throw new Error(`Every folder name from ${slug} to ${slug}-${MAX_FOLDER_ATTEMPTS} is taken.`);
}

async function git(cwd: string, args: ReadonlyArray<string>) {
  const result = await runProcess("git", [...args], {
    cwd,
    env: process.env,
    allowNonZeroExit: true,
    timeoutMs: 30_000,
    maxBufferBytes: 64 * 1024,
  });
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || `git ${args[0]} exited with ${result.code}`);
}

/**
 * Writes the starter files, initializes a repository and commits them. A failed Git step keeps
 * the folder and returns a warning, so the project is still usable without history.
 */
export async function initializeNewProject(input: {
  readonly folder: string;
  readonly name: string;
  readonly authorName: string;
  readonly authorEmail: string;
}): Promise<{ readonly warning: string | null }> {
  try {
    await NodeFS.writeFile(NodePath.join(input.folder, "README.md"), `# ${input.name}\n`, {
      flag: "wx",
    });
    await NodeFS.writeFile(
      NodePath.join(input.folder, ".gitignore"),
      ".DS_Store\nnode_modules/\n",
      { flag: "wx" },
    );
  } catch (cause) {
    // The folder was just reserved and holds only these files, so a failed start leaves nothing
    // behind; otherwise each retry would leave another empty `<slug>-N`.
    await NodeFS.rm(input.folder, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
  try {
    await git(input.folder, ["init", "-q"]);
  } catch (cause) {
    return { warning: `The project was created without Git: ${(cause as Error).message}` };
  }
  const identity = [
    ...(input.authorName.trim() ? ["-c", `user.name=${input.authorName.trim()}`] : []),
    ...(input.authorEmail.trim() ? ["-c", `user.email=${input.authorEmail.trim()}`] : []),
  ];
  try {
    await git(input.folder, ["add", "-A"]);
    await git(input.folder, [...identity, "commit", "-q", "--no-verify", "-m", "Initial commit"]);
  } catch (cause) {
    return {
      warning: `The project was created, but its first commit failed: ${(cause as Error).message}`,
    };
  }
  return { warning: null };
}
