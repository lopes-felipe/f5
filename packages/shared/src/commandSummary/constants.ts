export interface ComparableCommandExecutionLike {
  readonly command: string;
  readonly detail?: string | null | undefined;
  readonly title?: string | null | undefined;
}

export const POSIX_SHELL_NAMES = new Set(["zsh", "bash", "sh", "fish"]);
export const COMMAND_TOOL_NAMES = new Set([
  "bash",
  "shell",
  "terminal",
  "command",
  "sh",
  "zsh",
  "run",
]);
export const SHELL_TOKEN_OPERATORS = [
  "2>&1",
  "1>>",
  "2>>",
  "&>>",
  "&>",
  ">>",
  "<<",
  "||",
  "&&",
  "1>",
  "2>",
  "|",
  ";",
  "&",
  "<",
  ">",
] as const;
export const SHELL_COMMAND_SEPARATORS = new Set(["|", "||", "&&", ";", "&"]);
export const RG_FLAGS_WITH_VALUE = new Set([
  "-A",
  "-B",
  "-C",
  "-E",
  "-e",
  "-f",
  "-g",
  "-j",
  "-M",
  "-m",
  "-t",
  "-T",
  "--after-context",
  "--before-context",
  "--context",
  "--encoding",
  "--engine",
  "--file",
  "--glob",
  "--glob-case-insensitive",
  "--ignore-file",
  "--max-columns",
  "--max-count",
  "--max-depth",
  "--max-filesize",
  "--path-separator",
  "--pre",
  "--pre-glob",
  "--regexp",
  "--replace",
  "--sort",
  "--sortr",
  "--threads",
  "--type",
  "--type-add",
  "--type-not",
]);
export const RG_PATTERN_FLAGS = new Set(["-e", "--regexp"]);
export const GREP_FLAGS_WITH_VALUE = new Set([
  "-A",
  "-B",
  "-C",
  "-D",
  "-d",
  "-e",
  "-f",
  "-m",
  "--after-context",
  "--before-context",
  "--binary-files",
  "--color",
  "--colour",
  "--context",
  "--devices",
  "--directories",
  "--exclude",
  "--exclude-dir",
  "--exclude-from",
  "--file",
  "--include",
  "--label",
  "--max-count",
  "--regexp",
]);
export const GREP_PATTERN_FLAGS = new Set(["-e", "--regexp"]);
export const GIT_GREP_FLAGS_WITH_VALUE = new Set([
  "-e",
  "-f",
  "-C",
  "--max-depth",
  "--open-files-in-pager",
]);
export const GIT_GREP_PATTERN_FLAGS = new Set(["-e"]);
export const RG_REJECT_FLAGS = new Set(["--files", "--type-list", "--help", "--version"]);
export const GREP_REJECT_FLAGS = new Set(["--help", "--version"]);
export const GIT_GREP_REJECT_FLAGS = new Set(["--help", "--version"]);
export const SIMPLE_LITERAL_ESCAPE_CHARS = new Set([
  ".",
  "\\",
  "-",
  "/",
  "_",
  ":",
  ",",
  "@",
  "#",
  "%",
  "=",
  "+",
]);
export const SIMPLE_REGEX_META_CHARS = new Set([
  ".",
  "^",
  "$",
  "*",
  "+",
  "?",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
]);
// Keep worklog summaries scannable in the timeline: enumerate a few concrete
// targets/patterns, then collapse the tail before the label turns into a
// second command transcript.
export const SEARCH_SUMMARY_TARGET_LIMIT = 3;
export const SEARCH_SUMMARY_PATTERN_LIMIT = 3;
export const SEARCH_SUMMARY_PATTERN_PREVIEW_LIMIT = 80;
export const FIND_PATTERN_FLAGS = new Set([
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-wholename",
  "-iwholename",
]);
export const FIND_FLAGS_WITH_VALUE = new Set([
  "-fstype",
  "-gid",
  "-group",
  "-maxdepth",
  "-mindepth",
  "-mount",
  "-mtime",
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-perm",
  "-size",
  "-type",
  "-uid",
  "-user",
  "-used",
  "-wholename",
  "-iwholename",
]);
export const FD_FLAGS_WITH_VALUE = new Set([
  "-d",
  "-e",
  "-E",
  "-j",
  "-s",
  "-t",
  "-x",
  "-X",
  "--changed-within",
  "--changed-before",
  "--extension",
  "--exclude",
  "--exec",
  "--exec-batch",
  "--max-depth",
  "--min-depth",
  "--owner",
  "--search-path",
  "--size",
  "--threads",
  "--type",
]);

export interface FileReadCommandMatch {
  readonly filePaths: ReadonlyArray<string>;
  readonly lineSummary?: string;
}

export interface SearchSummaryInput {
  readonly patterns: ReadonlyArray<string>;
  readonly targets?: ReadonlyArray<string>;
}

export interface ActivityDisplayHints {
  readonly readPaths?: ReadonlyArray<string>;
  readonly lineSummary?: string;
  readonly searchSummary?: string;
}

export type CompactCommandClassification =
  | {
      readonly kind: "search";
      readonly summary: string;
    }
  | {
      readonly kind: "file-read";
      readonly fileRead: FileReadCommandMatch;
    }
  | {
      readonly kind: "other";
    };

export interface SearchSummaryMatch {
  readonly targets: ReadonlyArray<string>;
  readonly patterns: ReadonlyArray<string>;
}

export interface ParsedSearchCommand {
  readonly patterns: ReadonlyArray<string>;
  readonly targets: ReadonlyArray<string>;
}

export interface SearchToolConfig {
  readonly flagsWithValue: ReadonlySet<string>;
  readonly patternFlags: ReadonlySet<string>;
  readonly rejectFlags?: ReadonlySet<string>;
}
