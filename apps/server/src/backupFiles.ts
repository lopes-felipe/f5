import { access, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

export function isInside(parent: string, candidate: string): boolean {
  const normalizedParent = resolve(parent);
  const normalizedCandidate = resolve(candidate);
  return (
    normalizedCandidate === normalizedParent ||
    normalizedCandidate.startsWith(
      normalizedParent.endsWith(sep) ? normalizedParent : `${normalizedParent}${sep}`,
    )
  );
}

export async function listRegularFiles(root: string): Promise<string[]> {
  if (!(await exists(root))) return [];
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        result.push(path);
      }
    }
  };
  await visit(root);
  return result;
}

export function archivePathForFile(prefix: string, root: string, file: string): string {
  const relativePath = relative(root, file).split(sep).join("/");
  return `${prefix}/${relativePath}`;
}
