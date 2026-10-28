import type { NativeApi } from "@t3tools/contracts";

/** Prefer a root file, otherwise require one unambiguous exact (then folded) basename. */
export function workspaceBasenameMatch(
  name: string,
  entries: readonly { path: string; kind: string }[],
): string | null {
  const files = entries.filter((entry) => entry.kind === "file");
  if (files.some((entry) => entry.path === name)) return name;
  const basename = (value: string) => value.split(/[\\/]/u).at(-1)!;
  const exact = files.filter((entry) => basename(entry.path) === name);
  if (exact.length) return exact.length === 1 ? exact[0]!.path : null;
  const folded = files.filter((entry) => basename(entry.path).toLowerCase() === name.toLowerCase());
  return folded.length === 1 ? folded[0]!.path : null;
}

/** Whether a workspace-relative path is a bare file name worth looking up in the workspace index. */
export function isWorkspaceBasenameLookup(name: string): boolean {
  return name.length > 0 && name.length <= 256 && name !== "." && !/[\\/]/u.test(name);
}

/** The workspace-relative file a bare file name refers to, through the workspace index. */
export async function findWorkspaceBasenameFile(
  api: Pick<NativeApi, "projects">,
  workspaceRoot: string,
  name: string,
): Promise<string | null> {
  if (!isWorkspaceBasenameLookup(name)) return null;
  const result = await api.projects.searchEntries({ cwd: workspaceRoot, query: name, limit: 25 });
  return workspaceBasenameMatch(name, result.entries);
}
