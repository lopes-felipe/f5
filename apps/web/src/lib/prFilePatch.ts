import type { PrHubChangedFile } from "@t3tools/contracts";
import { getRenderablePatch } from "./diffPatch";

type PrFile = Pick<
  PrHubChangedFile,
  "path" | "previousPath" | "changeType" | "additions" | "deletions"
>;

export function isPurePrFileRename(file: PrFile): boolean {
  return (
    !!file.previousPath &&
    file.previousPath !== file.path &&
    file.additions === 0 &&
    file.deletions === 0
  );
}

/** The renderer mishandles Git-quoted headers. Parse hunks using safe placeholder
 * names, then restore the authoritative paths without modifying review anchors. */
export function getRenderablePrFilePatch(
  file: PrFile,
  patch: string | null | undefined,
  scope: string,
) {
  const renamed = !!file.previousPath && file.previousPath !== file.path;
  const start = patch?.search(/^@@ /m) ?? -1;
  if (start < 0 && !isPurePrFileRename(file)) return null;
  const mode =
    file.changeType === "added"
      ? "new file mode 100644\n"
      : file.changeType === "deleted"
        ? "deleted file mode 100644\n"
        : renamed
          ? `similarity index ${start < 0 ? 100 : 0}%\nrename from old-file\nrename to file\n`
          : "";
  const parsed = getRenderablePatch(
    `diff --git a/${renamed ? "old-file" : "file"} b/file\n${mode}${start < 0 ? "" : `--- ${file.changeType === "added" ? "/dev/null" : renamed ? "a/old-file" : "a/file"}\n+++ ${file.changeType === "deleted" ? "/dev/null" : "b/file"}\n${patch!.slice(start)}`}`,
    JSON.stringify([scope, file.path, file.previousPath]),
  );
  if (parsed?.kind !== "files") return parsed;
  return {
    ...parsed,
    files: parsed.files.map((diff) => ({
      ...diff,
      name: file.path,
      prevName: file.previousPath ?? file.path,
    })),
  };
}
