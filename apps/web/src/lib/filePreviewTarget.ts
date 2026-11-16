import { looksLikeAbsoluteFilePath } from "./normalizeFilePathForDiff";

export interface FilePreviewTarget {
  cwd: string;
  relativePath: string;
  readOnly: boolean;
}

const TEXT_PREVIEW_EXTENSIONS = new Set(
  "txt md markdown mdown json jsonc yaml yml toml ini cfg conf env log csv tsv xml html htm css scss sass less js jsx ts tsx mjs cjs py rb rs go java c cc cpp h hpp swift kt kts cs php vue svelte sql sh bash zsh fish lock patch diff".split(
    " ",
  ),
);

/** External media keeps the existing viewer/editor handoff; this panel reads text. */
export function isExternalTextPreviewPath(filePath: string): boolean {
  const name = filePath.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  return (
    TEXT_PREVIEW_EXTENSIONS.has(name.split(".").at(-1) ?? "") ||
    /^(?:dockerfile|makefile|readme|license|\.gitignore|\.gitattributes|\.env(?:\..+)?)$/u.test(
      name,
    )
  );
}

/**
 * Keep the displayed path intact while adapting local references to the existing
 * bounded read RPC. Its server-side realpath containment and size limits still
 * apply. External references never become editable workspace entries.
 */
export function resolveFilePreviewTarget(
  filePath: string | undefined,
  workspaceRoot: string | undefined,
): FilePreviewTarget | undefined {
  if (!filePath) return;
  if (!looksLikeAbsoluteFilePath(filePath)) {
    return workspaceRoot
      ? { cwd: workspaceRoot, relativePath: filePath, readOnly: false }
      : undefined;
  }
  const path = filePath.replaceAll("\\", "/");
  // Network shares are not local file previews.
  if (path.startsWith("//")) return;
  const separator = path.lastIndexOf("/");
  const relativePath = path.slice(separator + 1);
  if (!relativePath || relativePath === "." || relativePath === "..") return;
  const parent = path.slice(0, separator + 1);
  const cwd = parent === "/" || /^[a-z]:\/$/iu.test(parent) ? parent : parent.slice(0, -1);
  return { cwd, relativePath, readOnly: true };
}
