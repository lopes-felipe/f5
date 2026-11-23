import type { SourceControlPullRequestRef, SourceControlProviderKind } from "@t3tools/contracts";

const COMMAND_START =
  "(?:^|[;&|({`\\n]|\\b(?:do|then|else)\\s)\\s*(?:(?:\\w+=\\S*|env|time|nohup|timeout\\s+\\S+)\\s+)*";
const CREATE_COMMANDS = [
  { kind: "github", command: /\bgh\s+pr\s+create\b/ },
  { kind: "gitlab", command: /\bglab\s+mr\s+create\b/ },
].map(({ kind, command }) => ({
  kind,
  command,
  run: new RegExp(COMMAND_START + command.source + "(?=$|[\\s;&|)])", "gu"),
}));
const createCommandCount = (code: string) =>
  CREATE_COMMANDS.reduce((count, { run }) => count + [...code.matchAll(run)].length, 0);

// Codex runs each command as `/bin/zsh -lc <script>`, quoting the script in pieces such as
// `"a "'`b`'" c"`.
const SHELL_WRAPPER = /^\s*(?:\S*\/)?(?:ba|z|da|k)?sh\s+-l?c\s+(?=["'])([\s\S]*)$/u;
const SHELL_WORD_PIECE = /"((?:\\[\s\S]|[^"\\])*)"|'([^']*)'|\\([\s\S])|(\S)/gu;
// Heredoc bodies, quoted strings and comments are text a command carries, not commands it runs.
const HEREDOC_BODY =
  /<<-?[ \t]*(['"]?)(\w+)\1[^\n]*\n(?:(?:[\s\S]*?\n)?[ \t]*\2[ \t]*(?=\n|$)|[\s\S]*$)/gu;
const QUOTED_OR_COMMENT = /'[^']*'|"(?:\\[\s\S]|[^"\\])*"|(?<=^|[\s;&|(])#[^\n]*/gmu;
const COMMAND_SEPARATOR = /&&|\|\||[;|\n]/u;
// Commands that print other change requests' URLs, so output beside them proves nothing.
const LISTS_CHANGE_REQUESTS =
  /\b(?:gh\s+(?:pr\s+(?:view|list|status)|search\s+prs|api)|glab\s+(?:mr\s+(?:view|list)|api))\b/u;
const URL_LINE = /^[ \t]*(https?:\/\/\S+)[ \t]*$/gmu;

/** The script a shell input runs, unwrapped from Codex's `sh -lc`. */
function shellScript(input: string): string {
  const [, wrapped] = SHELL_WRAPPER.exec(input) ?? [];
  return wrapped === undefined
    ? input
    : Array.from(
        wrapped.matchAll(SHELL_WORD_PIECE),
        ([, double, single, escaped, bare]) =>
          double?.replace(/\\(["\\$`])/gu, "$1") ?? single ?? escaped ?? bare,
      ).join("");
}

/** A script split at command separators that sit outside quotes. */
function shellSegments(script: string): ReadonlyArray<string> {
  const segments: Array<string> = [];
  let current = "";
  let quote: string | null = null;
  for (let index = 0; index < script.length; index++) {
    const char = script[index] ?? "";
    if (quote !== null) {
      current += char;
      if (char === "\\" && quote === '"') current += script[++index] ?? "";
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    if (char === "\\") {
      current += char + (script[++index] ?? "");
      continue;
    }
    const pair = script.slice(index, index + 2);
    if (pair === "&&" || pair === "||" || char === ";" || char === "|" || char === "\n") {
      segments.push(current);
      current = "";
      if (pair === "&&" || pair === "||") index++;
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

/** The commands a script runs, without the text it carries. */
const shellCode = (script: string) =>
  script.replace(HEREDOC_BODY, "<<").replace(QUOTED_OR_COMMENT, "''");

/**
 * The change requests a shell command opened: URLs on lines of their own in the output of a
 * command that runs a host's create command. One the command also names, as `gh pr view 12`
 * does, existed before it ran. More URLs than create commands means something else printed
 * some, such as `gh pr list`, so none are taken.
 */
export function changeRequestsCreatedBy(
  input: string,
  output: string,
  parseUrl: (url: string, kind?: SourceControlProviderKind) => SourceControlPullRequestRef | null,
  allowedGitLabHosts: ReadonlySet<string> = new Set(["gitlab.com"]),
) {
  if (!CREATE_COMMANDS.some(({ command }) => command.test(input))) return [];
  const script = shellScript(input);
  const code = shellCode(script).trim();
  const creates = createCommandCount(code);
  // A successful shell exit only proves the create ran when it is the final
  // command in a plain && chain. Branches, pipelines and later lookups are ambiguous.
  if (creates !== 1 || /[;|\n&`(){}]/u.test(code.replaceAll("&&", ""))) return [];
  const finalCommand = code.split("&&").at(-1) ?? "";
  if (createCommandCount(finalCommand) !== 1) return [];
  const otherCommands = code
    .split(COMMAND_SEPARATOR)
    .filter((part) => createCommandCount(part) === 0)
    .join("\n");
  if (LISTS_CHANGE_REQUESTS.test(otherCommands)) return [];
  const otherScript = shellSegments(script.replace(HEREDOC_BODY, "<<"))
    .filter((segment) => createCommandCount(shellCode(segment)) === 0)
    .join("\n");
  const creators = new Set(
    CREATE_COMMANDS.filter(({ run }) => code.match(run) !== null).map(({ kind }) => kind),
  );
  const created = new Map<string, SourceControlPullRequestRef & { readonly url: string }>();
  for (const [, url = ""] of output.matchAll(URL_LINE)) {
    const kind = url.includes("/-/merge_requests/") ? "gitlab" : "github";
    const link = parseUrl(url, kind);
    if (link?.provider === "github" && link.host !== "github.com") continue;
    if (link?.provider === "gitlab" && !allowedGitLabHosts.has(link.host)) continue;
    if (link === null || !creators.has(link.provider)) continue;
    const expectedPath = link.provider === "github" ? "/pull/" : "/-/merge_requests/";
    const parsed = new URL(url);
    if (
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password ||
      parsed.protocol !== "https:" ||
      parsed.port ||
      parsed.pathname !== "/" + link.repository + expectedPath + link.number
    )
      continue;
    const named = new RegExp(`(?:^|(?<=[\\s#/=("']))${link.number}(?=$|[\\s);&|/"'])`, "u");
    // Quoted text in the other commands counts, as in `printf '.../pull/12'`.
    if (named.test(otherScript)) continue;
    const canonical = "https://" + link.host + parsed.pathname;
    created.set(canonical, { ...link, url: canonical });
  }
  return created.size > creates ? [] : [...created.values()];
}
