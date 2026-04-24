import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

// Matches Linux PATH_MAX (4096) and aligns with the `addProjectBaseDirectory`
// settings schema so values saved in settings can always be sent to the browse
// endpoint without the payload decode rejecting them.
const FILESYSTEM_PATH_MAX_LENGTH = 4096;

// NOTE: `TrimmedNonEmptyString` rejects empty / whitespace-only values with
// Effect Schema's default error message, which isn't particularly friendly.
// Callers must gate dispatch on a non-empty trimmed path before sending the
// request (the palette uses `browseDirectoryPath.length > 0`); if a future
// call site needs a user-facing error here, consider wrapping this in a
// custom `Schema.filter` with a clearer message.
export const FilesystemBrowseInput = Schema.Struct({
  partialPath: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  cwd: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH))),
});
export type FilesystemBrowseInput = typeof FilesystemBrowseInput.Type;

export const FilesystemBrowseEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  fullPath: TrimmedNonEmptyString,
});
export type FilesystemBrowseEntry = typeof FilesystemBrowseEntry.Type;

export const FilesystemBrowseResult = Schema.Struct({
  parentPath: TrimmedNonEmptyString,
  entries: Schema.Array(FilesystemBrowseEntry),
});
export type FilesystemBrowseResult = typeof FilesystemBrowseResult.Type;
