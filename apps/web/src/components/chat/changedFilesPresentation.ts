export const CHANGED_FILES_EXPANDED_MAX_FILES = 5;
export const CHANGED_FILES_EXPANDED_MAX_LINES = 200;
export const CHANGED_FILES_COMPACT_PREVIEW_COUNT = 3;

export type ChangedFilesPresentation = "expanded" | "compact" | "collapsed";

export function resolveChangedFilesPresentation(input: {
  readonly fileCount: number;
  readonly changedLineCount: number;
  readonly isNewest: boolean;
}): ChangedFilesPresentation {
  if (!input.isNewest) {
    return "collapsed";
  }
  return input.fileCount <= CHANGED_FILES_EXPANDED_MAX_FILES &&
    input.changedLineCount <= CHANGED_FILES_EXPANDED_MAX_LINES
    ? "expanded"
    : "compact";
}

export function isChangedFileExpandedByDefault(input: {
  readonly presentation: ChangedFilesPresentation;
  readonly fileIndex: number;
}): boolean {
  switch (input.presentation) {
    case "expanded":
      return true;
    case "compact":
      return input.fileIndex < CHANGED_FILES_COMPACT_PREVIEW_COUNT;
    case "collapsed":
      return false;
  }
}
