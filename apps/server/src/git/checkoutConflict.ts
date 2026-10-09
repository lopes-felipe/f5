import { unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";

/** Read only checkout's overwrite diagnostics; other Git failures remain ordinary errors. */
export function checkoutConflictFiles(detail: string): ReadonlyArray<string> | null {
  const files = new Set<string>();
  let inFileList = false;
  let foundConflict = false;
  for (const line of detail.split(/\r?\n/)) {
    if (
      line.endsWith(
        "error: Your local changes to the following files would be overwritten by checkout:",
      ) ||
      line.endsWith(
        "error: The following untracked working tree files would be overwritten by checkout:",
      )
    ) {
      foundConflict = true;
      inFileList = true;
    } else if (inFileList && line.startsWith("\t")) {
      const path = line.slice(1);
      files.add(path.startsWith('"') && path.endsWith('"') ? unquoteGitPatchPath(path) : path);
    } else {
      inFileList = false;
    }
  }
  return foundConflict ? [...files] : null;
}
