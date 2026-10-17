import { FilesystemPath } from "./baseSchemas";
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

const ProjectMonogramIcon = Schema.Struct({
  type: Schema.Literal("monogram"),
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(6)),
  color: ProjectIconColor,
});
export const ProjectIcon = Schema.Union([ProjectLucideIcon, ProjectEmojiIcon, ProjectMonogramIcon]);
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
  cwd: FilesystemPath,
  query: TrimmedString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectEntry = Schema.Struct({
  path: FilesystemPath,
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
  path: FilesystemPath,
  lineNumber: PositiveInt,
  lineContent: Schema.String.check(Schema.isMaxLength(8 * 1024)),
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
  cwd: FilesystemPath,
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_LIST_ENTRIES_MAX_LIMIT)),
  ),
});
export type ProjectListEntriesInput = typeof ProjectListEntriesInput.Type;

export const ProjectListDirectoryInput = Schema.Struct({
  cwd: FilesystemPath,
  relativePath: TrimmedString,
  includeIgnored: Schema.optional(Schema.Boolean),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_LIST_ENTRIES_MAX_LIMIT)),
  ),
});
export type ProjectListDirectoryInput = typeof ProjectListDirectoryInput.Type;

export const ProjectListEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
  totalEntries: NonNegativeInt,
});
export type ProjectListEntriesResult = typeof ProjectListEntriesResult.Type;

export const ProjectWriteFileInput = Schema.Struct({
  cwd: FilesystemPath,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
  condition: Schema.Union([
    Schema.Struct({ type: Schema.Literal("create") }),
    Schema.Struct({ type: Schema.Literal("match"), contentSha256: Sha256HexString }),
  ]),
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Union([
  Schema.Struct({
    relativePath: TrimmedNonEmptyString,
    byteLength: NonNegativeInt,
    contentSha256: Sha256HexString,
  }),
  Schema.Struct({
    conflict: Schema.Literal(true),
    relativePath: TrimmedNonEmptyString,
    currentContentSha256: Schema.NullOr(Sha256HexString),
  }),
]);
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

/** Paths one client may watch per workspace; open files plus visible directories. */
export const PROJECT_WATCHED_PATHS_MAX = 512;

export const ProjectSetWatchedPathsInput = Schema.Struct({
  cwd: FilesystemPath,
  files: Schema.Array(Schema.String).check(Schema.isMaxLength(PROJECT_WATCHED_PATHS_MAX)),
  directories: Schema.Array(Schema.String).check(Schema.isMaxLength(PROJECT_WATCHED_PATHS_MAX)),
});
export type ProjectSetWatchedPathsInput = typeof ProjectSetWatchedPathsInput.Type;

export const ProjectSetWatchedPathsResult = Schema.Struct({
  watched: NonNegativeInt,
  /** Some paths are polled because watching failed; keep broader refreshes. */
  degraded: Schema.Boolean,
  rejected: Schema.Array(Schema.String),
});
export type ProjectSetWatchedPathsResult = typeof ProjectSetWatchedPathsResult.Type;

export const ProjectWatchedPathChange = Schema.Struct({
  relativePath: Schema.String,
  kind: Schema.Literals(["file", "directory"]),
  change: Schema.Literals(["created", "changed", "deleted"]),
  /** Advances on every observed change of this path. */
  revision: NonNegativeInt,
});
export type ProjectWatchedPathChange = typeof ProjectWatchedPathChange.Type;

export const ProjectWatchedPathsChangedPayload = Schema.Struct({
  cwd: Schema.String,
  /** Empty when only the watch status (`degraded`) changed. */
  changes: Schema.Array(ProjectWatchedPathChange),
  degraded: Schema.Boolean,
});
export type ProjectWatchedPathsChangedPayload = typeof ProjectWatchedPathsChangedPayload.Type;

export const PROJECT_READ_FILE_MAX_SIZE = 2 * 1024 * 1024; // 2MB

export const ProjectReadFileInput = Schema.Struct({
  cwd: FilesystemPath,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH)),
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectReadFileResult = Schema.Struct({
  workspaceIdentity: Schema.optional(Schema.String),
  fileIdentity: Schema.optional(Schema.String),
  relativePath: TrimmedNonEmptyString,
  contents: Schema.String,
  byteLength: NonNegativeInt,
  truncated: Schema.Boolean,
  contentSha256: Schema.optional(Sha256HexString),
});
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export const ProjectAuthorizeEntryInput = Schema.Struct({
  cwd: FilesystemPath,
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

export const ProjectCloneInput = Schema.Struct({
  operationId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  parentPath: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  directoryName: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
});
export type ProjectCloneInput = typeof ProjectCloneInput.Type;
export const ProjectCloneCancelInput = Schema.Struct({
  operationId: ProjectCloneInput.fields.operationId,
});
export type ProjectCloneCancelInput = typeof ProjectCloneCancelInput.Type;
export const ProjectCloneJob = Schema.Struct({
  ...ProjectCloneInput.fields,
  destination: Schema.String,
  projectId: ProjectId,
  status: Schema.Literals(["queued", "cloning", "complete", "failed", "cancelled"]),
  progress: Schema.String,
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type ProjectCloneJob = typeof ProjectCloneJob.Type;

export const ProjectIssueAssetUrlInput = Schema.Struct({
  identity: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }),
    Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
    Schema.Struct({ kind: Schema.Literal("attachments") }),
  ]),
  files: Schema.Array(
    Schema.Struct({
      relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
      grant: Schema.Literals(["file", "html-document"]),
    }),
  ).check(Schema.isMaxLength(100)),
});
export type ProjectIssueAssetUrlInput = typeof ProjectIssueAssetUrlInput.Type;
/** One entry per requested file, in order; `null` when that file cannot be read. */
export const ProjectIssueAssetUrlResult = Schema.Array(
  Schema.NullOr(
    Schema.Struct({
      relativePath: Schema.String,
      url: Schema.String,
      expiresAt: Schema.Number,
      width: Schema.optional(Schema.Number),
      height: Schema.optional(Schema.Number),
    }),
  ),
);
export type ProjectIssueAssetUrlResult = typeof ProjectIssueAssetUrlResult.Type;

export const ProjectOpenHtmlPreviewInput = Schema.Struct({
  identity: ProjectIssueAssetUrlInput.fields.identity,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type ProjectOpenHtmlPreviewInput = typeof ProjectOpenHtmlPreviewInput.Type;
