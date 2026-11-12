import { structuredPatch, formatPatch, FILE_HEADERS_ONLY } from "diff";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Feed every ACP diff into the shared structured file-change ingestion path. */
export function acpFileChanges(content: unknown): ReadonlyArray<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((entry): ReadonlyArray<Record<string, unknown>> => {
    const diff = record(entry);
    if (diff?.type !== "diff") return [];
    const patch = record(diff.patch);
    if (typeof patch?.text === "string") {
      const changes = Array.isArray(diff.changes) ? diff.changes : [];
      const first = record(changes[0]);
      const path =
        typeof first?.path === "string"
          ? first.path
          : typeof diff.path === "string"
            ? diff.path
            : undefined;
      if (!path) return [];
      const oldPath = typeof first?.oldPath === "string" ? first.oldPath : path;
      const before = first?.operation === "add" ? "/dev/null" : "a/" + oldPath;
      const after = first?.operation === "delete" ? "/dev/null" : "b/" + path;
      const text = patch.text.trimStart().startsWith("@@")
        ? "diff --git " +
          ("a/" + oldPath) +
          " " +
          ("b/" + path) +
          "\n--- " +
          before +
          "\n+++ " +
          after +
          "\n" +
          patch.text.trimStart()
        : patch.text;
      return [{ path, type: "update", diff: text }];
    }
    if (typeof diff.path !== "string" || typeof diff.newText !== "string") return [];
    if (diff.oldText === diff.newText) return [];
    if (typeof diff.oldText !== "string")
      return [{ path: diff.path, type: "add", content: diff.newText }];
    // ACP sends complete files, unlike Claude's replacement snippets. Bound
    // worst-case diff work and fall back to the tool card if computation aborts.
    const patchFromContents = structuredPatch(
      diff.path,
      diff.path,
      diff.oldText,
      diff.newText,
      undefined,
      undefined,
      { context: 3, maxEditLength: 100_000, timeout: 100 },
    );
    return !patchFromContents || patchFromContents.hunks.length === 0
      ? []
      : [
          {
            path: diff.path,
            type: "update",
            diff: formatPatch(patchFromContents, FILE_HEADERS_ONLY),
          },
        ];
  });
}
