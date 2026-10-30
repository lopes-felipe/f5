import { openInPreferredEditor } from "../editorPreferences";
import { readNativeApi } from "../nativeApi";
import { toastManager } from "../components/ui/toast";
import type { EditorId } from "@t3tools/contracts";

/** File references must report failed editor handoffs to the user. */
export async function openFileInEditor(targetPath: string, editor?: EditorId): Promise<void> {
  try {
    const api = readNativeApi();
    if (!api) throw new Error("Editor opening is unavailable.");
    if (editor) await api.shell.openInEditor(targetPath, editor);
    else await openInPreferredEditor(api, targetPath);
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Unable to open file",
      description: `${targetPath}: ${error instanceof Error ? error.message : "An error occurred."}`,
    });
  }
}
