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
