import { Schema } from "effect";
import {
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas";

export const PROJECT_ICON_GLYPHS = [
  "folder",
  "code",
  "terminal",
  "bot",
  "rocket",
  "flask",
  "database",
  "globe",
  "briefcase",
  "gamepad",
] as const;
export const ProjectIconGlyph = Schema.Literals(PROJECT_ICON_GLYPHS);
export type ProjectIconGlyph = typeof ProjectIconGlyph.Type;

export const PROJECT_ICON_COLORS = [
  "gray",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "indigo",
  "violet",
  "pink",
] as const;
export const ProjectIconColor = Schema.Literals(PROJECT_ICON_COLORS);
export type ProjectIconColor = typeof ProjectIconColor.Type;

const ProjectLucideIcon = Schema.Struct({
  type: Schema.Literal("lucide"),
  glyph: ProjectIconGlyph,
  color: ProjectIconColor,
});

const ProjectEmojiIcon = Schema.Struct({
  type: Schema.Literal("emoji"),
  emoji: TrimmedNonEmptyString.check(
    Schema.isMaxLength(16),
    Schema.isPattern(/^(?=.*(?:\p{Extended_Pictographic}|\p{Regional_Indicator}))[^\r\n]+$/u),
  ),
});

export const ProjectIcon = Schema.Union([ProjectLucideIcon, ProjectEmojiIcon]);
export type ProjectIcon = typeof ProjectIcon.Type;

export const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
export const PROJECT_SEARCH_CONTENTS_MAX_LIMIT = 500;
export const PROJECT_SEARCH_CONTENTS_MAX_MATCHES_PER_FILE = 100;
export const PROJECT_LIST_ENTRIES_DEFAULT_LIMIT = 5_000;
export const PROJECT_LIST_ENTRIES_MAX_LIMIT = 100_000;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_READ_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_AUTHORIZE_ENTRY_PATH_MAX_LENGTH = 512;
const Sha256HexString = TrimmedNonEmptyString.check(Schema.isPattern(/^[0-9a-f]{64}$/));

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

const ProjectContentSearchRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const ProjectSearchContentsInput = Schema.Struct({
  requestId: ProjectContentSearchRequestId,
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
  // Whitespace is significant in content queries, so this deliberately does
  // not use TrimmedNonEmptyString.
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_CONTENTS_MAX_LIMIT)),
  caseSensitive: Schema.Boolean,
  wholeWord: Schema.Boolean,
  useRegex: Schema.Boolean,
});
export type ProjectSearchContentsInput = typeof ProjectSearchContentsInput.Type;

export const ProjectContentMatchRange = Schema.Struct({
  // Ranges are zero-based Unicode code-point offsets, not UTF-8 bytes or JS
  // UTF-16 code units.
  start: NonNegativeInt,
  end: NonNegativeInt,
});
export type ProjectContentMatchRange = typeof ProjectContentMatchRange.Type;

export const ProjectContentMatch = Schema.Struct({
  path: TrimmedNonEmptyString,
  lineNumber: PositiveInt,
  lineContent: Schema.String,
  matchRanges: Schema.Array(ProjectContentMatchRange).check(Schema.isMaxLength(256)),
});
export type ProjectContentMatch = typeof ProjectContentMatch.Type;

export const ProjectSearchContentsResult = Schema.Struct({
  requestId: ProjectContentSearchRequestId,
  matches: Schema.Array(ProjectContentMatch).check(
    Schema.isMaxLength(PROJECT_SEARCH_CONTENTS_MAX_LIMIT),
  ),
  truncated: Schema.Boolean,
  indexedPathCount: NonNegativeInt,
  indexTruncated: Schema.Boolean,
  regexFallbackError: Schema.optional(Schema.String),
});
export type ProjectSearchContentsResult = typeof ProjectSearchContentsResult.Type;

export const ProjectCancelContentSearchInput = Schema.Struct({
  requestId: ProjectContentSearchRequestId,
});
export type ProjectCancelContentSearchInput = typeof ProjectCancelContentSearchInput.Type;

export const ProjectCancelContentSearchResult = Schema.Struct({
  cancelled: Schema.Boolean,
});
export type ProjectCancelContentSearchResult = typeof ProjectCancelContentSearchResult.Type;

export const ProjectListEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_LIST_ENTRIES_MAX_LIMIT)),
  ),
});
export type ProjectListEntriesInput = typeof ProjectListEntriesInput.Type;

export const ProjectListEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
  totalEntries: NonNegativeInt,
});
export type ProjectListEntriesResult = typeof ProjectListEntriesResult.Type;

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
  expectedContentSha256: Schema.optional(Sha256HexString),
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  byteLength: NonNegativeInt,
  contentSha256: Sha256HexString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export const PROJECT_READ_FILE_MAX_SIZE = 2 * 1024 * 1024; // 2MB

export const ProjectReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH)),
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectReadFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  contents: Schema.String,
  byteLength: NonNegativeInt,
  truncated: Schema.Boolean,
  contentSha256: Schema.optional(Sha256HexString),
});
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export const ProjectAuthorizeEntryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_AUTHORIZE_ENTRY_PATH_MAX_LENGTH),
  ),
  kind: Schema.optional(ProjectEntryKind),
});
export type ProjectAuthorizeEntryInput = typeof ProjectAuthorizeEntryInput.Type;

export const ProjectAuthorizeEntryResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
});
export type ProjectAuthorizeEntryResult = typeof ProjectAuthorizeEntryResult.Type;
