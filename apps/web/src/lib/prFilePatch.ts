import type { PrHubChangedFile } from "@t3tools/contracts";
import { getRenderablePatch } from "./diffPatch";

/** The renderer mishandles Git-quoted headers. Parse hunks using safe placeholder
 * names, then restore the authoritative paths without modifying review anchors. */
export function getRenderablePrFilePatch(
  file: Pick<PrHubChangedFile, "path" | "previousPath" | "changeType">,
  patch: string | null | undefined,
  scope: string,
) {
  if (!patch) return null;
  const start = patch.search(/^@@ /m);
  if (start < 0) return null;
  const mode =
    file.changeType === "added"
      ? "new file mode 100644\n"
      : file.changeType === "deleted"
        ? "deleted file mode 100644\n"
        : "";
  const parsed = getRenderablePatch(
    `diff --git a/file b/file\n${mode}--- ${file.changeType === "added" ? "/dev/null" : "a/file"}\n+++ ${file.changeType === "deleted" ? "/dev/null" : "b/file"}\n${patch.slice(start)}`,
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
