interface ComparableCommandExecutionLike {
  readonly command: string;
  readonly detail?: string | null | undefined;
  readonly title?: string | null | undefined;
}

const POSIX_SHELL_NAMES = new Set(["zsh", "bash", "sh", "fish"]);
const COMMAND_TOOL_NAMES = new Set(["bash", "shell", "terminal", "command", "sh", "zsh", "run"]);
const SHELL_TOKEN_OPERATORS = [
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
const SHELL_COMMAND_SEPARATORS = new Set(["|", "||", "&&", ";", "&"]);
const RG_FLAGS_WITH_VALUE = new Set([
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
const RG_PATTERN_FLAGS = new Set(["-e", "--regexp"]);
const GREP_FLAGS_WITH_VALUE = new Set([
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
const GREP_PATTERN_FLAGS = new Set(["-e", "--regexp"]);
const GIT_GREP_FLAGS_WITH_VALUE = new Set([
  "-e",
  "-f",
  "-C",
  "--max-depth",
  "--open-files-in-pager",
]);
const GIT_GREP_PATTERN_FLAGS = new Set(["-e"]);
const RG_REJECT_FLAGS = new Set(["--files", "--type-list", "--help", "--version"]);
const GREP_REJECT_FLAGS = new Set(["--help", "--version"]);
const GIT_GREP_REJECT_FLAGS = new Set(["--help", "--version"]);
const SIMPLE_LITERAL_ESCAPE_CHARS = new Set([
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
const SIMPLE_REGEX_META_CHARS = new Set([
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
const SEARCH_SUMMARY_TARGET_LIMIT = 3;
const SEARCH_SUMMARY_PATTERN_LIMIT = 3;
const SEARCH_SUMMARY_PATTERN_PREVIEW_LIMIT = 80;
const FIND_PATTERN_FLAGS = new Set([
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-wholename",
  "-iwholename",
]);
const FIND_FLAGS_WITH_VALUE = new Set([
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
const FD_FLAGS_WITH_VALUE = new Set([
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

interface SearchSummaryMatch {
  readonly targets: ReadonlyArray<string>;
  readonly patterns: ReadonlyArray<string>;
}

interface ParsedSearchCommand {
  readonly patterns: ReadonlyArray<string>;
  readonly targets: ReadonlyArray<string>;
}

interface SearchToolConfig {
  readonly flagsWithValue: ReadonlySet<string>;
  readonly patternFlags: ReadonlySet<string>;
  readonly rejectFlags?: ReadonlySet<string>;
}

export function isGenericCommandTitle(title: string): boolean {
  return /^(?:ran|running) command$|^command run$/i.test(title.trim());
}

function shellBasename(command: string): string {
  const normalized = command.replace(/\\/g, "/");
  const segments = normalized.split("/");
  return segments[segments.length - 1] ?? normalized;
}

function unwrapShellCommandArg(value: string): string {
  if (value.length < 2) {
    return value;
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/'"'"'/g, "'");
  }

  if (value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\(["\\$`])/g, "$1")
      .replace(/\\n/g, "\n");
  }

  return value;
}

function isQuotedToken(token: string): boolean {
  return (
    token.length >= 2 &&
    ((token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith('"') && token.endsWith('"')))
  );
}

function isCommandSubstitutionToken(token: string): boolean {
  return /^\$\(.+\)$/.test(token) || /^`[^`]+`$/.test(token);
}

function maybeUnquoteShellToken(token: string): string {
  return isQuotedToken(token) ? unwrapShellCommandArg(token) : token;
}

export function displayCommandExecutionCommand(command: string): string {
  const match = /^(?<shell>\S+)\s+(?<flag>-(?:ilc|lc|ic|c))\s+(?<rest>.+)$/s.exec(command.trim());
  const shell = match?.groups?.shell;
  const rest = match?.groups?.rest;
  if (!shell || !rest) {
    return command;
  }

  if (!POSIX_SHELL_NAMES.has(shellBasename(shell))) {
    return command;
  }

  return unwrapShellCommandArg(rest.trim());
}

function extractCommandToolSummaryPayload(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = /^(?<tool>[A-Za-z][A-Za-z0-9 _-]*):\s*(?<payload>.+)$/s.exec(value.trim());
  if (!match?.groups) {
    return null;
  }

  const { tool, payload: rawPayload } = match.groups;
  if (tool === undefined || rawPayload === undefined) {
    return null;
  }

  const toolName = tool.trim().toLowerCase();
  if (!COMMAND_TOOL_NAMES.has(toolName)) {
    return null;
  }

  const payload = rawPayload.trim();
  if (payload.length === 0 || /^\{\s*\}$/.test(payload)) {
    return null;
  }

  if (payload.startsWith("{") && payload.endsWith("}")) {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const command =
        typeof parsed.command === "string"
          ? parsed.command
          : typeof parsed.cmd === "string"
            ? parsed.cmd
            : null;
      const trimmed = command?.trim();
      return trimmed && trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }

  return payload;
}

function isUnhelpfulCommandSummary(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length === 0 ||
    /^(?:[A-Za-z][A-Za-z0-9 _-]*:\s*\{\s*\}|\[command unavailable\])$/s.test(trimmed)
  );
}

export function normalizeCommandExecutionDetail(detail: string | null | undefined): string | null {
  if (detail === null || detail === undefined) {
    return null;
  }
  return extractCommandToolSummaryPayload(detail) ?? detail;
}

export function resolveCommandExecutionDisplayCommand(
  execution: Pick<ComparableCommandExecutionLike, "command" | "detail">,
): string {
  const detailSummary = extractCommandToolSummaryPayload(execution.detail);
  if (detailSummary) {
    const commandSummary = extractCommandToolSummaryPayload(execution.command);
    if (
      !commandSummary ||
      isUnhelpfulCommandSummary(execution.command) ||
      commandSummary !== detailSummary
    ) {
      return detailSummary;
    }
  }

  return (
    extractCommandToolSummaryPayload(execution.command) ??
    displayCommandExecutionCommand(execution.command)
  );
}

export function resolveCommandExecutionSummaryText(
  execution: Pick<ComparableCommandExecutionLike, "command" | "detail" | "title">,
): string {
  const displayCommand = resolveCommandExecutionDisplayCommand(execution);
  const searchSummary = deriveSearchCommandSummary(displayCommand);
  return execution.title &&
    execution.title !== execution.command &&
    execution.title !== displayCommand &&
    !isGenericCommandTitle(execution.title)
    ? execution.title
    : (searchSummary ?? displayCommand);
}

function parseSedFileReadCommand(command: string): FileReadCommandMatch | null {
  const tokens = lexShellCommand(command).filter((token) => token.trim().length > 0);
  if (tokens.length < 3) {
    return null;
  }

  if (tokens.some((token) => isShellOperatorToken(token))) {
    return null;
  }

  const [binary, ...args] = tokens;
  if (!binary || shellBasename(maybeUnquoteShellToken(binary)) !== "sed") {
    return null;
  }

  const sedCommand = parseSedPrintCommandArgs(args);
  if (!sedCommand || sedCommand.trailingArgs.length === 0) {
    return null;
  }

  const filePaths = sedCommand.trailingArgs
    .map((filePath) => filePath.trim())
    .filter((filePath) => filePath.length > 0);
  if (filePaths.length !== sedCommand.trailingArgs.length) {
    return null;
  }

  const lineSummary = formatSedLineSummary(sedCommand.script);

  return {
    filePaths,
    ...(lineSummary ? { lineSummary } : {}),
  };
}

function parseSedPrintCommandArgs(
  args: ReadonlyArray<string>,
): { script: string; trailingArgs: string[] } | null {
  let script: string | null = null;
  let index = 0;

  while (index < args.length) {
    const rawArg = args[index];
    if (!rawArg) {
      index += 1;
      continue;
    }

    if (rawArg === "--") {
      index += 1;
      break;
    }

    if (rawArg === "-n" || rawArg === "--quiet" || rawArg === "--silent") {
      index += 1;
      continue;
    }

    if (rawArg === "-e") {
      const nextArg = args[index + 1];
      if (!nextArg || script !== null) {
        return null;
      }
      script = maybeUnquoteShellToken(nextArg);
      index += 2;
      continue;
    }

    if (rawArg.startsWith("-e") && rawArg.length > 2) {
      if (script !== null) {
        return null;
      }
      script = maybeUnquoteShellToken(rawArg.slice(2));
      index += 1;
      continue;
    }

    if (
      rawArg === "-i" ||
      rawArg.startsWith("-i") ||
      rawArg === "--in-place" ||
      rawArg.startsWith("--in-place=") ||
      rawArg === "-f" ||
      rawArg.startsWith("-f")
    ) {
      return null;
    }

    if (rawArg.startsWith("-")) {
      return null;
    }

    if (script === null) {
      script = maybeUnquoteShellToken(rawArg);
      index += 1;
      continue;
    }

    break;
  }

  if (script === null) {
    return null;
  }

  const normalizedScript = script.trim();
  if (!/^(?:\d+|\$)(?:,(?:\d+|\$))?p$/i.test(normalizedScript)) {
    return null;
  }

  return {
    script: normalizedScript,
    trailingArgs: args.slice(index).map(maybeUnquoteShellToken),
  };
}

function formatLineSummaryRange(
  start: number | "last",
  end?: number | "end" | null,
): string | null {
  if (start !== "last" && (!Number.isInteger(start) || start <= 0)) {
    return null;
  }

  if (
    end === undefined ||
    end === null ||
    (typeof start === "number" && typeof end === "number" && end <= start)
  ) {
    return start === "last" ? "last line" : `line ${start}`;
  }

  const formattedStart = start === "last" ? "last" : String(start);
  const formattedEnd = end === "end" ? "end" : String(end);
  return `lines ${formattedStart}-${formattedEnd}`;
}

export function formatLineRangeSummary(input: {
  readonly startLine: number;
  readonly endLine?: number | null;
}): string | null {
  if (!Number.isInteger(input.startLine) || input.startLine <= 0) {
    return null;
  }

  if (input.endLine === -1) {
    return formatLineSummaryRange(input.startLine, "end");
  }

  return formatLineSummaryRange(input.startLine, input.endLine);
}

function formatSedLineSummary(script: string): string | null {
  const match = /^(?<start>\d+|\$)(?:,(?<end>\d+|\$))?p$/i.exec(script);
  if (!match?.groups?.start) {
    return null;
  }

  const start = match.groups.start;
  const end = match.groups.end;
  return formatLineSummaryRange(
    start === "$" ? "last" : Number.parseInt(start, 10),
    end === undefined ? undefined : end === "$" ? "end" : Number.parseInt(end, 10),
  );
}

function parseNlBodyNumberingAllFilePath(tokens: ReadonlyArray<string>): string | null {
  const [binary, ...args] = tokens;
  if (!binary || shellBasename(maybeUnquoteShellToken(binary)) !== "nl") {
    return null;
  }

  let numberingAllLines = false;
  let filePath: string | null = null;
  let index = 0;

  while (index < args.length) {
    const rawArg = args[index];
    if (!rawArg) {
      index += 1;
      continue;
    }

    if (rawArg === "--") {
      index += 1;
      break;
    }

    if (rawArg === "-ba") {
      numberingAllLines = true;
      index += 1;
      continue;
    }

    if (rawArg === "-b" || rawArg === "--body-numbering") {
      const nextArg = args[index + 1];
      if (!nextArg || maybeUnquoteShellToken(nextArg) !== "a") {
        return null;
      }
      numberingAllLines = true;
      index += 2;
      continue;
    }

    if (rawArg.startsWith("--body-numbering=")) {
      if (maybeUnquoteShellToken(rawArg.slice("--body-numbering=".length)) !== "a") {
        return null;
      }
      numberingAllLines = true;
      index += 1;
      continue;
    }

    if (rawArg.startsWith("-")) {
      return null;
    }

    if (filePath !== null) {
      return null;
    }

    filePath = maybeUnquoteShellToken(rawArg).trim();
    index += 1;
    break;
  }

  const remainingArgs = args.slice(index).map((entry) => maybeUnquoteShellToken(entry).trim());
  if (
    !numberingAllLines ||
    !filePath ||
    filePath.length === 0 ||
    remainingArgs.some((entry) => entry.length > 0)
  ) {
    return null;
  }

  return filePath;
}

function parseNumberedNlFileReadCommand(command: string): FileReadCommandMatch | null {
  const tokens = lexShellCommand(command).filter((token) => token.trim().length > 0);
  if (tokens.length < 6) {
    return null;
  }

  const operatorTokens = tokens.filter((token) => isShellOperatorToken(token));
  if (operatorTokens.length !== 1 || operatorTokens[0] !== "|") {
    return null;
  }

  const pipeIndex = tokens.indexOf("|");
  if (pipeIndex <= 0 || pipeIndex >= tokens.length - 1) {
    return null;
  }

  const leftTokens = tokens.slice(0, pipeIndex);
  const rightTokens = tokens.slice(pipeIndex + 1);

  const filePath = parseNlBodyNumberingAllFilePath(leftTokens);
  if (!filePath) {
    return null;
  }

  const [binary, ...args] = rightTokens;
  if (!binary || shellBasename(maybeUnquoteShellToken(binary)) !== "sed") {
    return null;
  }

  const sedCommand = parseSedPrintCommandArgs(args);
  if (!sedCommand || sedCommand.trailingArgs.length > 0) {
    return null;
  }

  const lineSummary = formatSedLineSummary(sedCommand.script);

  return {
    filePaths: [filePath],
    ...(lineSummary ? { lineSummary } : {}),
  };
}

function parseRipgrepFileReadCommand(command: string): FileReadCommandMatch | null {
  const tokens = lexShellCommand(command).filter((token) => token.trim().length > 0);
  if (tokens.length < 3) {
    return null;
  }

  if (tokens.some((token) => isShellOperatorToken(token))) {
    return null;
  }

  const [binary, ...args] = tokens;
  const executable = binary ? shellBasename(maybeUnquoteShellToken(binary)) : null;
  if (executable !== "rg" && executable !== "ripgrep") {
    return null;
  }

  let patternSeen = false;
  const filePaths: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const rawArg = args[index];
    if (!rawArg) {
      continue;
    }

    if (rawArg === "--") {
      const remaining = args.slice(index + 1).map(maybeUnquoteShellToken);
      if (!patternSeen) {
        if (remaining.length === 0) {
          return null;
        }
        patternSeen = true;
        filePaths.push(
          ...remaining
            .slice(1)
            .map((entry) => entry.trim())
            .filter(Boolean),
        );
      } else {
        filePaths.push(...remaining.map((entry) => entry.trim()).filter(Boolean));
      }
      break;
    }

    if (rawArg.startsWith("--")) {
      if (rawArg.startsWith("--regexp=")) {
        patternSeen = true;
        continue;
      }
      if (rawArg.includes("=")) {
        continue;
      }
      if (!RG_FLAGS_WITH_VALUE.has(rawArg)) {
        continue;
      }
      const nextArg = args[index + 1];
      if (!nextArg) {
        return null;
      }
      if (RG_PATTERN_FLAGS.has(rawArg)) {
        patternSeen = true;
      }
      index += 1;
      continue;
    }

    if (rawArg.startsWith("-") && rawArg !== "-") {
      if (rawArg.startsWith("-e") && rawArg.length > 2) {
        patternSeen = true;
        continue;
      }
      if (RG_FLAGS_WITH_VALUE.has(rawArg)) {
        const nextArg = args[index + 1];
        if (!nextArg) {
          return null;
        }
        if (RG_PATTERN_FLAGS.has(rawArg)) {
          patternSeen = true;
        }
        index += 1;
        continue;
      }
      continue;
    }

    const normalized = maybeUnquoteShellToken(rawArg).trim();
    if (normalized.length === 0) {
      continue;
    }

    if (!patternSeen) {
      patternSeen = true;
      continue;
    }

    filePaths.push(normalized);
  }

  if (!patternSeen || filePaths.length === 0) {
    return null;
  }

  return { filePaths };
}

export function detectFileReadCommand(command: string): FileReadCommandMatch | null {
  const displayCommand = displayCommandExecutionCommand(command).trim();
  if (displayCommand.length === 0) {
    return null;
  }

  return (
    parseSedFileReadCommand(displayCommand) ??
    parseNumberedNlFileReadCommand(displayCommand) ??
    parseRipgrepFileReadCommand(displayCommand)
  );
}

export function classifyCompactCommand(command: string): CompactCommandClassification {
  const searchSummary = deriveSearchCommandSummary(command);
  if (searchSummary) {
    return {
      kind: "search",
      summary: searchSummary,
    };
  }

  const fileReadMatch = detectFileReadCommand(command);
  if (fileReadMatch) {
    return {
      kind: "file-read",
      fileRead: fileReadMatch,
    };
  }

  return {
    kind: "other",
  };
}

function isSearchToolName(binary: string): boolean {
  return binary === "rg" || binary === "ripgrep" || binary === "grep" || binary === "ggrep";
}

function parseHeadStage(tokens: ReadonlyArray<string>): boolean {
  const [binary, ...args] = tokens;
  if (!binary || shellBasename(maybeUnquoteShellToken(binary)) !== "head") {
    return false;
  }

  if (args.length === 1 && /^-\d+$/.test(args[0] ?? "")) {
    return true;
  }

  if (args.length === 2 && args[0] === "-n" && /^\d+$/.test(args[1] ?? "")) {
    return true;
  }

  if (args.length === 1 && /^(?:--lines=)\d+$/.test(args[0] ?? "")) {
    return true;
  }

  return false;
}

function stripAllowedSearchPipeline(tokens: ReadonlyArray<string>): ReadonlyArray<string> | null {
  const operatorIndexes = tokens
    .map((token, index) => (isShellOperatorToken(token) ? index : -1))
    .filter((index) => index >= 0);

  if (operatorIndexes.length === 0) {
    return tokens;
  }

  if (operatorIndexes.length !== 1) {
    return null;
  }

  const pipeIndex = operatorIndexes[0];
  if (
    pipeIndex === undefined ||
    tokens[pipeIndex] !== "|" ||
    pipeIndex <= 0 ||
    pipeIndex >= tokens.length - 1
  ) {
    return null;
  }

  const baseTokens = tokens.slice(0, pipeIndex);
  const trailingTokens = tokens.slice(pipeIndex + 1);
  return parseHeadStage(trailingTokens) ? baseTokens : null;
}

function pushUnique(target: string[], seen: Set<string>, value: string) {
  const trimmed = value.trim();
  if (trimmed.length === 0 || seen.has(trimmed)) {
    return;
  }
  seen.add(trimmed);
  target.push(trimmed);
}

function parseSearchCommandArgs(
  args: ReadonlyArray<string>,
  config: SearchToolConfig,
): ParsedSearchCommand | null {
  const patterns: string[] = [];
  const seenPatterns = new Set<string>();
  const targets: string[] = [];
  const seenTargets = new Set<string>();
  let positionalPattern: string | null = null;
  let collectTargets = false;

  for (let index = 0; index < args.length; index += 1) {
    const rawArg = args[index];
    if (!rawArg) {
      continue;
    }

    if (collectTargets) {
      pushUnique(targets, seenTargets, maybeUnquoteShellToken(rawArg));
      continue;
    }

    if (rawArg === "--") {
      collectTargets = true;
      continue;
    }

    if (rawArg.startsWith("--")) {
      const longFlag = rawArg.includes("=") ? rawArg.slice(0, rawArg.indexOf("=")) : rawArg;
      if (config.rejectFlags?.has(longFlag)) {
        return null;
      }

      if (rawArg.includes("=")) {
        const separatorIndex = rawArg.indexOf("=");
        const flag = rawArg.slice(0, separatorIndex);
        const value = rawArg.slice(separatorIndex + 1);
        if (config.patternFlags.has(flag)) {
          pushUnique(patterns, seenPatterns, maybeUnquoteShellToken(value));
        }
        continue;
      }

      if (config.flagsWithValue.has(rawArg)) {
        const nextArg = args[index + 1];
        if (!nextArg) {
          return null;
        }
        if (config.patternFlags.has(rawArg)) {
          pushUnique(patterns, seenPatterns, maybeUnquoteShellToken(nextArg));
        }
        index += 1;
        continue;
      }

      continue;
    }

    if (rawArg.startsWith("-") && rawArg !== "-") {
      const shortFlag = rawArg.slice(0, 2);
      if (config.patternFlags.has(shortFlag)) {
        if (rawArg.length > 2) {
          pushUnique(patterns, seenPatterns, maybeUnquoteShellToken(rawArg.slice(2)));
          continue;
        }
        const nextArg = args[index + 1];
        if (!nextArg) {
          return null;
        }
        pushUnique(patterns, seenPatterns, maybeUnquoteShellToken(nextArg));
        index += 1;
        continue;
      }

      if (config.flagsWithValue.has(shortFlag) && rawArg.length === 2) {
        const nextArg = args[index + 1];
        if (!nextArg) {
          return null;
        }
        index += 1;
      }

      continue;
    }

    const normalized = maybeUnquoteShellToken(rawArg).trim();
    if (normalized.length === 0) {
      continue;
    }

    if (patterns.length === 0 && positionalPattern === null) {
      positionalPattern = normalized;
      continue;
    }

    pushUnique(targets, seenTargets, normalized);
  }

  const resolvedPatterns =
    patterns.length > 0 ? patterns : positionalPattern ? [positionalPattern] : [];
  if (resolvedPatterns.length === 0) {
    return null;
  }

  return {
    patterns: resolvedPatterns,
    targets: targets.length > 0 ? targets : ["workspace"],
  };
}

function parseGitGrepSearchCommand(tokens: ReadonlyArray<string>): ParsedSearchCommand | null {
  if (tokens.length < 2) {
    return null;
  }

  const [binary, subcommand, ...args] = tokens;
  if (!binary || shellBasename(maybeUnquoteShellToken(binary)) !== "git") {
    return null;
  }
  if (!subcommand || maybeUnquoteShellToken(subcommand) !== "grep") {
    return null;
  }

  return parseSearchCommandArgs(args, {
    flagsWithValue: GIT_GREP_FLAGS_WITH_VALUE,
    patternFlags: GIT_GREP_PATTERN_FLAGS,
    rejectFlags: GIT_GREP_REJECT_FLAGS,
  });
}

function parseFindSearchCommand(tokens: ReadonlyArray<string>): ParsedSearchCommand | null {
  if (tokens.length < 2) {
    return null;
  }

  const [binary, ...args] = tokens;
  if (!binary || shellBasename(maybeUnquoteShellToken(binary)) !== "find") {
    return null;
  }

  const targets: string[] = [];
  const seenTargets = new Set<string>();
  const patterns: string[] = [];
  const seenPatterns = new Set<string>();
  let scanningTargets = true;

  for (let index = 0; index < args.length; index += 1) {
    const rawArg = args[index];
    if (!rawArg) {
      continue;
    }

    if (rawArg === "--") {
      scanningTargets = false;
      continue;
    }

    if (
      rawArg === "(" ||
      rawArg === ")" ||
      rawArg === "!" ||
      rawArg === "," ||
      rawArg === "-o" ||
      rawArg === "-or" ||
      rawArg === "-a" ||
      rawArg === "-and"
    ) {
      scanningTargets = false;
      continue;
    }

    if (rawArg.startsWith("-")) {
      scanningTargets = false;
      const separatorIndex = rawArg.indexOf("=");
      const flag = separatorIndex >= 0 ? rawArg.slice(0, separatorIndex) : rawArg;

      if (FIND_PATTERN_FLAGS.has(flag)) {
        const value = separatorIndex >= 0 ? rawArg.slice(separatorIndex + 1) : args[index + 1];
        if (!value) {
          return null;
        }
        pushUnique(patterns, seenPatterns, maybeUnquoteShellToken(value));
        if (separatorIndex < 0) {
          index += 1;
        }
        continue;
      }

      if (FIND_FLAGS_WITH_VALUE.has(flag) && separatorIndex < 0) {
        const nextArg = args[index + 1];
        if (!nextArg) {
          return null;
        }
        index += 1;
      }
      continue;
    }

    const normalized = maybeUnquoteShellToken(rawArg).trim();
    if (normalized.length === 0) {
      continue;
    }

    if (scanningTargets) {
      pushUnique(targets, seenTargets, normalized);
    }
  }

  if (patterns.length === 0) {
    return null;
  }

  return {
    patterns,
    targets: targets.length > 0 ? targets : ["workspace"],
  };
}

function parseFdSearchCommand(tokens: ReadonlyArray<string>): ParsedSearchCommand | null {
  if (tokens.length < 2) {
    return null;
  }

  const [binary, ...args] = tokens;
  const executable = binary ? shellBasename(maybeUnquoteShellToken(binary)) : null;
  if (executable !== "fd" && executable !== "fdfind") {
    return null;
  }

  let pattern: string | null = null;
  const targets: string[] = [];
  const seenTargets = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const rawArg = args[index];
    if (!rawArg) {
      continue;
    }

    if (rawArg === "--") {
      const remaining = args
        .slice(index + 1)
        .map((entry) => maybeUnquoteShellToken(entry).trim())
        .filter((entry) => entry.length > 0);
      if (pattern === null) {
        const [nextPattern, ...remainingTargets] = remaining;
        if (!nextPattern) {
          return null;
        }
        pattern = nextPattern;
        for (const target of remainingTargets) {
          pushUnique(targets, seenTargets, target);
        }
      } else {
        for (const target of remaining) {
          pushUnique(targets, seenTargets, target);
        }
      }
      break;
    }

    if (rawArg.startsWith("--")) {
      const separatorIndex = rawArg.indexOf("=");
      const flag = separatorIndex >= 0 ? rawArg.slice(0, separatorIndex) : rawArg;
      if (FD_FLAGS_WITH_VALUE.has(flag) && separatorIndex < 0) {
        const nextArg = args[index + 1];
        if (!nextArg) {
          return null;
        }
        index += 1;
      }
      continue;
    }

    if (rawArg.startsWith("-") && rawArg !== "-") {
      const shortFlag = rawArg.slice(0, 2);
      if (FD_FLAGS_WITH_VALUE.has(shortFlag) && rawArg.length === 2) {
        const nextArg = args[index + 1];
        if (!nextArg) {
          return null;
        }
        index += 1;
      }
      continue;
    }

    const normalized = maybeUnquoteShellToken(rawArg).trim();
    if (normalized.length === 0) {
      continue;
    }

    if (pattern === null) {
      pattern = normalized;
      continue;
    }

    pushUnique(targets, seenTargets, normalized);
  }

  if (!pattern) {
    return null;
  }

  return {
    patterns: [pattern],
    targets: targets.length > 0 ? targets : ["workspace"],
  };
}

function parseSearchCommand(command: string): ParsedSearchCommand | null {
  const rawTokens = lexShellCommand(command).filter((token) => token.trim().length > 0);
  if (rawTokens.length < 2) {
    return null;
  }

  const tokens = stripAllowedSearchPipeline(rawTokens);
  if (!tokens || tokens.length < 2) {
    return null;
  }
  if (tokens.some((token) => isCommandSubstitutionToken(token))) {
    return null;
  }

  const executable = shellBasename(maybeUnquoteShellToken(tokens[0] ?? ""));
  if (isSearchToolName(executable)) {
    const config =
      executable === "rg" || executable === "ripgrep"
        ? {
            flagsWithValue: RG_FLAGS_WITH_VALUE,
            patternFlags: RG_PATTERN_FLAGS,
            rejectFlags: RG_REJECT_FLAGS,
          }
        : {
            flagsWithValue: GREP_FLAGS_WITH_VALUE,
            patternFlags: GREP_PATTERN_FLAGS,
            rejectFlags: GREP_REJECT_FLAGS,
          };
    return parseSearchCommandArgs(tokens.slice(1), config);
  }

  return (
    parseGitGrepSearchCommand(tokens) ??
    parseFindSearchCommand(tokens) ??
    parseFdSearchCommand(tokens)
  );
}

function decodeSimpleLiteralPatternSegment(segment: string): string | null {
  let decoded = "";

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (!char) {
      break;
    }

    if (char === "\\") {
      const nextChar = segment[index + 1];
      if (!nextChar || !SIMPLE_LITERAL_ESCAPE_CHARS.has(nextChar)) {
        return null;
      }
      decoded += nextChar;
      index += 1;
      continue;
    }

    if (char === "|" || SIMPLE_REGEX_META_CHARS.has(char)) {
      return null;
    }

    decoded += char;
  }

  const trimmed = decoded.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function expandLiteralAlternationPattern(pattern: string): ReadonlyArray<string> | null {
  const segments: string[] = [];
  let current = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (!char) {
      break;
    }

    if (char === "\\") {
      const nextChar = pattern[index + 1];
      if (!nextChar) {
        return null;
      }
      current += `${char}${nextChar}`;
      index += 1;
      continue;
    }

    if (char === "|") {
      const decoded = decodeSimpleLiteralPatternSegment(current);
      if (!decoded) {
        return null;
      }
      segments.push(decoded);
      current = "";
      continue;
    }

    current += char;
  }

  const decoded = decodeSimpleLiteralPatternSegment(current);
  if (!decoded) {
    return null;
  }
  segments.push(decoded);
  return segments.length > 0 ? segments : null;
}

function summarizePattern(pattern: string): ReadonlyArray<string> {
  const literalSegments = expandLiteralAlternationPattern(pattern.trim());
  if (literalSegments) {
    return literalSegments;
  }

  const trimmed = pattern.trim();
  if (trimmed.length <= SEARCH_SUMMARY_PATTERN_PREVIEW_LIMIT) {
    return trimmed.length > 0 ? [trimmed] : [];
  }

  return [`${trimmed.slice(0, SEARCH_SUMMARY_PATTERN_PREVIEW_LIMIT - 1).trimEnd()}…`];
}

function summarizeList(values: ReadonlyArray<string>, limit: number): string {
  if (values.length <= limit) {
    return values.join(", ");
  }
  return `${values.slice(0, limit).join(", ")}, …`;
}

function buildSearchSummary(match: SearchSummaryMatch): string {
  return `Searching ${summarizeList(match.targets, SEARCH_SUMMARY_TARGET_LIMIT)} for ${summarizeList(
    match.patterns,
    SEARCH_SUMMARY_PATTERN_LIMIT,
  )}`;
}

export function deriveSearchSummaryFromPatternsAndTargets(
  input: SearchSummaryInput,
): string | null {
  const patterns: string[] = [];
  const seenPatterns = new Set<string>();
  for (const pattern of input.patterns) {
    pushUnique(patterns, seenPatterns, pattern);
  }
  const expandedPatterns = patterns.flatMap((pattern) => summarizePattern(pattern));
  if (expandedPatterns.length === 0) {
    return null;
  }

  const targets: string[] = [];
  const seenTargets = new Set<string>();
  for (const target of input.targets ?? []) {
    pushUnique(targets, seenTargets, target);
  }

  return buildSearchSummary({
    targets: targets.length > 0 ? targets : ["workspace"],
    patterns: expandedPatterns,
  });
}

function summarizeSearchMatch(command: string): SearchSummaryMatch | null {
  const parsed = parseSearchCommand(command);
  if (!parsed) {
    return null;
  }

  const expandedPatterns = parsed.patterns.flatMap((pattern) => summarizePattern(pattern));
  if (expandedPatterns.length === 0) {
    return null;
  }

  return {
    targets: parsed.targets,
    patterns: expandedPatterns,
  };
}

export function deriveSearchCommandSummary(command: string): string | null {
  const normalizedCommand =
    extractCommandToolSummaryPayload(command) ?? displayCommandExecutionCommand(command);
  const match = summarizeSearchMatch(normalizedCommand.trim());
  return match ? deriveSearchSummaryFromPatternsAndTargets(match) : null;
}

function normalizeNarratedPath(value: string): string | null {
  let normalized = value.trim();
  if (
    normalized.length >= 2 &&
    ((normalized.startsWith("`") && normalized.endsWith("`")) ||
      (normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }

  if (normalized.length === 0) {
    return null;
  }

  const looksPathLike =
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized.startsWith("~") ||
    normalized.startsWith(".") ||
    normalized.includes(".") ||
    normalized.includes("_") ||
    normalized.includes("-") ||
    /^[A-Za-z]:[\\/]/.test(normalized) ||
    !/\s/.test(normalized);

  return looksPathLike ? normalized : null;
}

function normalizeNarratedLineSummary(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function deriveReadingDetailDisplayHints(detail: string): ActivityDisplayHints | null {
  const match = /^Reading\s+(?<rest>.+)$/i.exec(detail.trim());
  const rest = match?.groups?.rest?.trim();
  if (!rest) {
    return null;
  }

  const prefixedRangeMatch =
    /^lines?\s+(?<start>\d+)(?:\s*-\s*(?<end>\d+|end))?\s+of\s+(?<path>.+)$/i.exec(rest);
  if (prefixedRangeMatch?.groups?.start && prefixedRangeMatch.groups.path) {
    const path = normalizeNarratedPath(prefixedRangeMatch.groups.path);
    if (!path) {
      return null;
    }
    const startLine = Number.parseInt(prefixedRangeMatch.groups.start, 10);
    const endGroup = prefixedRangeMatch.groups.end;
    const endLine =
      endGroup === undefined
        ? undefined
        : endGroup.toLowerCase() === "end"
          ? -1
          : Number.parseInt(endGroup, 10);
    const lineSummary = formatLineRangeSummary({
      startLine,
      ...(endLine !== undefined ? { endLine } : {}),
    });
    return {
      readPaths: [path],
      ...(lineSummary ? { lineSummary } : {}),
    };
  }

  const parenthesizedRangeMatch =
    /^(?<path>.+?)\s+\((?<summary>line \d+|lines \d+-\d+|lines \d+-end|last line)\)$/i.exec(rest);
  if (parenthesizedRangeMatch?.groups?.path && parenthesizedRangeMatch.groups.summary) {
    const path = normalizeNarratedPath(parenthesizedRangeMatch.groups.path);
    const lineSummary = normalizeNarratedLineSummary(parenthesizedRangeMatch.groups.summary);
    if (!path) {
      return null;
    }
    return {
      readPaths: [path],
      ...(lineSummary ? { lineSummary } : {}),
    };
  }

  const suffixedRangeMatch = /^(?<path>.+?):(?<start>\d+)(?:-(?<end>\d+))?$/i.exec(rest);
  if (suffixedRangeMatch?.groups?.path && suffixedRangeMatch.groups.start) {
    const path = normalizeNarratedPath(suffixedRangeMatch.groups.path);
    if (!path) {
      return null;
    }
    const startLine = Number.parseInt(suffixedRangeMatch.groups.start, 10);
    const endLine = suffixedRangeMatch.groups.end
      ? Number.parseInt(suffixedRangeMatch.groups.end, 10)
      : undefined;
    const lineSummary = formatLineRangeSummary({
      startLine,
      ...(endLine !== undefined ? { endLine } : {}),
    });
    return {
      readPaths: [path],
      ...(lineSummary ? { lineSummary } : {}),
    };
  }

  const path = normalizeNarratedPath(rest);
  return path ? { readPaths: [path] } : null;
}

export function deriveNarratedActivityDisplayHints(detail: string): ActivityDisplayHints | null {
  const trimmed = detail.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (/^Searching\s+/i.test(trimmed)) {
    return {
      searchSummary: trimmed,
    };
  }

  const runningMatch = /^Running\s+(?<command>.+)$/i.exec(trimmed);
  if (runningMatch?.groups?.command) {
    const commandClassification = classifyCompactCommand(runningMatch.groups.command);
    if (commandClassification.kind === "search") {
      return {
        searchSummary: commandClassification.summary,
      };
    }
    if (commandClassification.kind === "file-read") {
      return {
        readPaths: commandClassification.fileRead.filePaths,
        ...(commandClassification.fileRead.lineSummary
          ? { lineSummary: commandClassification.fileRead.lineSummary }
          : {}),
      };
    }
  }

  return deriveReadingDetailDisplayHints(trimmed);
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function readShellWord(command: string, start: number): string {
  let index = start;
  let quote: '"' | "'" | null = null;

  while (index < command.length) {
    const char = command[index];
    if (!char) {
      break;
    }

    if (quote === null) {
      if (isWhitespace(char)) {
        break;
      }
      if (SHELL_TOKEN_OPERATORS.some((operator) => command.startsWith(operator, index))) {
        break;
      }
      if (char === "'" || char === '"') {
        quote = char;
        index += 1;
        continue;
      }
      if (char === "\\") {
        index += Math.min(2, command.length - index);
        continue;
      }
      index += 1;
      continue;
    }

    if (char === quote) {
      quote = null;
      index += 1;
      continue;
    }
    if (quote === '"' && char === "\\") {
      index += Math.min(2, command.length - index);
      continue;
    }
    index += 1;
  }

  return command.slice(start, index);
}

export function lexShellCommand(command: string): ReadonlyArray<string> {
  const tokens: string[] = [];
  let index = 0;

  while (index < command.length) {
    const char = command[index];
    if (!char) {
      break;
    }

    if (isWhitespace(char)) {
      const start = index;
      while (index < command.length && isWhitespace(command[index] ?? "")) {
        index += 1;
      }
      tokens.push(command.slice(start, index));
      continue;
    }

    const operator = SHELL_TOKEN_OPERATORS.find((candidate) =>
      command.startsWith(candidate, index),
    );
    if (operator) {
      tokens.push(operator);
      index += operator.length;
      continue;
    }

    const word = readShellWord(command, index);
    if (word.length === 0) {
      tokens.push(char);
      index += 1;
      continue;
    }
    tokens.push(word);
    index += word.length;
  }

  return tokens;
}

export function isShellOperatorToken(token: string): boolean {
  return SHELL_TOKEN_OPERATORS.includes(token as (typeof SHELL_TOKEN_OPERATORS)[number]);
}

export function isShellCommandSeparatorToken(token: string): boolean {
  return SHELL_COMMAND_SEPARATORS.has(token);
}
