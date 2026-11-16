import {
  resolveAndPersistPreferredEditor,
  withEditorOpenAuthorization,
} from "../editorPreferences";
import { resolveMarkdownFileEditorTarget, type MarkdownFileLinkMeta } from "../markdown-links";
import { readNativeApi } from "../nativeApi";
import { toastManager } from "../components/ui/toast";
import { findWorkspaceBasenameFile } from "./workspaceBasename";

/** Resolve actual entry kinds on demand; an extensionless name is not a directory. */
export async function openMarkdownFileLink(
  meta: MarkdownFileLinkMeta,
  cwd: string | undefined,
  navigateFile: (target: string) => boolean,
): Promise<void> {
  let reportedPath = meta.targetPath;
  try {
    const api = readNativeApi();
    if (!api) throw new Error("Local file actions are unavailable.");
    // Capture the gesture before filesystem/config lookups. Unused grants are released.
    await withEditorOpenAuthorization(undefined, async (authorization) => {
      const path = meta.filePath.replace(/[\\/]+$/, "");
      const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
      let directory = !meta.line && /[\\/]$/.test(meta.filePath);
      if (!meta.line && !directory && separator >= 0) {
        const parent = path.slice(0, separator + 1);
        const name = path.slice(separator + 1);
        const entries = await api.projects
          .listDirectory({ cwd: parent, relativePath: "", includeIgnored: true })
          .catch(() => null);
        directory =
          entries?.entries.some(
            (entry) =>
              entry.kind === "directory" &&
              entry.path
                .replace(/[\\/]+$/, "")
                .split(/[\\/]/)
                .at(-1) === name,
          ) ?? false;
      }
      if (!directory && navigateFile(meta.targetPath)) return;
      const target = directory
        ? meta.filePath
        : await resolveMarkdownFileEditorTarget(meta, cwd, (name) =>
            cwd ? findWorkspaceBasenameFile(api, cwd, name) : Promise.resolve(null),
          );
      reportedPath = target;
      const editor = directory
        ? "vscode"
        : resolveAndPersistPreferredEditor((await api.server.getConfig()).availableEditors);
      if (!editor) throw new Error("No available editors found.");
      if (authorization) await api.shell.openInEditor(target, editor, authorization);
      else await api.shell.openInEditor(target, editor);
    });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Unable to open local path",
      description: `${reportedPath}: ${error instanceof Error ? error.message : "An unexpected file action error occurred."}`,
    });
  }
}
