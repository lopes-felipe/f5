/** Legacy backups store absolute registry paths, while archive paths are relative. */
export function resolveBackupAttachmentPath(
  storedPath: string,
  paths: ReadonlySet<string>,
): string | undefined {
  let suffix = storedPath.replaceAll("\\", "/");
  let match: string | undefined;
  while (suffix.length > 0) {
    if (paths.has(suffix)) {
      if (match !== undefined)
        throw new Error(`Backup attachment path is ambiguous: ${storedPath}`);
      match = suffix;
    }
    const separator = suffix.indexOf("/");
    if (separator === -1) break;
    suffix = suffix.slice(separator + 1);
  }
  return match;
}
