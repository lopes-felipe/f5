/** Directories are references, never recursively read or uploaded. Archives remain opaque files. */
export function partitionDroppedAttachments(transfer: DataTransfer) {
  const directories = new Set(
    Array.from(transfer.items).flatMap((item) => {
      const entry = item.webkitGetAsEntry?.();
      return entry?.isDirectory ? [entry.name] : [];
    }),
  );
  const files = Array.from(transfer.files);
  return {
    files: files.filter((file) => !directories.has(file.name)),
    folders: files.filter((file) => directories.has(file.name)),
  };
}
