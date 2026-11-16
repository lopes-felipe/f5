import { withEditorOpenAuthorization } from "../editorPreferences";
import { readNativeApi } from "../nativeApi";
import { toastManager } from "../components/ui/toast";
import { desktopIpcErrorMessage } from "./desktopIpcError";
import { isMacPlatform } from "./utils";

/** Native menu selections authorize exactly this path, even after the original gesture expires. */
export async function showLocalPathContextMenu(
  targetPath: string,
  position: { x: number; y: number },
): Promise<void> {
  try {
    const api = readNativeApi();
    if (!api) throw new Error("Local file actions are unavailable.");
    const action = await api.contextMenu.show(
      [
        { id: "open-in-editor", label: "Open in VS Code" },
        {
          id: "reveal-in-file-manager",
          label: isMacPlatform(navigator.platform) ? "Show in Finder" : "Show in file manager",
        },
      ],
      position,
      { editorTarget: targetPath },
    );
    if (action === "open-in-editor") {
      await withEditorOpenAuthorization(targetPath, async (authorization) => {
        if (authorization) await api.shell.openInEditor(targetPath, "vscode", authorization);
        else await api.shell.openInEditor(targetPath, "vscode");
      });
    } else if (action === "reveal-in-file-manager") {
      if (window.desktopBridge?.revealFile) {
        await window.desktopBridge.revealFile(targetPath);
      } else {
        await api.shell.openInEditor(targetPath, "file-manager");
      }
    }
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Unable to open local path",
      description: desktopIpcErrorMessage(error, "An unexpected file action error occurred."),
    });
  }
}
