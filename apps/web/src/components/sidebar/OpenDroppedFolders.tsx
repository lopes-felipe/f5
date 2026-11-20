import { useEffect } from "react";
import { useOpenLocalWorkspace } from "../../hooks/useOpenLocalWorkspace";
import { toastManager } from "../ui/toast";

/** Loaded only after a folder drop, without remounting the sidebar's children. */
export default function OpenDroppedFolders({
  folders,
  completed,
}: {
  folders: readonly { name: string; path: string | null | undefined }[];
  completed: () => void;
}) {
  const { open } = useOpenLocalWorkspace();
  useEffect(() => {
    let disposed = false;
    void Promise.resolve().then(async () => {
      for (const folder of folders) {
        if (disposed) return;
        try {
          if (!folder.path)
            throw new Error(
              "Dropping folders requires the desktop app. Use Add project to choose a folder.",
            );
          await open(folder.path);
        } catch (cause) {
          if (!disposed)
            toastManager.add({
              type: "error",
              title: "Could not open " + folder.name,
              description: cause instanceof Error ? cause.message : "Could not open project.",
            });
        }
      }
      if (!disposed) completed();
    });
    return () => {
      disposed = true;
    };
  }, [folders, completed, open]);
  return null;
}
