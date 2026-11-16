/**
 * The scratch project is the profile's reserved home for threads without a project. It is
 * created only by the server, and each of its threads runs in its own folder directly under
 * the project root, named `<yyyy-mm-dd>-<first-words>-<id8>`.
 */
export const SCRATCH_PROJECT_TITLE = "No project";

/** The folder under a profile's base directory that holds every scratch thread folder. */
export const SCRATCH_DIRECTORY_NAME = "scratch";

export function isScratchProject(
  project: { readonly kind?: string | undefined } | null | undefined,
): boolean {
  return project?.kind === "scratch";
}

/** Projects a user picks from. The scratch project is a home for threads, not a choice. */
export function withoutScratchProjects<T extends { readonly kind?: string | undefined }>(
  projects: ReadonlyArray<T>,
): T[] {
  return projects.filter((project) => !isScratchProject(project));
}

/**
 * A scratch thread's folder name. Only `[a-z0-9-]` reaches it, so it is always one path
 * segment: the date is kept only when `createdAt` starts with one, and the words are capped so
 * a pasted prompt cannot outgrow a file name. It depends only on its inputs, so allocating it
 * twice for the same thread gives the same folder.
 */
export function scratchThreadFolderName(input: {
  readonly threadId: string;
  readonly createdAt: string;
  readonly text: string;
}): string {
  const words = input.text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 5)
    .join("-")
    .slice(0, 48)
    .replace(/-+$/, "");
  const id =
    input.threadId
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 8) || "thread";
  const date = /^\d{4}-\d{2}-\d{2}/.exec(input.createdAt)?.[0];
  return [date, words, id].filter(Boolean).join("-");
}

/** Whether `path` is a single folder directly inside the scratch root. */
export function isScratchThreadFolder(root: string, path: string): boolean {
  const trimmedRoot = root.replace(/[\\/]+$/, "");
  if (trimmedRoot.length === 0 || path.length <= trimmedRoot.length + 1) return false;
  if (!path.startsWith(trimmedRoot)) return false;
  const separator = path[trimmedRoot.length];
  if (separator !== "/" && separator !== "\\") return false;
  const leaf = path.slice(trimmedRoot.length + 1);
  return /^[a-z0-9][a-z0-9-]*$/.test(leaf);
}
