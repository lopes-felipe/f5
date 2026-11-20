import { lazy, Suspense, useCallback, useState, type DragEvent, type ReactNode } from "react";
import { FolderPlusIcon } from "lucide-react";
import { partitionDroppedAttachments } from "../../lib/droppedAttachments";
import { toastManager } from "../ui/toast";
const OpenDroppedFolders = lazy(() => import("./OpenDroppedFolders"));

export function SidebarFolderDrop({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  const [batches, setBatches] = useState<
    Array<Array<{ name: string; path: string | null | undefined }>>
  >([]);
  const completed = useCallback(() => setBatches((current) => current.slice(1)), []);
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
        if (paths.length) setBatches((current) => [...current, paths]);
        if (files.length && !claimed)
          toastManager.add({
            type: "info",
            title: "Only folders can be added as projects",
            description: "Drop files on a thread to attach them.",
          });
      }}
    >
      {children}
      {batches[0] ? (
        <Suspense fallback={null}>
          <OpenDroppedFolders folders={batches[0]} completed={completed} />
        </Suspense>
      ) : null}
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
