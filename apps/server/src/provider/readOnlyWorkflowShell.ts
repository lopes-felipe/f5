import {
  parse,
  type Command,
  type CommandNode,
  type CompoundList,
  type DoubleQuotedChild,
  type If,
  type PipelineNode,
  type Redirection,
  type Statement,
  type Word,
  type WordPart,
} from "unbash";

/**
 * Whether a shell command only reads, for read-only workflow stages without an OS sandbox: Cursor,
 * and Antigravity and Codex where their sandbox can't start (F5's macOS desktop app). Claude enforces read-only with its native plan-mode classifier; these providers
 * hand every command to F5 instead.
 *
 * The classifier fails closed: anything it cannot prove read-only is refused, and the model is
 * told no and can try a simpler command. Only plain commands joined by `|`, `&&`, `||` and `;`,
 * optionally inside `if`/`elif`/`else`, `{ …; }` or `( … )`, are accepted, each running an
 * allowlisted program with flags that cannot write or execute.
 */
export type ReadOnlyShellClassification =
  | { readonly readOnly: true }
  | { readonly readOnly: false; readonly reason: string };

/**
 * Added to the environment of providers whose read-only stages use this classifier:
 *
 * - `GIT_OPTIONAL_LOCKS=0`: `git status` otherwise refreshes the index and holds `index.lock`,
 *   which can fail a concurrent Git command in the same worktree;
 * - `GIT_PAGER=cat`: on a terminal Git pipes `log`, `diff` and `show` through the pager named in
 *   `core.pager` or `pager.<command>`, which a repository's own config can set to any program.
 *   The variable outranks both;
 * - `GIT_NO_LAZY_FETCH=1`: in a partial clone a read of a missing object otherwise fetches it
 *   from the promisor remote, which reaches the network and writes to the object store.
 */
export const READ_ONLY_WORKFLOW_ENVIRONMENT = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  GIT_NO_LAZY_FETCH: "1",
} as const;

/**
 * What an accepted command does with directories, in the order it is written: a `cd` and its
 * target (undefined when the form has no single target, such as zsh's `cd old new`), or a `git`
 * call and its `-C` directories. `readOnlyGitConfig.ts` works out from these which repositories
 * the command's Git calls can read.
 */
export type ReadOnlyShellDirectoryUse =
  | { readonly kind: "cd"; readonly path: string | undefined }
  | { readonly kind: "git"; readonly path: ReadonlyArray<string> };

/** Filled while `readOnlyShellDirectoryUses` runs the classifier, which is synchronous. */
let directoryUses: ReadOnlyShellDirectoryUse[] | undefined;

/** The `cd` and `git` calls of a command the classifier accepts, or undefined when it refuses. */
export function readOnlyShellDirectoryUses(
  command: string,
): ReadonlyArray<ReadOnlyShellDirectoryUse> | undefined {
  const uses: ReadOnlyShellDirectoryUse[] = [];
  directoryUses = uses;
  try {
    return classifyReadOnlyShellCommand(command).readOnly ? uses : undefined;
  } finally {
    directoryUses = undefined;
  }
}

/** Where `cd <args>` goes: `~` for none, undefined for a form with no single written target. */
function cdTarget(args: ReadonlyArray<string>): string | undefined {
  const operands = [...args];
  while (operands.length > 0 && /^-[LPqs]+$/.test(operands[0]!)) operands.shift();
  if (operands[0] === "--") operands.shift();
  if (operands.length === 0) return "~";
  return operands.length === 1 ? operands[0] : undefined;
}

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

const SHELL_PROGRAM = /^(?:(?:\/usr)?\/bin\/)?(?:ba|z|da)?sh$/;

/** `sh`, `bash`, `zsh` or `dash`, bare or in `/bin` or `/usr/bin`. */
export function isShellProgram(program: string): boolean {
  return SHELL_PROGRAM.test(program);
}

/** A program the classifier accepts whatever its arguments are. */
export function isPlainReadProgram(program: string): boolean {
  return PLAIN_READ_PROGRAMS.has(program);
}

/**
 * The script inside `/bin/zsh -lc '<script>'`, the form Codex reports a shell command in, or the
 * command unchanged when it isn't one. Only a lone shell call with `-c`, `-lc` or `-l -c` and one
 * literal script is unwrapped; the script is then classified like any other command, and
 * anything else is classified as written (where a shell is not on the allowlist).
 */
export function unwrapShellInvocation(command: string): string {
  let script;
  try {
    script = parse(command);
  } catch {
    return command;
  }
  if ((script.errors && script.errors.length > 0) || script.commands.length !== 1) return command;
  const statement = script.commands[0]!;
  const node = statement.command;
  if (statement.background || node.type !== "Command" || node.prefix.length > 0) return command;
  if (!node.name || !isStaticWord(node.name) || !isShellProgram(node.name.value)) return command;
  const args: string[] = [];
  for (const entry of node.suffix) {
    if (entry.type !== "Word" || !isStaticWord(entry)) return command;
    args.push(entry.value);
  }
  if (args.length === 2 && (args[0] === "-c" || args[0] === "-lc")) return args[1]!;
  if (args.length === 3 && args[0] === "-l" && args[1] === "-c") return args[2]!;
  return command;
}

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
  const scope: ShellScope = new Map();
  for (const statement of script.commands) {
    const verdict = classifyTopLevelStatement(statement, scope);
    if (!verdict.readOnly) return verdict;
  }
  return READ_ONLY;
}

/**
 * Script-local variables set earlier in the command, with their literal values. A model often
 * writes `HEAD_SHA=abc123` once and then `git show "$HEAD_SHA"`; each later `$HEAD_SHA` is
 * classified as the literal it stands for. A variable counts only when it is certainly set before
 * use: a statement of its own at the top level, or the first command of a top-level `&&`/`||`
 * chain. Its value must itself be literal (or built from earlier such variables).
 */
type ShellScope = Map<string, string>;

/**
 * Names a shell, or a program F5 allows, gives a meaning to. Setting one in the shell changes an
 * exported value children inherit (`GIT_DIR`, `PAGER`, `LD_PRELOAD`) or the shell's own behavior
 * (`IFS`, `PATH`, zsh's `path` array), so these are refused rather than tracked. Compared in upper
 * case, so `home` and `Path` are refused too.
 */
const SPECIAL_VARIABLES = new Set([
  "_",
  "PATH",
  "HOME",
  "IFS",
  "ENV",
  "CDPATH",
  "SHELL",
  "SHELLOPTS",
  "GLOBIGNORE",
  "FIGNORE",
  "PS1",
  "PS2",
  "PS3",
  "PS4",
  "PROMPT",
  "RPROMPT",
  "PROMPT_COMMAND",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PWD",
  "OLDPWD",
  "USER",
  "LOGNAME",
  "MAIL",
  "MAILCHECK",
  "INPUTRC",
  "TERM",
  "TERMINFO",
  "TERMCAP",
  "PAGER",
  "EDITOR",
  "VISUAL",
  "BROWSER",
  "OPTIND",
  "OPTARG",
  "REPLY",
  "NULLCMD",
  "READNULLCMD",
  "FUNCNEST",
  "EXECIGNORE",
  "POSIXLY_CORRECT",
  "TIMEFORMAT",
  "SECONDS",
  "RANDOM",
  "LINENO",
  "COLUMNS",
  "LINES",
]);
const SPECIAL_VARIABLE_PREFIXES = [
  "LD_",
  "DYLD_",
  "GIT_",
  "GH_",
  "GITHUB_",
  "GLAMOUR_",
  "XDG_",
  "NODE_",
  "NPM_",
  "YARN_",
  "BUN_",
  "PYTHON",
  "PERL",
  "RUBY",
  "JAVA",
  "LESS",
  "RIPGREP_",
  "FZF_",
  "FD_",
  "JQ_",
  "SSH_",
  "GPG",
  "GNUPG",
  "SSL_",
  "CURL_",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "BASH",
  "ZSH",
  "HIST",
  "LC_",
  "TERM",
];
const SPECIAL_VARIABLE_SUFFIXES = [
  "PATH",
  "HOME",
  "DIR",
  "PAGER",
  "EDITOR",
  "_CONFIG",
  "_OPTS",
  "_OPTIONS",
  "_ARGS",
  "_FLAGS",
  "_COMMAND",
  "_CMD",
  "_PROGRAM",
  "_SHELL",
  "_PROXY",
];
/** zsh's lowercase special parameters, several tied to an uppercase one (`path` is `PATH`). */
const ZSH_SPECIAL_PARAMETERS = new Set([
  "path",
  "cdpath",
  "fpath",
  "manpath",
  "mailpath",
  "module_path",
  "psvar",
  "watch",
  "histchars",
  "prompt",
  "argv",
  "status",
  "pipestatus",
  "options",
  "signals",
  "parameters",
  "commands",
  "functions",
  "aliases",
  "galiases",
  "saliases",
  "builtins",
  "jobstates",
  "jobtexts",
  "jobdirs",
  "nameddirs",
  "userdirs",
  "dirstack",
  "funcstack",
  "history",
  "historywords",
  "modules",
  "reswords",
  "terminfo",
  "termcap",
  "widgets",
  "keymaps",
  "mapfile",
  "match",
  "mbegin",
  "mend",
  "reply",
  "zle_highlight",
]);

function isSpecialVariable(name: string): boolean {
  if (ZSH_SPECIAL_PARAMETERS.has(name)) return true;
  const upper = name.toUpperCase();
  return (
    SPECIAL_VARIABLES.has(upper) ||
    SPECIAL_VARIABLE_PREFIXES.some((prefix) => upper.startsWith(prefix)) ||
    SPECIAL_VARIABLE_SUFFIXES.some((suffix) => upper.endsWith(suffix))
  );
}

/** `NAME=value …` with nothing else: no program, redirection or argument. */
function assignmentOnly(node: Statement["command"]): Command | undefined {
  return node.type === "Command" &&
    !node.name &&
    node.suffix.length === 0 &&
    node.prefix.length > 0 &&
    node.prefix.every((entry) => entry.type === "Assignment")
    ? node
    : undefined;
}

/** Adds an assignment-only command's variables to `scope`, left to right like the shell. */
function bindVariables(command: Command, scope: ShellScope): ReadOnlyShellClassification {
  for (const entry of command.prefix) {
    if (entry.type !== "Assignment") return refuse("a command name is required");
    const name = entry.name;
    if (isSpecialVariable(name))
      return refuse(`setting ${name} is not allowed: write the value literally instead`);
    if (entry.append || entry.index !== undefined || entry.value.type !== "Word")
      return refuse(`${name} must be set to a literal value: write the value literally instead`);
    const value = resolveWord(entry.value, scope, { splits: false });
    if (!value.ok) return refuse(value.reason);
    scope.set(name, value.value);
  }
  return READ_ONLY;
}

function classifyTopLevelStatement(
  statement: Statement,
  scope: ShellScope,
): ReadOnlyShellClassification {
  if (statement.background) return refuse("background commands are not allowed");
  const node = statement.command;
  const assignments = assignmentOnly(node);
  if (assignments) return bindVariables(assignments, scope);
  const leading = node.type === "AndOr" && node.commands[0] && assignmentOnly(node.commands[0]);
  if (node.type === "AndOr" && leading) {
    const bound = bindVariables(leading, scope);
    if (!bound.readOnly) return bound;
    for (const entry of node.commands.slice(1)) {
      const verdict = classifyPipelineNode(entry, 0, scope);
      if (!verdict.readOnly) return verdict;
    }
    return READ_ONLY;
  }
  return classifyStatement(statement, 0, scope);
}

type ResolvedWord =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string };

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** An unquoted value with any of these would be split into words or matched as a glob. */
const SPLITS_OR_GLOBS = /[\s*?[\]]/;

/**
 * A word's value with the scope's variables expanded, or why it can't be known. Any other
 * expansion (command substitution, `$1`, `${X:-y}`, unknown variables) is refused. `splits` is
 * false for assignment values, which the shell neither splits nor globs; elsewhere an unquoted
 * variable must expand to exactly one plain word.
 */
function resolveWord(
  word: Word,
  scope: ReadonlyMap<string, string>,
  options: { readonly splits: boolean },
): ResolvedWord {
  if (!word.parts) return { ok: true, value: word.value };
  let value = "";
  const visit = (
    parts: ReadonlyArray<WordPart | DoubleQuotedChild>,
    quoted: boolean,
  ): string | undefined => {
    for (const part of parts) {
      switch (part.type) {
        case "Literal":
        case "SingleQuoted":
        case "AnsiCQuoted":
          value += part.value;
          continue;
        case "DoubleQuoted":
        case "LocaleString": {
          const failure = visit(part.parts, true);
          if (failure) return failure;
          continue;
        }
        case "SimpleExpansion":
        case "ParameterExpansion": {
          const name =
            part.type === "SimpleExpansion"
              ? part.text.slice(1)
              : part.prefix === undefined &&
                  part.index === undefined &&
                  part.operation === undefined
                ? part.parameter
                : undefined;
          if (name === undefined || !VARIABLE_NAME.test(name))
            return "arguments must be literal: no substitutions or special expansions";
          const known = scope.get(name);
          if (known === undefined)
            return `$${name} is not set earlier in this command: set ${name}=value before using it, or write the value literally`;
          if (!quoted && options.splits && (known === "" || SPLITS_OR_GLOBS.test(known)))
            return `quote "$${name}": its value is empty or has spaces or wildcards`;
          value += known;
          continue;
        }
        default:
          return "arguments must be literal: no command substitutions or other expansions";
      }
    }
    return undefined;
  };
  const failure = visit(word.parts, false);
  return failure === undefined ? { ok: true, value } : { ok: false, reason: failure };
}

/**
 * Deeper nesting of `if`, `{ }` and `( )` is refused rather than walked. An `elif` is not nesting:
 * it stays at its `if`'s depth and counts toward MAX_ELIF_CLAUSES instead.
 */
const MAX_COMPOUND_DEPTH = 8;
const MAX_ELIF_CLAUSES = 32;

function classifyStatement(
  statement: Statement,
  depth: number,
  scope: ShellScope,
): ReadOnlyShellClassification {
  if (statement.background) return refuse("background commands are not allowed");
  const node = statement.command;
  if (node.type === "AndOr") {
    for (const entry of node.commands) {
      const verdict = classifyPipelineNode(entry, depth, scope);
      if (!verdict.readOnly) return verdict;
    }
    return READ_ONLY;
  }
  return classifyPipelineNode(node, depth, scope);
}

function classifyPipelineNode(
  node: PipelineNode,
  depth: number,
  scope: ShellScope,
): ReadOnlyShellClassification {
  if (node.type === "Pipeline") {
    if (node.operators.some((operator) => operator !== "|"))
      return refuse("only plain `|` pipes are allowed");
    for (const entry of node.commands) {
      const verdict = classifyCommandNode(entry, depth, scope);
      if (!verdict.readOnly) return verdict;
    }
    return READ_ONLY;
  }
  if (node.type === "Time" || node.type === "Negation")
    return refuse(`${node.type} commands are not allowed`);
  return classifyCommandNode(node, depth, scope);
}

/**
 * A simple command, or an `if`/`elif`/`else`, `{ …; }` or `( … )` whose every nested statement
 * is read-only. Redirections on a compound pass the same `/dev/null`-only check as a simple
 * command's. Loops, `case`, functions, coprocesses and `[[ ]]`/`(( ))` stay refused: a loop can
 * run without end and the others add expansions this classifier does not inspect.
 */
function classifyCommandNode(
  node: CommandNode,
  depth: number,
  scope: ShellScope,
): ReadOnlyShellClassification {
  switch (node.type) {
    case "Command":
      return classifyCommand(node, scope);
    case "Redirected": {
      for (const redirection of node.redirects) {
        const verdict = classifyRedirection(redirection);
        if (!verdict.readOnly) return verdict;
      }
      return classifyCommandNode(node.command, depth, scope);
    }
    case "If":
      if (depth >= MAX_COMPOUND_DEPTH) return refuse("commands are nested too deeply");
      return classifyIfChain(node, depth + 1, scope);
    case "BraceGroup":
    case "Subshell":
      if (depth >= MAX_COMPOUND_DEPTH) return refuse("commands are nested too deeply");
      return classifyCompoundList(node.body, depth + 1, scope);
    default:
      return refuse(`${node.type} commands are not allowed`);
  }
}

/**
 * An `if` and its `elif` clauses, which unbash stores as an `If` in the previous clause's `else`.
 * Walked in a loop so a flat chain neither counts as nesting nor recurses per clause.
 */
function classifyIfChain(node: If, depth: number, scope: ShellScope): ReadOnlyShellClassification {
  let clause: If = node;
  for (let clauses = 1; ; clauses += 1) {
    if (clauses > MAX_ELIF_CLAUSES) return refuse("too many `elif` clauses");
    for (const list of [clause.clause, clause.then]) {
      const verdict = classifyCompoundList(list, depth, scope);
      if (!verdict.readOnly) return verdict;
    }
    const rest = clause.else;
    if (rest === undefined) return READ_ONLY;
    if (rest.type !== "If") return classifyCompoundList(rest, depth, scope);
    clause = rest;
  }
}

function classifyCompoundList(
  list: CompoundList,
  depth: number,
  scope: ShellScope,
): ReadOnlyShellClassification {
  if (list.commands.length === 0) return refuse("empty command");
  for (const statement of list.commands) {
    const verdict = classifyStatement(statement, depth, scope);
    if (!verdict.readOnly) return verdict;
  }
  return READ_ONLY;
}

function classifyCommand(command: Command, scope: ShellScope): ReadOnlyShellClassification {
  // Variables count only where they are certainly set before use (classifyTopLevelStatement).
  if (assignmentOnly(command))
    return refuse(
      "variables must be set on their own at the top level, or first in an `&&` chain: or write the value literally",
    );
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

  // Every argument must be literal, or a variable this command set to a literal earlier, which
  // is checked as the value it stands for. A substitution runs a command, any other variable could
  // expand to a flag that writes or executes, and `echo $GH_TOKEN` would put a secret in the
  // model's context. `cmd NAME=value` is a plain argument for every allowed program.
  const args: string[] = [];
  for (const entry of command.suffix) {
    if (entry.type === "Assignment") {
      if (entry.value.type !== "Word") return refuse("arguments must be literal");
      const value = resolveWord(entry.value, scope, { splits: true });
      if (!value.ok) return refuse(value.reason);
      continue;
    }
    if (entry.type !== "Word") continue;
    const value = resolveWord(entry, scope, { splits: true });
    if (!value.ok) return refuse(value.reason);
    args.push(value.value);
  }

  if (program === "cd") directoryUses?.push({ kind: "cd", path: cdTarget(args) });
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
  const directories: string[] = [];
  while (index < args.length && args[index]!.startsWith("-")) {
    const arg = args[index]!;
    if (arg === "-C") {
      if (index + 1 >= args.length) return refuse("`git -C` needs a directory");
      directories.push(args[index + 1]!);
      index += 2;
      continue;
    }
    if (arg === "--no-pager" || arg === "--no-optional-locks") {
      index += 1;
      continue;
    }
    return refuse(`\`git ${arg}\` is not allowed`);
  }
  directoryUses?.push({ kind: "git", path: directories });
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
