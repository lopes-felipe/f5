export function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:([/\\]|$)/.test(value);
}

export function isUncPath(value: string): boolean {
  return value.startsWith("\\\\");
}

/** Any two leading Windows separators can initiate network authentication. */
export function isNetworkPath(value: string): boolean {
  return /^[\\/]{2}/.test(value);
}

/** Lexical containment for client links; the server still checks canonical paths. */
export function workspaceRelativeFilePath(
  value: string,
  workspaceRoot: string | undefined,
): string | null {
  if (!workspaceRoot) return null;
  const target = value.replaceAll("\\", "/");
  const root = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  const insensitive = isWindowsAbsolutePath(workspaceRoot) || isNetworkPath(workspaceRoot);
  const comparableTarget = insensitive ? target.toLowerCase() : target;
  const comparableRoot = insensitive ? root.toLowerCase() : root;
  if (comparableTarget.replace(/\/+$/, "") === comparableRoot) return ".";
  if (!comparableTarget.startsWith(comparableRoot + "/")) return null;
  const relative = target.slice(root.length + 1);
  let depth = 0;
  for (const segment of relative.split("/")) {
    if (segment === "..") depth--;
    else if (segment && segment !== ".") depth++;
    if (depth < 0) return null;
  }
  return relative;
}

export function isWindowsAbsolutePath(value: string): boolean {
  return isUncPath(value) || isWindowsDrivePath(value);
}

export function isExplicitRelativePath(value: string): boolean {
  return (
    value === "." ||
    value === ".." ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\")
  );
}
