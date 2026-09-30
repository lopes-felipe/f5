type DroppedTransfer = Pick<DataTransfer, "files"> & {
  readonly items: ArrayLike<
    Pick<DataTransferItem, "kind" | "getAsFile"> & {
      webkitGetAsEntry?: () => { readonly isDirectory: boolean } | null;
    }
  >;
};

/**
 * Directories are references, never recursively read or uploaded. Archives remain opaque files.
 * Each file is classified by its own transfer item, so a file that shares a name with a dropped
 * folder is still uploaded as a file.
 */
export function partitionDroppedAttachments(transfer: DroppedTransfer) {
  const items = Array.from(transfer.items).filter((item) => item.kind === "file");
  if (items.length === 0) return { files: Array.from(transfer.files), folders: [] as File[] };
  const files: File[] = [];
  const folders: File[] = [];
  for (const item of items) {
    const file = item.getAsFile();
    if (!file) continue;
    (item.webkitGetAsEntry?.()?.isDirectory ? folders : files).push(file);
  }
  return { files, folders };
}
