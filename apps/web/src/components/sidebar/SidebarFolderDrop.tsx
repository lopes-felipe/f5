import { useState, type DragEvent, type ReactNode } from "react";
import { FolderPlusIcon } from "lucide-react";
import { partitionDroppedAttachments } from "../../lib/droppedAttachments";
import { useOpenLocalWorkspace } from "../../hooks/useOpenLocalWorkspace";
import { toastManager } from "../ui/toast";

export function SidebarFolderDrop({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  const workspace = useOpenLocalWorkspace();
  const isFileDrag = (event: DragEvent) => event.dataTransfer.types.includes("Files");
  const over = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    if (event.defaultPrevented) {
      setActive(false);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setActive(true);
  };
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={over}
      onDragOver={over}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setActive(false);
      }}
      onDrop={(event) => {
        if (!isFileDrag(event)) return;
        const claimed = event.defaultPrevented;
        event.preventDefault();
        setActive(false);
        const { folders, files } = partitionDroppedAttachments(event.dataTransfer);
        const paths = folders.map((folder) => ({
          name: folder.name,
          path: window.desktopBridge?.getPathForFile?.(folder),
        }));
        void (async () => {
          for (const folder of paths) {
            try {
              if (!folder.path)
                throw new Error(
                  "Dropping folders requires the desktop app. Use Add project to choose a folder.",
                );
              await workspace.open(folder.path);
            } catch (cause) {
              toastManager.add({
                type: "error",
                title: "Could not open " + folder.name,
                description: cause instanceof Error ? cause.message : "Could not open project.",
              });
            }
          }
        })();
        if (files.length && !claimed)
          toastManager.add({
            type: "info",
            title: "Only folders can be added as projects",
            description: "Drop files on a thread to attach them.",
          });
      }}
    >
      {children}
      {active ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-1 z-30 flex flex-col items-center justify-center gap-2 rounded-lg bg-sidebar/90 p-4 text-center text-sm ring-1 ring-primary"
        >
          <FolderPlusIcon className="size-5" />
          {window.desktopBridge
            ? "Drop folders to add projects"
            : "Dropping folders requires the desktop app"}
        </div>
      ) : null}
    </div>
  );
}
