import { openInPreferredEditor, withEditorOpenAuthorization } from "../editorPreferences";
import { readNativeApi } from "../nativeApi";
import { toastManager } from "../components/ui/toast";
import type { EditorId } from "@t3tools/contracts";

/**
 * File references must report failed editor handoffs to the user. `resolveTarget` replaces
 * `targetPath` once the click's grant is captured (see `openInPreferredEditor`).
 */
export async function openFileInEditor(
  targetPath: string,
  editor?: EditorId,
  resolveTarget?: () => Promise<string>,
): Promise<void> {
  let reportedPath = targetPath;
  const resolve = resolveTarget && (async () => (reportedPath = await resolveTarget()));
  try {
    const api = readNativeApi();
    if (!api) throw new Error("Editor opening is unavailable.");
    if (!editor) await openInPreferredEditor(api, targetPath, resolve);
    else if (!resolve) await api.shell.openInEditor(targetPath, editor);
    else
      await withEditorOpenAuthorization(undefined, async (authorization) => {
        const target = await resolve();
        if (authorization) await api.shell.openInEditor(target, editor, authorization);
        else await api.shell.openInEditor(target, editor);
      });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Unable to open file",
      description: `${reportedPath}: ${error instanceof Error ? error.message : "An error occurred."}`,
    });
  }
}
