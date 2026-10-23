/** Ignored environment files can hold credentials and must survive cleanup. */
export const isProtectedIgnoredPath = (path: string): boolean =>
  path.split("/").some((segment) => segment === ".env" || segment.startsWith(".env."));

/** Only dependency directories were removable by the existing manual policy. */
export const isManualRemovalIgnoredBlocker = (path: string): boolean =>
  !/(^|\/)node_modules\/?$/.test(path);

export interface CleanupSafetyProbe {
  readonly hasTrackedChanges: boolean;
  readonly hasUntrackedChanges: boolean;
  readonly ignoredEntries: ReadonlyArray<string>;
  readonly ignoredTruncated: boolean;
}

/** Parse NUL-delimited porcelain v2, including the extra source path of renames. */
export function parseCleanupSafetyStatus(stdout: string): CleanupSafetyProbe {
  if (stdout && !stdout.endsWith("\0")) throw new Error("Incomplete cleanup safety status");
  let hasTrackedChanges = false;
  let hasUntrackedChanges = false;
  const ignoredEntries: string[] = [];
  const records = stdout.split("\0");
  for (let index = 0; index < records.length - 1; index++) {
    const record = records[index]!;
    if (record.startsWith("? ")) hasUntrackedChanges = true;
    else if (record.startsWith("! ")) ignoredEntries.push(record.slice(2));
    else if (/^[12u] /.test(record)) {
      hasTrackedChanges = true;
      if (record.startsWith("2 ") && !records[++index])
        throw new Error("Incomplete cleanup safety rename");
    } else throw new Error("Unrecognized cleanup safety status");
  }
  return { hasTrackedChanges, hasUntrackedChanges, ignoredEntries, ignoredTruncated: false };
}
