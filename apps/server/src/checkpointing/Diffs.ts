import { parsePatchFiles } from "@pierre/diffs";

export interface TurnDiffFileSummary {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export function parseTurnDiffFilesFromUnifiedDiff(
  diff: string,
): ReadonlyArray<TurnDiffFileSummary> {
  const normalized = diff.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return [];
  }

  const parsedPatches = parsePatchFiles(normalized);
  const files = parsedPatches.flatMap((patch) =>
    patch.files.map((file) => ({
      path: file.name,
      additions: file.hunks.reduce((total, hunk) => total + hunk.additionLines, 0),
      deletions: file.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0),
    })),
  );

  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

export interface ChangedPath {
  readonly path: string;
  /** The source of a rename or copy. */
  readonly previousPath?: string;
}

/** Parses `git diff --numstat -z` output into changed paths, keeping both sides of renames. */
export function parseNumstatPaths(numstat: string): ReadonlyArray<ChangedPath> {
  const records = numstat.split("\0");
  const files: ChangedPath[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const counts = /^(-|\d+)\t(-|\d+)\t/.exec(records[index]!);
    if (!counts) continue;
    const path = records[index]!.slice(counts[0].length);
    if (path.length > 0) {
      files.push({ path });
      continue;
    }
    // Renames and copies use two more records: the source and the destination.
    const previousPath = records[index + 1] ?? "";
    const destination = records[index + 2] ?? "";
    index += 2;
    if (destination.length > 0) files.push({ path: destination, previousPath });
  }
  return files;
}

/**
 * True when Git brought this file in and no work in the range touched it. A rename stays
 * when either side was authored, because the turn shows it as one file.
 */
export function isGitImport(file: ChangedPath, authoredPaths: ReadonlySet<string>): boolean {
  return (
    !authoredPaths.has(file.path) &&
    (file.previousPath === undefined || !authoredPaths.has(file.previousPath))
  );
}

// Windows limits a command line to 32,767 characters; leave room for git's other arguments.
const MAX_PATHSPEC_CHARS = 24_000;

/**
 * Splits path groups into literal pathspec lists that each fit on one command line. A
 * group (a rename's two sides) stays in one list. No groups yields no lists.
 */
export function batchLiteralPathspecs(
  groups: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<ReadonlyArray<string>> {
  const batches: string[][] = [];
  let batch: string[] = [];
  let length = 0;
  for (const group of groups) {
    const pathspecs = group.map((path) => `:(literal)${path}`);
    const size = pathspecs.reduce((total, pathspec) => total + pathspec.length + 1, 0);
    if (batch.length > 0 && length + size > MAX_PATHSPEC_CHARS) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(...pathspecs);
    length += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}
