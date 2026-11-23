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

export type CommandExecutionBackgroundStatus = "running" | "completed" | "failed" | "stopped";

export interface ParsedCommandExecutionTitle {
  readonly baseTitle: string;
  readonly backgroundStatus: CommandExecutionBackgroundStatus | null;
}

// Claude retitles backgrounded tools as "<title> — <status>" (see the Claude
// adapter's backgroundToolTitle); the suffix is the only stored background marker.
const BACKGROUND_TITLE_PATTERN = /^(.*\S)\s+—\s+(running|completed|failed|stopped)$/s;

export function parseCommandExecutionTitle(title: string): ParsedCommandExecutionTitle {
  const trimmed = title.trim();
  const match = BACKGROUND_TITLE_PATTERN.exec(trimmed);
  if (!match?.[1] || !match[2]) {
    return { baseTitle: trimmed, backgroundStatus: null };
  }
  return {
    baseTitle: match[1],
    backgroundStatus: match[2] as CommandExecutionBackgroundStatus,
  };
}

export function commandExecutionBackgroundStatus(
  execution: Pick<ComparableCommandExecutionLike, "title">,
): CommandExecutionBackgroundStatus | null {
  return execution.title ? parseCommandExecutionTitle(execution.title).backgroundStatus : null;
}

export function isGenericCommandTitle(title: string): boolean {
  return /^(?:ran|running) command$|^command run$/i.test(
    parseCommandExecutionTitle(title).baseTitle,
  );
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

// Codex can serialize a single argv value as adjacent single/double-quoted
// fragments. Decode only that complete transport form, never PowerShell escapes.
function unwrapQuotedCommandFragments(value: string): string | null {
  let offset = 0;
  let fragments = 0;
  let result = "";
  while (offset < value.length) {
    const quote = value[offset++];
    if (quote !== "'" && quote !== '"') return null;
    let closed = false;
    while (offset < value.length) {
      const char = value[offset++];
      if (char === quote) {
        closed = true;
        break;
      }
      if (quote === '"' && char === "\\" && /["\\$`]/.test(value[offset] ?? "")) {
        result += value[offset++];
      } else {
        result += char;
      }
    }
    if (!closed) return null;
    fragments += 1;
  }
  return fragments > 1 ? result : null;
}

function displayPowerShellCommand(command: string): string | null {
  const match =
    /^(?:"(?<doubleQuotedShell>[^"]+)"|'(?<singleQuotedShell>[^']+)'|(?<shell>[^\s"']+))\s+(?<args>.+)$/s.exec(
      command.trim(),
    );
  const shell =
    match?.groups?.doubleQuotedShell ?? match?.groups?.singleQuotedShell ?? match?.groups?.shell;
  const args = match?.groups?.args;
  if (!shell || !args || !/^(?:powershell|pwsh)(?:\.exe)?$/i.test(shellBasename(shell))) {
    return null;
  }

  const invocation =
    /^(?:(?:-NoLogo|-NoProfile|-NonInteractive)\s+|-ExecutionPolicy\s+(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s\-"']+)\s+)*-(?:Command|c)\s+(?<body>.+)$/is.exec(
      args,
    );
  const body = invocation?.groups?.body?.trim();
  if (!body || body === "-") {
    return null;
  }

  // Provider command strings already contain the script text. Only remove its
  // enclosing quotes: POSIX unescaping would corrupt Windows paths and scripts.
  if (body.startsWith("'") || body.startsWith('"')) {
    const fragments = unwrapQuotedCommandFragments(body);
    if (fragments !== null) return fragments || null;
    return isQuotedToken(body) && body.length > 2 ? body.slice(1, -1) : null;
  }
  return body;
}

export function displayCommandExecutionCommand(command: string): string {
  const powerShellCommand = displayPowerShellCommand(command);
  if (powerShellCommand !== null) {
    return powerShellCommand;
  }
  const windows = /^(?:"([^"]+)"|'([^']+)'|(\S+))\s+(.+)$/s.exec(command.trim());
  const executable = windows?.[1] ?? windows?.[2] ?? windows?.[3];
  if (executable && /^cmd(?:\.exe)?$/i.test(shellBasename(executable))) {
    const tokens = lexShellCommand(windows![4]!).filter((token) => token.trim().length > 0);
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (token.toLowerCase() === "/c") {
        // Keep launchers with positional arguments or shell operators intact.
        if (index === tokens.length - 2) {
          const script = tokens[index + 1]!;
          if (isShellOperatorToken(script)) break;
          return isQuotedToken(script) ? script.slice(1, -1) || command : script;
        }
        break;
      }
      if (!token.startsWith("/")) break;
    }
    return command;
  }
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
  const payload = extractCommandToolSummaryPayload(detail);
  return payload === null ? detail : displayCommandExecutionCommand(payload);
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
      return displayCommandExecutionCommand(detailSummary);
    }
  }

  return displayCommandExecutionCommand(
    extractCommandToolSummaryPayload(execution.command) ?? execution.command,
  );
}

export function resolveCommandExecutionSummaryText(
  execution: Pick<ComparableCommandExecutionLike, "command" | "detail" | "title">,
): string {
  const displayCommand = resolveCommandExecutionDisplayCommand(execution);
  const baseTitle = execution.title ? parseCommandExecutionTitle(execution.title).baseTitle : null;
  if (
    baseTitle &&
    baseTitle !== execution.command &&
    baseTitle !== displayCommand &&
    !isGenericCommandTitle(baseTitle)
  ) {
    return baseTitle;
  }
  return deriveSearchCommandSummary(displayCommand) ?? displayCommand;
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
): { script: string; trailingArgs: string[]; quiet: boolean } | null {
  let script: string | null = null;
  let quiet = false;
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
      quiet = true;
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
    quiet,
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

// Header labels for command cards whose provider sends no description (Codex,
// Cursor, OpenCode, Pi). They say what a command does, never why it ran, and stay
// null for anything unrecognized rather than restating the command.
const MAX_COMMAND_LABELS = 2;
const COMMAND_LABEL_SETUP_PROGRAMS = new Set([
  "cd",
  "pushd",
  "popd",
  "export",
  "unset",
  "set",
  "source",
  ".",
  "true",
  "echo",
  "printf",
]);
const COMMAND_LABEL_REDIRECTIONS_WITH_TARGET = new Set([
  ">",
  ">>",
  "1>",
  "2>",
  "1>>",
  "2>>",
  "&>",
  "&>>",
  "<",
  "<<",
]);
const COMMAND_LABEL_WRAPPER_FLAGS_WITH_VALUE = new Map<string, ReadonlySet<string>>([
  ["env", new Set(["-u", "--unset", "-C", "--chdir"])],
  ["time", new Set(["-f", "--format", "-o", "--output"])],
  ["timeout", new Set(["-s", "--signal", "-k", "--kill-after"])],
  ["sudo", new Set(["-u", "--user", "-g", "--group"])],
  ["nice", new Set(["-n", "--adjustment"])],
  ["npx", new Set(["-p", "--package"])],
  ["bunx", new Set(["-p", "--package"])],
]);
const COMMAND_LABEL_TWO_WORD_WRAPPERS = new Set([
  "bun x",
  "npm exec",
  "pnpm exec",
  "pnpm dlx",
  "yarn exec",
  "yarn dlx",
  "uv run",
]);
const NO_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set();
const PACKAGE_MANAGER_FLAGS_WITH_VALUE = new Set([
  "--cwd",
  "--filter",
  "-F",
  "--prefix",
  "-C",
  "--dir",
  "--workspace",
  "--config",
]);
const CARGO_FLAGS_WITH_VALUE = new Set(["-C", "-Z", "--config", "--color"]);
const GIT_FLAGS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const GH_FLAGS_WITH_VALUE = new Set(["-R", "--repo"]);
const MAKE_FLAGS_WITH_VALUE = new Set(["-C", "-f", "--directory", "--file", "--makefile"]);
const SCRIPT_RUNNER_FLAGS_WITH_VALUE = new Set(["-r", "--require", "--import", "--loader"]);
const SCRIPT_RUNNER_INLINE_FLAGS = new Set(["-c", "-e", "--eval", "-p", "--print"]);
const CARGO_SUBCOMMAND_LABELS = new Map([
  ["test", "Run tests"],
  ["fmt", "Format code"],
  ["clippy", "Lint"],
  ["check", "Check build"],
  ["build", "Build"],
  ["run", "Run binary"],
]);
const GIT_SUBCOMMAND_LABELS = new Map([
  ["status", "Git status"],
  ["diff", "Show diff"],
  ["log", "Show git log"],
  ["show", "Show commit"],
  ["add", "Stage changes"],
  ["commit", "Commit"],
  ["push", "Push"],
  ["pull", "Pull"],
  ["fetch", "Fetch"],
  ["checkout", "Switch branch"],
  ["switch", "Switch branch"],
  ["stash", "Stash changes"],
  ["rebase", "Rebase"],
  ["merge", "Merge"],
  ["worktree", "Manage worktrees"],
]);
const GH_COMMAND_LABELS = new Map([
  ["pr checks", "Check PR CI"],
  ["pr view", "View PR"],
  ["pr diff", "Show PR diff"],
  ["pr list", "List PRs"],
  ["pr create", "Create PR"],
  ["run view", "Inspect CI run"],
  ["run list", "List CI runs"],
  ["run watch", "Watch CI run"],
]);

interface CommandLabelSegment {
  readonly rawWords: ReadonlyArray<string>;
  readonly words: ReadonlyArray<string>;
}

function splitCommandLabelSegments(command: string): ReadonlyArray<CommandLabelSegment> {
  const segments: CommandLabelSegment[] = [];
  let rawWords: string[] = [];
  let skipNextWord = false;
  let inComment = false;
  const flush = () => {
    if (rawWords.length > 0) {
      segments.push({ rawWords, words: rawWords.map(maybeUnquoteShellToken) });
    }
    rawWords = [];
    skipNextWord = false;
    inComment = false;
  };

  for (const token of lexShellCommand(command)) {
    if (token.trim().length === 0) {
      if (token.includes("\n")) flush();
      continue;
    }
    if (inComment) continue;
    if (isShellCommandSeparatorToken(token)) {
      flush();
      continue;
    }
    if (COMMAND_LABEL_REDIRECTIONS_WITH_TARGET.has(token)) {
      skipNextWord = true;
      continue;
    }
    if (isShellOperatorToken(token) || /^\\\s+$/.test(token)) continue;
    if (skipNextWord) {
      skipNextWord = false;
      continue;
    }
    if (token.startsWith("#")) {
      inComment = true;
      continue;
    }
    rawWords.push(token);
  }
  flush();
  return segments;
}

function commandLabelProgram(word: string): string {
  return shellBasename(word)
    .toLowerCase()
    .replace(/\.exe$/, "");
}

function commandLabelPathBasename(path: string): string {
  return shellBasename(path.replace(/[\\/]+$/, "")) || path;
}

function skipLeadingFlags(
  words: ReadonlyArray<string>,
  start: number,
  flagsWithValue: ReadonlySet<string>,
): number {
  let index = start;
  while (index < words.length) {
    const word = words[index] ?? "";
    if (word === "--") return index + 1;
    if (!word.startsWith("-")) return index;
    index += flagsWithValue.has(word) ? 2 : 1;
  }
  return index;
}

/** Index of the first word after env assignments and wrappers like `env`, `timeout 5`. */
function commandLabelProgramIndex(words: ReadonlyArray<string>): number {
  let index = 0;
  while (index < words.length) {
    const word = words[index] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      index += 1;
      continue;
    }
    const program = commandLabelProgram(word);
    const next = words[index + 1];
    if (next !== undefined && COMMAND_LABEL_TWO_WORD_WRAPPERS.has(`${program} ${next}`)) {
      index = skipLeadingFlags(words, index + 2, NO_FLAGS_WITH_VALUE);
      continue;
    }
    const wrapperFlags = COMMAND_LABEL_WRAPPER_FLAGS_WITH_VALUE.get(program);
    if (!wrapperFlags) return index;
    index = skipLeadingFlags(words, index + 1, wrapperFlags);
    if (program === "timeout") index += 1;
  }
  return index;
}

function positionalArgs(
  args: ReadonlyArray<string>,
  flagsWithValue: ReadonlySet<string> = NO_FLAGS_WITH_VALUE,
): ReadonlyArray<string> {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") break;
    if (arg.startsWith("-")) {
      if (flagsWithValue.has(arg)) index += 1;
      continue;
    }
    positionals.push(arg);
  }
  return positionals;
}

function isScriptFilePath(value: string): boolean {
  return /[\\/]/.test(value) || /\.(?:[cm]?[jt]sx?|sh|py)$/i.test(value);
}

function labelPackageScript(script: string): string | null {
  if (isScriptFilePath(script)) return `Run ${commandLabelPathBasename(script)}`;
  if (!/^[\w@:.-]+$/.test(script)) return null;
  const name = script.toLowerCase();
  if (name === "test" || name.startsWith("test:")) return "Run tests";
  if (name === "typecheck" || name.startsWith("typecheck:") || name === "tsc") return "Typecheck";
  if (name.startsWith("lint")) return "Lint";
  if (name === "fmt" || name.startsWith("fmt:") || name.startsWith("format")) return "Format code";
  if (name.startsWith("build")) return "Build";
  if (name === "dev" || name === "start") return "Start dev server";
  return `Run ${script}`;
}

function labelPackageManagerCommand(program: string, args: ReadonlyArray<string>): string | null {
  if (program === "yarn" && args.length === 0) return "Install dependencies";
  const [first, second] = positionalArgs(args, PACKAGE_MANAGER_FLAGS_WITH_VALUE);
  if (first === undefined) return null;
  switch (first) {
    case "run":
    case "run-script":
      return second ? labelPackageScript(second) : null;
    case "install":
    case "i":
    case "ci":
      return "Install dependencies";
    case "add":
      return second ? `Add ${second}` : null;
    case "remove":
    case "rm":
    case "uninstall":
      return second ? `Remove ${second}` : null;
    case "test":
    case "t":
      return "Run tests";
  }
  if (program === "npm") return first === "start" ? "Start dev server" : null;
  return labelPackageScript(first);
}

function labelFetchCommand(args: ReadonlyArray<string>): string {
  const url = args.find((arg) => /^https?:\/\//i.test(arg));
  if (url) {
    try {
      return `Fetch ${new URL(url).host}`;
    } catch {
      // Fall through to the generic label for unparseable URLs.
    }
  }
  return "Fetch URL";
}

function labelScriptRunnerCommand(program: string, args: ReadonlyArray<string>): string | null {
  if (args.some((arg) => SCRIPT_RUNNER_INLINE_FLAGS.has(arg))) return null;
  const moduleIndex = args.indexOf("-m");
  if (moduleIndex >= 0) {
    const moduleName = args[moduleIndex + 1];
    if (!moduleName) return null;
    return moduleName === "pytest" ? "Run tests" : `Run ${moduleName}`;
  }
  const positionals = positionalArgs(args, SCRIPT_RUNNER_FLAGS_WITH_VALUE);
  if (program === "deno") {
    if (positionals[0] === "test") return "Run tests";
    if (positionals[0] === "run") {
      return positionals[1] ? `Run ${commandLabelPathBasename(positionals[1])}` : null;
    }
  }
  return positionals[0] ? `Run ${commandLabelPathBasename(positionals[0])}` : null;
}

function labelCommandWords(words: ReadonlyArray<string>): string | null {
  const [first, ...args] = words;
  if (first === undefined) return null;
  const program = commandLabelProgram(first);
  switch (program) {
    case "bun":
    case "npm":
    case "pnpm":
    case "yarn":
      return labelPackageManagerCommand(program, args);
    case "vitest":
    case "jest":
    case "pytest":
      return "Run tests";
    case "tsc":
      return "Typecheck";
    case "eslint":
    case "oxlint":
      return "Lint";
    case "prettier":
    case "oxfmt":
    case "gofmt":
    case "rustfmt":
      return "Format code";
    case "biome": {
      const subcommand = positionalArgs(args)[0];
      return subcommand === "lint" ? "Lint" : subcommand === "format" ? "Format code" : null;
    }
    case "go":
      return positionalArgs(args)[0] === "test" ? "Run tests" : null;
    case "cargo": {
      const subcommand = positionalArgs(args, CARGO_FLAGS_WITH_VALUE).find(
        (arg) => !arg.startsWith("+"),
      );
      return subcommand ? (CARGO_SUBCOMMAND_LABELS.get(subcommand) ?? null) : null;
    }
    case "git": {
      const subcommand = positionalArgs(args, GIT_FLAGS_WITH_VALUE)[0];
      if (!subcommand || !/^[a-z][a-z-]*$/.test(subcommand)) return null;
      return GIT_SUBCOMMAND_LABELS.get(subcommand) ?? `Run git ${subcommand}`;
    }
    case "gh": {
      const [area, action] = positionalArgs(args, GH_FLAGS_WITH_VALUE);
      if (area === "api") return "Call GitHub API";
      if (area === "issue") return "View issue";
      return area && action ? (GH_COMMAND_LABELS.get(`${area} ${action}`) ?? null) : null;
    }
    case "ls":
    case "tree":
      return "List files";
    case "find":
      return "Find files";
    case "mkdir":
      return "Create directory";
    case "rm":
      return "Delete files";
    case "mv":
      return "Move files";
    case "cp":
      return "Copy files";
    case "chmod":
      return "Change permissions";
    case "curl":
    case "wget":
      return labelFetchCommand(args);
    case "make": {
      const target = positionalArgs(args, MAKE_FLAGS_WITH_VALUE).find((arg) => !arg.includes("="));
      return target ? `Make ${target}` : "Make";
    }
    case "sleep":
      return "Wait";
    case "ps":
    case "pgrep":
      return "List processes";
    case "kill":
    case "pkill":
      return "Stop process";
    case "which": {
      const name = positionalArgs(args)[0];
      return name ? `Locate ${name}` : null;
    }
    case "command":
      return (args[0] === "-v" || args[0] === "-V") && args[1] ? `Locate ${args[1]}` : null;
    case "node":
    case "python":
    case "python3":
    case "deno":
    case "tsx":
      return labelScriptRunnerCommand(program, args);
    default:
      return null;
  }
}

function labelReadOrSearchCommand(command: string): string | null {
  const searchSummary = deriveSearchCommandSummary(command);
  if (searchSummary) return searchSummary;
  const fileRead = detectFileReadCommand(command);
  if (!fileRead) return null;
  const [onlyPath] = fileRead.filePaths;
  return fileRead.filePaths.length === 1 && onlyPath
    ? `Read ${commandLabelPathBasename(onlyPath)}`
    : `Read ${fileRead.filePaths.length} files`;
}

export function deriveCommandExecutionLabel(command: string): string | null {
  const displayCommand = displayCommandExecutionCommand(command).trim();
  if (displayCommand.length === 0) return null;
  const wholeCommandLabel = labelReadOrSearchCommand(displayCommand);
  if (wholeCommandLabel) return wholeCommandLabel;

  const labels: string[] = [];
  for (const segment of splitCommandLabelSegments(displayCommand)) {
    const programIndex = commandLabelProgramIndex(segment.words);
    const words = segment.words.slice(programIndex);
    const program = words[0];
    if (program === undefined || COMMAND_LABEL_SETUP_PROGRAMS.has(commandLabelProgram(program))) {
      continue;
    }
    const label =
      labelReadOrSearchCommand(segment.rawWords.slice(programIndex).join(" ")) ??
      labelCommandWords(words);
    if (label && !labels.includes(label)) labels.push(label);
    if (labels.length === MAX_COMMAND_LABELS) break;
  }
  return labels.length > 0 ? labels.join(", ") : null;
}

// ---------------------------------------------------------------------------
// Output presentation hints
//
// What a command's output is made of, read from the command alone, so the
// transcript card can render file content, search results and diffs. Each
// parser returns null for anything it does not fully understand.

interface CommandStatement {
  /** The pipeline's stages, each a list of words. */
  readonly stages: ReadonlyArray<ReadonlyArray<string>>;
  /** Joined to the previous statement by `&&`, so it runs only if that succeeded. */
  readonly afterAnd: boolean;
}

/** Pipelines joined by `&&`, `;` or newlines. */
type CommandStatements = ReadonlyArray<CommandStatement>;

function splitCommandStatements(command: string): CommandStatements | null {
  const displayCommand = displayCommandExecutionCommand(command).trim();
  if (displayCommand.length === 0) return null;
  const tokens = lexShellCommand(displayCommand);
  const statements: CommandStatement[] = [];
  let stages: Array<ReadonlyArray<string>> = [];
  let words: string[] = [];
  let afterAnd = false;
  const endStage = (): boolean => {
    if (words.length === 0) return false;
    stages.push(words);
    words = [];
    return true;
  };
  const endStatement = (nextAfterAnd: boolean): boolean => {
    const ended = endStage();
    if (!ended && stages.length > 0) return false;
    if (stages.length > 0) statements.push({ stages, afterAnd });
    else if (nextAfterAnd) return false;
    stages = [];
    afterAnd = nextAfterAnd;
    return true;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token.trim().length === 0) {
      if (token.includes("\n") && !endStatement(false)) return null;
      continue;
    }
    if (token === "&&" || token === ";") {
      if (!endStatement(token === "&&")) return null;
      continue;
    }
    if (token === "|") {
      if (!endStage()) return null;
      continue;
    }
    if (token === "2>&1") continue;
    if (token === "2>") {
      let next = index + 1;
      while ((tokens[next] ?? "x").trim().length === 0 && next < tokens.length) next += 1;
      if (tokens[next] !== "/dev/null") return null;
      index = next;
      continue;
    }
    if (isShellOperatorToken(token) || isCommandSubstitutionToken(token)) return null;
    words.push(token);
  }
  if (!endStatement(false)) return null;
  return statements.length > 0 ? statements : null;
}

/**
 * Follows `cd` statements to know where later statements ran. A statement
 * joined by `;` or a newline runs even when an earlier `cd` failed, so after a
 * `cd` the directory is only known along an unbroken `&&` chain.
 */
function createCwdTracker() {
  let offset: string | null = null;
  let changed = false;
  let known = true;
  return {
    advance(stages: CommandStatement["stages"], afterAnd: boolean): void {
      if (changed && !afterAnd) known = false;
      const target = cdStatementTarget(stages);
      if (target !== null) {
        offset = joinCwdOffset(offset, target);
        changed = true;
      }
    },
    offset: () => offset,
    /** Whether the statement just recorded surely ran in `offset`. */
    known: () => known,
  };
}

function isAbsoluteShellPath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path);
}

function joinCwdOffset(current: string | null, next: string): string {
  if (current === null || isAbsoluteShellPath(next)) return next;
  return `${current.replace(/[\\/]+$/, "")}/${next}`;
}

/** The directory a lone `cd <dir>` statement moves to, or null when it is not one. */
function cdStatementTarget(statement: ReadonlyArray<ReadonlyArray<string>>): string | null {
  const [stage] = statement;
  if (statement.length !== 1 || !stage || stage.length !== 2) return null;
  if (maybeUnquoteShellToken(stage[0] ?? "") !== "cd") return null;
  const target = maybeUnquoteShellToken(stage[1] ?? "").trim();
  return target.length > 0 && target !== "-" ? target : null;
}

function stageProgram(stage: ReadonlyArray<string>): string {
  return shellBasename(maybeUnquoteShellToken(stage[0] ?? ""));
}

export interface FileReadSegment {
  readonly filePath: string;
  /** Directory the read ran in, from earlier `cd` statements; null when none. */
  readonly cwdOffset: string | null;
  /** False when a `cd` before the read may have failed (`cd x; cat a.ts`). */
  readonly cwdKnown: boolean;
  /** File line of the first output line; null when it cannot be known (`tail -n 5`). */
  readonly startLine: number | null;
  /** Output lines carry an `nl -ba` / `cat -n` number prefix. */
  readonly numberedOutput: boolean;
}

export interface FileReadSegments {
  readonly segments: ReadonlyArray<FileReadSegment>;
}

function sedPrintStartLine(script: string): number | null {
  const match = /^(\d+|\$)(?:,(?:\d+|\$))?p$/i.exec(script.trim());
  if (!match?.[1] || match[1] === "$") return null;
  const start = Number.parseInt(match[1], 10);
  return start > 0 ? start : null;
}

function singleFileArgument(args: ReadonlyArray<string>): string | null {
  if (args.length !== 1) return null;
  const path = maybeUnquoteShellToken(args[0] ?? "").trim();
  return path.length > 0 && !path.startsWith("-") ? path : null;
}

/** Strips one recognized `head`/`tail` line-count option; null when the args hold others. */
function parseLineCountArgs(
  args: ReadonlyArray<string>,
): { count: string | null; rest: ReadonlyArray<string> } | null {
  const [first, second, ...rest] = args;
  if (first === "-n" && second !== undefined) return { count: second, rest };
  if (first?.startsWith("--lines=")) {
    return { count: first.slice("--lines=".length), rest: args.slice(1) };
  }
  if (first !== undefined && /^-(?:n)?\+?\d+$/.test(first)) {
    return { count: first.replace(/^-n?/, ""), rest: args.slice(1) };
  }
  return { count: null, rest: args };
}

function parseSingleStageFileRead(
  stage: ReadonlyArray<string>,
): Omit<FileReadSegment, "cwdOffset" | "cwdKnown"> | null {
  const program = stageProgram(stage);
  const args = stage.slice(1);
  if (program === "sed") {
    // Without quiet mode sed prints the whole file plus the range again, so
    // the output is not the range and its lines cannot be numbered.
    const sed = parseSedPrintCommandArgs(args);
    if (!sed?.quiet || sed.trailingArgs.length !== 1) return null;
    const filePath = sed.trailingArgs[0]?.trim() ?? "";
    if (filePath.length === 0) return null;
    return { filePath, startLine: sedPrintStartLine(sed.script), numberedOutput: false };
  }
  if (program === "cat") {
    const numbered = args[0] === "-n";
    const filePath = singleFileArgument(numbered ? args.slice(1) : args);
    return filePath ? { filePath, startLine: 1, numberedOutput: numbered } : null;
  }
  if (program === "head" || program === "tail") {
    const parsed = parseLineCountArgs(args);
    const filePath = parsed ? singleFileArgument(parsed.rest) : null;
    if (!parsed || !filePath) return null;
    if (parsed.count !== null && !/^\+?\d+$/.test(parsed.count)) return null;
    if (program === "head") return { filePath, startLine: 1, numberedOutput: false };
    const fromLine = parsed.count?.startsWith("+")
      ? Number.parseInt(parsed.count.slice(1), 10)
      : null;
    return {
      filePath,
      startLine: fromLine !== null && fromLine > 0 ? fromLine : null,
      numberedOutput: false,
    };
  }
  if (program === "nl") {
    const filePath = parseNlBodyNumberingAllFilePath(stage);
    return filePath ? { filePath, startLine: 1, numberedOutput: true } : null;
  }
  return null;
}

function parseFileReadPipeline(
  stages: ReadonlyArray<ReadonlyArray<string>>,
): Omit<FileReadSegment, "cwdOffset" | "cwdKnown"> | null {
  const [first, second] = stages;
  if (!first) return null;
  if (stages.length === 1) return parseSingleStageFileRead(first);
  if (stages.length !== 2 || !second) return null;
  // `nl -ba file | sed -n 10,20p` and `cat -n file | sed -n 10,20p`
  const source = parseSingleStageFileRead(first);
  if (!source?.numberedOutput || stageProgram(second) !== "sed") return null;
  const sed = parseSedPrintCommandArgs(second.slice(1));
  if (!sed?.quiet || sed.trailingArgs.length > 0) return null;
  return { ...source, startLine: sedPrintStartLine(sed.script) };
}

/**
 * The file reads a command is made of, such as `sed -n 10,20p a.ts` or
 * `cd src && cat a.ts; head -n 5 b.ts`, in output order. Null when any
 * statement is something other than a read or a `cd`.
 */
export function parseFileReadSegments(command: string): FileReadSegments | null {
  const statements = splitCommandStatements(command);
  if (!statements) return null;
  const segments: FileReadSegment[] = [];
  const cwd = createCwdTracker();
  for (const { stages, afterAnd } of statements) {
    cwd.advance(stages, afterAnd);
    if (cdStatementTarget(stages) !== null) continue;
    const read = parseFileReadPipeline(stages);
    if (!read) return null;
    segments.push({ ...read, cwdOffset: cwd.offset(), cwdKnown: cwd.known() });
  }
  return segments.length > 0 ? { segments } : null;
}

export interface SearchOutputCommand {
  readonly tool: "grep" | "rg";
  readonly patterns: ReadonlyArray<string>;
  /** Paths given on the command line; empty when it searched the cwd. */
  readonly targets: ReadonlyArray<string>;
  readonly cwdOffset: string | null;
  /** False when a `cd` before the search may have failed (`cd x; rg …`). */
  readonly cwdKnown: boolean;
  /** Statements after the search print output of their own after its matches. */
  readonly followedByOtherStatements: boolean;
  readonly fixedStrings: boolean;
  readonly ignoreCase: boolean;
  /** Patterns use extended (ERE/PCRE/Rust) syntax rather than POSIX basic. */
  readonly extendedRegex: boolean;
  /** PCRE patterns (`grep -P`, `rg -P`), which JS cannot match safely. */
  readonly perlRegex: boolean;
  /** Output lines carry no file name even with several matches (`grep -h`). */
  readonly noFileName: boolean;
  readonly recursive: boolean;
  /** Output lines carry line numbers (`-n`, `--vimgrep`). */
  readonly lineNumbers: boolean;
}

const GREP_VALUE_FLAG_LETTERS = new Set(["A", "B", "C", "e", "f", "m", "d", "D"]);
const RG_VALUE_FLAG_LETTERS = new Set([
  "A",
  "B",
  "C",
  "e",
  "f",
  "g",
  "m",
  "t",
  "T",
  "j",
  "M",
  "E",
  "r",
]);

function collectSearchFlags(
  args: ReadonlyArray<string>,
  tool: "grep" | "rg",
): { letters: Set<string>; longFlags: Set<string> } {
  const letters = new Set<string>();
  const longFlags = new Set<string>();
  const valueLetters = tool === "rg" ? RG_VALUE_FLAG_LETTERS : GREP_VALUE_FLAG_LETTERS;
  const longValueFlags = tool === "rg" ? RG_FLAGS_WITH_VALUE : GREP_FLAGS_WITH_VALUE;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      longFlags.add(flag);
      if (!arg.includes("=") && longValueFlags.has(arg)) index += 1;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let offset = 1; offset < arg.length; offset += 1) {
      const letter = arg[offset] ?? "";
      if (valueLetters.has(letter)) {
        if (offset === arg.length - 1) index += 1;
        break;
      }
      letters.add(letter);
    }
  }
  return { letters, longFlags };
}

const FILTER_GREP_LETTERS = new Set(["v", "i", "E", "F", "G", "w", "x", "s"]);
const FILTER_RG_LETTERS = new Set(["v", "i", "F", "w", "x", "s", "S"]);
const FILTER_GREP_LONG_FLAGS = new Set([
  "--invert-match",
  "--ignore-case",
  "--extended-regexp",
  "--fixed-strings",
  "--basic-regexp",
  "--word-regexp",
  "--line-regexp",
  "--no-messages",
]);
const FILTER_RG_LONG_FLAGS = new Set([
  "--invert-match",
  "--ignore-case",
  "--fixed-strings",
  "--word-regexp",
  "--line-regexp",
  "--no-messages",
  "--smart-case",
  "--case-sensitive",
]);

/**
 * Whether the shell may turn a word into something else: parameter or command
 * substitution (outside single quotes), or a glob, tilde or brace expansion
 * (unquoted). `grep $FILTER` could expand to `-n foo`, and `grep a*` to file
 * names, so the stage's real arguments are unknown.
 */
function isExpandableShellWord(token: string): boolean {
  if (/^'[^']*'$/.test(token)) return false;
  // A `$` before a quote or at the end stays literal (`"test$"` anchors).
  if (/`|\$[\w{(@*#?$!-]/.test(token)) return true;
  if (/^"[^"]*"$/.test(token)) return false;
  return /[*?[{~\\'"]/.test(token);
}

/**
 * A pipeline stage that only keeps or drops whole lines of its input, so
 * search results that pass through it still read as `path:line:text`:
 * `head`/`tail` with a count, or a grep/rg filter over stdin
 * (`grep -v test`, `grep -iE 'a|b'`). Flags that rewrite lines (`-n`, `-o`,
 * `-c`, `-H`, context), file arguments (which stop it reading stdin) and
 * words the shell would expand are rejected.
 *
 * Like the search stage, an rg filter is assumed to run without a TTY and
 * without a `RIPGREP_CONFIG_PATH` that turns on line numbers; either would
 * prefix its own numbers (`1:72:foo`).
 */
function isLineFilterStage(stage: ReadonlyArray<string>): boolean {
  if (stage.slice(1).some(isExpandableShellWord)) return false;
  const program = stageProgram(stage);
  const args = stage.slice(1).map(maybeUnquoteShellToken);
  if (program === "head" || program === "tail") {
    const parsed = parseLineCountArgs(args);
    return (
      parsed !== null &&
      parsed.rest.length === 0 &&
      (parsed.count === null || /^\+?\d+$/.test(parsed.count))
    );
  }
  const isRg = program === "rg" || program === "ripgrep";
  if (!isRg && !["grep", "ggrep", "egrep", "fgrep"].includes(program)) return false;
  const letters = isRg ? FILTER_RG_LETTERS : FILTER_GREP_LETTERS;
  const longFlags = isRg ? FILTER_RG_LONG_FLAGS : FILTER_GREP_LONG_FLAGS;
  let patterns = 0;
  let positionals = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      positionals += args.length - index - 1;
      break;
    }
    if (arg === "-e" || arg === "--regexp") {
      if (index === args.length - 1) return false;
      patterns += 1;
      index += 1;
      continue;
    }
    if (arg.startsWith("--regexp=")) {
      patterns += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      if (!longFlags.has(arg)) return false;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      const cluster = arg.slice(1);
      const valueAt = cluster.indexOf("e");
      const flagPart = valueAt === -1 ? cluster : cluster.slice(0, valueAt);
      if (![...flagPart].every((letter) => letters.has(letter))) return false;
      if (valueAt !== -1) {
        patterns += 1;
        // `-ve pattern` takes the next word; `-vepattern` carries it inline.
        if (valueAt === cluster.length - 1) {
          if (index === args.length - 1) return false;
          index += 1;
        }
      }
      continue;
    }
    positionals += 1;
  }
  // With `-e` every positional is a file; without, the first is the pattern.
  return patterns > 0 ? positionals === 0 : positionals === 1;
}

/**
 * A grep or ripgrep search whose output can be read as `path:line:text`
 * lines. Leading `cd` statements are followed. Statements after the search
 * are allowed and reported, so the caller can keep their output (which comes
 * after the matches, and can look like a match) out of the results.
 */
export function parseSearchOutputCommand(command: string): SearchOutputCommand | null {
  const statements = splitCommandStatements(command);
  if (!statements) return null;
  const cwd = createCwdTracker();
  let index = 0;
  for (; index < statements.length; index += 1) {
    const statement = statements[index]!;
    cwd.advance(statement.stages, statement.afterAnd);
    if (cdStatementTarget(statement.stages) === null) break;
  }
  const statement = statements[index];
  if (!statement) return null;
  const [stage, ...rest] = statement.stages;
  if (!stage || !rest.every(isLineFilterStage)) return null;
  const program = stageProgram(stage);
  if (!isSearchToolName(program)) return null;
  const tool = program === "rg" || program === "ripgrep" ? "rg" : "grep";
  const args = stage.slice(1);
  const parsed = parseSearchCommandArgs(
    args,
    tool === "rg"
      ? {
          flagsWithValue: RG_FLAGS_WITH_VALUE,
          patternFlags: RG_PATTERN_FLAGS,
          rejectFlags: RG_REJECT_FLAGS,
        }
      : {
          flagsWithValue: GREP_FLAGS_WITH_VALUE,
          patternFlags: GREP_PATTERN_FLAGS,
          rejectFlags: GREP_REJECT_FLAGS,
        },
  );
  if (!parsed) return null;
  const { letters, longFlags } = collectSearchFlags(args, tool);
  const has = (letter: string, ...flags: string[]) =>
    letters.has(letter) || flags.some((flag) => longFlags.has(flag));
  const smartCase =
    tool === "rg" &&
    has("S", "--smart-case") &&
    parsed.patterns.every((pattern) => pattern === pattern.toLowerCase());
  return {
    tool,
    patterns: parsed.patterns,
    // parseSearchCommandArgs reports a search without paths as "workspace".
    targets:
      parsed.targets.length === 1 &&
      parsed.targets[0] === "workspace" &&
      !args.some((arg) => maybeUnquoteShellToken(arg) === "workspace")
        ? []
        : parsed.targets,
    cwdOffset: cwd.offset(),
    cwdKnown: cwd.known(),
    followedByOtherStatements: index < statements.length - 1,
    fixedStrings: has("F", "--fixed-strings"),
    ignoreCase: has("i", "--ignore-case") || smartCase,
    extendedRegex: tool === "rg" || has("E", "--extended-regexp") || has("P", "--perl-regexp"),
    perlRegex: has("P", tool === "rg" ? "--pcre2" : "--perl-regexp"),
    noFileName: has("h", "--no-filename"),
    recursive: tool === "rg" || has("r", "--recursive") || has("R", "--dereference-recursive"),
    // Without a TTY neither tool numbers lines unless asked to. `--vimgrep`
    // and `--column` add a column (`path:3:7:text`), a format not parsed here.
    lineNumbers:
      has("n", "--line-number") &&
      !(tool === "rg" && has("N", "--no-line-number")) &&
      !longFlags.has("--vimgrep") &&
      !longFlags.has("--column"),
  };
}

const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree"]);

function isDiffStage(stage: ReadonlyArray<string>): boolean {
  const program = stageProgram(stage);
  const words = stage.slice(1).map(maybeUnquoteShellToken);
  if (program === "diff") {
    return words.some(
      (word) => word === "-u" || word.startsWith("-U") || word.startsWith("--unified"),
    );
  }
  if (program !== "git") return false;
  let index = 0;
  while (index < words.length && (words[index] ?? "").startsWith("-")) {
    index += GIT_OPTIONS_WITH_VALUE.has(words[index] ?? "") ? 2 : 1;
  }
  const subcommand = words[index];
  const rest = words.slice(index + 1);
  const patch = rest.some((word) => word === "-p" || word === "--patch" || word === "-u");
  if (subcommand === "diff" || subcommand === "show") {
    return !rest.some((word) =>
      ["--stat", "--name-only", "--name-status", "--shortstat", "--numstat"].includes(word),
    );
  }
  if (subcommand === "log") return patch;
  if (subcommand === "stash") return rest[0] === "show" && patch;
  return false;
}

/** Whether a command prints a unified diff: `git diff`, `git show`, `diff -u`, ... */
export function isDiffCommand(command: string): boolean {
  const statements = splitCommandStatements(command);
  if (!statements) return false;
  let index = 0;
  while (index < statements.length && cdStatementTarget(statements[index]!.stages) !== null) {
    index += 1;
  }
  const statement = statements[index];
  if (!statement || index !== statements.length - 1) return false;
  const [stage, ...rest] = statement.stages;
  if (!stage || rest.length > 1 || (rest[0] && !parseHeadStage(rest[0]))) return false;
  return isDiffStage(stage);
}
