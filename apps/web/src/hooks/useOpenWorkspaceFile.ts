import type { TurnId } from "@t3tools/contracts";
import { useCallback } from "react";

import { toastManager } from "../components/ui/toast";
import { openInPreferredEditor } from "../editorPreferences";
import { useFileNavigation } from "../fileNavigationContext";
import { readNativeApi } from "../nativeApi";
import { resolvePathLinkTarget } from "../terminal-links";

/**
 * Opens a file the chat shows: in the in-app file view when the thread's file
 * navigation takes it, otherwise in the preferred editor. `filePath` may carry
 * a `:line[:column]` suffix and may be relative to `workspaceRoot`.
 */
export function useOpenWorkspaceFile(options: {
  workspaceRoot: string | undefined;
  turnId?: TurnId | undefined;
}): (filePath: string) => void {
  const handleFileNavigation = useFileNavigation();
  const { workspaceRoot, turnId } = options;
  return useCallback(
    (filePath: string) => {
      if (handleFileNavigation(filePath, turnId)) {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Editor opening is unavailable.",
        });
        return;
      }
      const targetPath = workspaceRoot ? resolvePathLinkTarget(filePath, workspaceRoot) : filePath;
      void openInPreferredEditor(api, targetPath).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Unable to open file",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      });
    },
    [handleFileNavigation, turnId, workspaceRoot],
  );
}
