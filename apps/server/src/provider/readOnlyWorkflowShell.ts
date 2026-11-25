import {
  parse,
  type Command,
  type CommandNode,
  type CompoundList,
  type DoubleQuotedChild,
  type PipelineNode,
  type Redirection,
  type Statement,
  type Word,
  type WordPart,
} from "unbash";

/**
 * Whether a shell command only reads, for read-only workflow stages on providers that have no
 * OS sandbox (Cursor, Antigravity). Codex enforces read-only with its sandbox and Claude with its
 * native plan-mode classifier; these providers hand every command to F5 instead.
 *
 * The classifier fails closed: anything it cannot prove read-only is refused, and the model is
 * told no and can try a simpler command. Only plain commands joined by `|`, `&&`, `||` and `;`,
 * optionally inside `if`/`elif`/`else`, `{ …; }` or `( … )`, are accepted, each running an
 * allowlisted program with flags that cannot write or execute.
 */
export type ReadOnlyShellClassification =
  | { readonly readOnly: true }
  | { readonly readOnly: false; readonly reason: string };

const READ_ONLY: ReadOnlyShellClassification = { readOnly: true };
const refuse = (reason: string): ReadOnlyShellClassification => ({ readOnly: false, reason });

/** Environment prefixes that only change output formatting. */
const ALLOWED_ASSIGNMENTS = new Set([
  "GH_NO_UPDATE_NOTIFIER",
  "NO_COLOR",
  "LC_ALL",
  "LANG",
  "TERM",
]);

/** Pager variables run their value as a command, so only "no pager" and `cat` are allowed. */
const PAGER_ASSIGNMENTS = new Set(["GH_PAGER", "GIT_PAGER", "PAGER"]);
const ALLOWED_PAGER_VALUES = new Set(["", "cat"]);

/**
 * Programs whose every flag only reads. Arguments must still be literal: a variable such as
 * `$GH_TOKEN` would print a secret into the model's context.
 */
const PLAIN_READ_PROGRAMS = new Set([
  "cat",
  "head",
  "wc",
  "ls",
  "pwd",
  "echo",
  "printf",
  "grep",
  "egrep",
  "fgrep",
  "cut",
  "tr",
  "diff",
  "cmp",
  "stat",
  "du",
  "df",
  "which",
  "basename",
  "dirname",
  "realpath",
  "uname",
  "true",
  "false",
  "test",
  "[",
  "cd",
  "type",
]);

const FIND_REFUSED_PREDICATES = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls"]);

const GIT_READ_SUBCOMMANDS = new Set([
  "status",
  "log",
  "show",
  "diff",
  "diff-tree",
  "rev-parse",
  "rev-list",
  "ls-files",
  "ls-tree",
  "cat-file",
  "blame",
  "describe",
  "merge-base",
  "shortlog",
  // Not `grep`: its `-O<cmd>` opens matches in a program and git accepts it inside a group of
  // short flags (`-iO'cmd'`), which a flag check cannot reliably catch.
  "name-rev",
  "show-ref",
  "for-each-ref",
]);

/** Long options that write a file or run a program; git also accepts their abbreviations. */
const GIT_REFUSED_LONG_OPTIONS = [
  "output",
  "ext-diff",
  "textconv",
  "filters",
  "open-files-in-pager",
];

const GIT_BRANCH_READ_FLAGS = new Set([
  "--show-current",
  "--list",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
]);

// A Map, not an object literal: `gh constructor x` must not reach `Object.prototype`.
const GH_READ_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["pr", new Set(["view", "diff", "checks", "list", "status"])],
  ["issue", new Set(["view", "list"])],
  ["repo", new Set(["view"])],
  ["run", new Set(["view", "list"])],
  ["release", new Set(["view", "list"])],
]);

/**
 * The only `gh api` flags accepted, spelled exactly. pflag groups short flags (`-iXDELETE`,
 * `-if body=x`), so any other `-…` token is refused rather than matched by prefix.
 */
const GH_API_SWITCHES = new Set([
  "-i",
  "--include",
  "--paginate",
  "--slurp",
  "--silent",
  "--verbose",
]);
const GH_API_VALUE_FLAGS = new Set(["-q", "--jq", "-t", "--template"]);
const GH_API_ACCEPT_HEADER = /^accept\s*:/i;

const SED_PRINT_SCRIPT = /^(\d+|\$)(,(\d+|\$))?p$/;

export function classifyReadOnlyShellCommand(command: string): ReadOnlyShellClassification {
  if (command.trim().length === 0) return refuse("empty command");
  let script;
  try {
    script = parse(command);
  } catch {
    return refuse("command could not be parsed");
  }
  if (script.errors && script.errors.length > 0) return refuse("command could not be parsed");
  if (script.commands.length === 0) return refuse("empty command");
  for (const statement of script.commands) {
    const verdict = classifyStatement(statement);
    if (!verdict.readOnly) return verdict;
  }
  return READ_ONLY;
}

/** Deeper nesting of `if`, `{ }` and `( )` is refused rather than walked. */
const MAX_COMPOUND_DEPTH = 8;

function classifyStatement(statement: Statement, depth = 0): ReadOnlyShellClassification {
  if (statement.background) return refuse("background commands are not allowed");
  const node = statement.command;
  if (node.type === "AndOr") {
    for (const entry of node.commands) {
      const verdict = classifyPipelineNode(entry, depth);
      if (!verdict.readOnly) return verdict;
    }
    return READ_ONLY;
  }
  return classifyPipelineNode(node, depth);
}

function classifyPipelineNode(node: PipelineNode, depth: number): ReadOnlyShellClassification {
  if (node.type === "Pipeline") {
    if (node.operators.some((operator) => operator !== "|"))
      return refuse("only plain `|` pipes are allowed");
    for (const entry of node.commands) {
      const verdict = classifyCommandNode(entry, depth);
      if (!verdict.readOnly) return verdict;
    }
    return READ_ONLY;
  }
  if (node.type === "Time" || node.type === "Negation")
    return refuse(`${node.type} commands are not allowed`);
  return classifyCommandNode(node, depth);
}

/**
 * A simple command, or an `if`/`elif`/`else`, `{ …; }` or `( … )` whose every nested statement
 * is read-only. Redirections on a compound pass the same `/dev/null`-only check as a simple
 * command's. Loops, `case`, functions, coprocesses and `[[ ]]`/`(( ))` stay refused: a loop can
 * run without end and the others add expansions this classifier does not inspect.
 */
function classifyCommandNode(node: CommandNode, depth: number): ReadOnlyShellClassification {
  switch (node.type) {
    case "Command":
      return classifyCommand(node);
    case "Redirected": {
      for (const redirection of node.redirects) {
        const verdict = classifyRedirection(redirection);
        if (!verdict.readOnly) return verdict;
      }
      return classifyCommandNode(node.command, depth);
    }
    case "If":
    case "BraceGroup":
    case "Subshell": {
      if (depth >= MAX_COMPOUND_DEPTH) return refuse("commands are nested too deeply");
      const lists =
        node.type === "If"
          ? [node.clause, node.then, ...(node.else ? [node.else] : [])]
          : [node.body];
      for (const list of lists) {
        const verdict =
          list.type === "If"
            ? classifyCommandNode(list, depth + 1)
            : classifyCompoundList(list, depth + 1);
        if (!verdict.readOnly) return verdict;
      }
      return READ_ONLY;
    }
    default:
      return refuse(`${node.type} commands are not allowed`);
  }
}

function classifyCompoundList(list: CompoundList, depth: number): ReadOnlyShellClassification {
  if (list.commands.length === 0) return refuse("empty command");
  for (const statement of list.commands) {
    const verdict = classifyStatement(statement, depth);
    if (!verdict.readOnly) return verdict;
  }
  return READ_ONLY;
}

function classifyCommand(command: Command): ReadOnlyShellClassification {
  for (const entry of command.prefix) {
    if (entry.type === "Assignment") {
      const isPager = PAGER_ASSIGNMENTS.has(entry.name);
      if (!isPager && !ALLOWED_ASSIGNMENTS.has(entry.name))
        return refuse(`setting ${entry.name} is not allowed`);
      if (entry.value.type !== "Word" || !isStaticWord(entry.value))
        return refuse(`${entry.name} must be a literal value`);
      if (isPager && !ALLOWED_PAGER_VALUES.has(entry.value.value))
        return refuse(`${entry.name} may only be empty or \`cat\``);
      continue;
    }
    const verdict = classifyRedirection(entry);
    if (!verdict.readOnly) return verdict;
  }
  for (const entry of command.suffix) {
    if (entry.type === "Word" || entry.type === "Assignment") continue;
    const verdict = classifyRedirection(entry);
    if (!verdict.readOnly) return verdict;
  }

  const name = command.name;
  if (!name) return refuse("a command name is required");
  if (!isStaticWord(name)) return refuse("the command name must be literal");
  const program = name.value;
  if (program.includes("/")) return refuse("programs must be named without a path");

  // Every argument must be literal. A substitution runs a command, a variable could expand to a
  // flag that writes or executes, and `echo $GH_TOKEN` would put a secret in the model's context.
  // `cmd NAME=value` is a plain argument for every allowed program.
  const args: string[] = [];
  for (const entry of command.suffix) {
    if (entry.type === "Assignment") {
      if (!(entry.value.type === "Word" && isStaticWord(entry.value)))
        return refuse("arguments must be literal");
      continue;
    }
    if (entry.type !== "Word") continue;
    if (!isStaticWord(entry))
      return refuse("arguments must be literal: no variables or substitutions");
    args.push(entry.value);
  }

  if (PLAIN_READ_PROGRAMS.has(program)) return READ_ONLY;

  switch (program) {
    case "command":
      return args.length >= 1 && (args[0] === "-v" || args[0] === "-V")
        ? READ_ONLY
        : refuse("`command` is only allowed as `command -v`");
    case "tail":
      // `tail -f` never exits, so the turn would hang until the watchdog fails it.
      return args.some(
        (arg) => /^-[a-zA-Z0-9]*[fF]/.test(arg) || abbreviatesLongOption(arg, "follow"),
      )
        ? refuse("`tail -f` never exits")
        : READ_ONLY;
    case "jq":
      // `env` and `$ENV` read the whole inherited environment, which can hold credentials.
      return args.some((arg) => /\benv\b|\$ENV\b/.test(arg))
        ? refuse("`jq` may not read the environment")
        : READ_ONLY;
    case "file":
      return args.some((arg) => /^-[a-zA-Z]*C/.test(arg) || abbreviatesLongOption(arg, "compile"))
        ? refuse("`file -C` writes a file")
        : READ_ONLY;
    case "date":
      return args.every(
        (arg) => arg.startsWith("+") || arg === "-u" || arg === "-R" || arg.startsWith("-I"),
      )
        ? READ_ONLY
        : refuse("`date` may only format the current time");
    case "rg":
      return args.some(
        (arg) => arg === "--pre" || arg.startsWith("--pre=") || arg.startsWith("--pre-glob"),
      )
        ? refuse("`rg --pre` runs a program")
        : READ_ONLY;
    case "find":
      return args.some((arg) => FIND_REFUSED_PREDICATES.has(arg) || arg.startsWith("-fprint"))
        ? refuse("`find` actions that write or execute are not allowed")
        : READ_ONLY;
    case "fd":
      return args.some(
        (arg) => arg.startsWith("--exec") || (/^-[a-zA-Z]+$/.test(arg) && /[xX]/.test(arg)),
      )
        ? refuse("`fd --exec` runs a program")
        : READ_ONLY;
    case "sort":
      return classifySort(args);
    case "uniq":
      return classifyUniq(args);
    case "sed":
      return classifySed(args);
    case "git":
      return classifyGit(args);
    case "gh":
      return classifyGh(args);
    default:
      return refuse(`\`${program}\` is not on the read-only allowlist`);
  }
}

function classifyRedirection(redirection: Redirection): ReadOnlyShellClassification {
  if (redirection.type === "HereDoc") return refuse("heredocs are not allowed");
  const target = redirection.target;
  if (!target || !isStaticWord(target)) return refuse("redirection targets must be literal");
  if (redirection.type === "HereString") return READ_ONLY;
  switch (redirection.operator) {
    case "<":
      return READ_ONLY;
    case ">":
    case "&>":
      return target.value === "/dev/null"
        ? READ_ONLY
        : refuse("output may only be redirected to /dev/null");
    case ">&":
      return target.value === "1" || target.value === "2"
        ? READ_ONLY
        : refuse("output may only be redirected to /dev/null");
    default:
      return refuse(`\`${redirection.operator}\` redirection is not allowed`);
  }
}

/**
 * Whether `arg` spells the long option `name` or an abbreviation of it. GNU `getopt_long` and
 * git accept any unambiguous prefix (`--outp=x` is `--output=x`), so a refused long option has
 * to be matched by prefix, not by exact spelling.
 */
function abbreviatesLongOption(arg: string, name: string): boolean {
  if (!arg.startsWith("--") || arg.length <= 2) return false;
  const spelled = arg.slice(2).split("=", 1)[0]!;
  return spelled.length > 0 && name.startsWith(spelled);
}

/** `sort` flags that only change ordering or checking; anything else (`-o`, `-T`, …) is refused. */
const SORT_FLAG_CLUSTER = /^-[bdfghiMnRrsuVzcC]+$/;
const SORT_LONG_FLAGS = new Set([
  "unique",
  "reverse",
  "numeric-sort",
  "human-numeric-sort",
  "general-numeric-sort",
  "ignore-case",
  "version-sort",
  "month-sort",
  "random-sort",
  "stable",
  "dictionary-order",
  "ignore-leading-blanks",
  "ignore-nonprinting",
  "zero-terminated",
  "check",
]);
const SORT_LONG_VALUE_FLAGS = new Set(["key", "field-separator", "buffer-size", "parallel"]);

function classifySort(args: ReadonlyArray<string>): ReadOnlyShellClassification {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") return READ_ONLY;
    if (!arg.startsWith("-") || arg === "-") continue;
    if (SORT_FLAG_CLUSTER.test(arg)) continue;
    if (/^-[kt]/.test(arg)) {
      // `-k1,2` carries its value; a bare `-k` takes the next token.
      if (arg.length === 2) index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      // Exact spellings only: an abbreviation could be one of the refused options.
      const name = arg.slice(2).split("=", 1)[0]!;
      const hasValue = arg.includes("=");
      if (SORT_LONG_FLAGS.has(name) && !hasValue) continue;
      if (SORT_LONG_VALUE_FLAGS.has(name)) {
        if (!hasValue) index += 1;
        continue;
      }
    }
    return refuse(`\`sort ${arg}\` is not allowed`);
  }
  return READ_ONLY;
}

function classifyUniq(args: ReadonlyArray<string>): ReadOnlyShellClassification {
  let positionals = 0;
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (optionsEnded) {
      positionals += 1;
      continue;
    }
    if (arg === "--") {
      // Every later token is an operand, even one starting with `-`.
      optionsEnded = true;
      continue;
    }
    if (arg === "-f" || arg === "-s" || arg === "-w") {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") positionals += 1;
  }
  return positionals <= 1 ? READ_ONLY : refuse("`uniq INPUT OUTPUT` writes a file");
}

function classifySed(args: ReadonlyArray<string>): ReadOnlyShellClassification {
  let quiet = false;
  let scriptSeen = false;
  for (const arg of args) {
    if (arg.startsWith("-") && arg !== "-") {
      if (/^-[nEr]+$/.test(arg)) {
        if (arg.includes("n")) quiet = true;
        continue;
      }
      if (arg === "--quiet" || arg === "--silent") {
        quiet = true;
        continue;
      }
      if (arg === "--regexp-extended") continue;
      return refuse(`\`sed ${arg}\` is not allowed`);
    }
    if (!scriptSeen) {
      if (!SED_PRINT_SCRIPT.test(arg)) return refuse("`sed` may only print line ranges");
      scriptSeen = true;
    }
  }
  return quiet && scriptSeen ? READ_ONLY : refuse("`sed` is only allowed as `sed -n 'N,Mp'`");
}

function classifyGit(args: ReadonlyArray<string>): ReadOnlyShellClassification {
  let index = 0;
  while (index < args.length && args[index]!.startsWith("-")) {
    const arg = args[index]!;
    if (arg === "-C") {
      if (index + 1 >= args.length) return refuse("`git -C` needs a directory");
      index += 2;
      continue;
    }
    if (arg === "--no-pager" || arg === "--no-optional-locks") {
      index += 1;
      continue;
    }
    return refuse(`\`git ${arg}\` is not allowed`);
  }
  const subcommand = args[index];
  if (subcommand === undefined) return refuse("a git subcommand is required");
  const rest = args.slice(index + 1);
  if (
    rest.some(
      (arg) =>
        // `--text` is an option of its own, not an abbreviation of `--textconv`.
        (arg !== "--text" &&
          GIT_REFUSED_LONG_OPTIONS.some((name) => abbreviatesLongOption(arg, name))) ||
        arg.startsWith("-O"),
    )
  )
    return refuse(`\`git ${subcommand}\` flags that write or execute are not allowed`);

  if (GIT_READ_SUBCOMMANDS.has(subcommand)) return READ_ONLY;
  if (subcommand === "branch")
    return rest.every((arg) => GIT_BRANCH_READ_FLAGS.has(arg))
      ? READ_ONLY
      : refuse("`git branch` is only allowed for listing");
  if (subcommand === "remote") {
    if (rest.length === 1 && (rest[0] === "-v" || rest[0] === "--verbose")) return READ_ONLY;
    if (rest.length === 2 && rest[0] === "get-url" && !rest[1]!.startsWith("-")) return READ_ONLY;
    return refuse("`git remote` is only allowed as `-v` or `get-url`");
  }
  return refuse(`\`git ${subcommand}\` is not on the read-only allowlist`);
}

function classifyGh(args: ReadonlyArray<string>): ReadOnlyShellClassification {
  const [group, subcommand] = args;
  if (group === undefined) return refuse("a gh command is required");
  if (group === "auth") return refuse("`gh auth` is not allowed");
  // pflag groups short flags, so `-cw` is `--comments --web`.
  if (args.some((arg) => arg === "--web" || /^-[a-zA-Z]*w/.test(arg)))
    return refuse("`gh --web` opens a browser");
  if (group === "api") return classifyGhApi(args.slice(1));
  const allowed = GH_READ_SUBCOMMANDS.get(group);
  if (!allowed || subcommand === undefined || !allowed.has(subcommand))
    return refuse(
      `\`gh ${group}${subcommand ? ` ${subcommand}` : ""}\` is not on the read-only allowlist`,
    );
  if (args.some((arg) => arg === "--watch" || arg.startsWith("--watch=")))
    return refuse("`gh --watch` never exits on its own");
  return READ_ONLY;
}

function classifyGhApi(args: ReadonlyArray<string>): ReadOnlyShellClassification {
  let endpoint: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) {
      if (endpoint !== undefined) return refuse("`gh api` takes a single endpoint");
      endpoint = arg;
      continue;
    }
    if (GH_API_SWITCHES.has(arg)) continue;
    if (arg === "-X" || arg === "--method") {
      if (args[index + 1]?.toUpperCase() !== "GET")
        return refuse("`gh api` may only send GET requests");
      index += 1;
      continue;
    }
    if (arg === "-XGET" || arg.toUpperCase() === "--METHOD=GET") continue;
    if (arg === "-H" || arg === "--header") {
      if (!GH_API_ACCEPT_HEADER.test(args[index + 1] ?? ""))
        return refuse("`gh api` may only set the Accept header");
      index += 1;
      continue;
    }
    if (arg.startsWith("--header=")) {
      if (!GH_API_ACCEPT_HEADER.test(arg.slice("--header=".length)))
        return refuse("`gh api` may only set the Accept header");
      continue;
    }
    if (GH_API_VALUE_FLAGS.has(arg)) {
      if (index + 1 >= args.length) return refuse(`\`gh api ${arg}\` needs a value`);
      index += 1;
      continue;
    }
    if (arg.startsWith("--jq=") || arg.startsWith("--template=")) continue;
    return refuse(`\`gh api ${arg}\` is not allowed`);
  }
  if (endpoint === undefined) return refuse("`gh api` needs an endpoint");
  if (endpoint === "graphql") return refuse("`gh api graphql` is not allowed");
  return READ_ONLY;
}

/** A word with no expansion of any kind: its value is exactly what the program receives. */
function isStaticWord(word: Word): boolean {
  return (word.parts ?? []).every(isStaticPart);
}

function isStaticPart(part: WordPart | DoubleQuotedChild): boolean {
  switch (part.type) {
    case "Literal":
    case "SingleQuoted":
    case "AnsiCQuoted":
      return true;
    case "DoubleQuoted":
    case "LocaleString":
      return part.parts.every(isStaticPart);
    default:
      return false;
  }
}
