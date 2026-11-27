import {
  parse,
  type Command,
  type CommandNode,
  type CompoundList,
  type DoubleQuotedChild,
  type For,
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
 * optionally inside `if`/`elif`/`else`, `{ …; }`, `( … )` or a `for` loop over literal words, are
 * accepted, each running an allowlisted program with flags that cannot write or execute.
 */
export type ReadOnlyShellClassification =
  | { readonly readOnly: true }
  | { readonly readOnly: false; readonly reason: string };

/**
 * Added to the environment of providers whose read-only stages use this classifier. `git status`
 * otherwise refreshes the index and holds `index.lock`, which can fail a concurrent Git command in
 * the same worktree.
 */
export const READ_ONLY_WORKFLOW_ENVIRONMENT = { GIT_OPTIONAL_LOCKS: "0" } as const;

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
  "nl",
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
  "shasum",
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

/** Options before the subcommand that neither run a program nor change which repository is read. */
const GIT_GLOBAL_SWITCHES = new Set([
  "--no-pager",
  "-P",
  "--no-optional-locks",
  "--no-lazy-fetch",
  "--no-replace-objects",
  "--literal-pathspecs",
]);

/**
 * `git branch` and `git tag` create a ref from a bare name, so listing is accepted only in a form
 * that cannot: switches spelled exactly as below (git's abbreviations are refused), and a name or
 * pattern only as the value of a filter or after `--list`.
 */
const GIT_REF_LIST_SWITCHES = new Set([
  "-i",
  "--ignore-case",
  "--no-color",
  "--color",
  "--column",
  "--no-column",
  "--omit-empty",
]);
/** `git branch` only: for `git tag`, `-a` creates an annotated tag and `-v` runs gpg. */
const GIT_BRANCH_LIST_SWITCHES = new Set([
  "--show-current",
  "--all",
  "--remotes",
  "--verbose",
  "--no-abbrev",
]);
const GIT_BRANCH_LIST_CLUSTER = /^-[arv]+$/;
const GIT_REF_LIST_MODE = new Set(["-l", "--list"]);
/** Each takes one value, attached with `=` or as the next argument. */
const GIT_REF_LIST_VALUE_FLAGS = new Set([
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
  "--sort",
  "--format",
]);
const GIT_REF_LIST_VALUE_SWITCH = /^--(?:color|column|abbrev)=[\w,-]+$/;
const GIT_WORKTREE_LIST_FLAGS = new Set(["--porcelain", "-v", "--verbose", "-z"]);

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

/** A sed address: a line number, `$`, or `/regex/` (with `\/` escapes and an optional `I`). */
const SED_ADDRESS = String.raw`(?:\d+|\$|/(?:[^/\\\n]|\\[^\n])*/I?)`;
/** One print command, `<address>[,<address>]p`, up to the `;`, newline or end that closes it. */
const SED_PRINT_COMMAND = new RegExp(
  String.raw`^${SED_ADDRESS}(?:,${SED_ADDRESS})?[ \t]*p[ \t]*(?=;|\n|$)`,
);

/**
 * Whether a sed script only prints: one or more `<address>[,<address>]p` commands separated by
 * `;` or newlines. Every other sed command is refused by not matching: `w` and `s///w` write a
 * file, `e` runs a program and `r` reads any file into the output.
 */
function isSedPrintScript(script: string): boolean {
  let rest = script;
  for (let commands = 0; ; commands += 1) {
    rest = rest.replace(/^[\s;]+/, "");
    if (rest.length === 0) return commands > 0;
    const match = SED_PRINT_COMMAND.exec(rest);
    if (!match) return false;
    rest = rest.slice(match[0].length);
  }
}

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
  const scope = new ShellScope();
  for (const statement of script.commands) {
    const verdict = classifyTopLevelStatement(statement, scope);
    if (!verdict.readOnly) return verdict;
  }
  return READ_ONLY;
}

/**
 * Script-local variables set earlier in the command, with their literal values. A model often
 * writes `HEAD_SHA=abc123` once and then `git show "$HEAD_SHA"`; each later `$HEAD_SHA` is
 * classified as the literal it stands for. Its value must itself be literal (or built from
 * earlier variables), and it must be set at the top level:
 *
 * - as a statement of its own, or first in an `&&`/`||` chain: certainly set from then on;
 * - later in an `&&` chain (`cd repo && F=a.ts; git show rev:$F`): certainly set for the rest of
 *   that chain, and `conditional` after it, because the chain may have stopped before the
 *   assignment. A command that uses a conditional variable must be read-only with the value and
 *   with the variable unset (classifyCommand).
 */
class ShellScope extends Map<string, string> {
  readonly conditional = new Set<string>();
  /** `for` loops currently being walked; see MAX_LOOP_DEPTH. */
  loopDepth = 0;

  /** A copy for a loop body, with the loop variable certainly set. */
  withLoopVariable(name: string, value: string): ShellScope {
    const copy = new ShellScope(this);
    for (const entry of this.conditional) copy.conditional.add(entry);
    copy.conditional.delete(name);
    copy.set(name, value);
    copy.loopDepth = this.loopDepth + 1;
    return copy;
  }
}

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

/**
 * Adds an assignment-only command's variables to `scope`, left to right like the shell.
 * `afterChain` is given for an assignment that may not run (not first in its `&&` chain): the
 * names it sets are appended, to be marked conditional once the chain ends.
 */
function bindVariables(
  command: Command,
  scope: ShellScope,
  afterChain?: string[],
): ReadOnlyShellClassification {
  for (const entry of command.prefix) {
    if (entry.type !== "Assignment") return refuse("a command name is required");
    const name = entry.name;
    if (isSpecialVariable(name))
      return refuse(`setting ${name} is not allowed: write the value literally instead`);
    if (entry.append || entry.index !== undefined || entry.value.type !== "Word")
      return refuse(`${name} must be set to a literal value: write the value literally instead`);
    const used = new Set<string>();
    const value = resolveWord(entry.value, scope, { splits: false, used });
    if (!value.ok) return refuse(value.reason);
    // The value would be one of two texts; only one can be checked.
    const [conditional] = used;
    if (conditional !== undefined)
      return refuse(
        `${name} is built from $${conditional}, which may be unset here: set ${conditional} on a line of its own first`,
      );
    if (afterChain === undefined) {
      scope.set(name, value.value);
      scope.conditional.delete(name);
      continue;
    }
    const previous = scope.get(name);
    if (previous !== undefined && previous !== value.value)
      return refuse(`${name} is already set: use another name, or set it on a line of its own`);
    // Certainly set with this value already: the assignment changes nothing either way.
    if (previous !== undefined && !scope.conditional.has(name)) continue;
    scope.set(name, value.value);
    scope.conditional.delete(name);
    afterChain.push(name);
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
  if (node.type !== "AndOr") return classifyPipelineNode(node, 0, scope);
  // After an `||` a command also runs when an earlier one failed, so a variable set mid-chain
  // would not be certainly set even for the rest of the chain.
  const onlyAnd = node.operators.every((operator) => operator === "&&");
  const afterChain: string[] = [];
  for (const [index, entry] of node.commands.entries()) {
    const assigned = index === 0 || onlyAnd ? assignmentOnly(entry) : undefined;
    const verdict = assigned
      ? bindVariables(assigned, scope, index === 0 ? undefined : afterChain)
      : classifyPipelineNode(entry, 0, scope);
    if (!verdict.readOnly) return verdict;
  }
  for (const name of afterChain) scope.conditional.add(name);
  return READ_ONLY;
}

type ResolvedWord =
  | {
      readonly ok: true;
      readonly value: string;
      /** False when the word is only unset variables, unquoted: the shell passes no argument. */
      readonly present: boolean;
    }
  | { readonly ok: false; readonly reason: string };

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** An unquoted value with any of these would be split into words or matched as a glob. */
const SPLITS_OR_GLOBS = /[\s*?[\]]/;

/**
 * A word's value with the scope's variables expanded, or why it can't be known. Any other
 * expansion (command substitution, `$1`, `${X:-y}`, unknown variables) is refused. `splits` is
 * false for assignment values, which the shell neither splits nor globs; elsewhere an unquoted
 * variable must expand to exactly one plain word.
 *
 * `used` collects the conditional variables the word reads. `unset` names the ones to expand as
 * unset instead, which is how classifyCommand checks the other outcome.
 */
function resolveWord(
  word: Word,
  scope: ShellScope,
  options: {
    readonly splits: boolean;
    readonly used?: Set<string>;
    readonly unset?: ReadonlySet<string>;
  },
): ResolvedWord {
  if (!word.parts) return { ok: true, value: word.value, present: true };
  let value = "";
  // Whether anything but an unset variable contributes: quotes make an (empty) argument too.
  let present = false;
  const visit = (
    parts: ReadonlyArray<WordPart | DoubleQuotedChild>,
    quoted: boolean,
  ): string | undefined => {
    for (const [index, part] of parts.entries()) {
      switch (part.type) {
        case "Literal":
        case "SingleQuoted":
        case "AnsiCQuoted":
          value += part.value;
          present = true;
          continue;
        case "DoubleQuoted":
        case "LocaleString": {
          present = true;
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
          // zsh, which Codex and the ACP agents run commands in, reads `$NAME:…` as history
          // modifiers (`$X:s/a/--flag/` rewrites the value into any text) and `$NAME[…]` as a
          // subscript, so the word would not be the literal checked here.
          const next = parts[index + 1];
          if (
            part.type === "SimpleExpansion" &&
            next?.type === "Literal" &&
            (next.value.startsWith(":") || next.value.startsWith("["))
          )
            return `write \${${name}} with braces before \`${next.value[0]}\`: zsh reads $${name}${next.value[0]}… as a modifier or subscript`;
          const known = scope.get(name);
          if (known === undefined)
            return `$${name} is not set earlier in this command: set ${name}=value before using it, or write the value literally`;
          if (!quoted && options.splits && (known === "" || SPLITS_OR_GLOBS.test(known)))
            return `quote "$${name}": its value is empty or has spaces or wildcards`;
          if (scope.conditional.has(name)) {
            options.used?.add(name);
            if (options.unset?.has(name)) continue;
          }
          value += known;
          present = true;
          continue;
        }
        default:
          return "arguments must be literal: no command substitutions or other expansions";
      }
    }
    return undefined;
  };
  const failure = visit(word.parts, false);
  return failure === undefined ? { ok: true, value, present } : { ok: false, reason: failure };
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
 * A simple command, or an `if`/`elif`/`else`, `{ …; }`, `( … )` or `for` over literal words whose
 * every nested statement is read-only. Redirections on a compound pass the same `/dev/null`-only
 * check as a simple command's. `while`/`until`, `case`, functions, coprocesses and
 * `[[ ]]`/`(( ))` stay refused: those loops can run without end and the others add expansions
 * this classifier does not inspect.
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
    case "For":
      if (depth >= MAX_COMPOUND_DEPTH) return refuse("commands are nested too deeply");
      return classifyForLoop(node, depth + 1, scope);
    default:
      return refuse(`${node.type} commands are not allowed`);
  }
}

/** A `for` list longer than this, or loops nested deeper, are refused rather than walked. */
const MAX_LOOP_WORDS = 64;
const MAX_LOOP_DEPTH = 2;
/** Unquoted, these make the shell produce words other than the one written. */
const LOOP_WORD_EXPANDS = /[*?[\]{}]|^~/;

/**
 * `for NAME in word …; do …; done` over literal words. The loop runs once per word, so the body
 * is classified once per word with NAME set to it: every command it can run is checked as the
 * text it will be. A list with a glob, a brace expansion, `~` or a variable is refused, since the
 * words would only be known when it runs; so is `for NAME; do` (the positional parameters).
 */
function classifyForLoop(node: For, depth: number, scope: ShellScope): ReadOnlyShellClassification {
  const literalList = refuse(
    "`for` is only allowed over literal words: `for f in a.ts b.ts; do …; done`",
  );
  if (scope.loopDepth >= MAX_LOOP_DEPTH) return refuse("`for` loops are nested too deeply");
  if (!isStaticWord(node.name) || !VARIABLE_NAME.test(node.name.value)) return literalList;
  const name = node.name.value;
  if (isSpecialVariable(name))
    return refuse(`looping over ${name} is not allowed: use another variable name`);
  const words = node.wordlist;
  if (words === undefined || words.length === 0) return literalList;
  if (words.length > MAX_LOOP_WORDS)
    return refuse(`\`for\` lists are limited to ${MAX_LOOP_WORDS} words`);
  for (const word of words) {
    if (!isStaticWord(word)) return literalList;
    const unquoted = word.parts
      ? word.parts.map((part) => (part.type === "Literal" ? part.value : "")).join("")
      : word.value;
    if (LOOP_WORD_EXPANDS.test(unquoted)) return literalList;
  }
  for (const word of words) {
    const verdict = classifyCompoundList(
      node.body,
      depth,
      scope.withLoopVariable(name, word.value),
    );
    if (!verdict.readOnly) return verdict;
  }
  return READ_ONLY;
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
  // Variables count only where the classifier can follow them (classifyTopLevelStatement).
  if (assignmentOnly(command))
    return refuse(
      "variables must be set at the top level, on their own or in an `&&` chain, not inside `if`, `{ }`, `( )`, a loop, a pipe or after `||`: or write the value literally",
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
  // model's context.
  const used = new Set<string>();
  const args = resolveArguments(command, scope, { used });
  if (typeof args === "string") return refuse(args);
  const verdict = classifyProgram(program, args);
  if (!verdict.readOnly || used.size === 0) return verdict;

  // A conditional variable is either its value (checked above) or unset. Check every other
  // outcome too: an unset variable drops its argument, which can change what the rest mean
  // (`sed -n $RANGE notes.txt` would run `notes.txt` as the script).
  const names = [...used];
  if (names.length > MAX_CONDITIONAL_VARIABLES)
    return refuse(
      `too many variables set after \`&&\` in one command: set ${names[0]} and the others on lines of their own`,
    );
  for (let mask = 1; mask < 1 << names.length; mask += 1) {
    const unset = new Set(names.filter((_, bit) => (mask >> bit) & 1));
    const alternative = resolveArguments(command, scope, { unset });
    const outcome =
      typeof alternative === "string" ? refuse(alternative) : classifyProgram(program, alternative);
    if (!outcome.readOnly)
      return refuse(
        `$${[...unset][0]} is set after \`&&\`, so it may be unset here (${outcome.reason}): set it on a line of its own`,
      );
  }
  return READ_ONLY;
}

/** Above this, a command's set/unset outcomes are not enumerated (2^n of them). */
const MAX_CONDITIONAL_VARIABLES = 3;

/**
 * The arguments the program receives, or why they can't be known. `cmd NAME=value` is one
 * argument, like any other word.
 */
function resolveArguments(
  command: Command,
  scope: ShellScope,
  options: { readonly used?: Set<string>; readonly unset?: ReadonlySet<string> },
): string[] | string {
  const args: string[] = [];
  for (const entry of command.suffix) {
    if (entry.type === "Assignment") {
      if (entry.value.type !== "Word" || entry.index !== undefined)
        return "arguments must be literal";
      const value = resolveWord(entry.value, scope, { splits: true, ...options });
      if (!value.ok) return value.reason;
      args.push(`${entry.name}${entry.append ? "+" : ""}=${value.value}`);
      continue;
    }
    if (entry.type !== "Word") continue;
    const value = resolveWord(entry, scope, { splits: true, ...options });
    if (!value.ok) return value.reason;
    if (value.present) args.push(value.value);
  }
  return args;
}

function classifyProgram(
  program: string,
  args: ReadonlyArray<string>,
): ReadOnlyShellClassification {
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
    case "base64":
      return classifyBase64(args);
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
  // With `-e`, every operand is a file; without it the first operand is the script.
  const expressions: string[] = [];
  let firstOperand: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("-") || arg === "-") {
      firstOperand ??= arg;
      continue;
    }
    if (arg === "--quiet" || arg === "--silent") {
      quiet = true;
      continue;
    }
    if (arg === "--regexp-extended") continue;
    if (arg.startsWith("--expression=")) {
      expressions.push(arg.slice("--expression=".length));
      continue;
    }
    // `-n`, `-E`, `-r` in any group, optionally ending in `-e`, which takes the next argument.
    const cluster = arg === "--expression" ? ["", "", "e"] : /^-([nEr]*)(e?)$/.exec(arg);
    if (!cluster) return refuse(`\`sed ${arg}\` is not allowed`);
    if (cluster[1]!.includes("n")) quiet = true;
    if (cluster[2]) {
      const expression = args[index + 1];
      if (expression === undefined) return refuse("`sed -e` needs a script");
      expressions.push(expression);
      index += 1;
    }
  }
  const scripts =
    expressions.length > 0 ? expressions : firstOperand === undefined ? [] : [firstOperand];
  if (!quiet || scripts.length === 0)
    return refuse("`sed` is only allowed as `sed -n '<lines or /regex/>p'`");
  return scripts.every(isSedPrintScript)
    ? READ_ONLY
    : refuse("`sed` may only print lines: `sed -n '10,20p;/regex/,$p'`");
}

/** `base64` writes its output to a file with `-o`/`--output` (macOS); everything else reads. */
function classifyBase64(args: ReadonlyArray<string>): ReadOnlyShellClassification {
  return args.some((arg) => /^-[a-zA-Z]*o/.test(arg) || abbreviatesLongOption(arg, "output"))
    ? refuse("`base64 -o` writes a file")
    : READ_ONLY;
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
    if (GIT_GLOBAL_SWITCHES.has(arg)) {
      index += 1;
      continue;
    }
    if (arg === "--version" && args.length === 1) return READ_ONLY;
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
  switch (subcommand) {
    case "grep":
      // `-O[<pager>]` opens the matching files in a program. git accepts it inside a group of
      // short flags (`-nO`, `-iOless`), so any group with an `O` is refused; `--open-files-in-pager`
      // and `--textconv` are refused above. A pattern attached to its flag (`-eOK`) is refused
      // too: write it as a separate argument.
      return rest.some((arg) => /^-[^-]*O/.test(arg))
        ? refuse("`git grep -O` opens files in a program")
        : READ_ONLY;
    case "branch":
      return classifyGitRefListing("branch", rest);
    case "tag":
      return classifyGitRefListing("tag", rest);
    case "remote":
      if (rest.length === 0) return READ_ONLY;
      if (rest.length === 1 && (rest[0] === "-v" || rest[0] === "--verbose")) return READ_ONLY;
      if (rest.length === 2 && rest[0] === "get-url" && !rest[1]!.startsWith("-")) return READ_ONLY;
      return refuse("`git remote` is only allowed bare, as `-v` or as `get-url`");
    case "worktree":
      return rest[0] === "list" && rest.slice(1).every((arg) => GIT_WORKTREE_LIST_FLAGS.has(arg))
        ? READ_ONLY
        : refuse("`git worktree` is only allowed as `git worktree list`");
    case "stash":
      // `list` takes `git log` options, which are checked like `git log`'s above.
      return rest[0] === "list"
        ? READ_ONLY
        : refuse("`git stash` is only allowed as `git stash list`");
    default:
      return refuse(`\`git ${subcommand}\` is not on the read-only allowlist`);
  }
}

/**
 * `git branch` or `git tag` in a form that can only list (GIT_REF_LIST_SWITCHES). A bare name
 * would create a ref, so an operand is accepted only as the value of a filter (`--contains
 * <commit>`) or, as a pattern, when `--list` is given.
 */
function classifyGitRefListing(
  subcommand: "branch" | "tag",
  args: ReadonlyArray<string>,
): ReadOnlyShellClassification {
  const refused = refuse(
    `\`git ${subcommand}\` is only allowed for listing: put names and patterns after \`--list\``,
  );
  const listMode = args.some((arg) => GIT_REF_LIST_MODE.has(arg));
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (GIT_REF_LIST_MODE.has(arg) || GIT_REF_LIST_SWITCHES.has(arg)) continue;
    if (GIT_REF_LIST_VALUE_SWITCH.test(arg)) continue;
    if (
      subcommand === "branch"
        ? GIT_BRANCH_LIST_SWITCHES.has(arg) || GIT_BRANCH_LIST_CLUSTER.test(arg)
        : /^-n\d*$/.test(arg)
    )
      continue;
    if (GIT_REF_LIST_VALUE_FLAGS.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) return refused;
      index += 1;
      continue;
    }
    const assigned = /^(--[a-z-]+)=/.exec(arg);
    if (assigned && GIT_REF_LIST_VALUE_FLAGS.has(assigned[1]!)) continue;
    if (arg.startsWith("-") || !listMode) return refused;
  }
  return READ_ONLY;
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
