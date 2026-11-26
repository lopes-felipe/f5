import { describe, expect, it } from "vitest";

import { classifyReadOnlyShellCommand } from "./readOnlyWorkflowShell.ts";

const readOnly = (command: string) => classifyReadOnlyShellCommand(command).readOnly;

describe("classifyReadOnlyShellCommand", () => {
  it.each([
    // The commands a Cursor reviewer issued in the failing workflow run.
    "gh pr view 743438 --repo doordash/pedregal --json number,title,body,state,author,baseRefName,baseRefOid,headRefName,headRefOid,files,commits,additions,deletions,changedFiles,url,mergeable,reviewDecision",
    "gh pr diff 743438 --repo doordash/pedregal",
    "git -C /Users/me/dev/pedregal status -sb && git -C /Users/me/dev/pedregal rev-parse HEAD",
    "GH_NO_UPDATE_NOTIFIER=1 gh api repos/x/y/pulls/1 --jq '{number,title}'",
    "gh api -X GET repos/x/y/pulls/1/files --paginate",
    // The Antigravity live certification's sandbox network probe relies on this one passing.
    "gh api zen",
    "rg -n foo | head",
    "sed -n '1,20p' file.ts",
    "sed -n 5p file.ts",
    "git log -1 2>/dev/null",
    "git --no-pager diff main...HEAD -- src 2>&1 | head -200",
    "git branch --show-current",
    "git remote get-url origin",
    "cd /tmp && ls -la",
    "ls src/*.ts ~/notes",
    "find . -name '*.ts' -not -path './node_modules/*'",
    "grep -rn TODO src < /dev/null",
    "command -v gh",
    "[ -d .git ] && echo yes || echo no",
    "sort -u file | uniq -c",
    "wc -l a b; du -sh .",
    "git --no-optional-locks -C repo status -sb",
    "git diff --text --stat HEAD~1",
    "git log --oneline --format=%H -5",
    "sort -t, -k2 -nr data.csv",
    "sort --key=2 --field-separator=: --unique f",
    "uniq -c -- -input",
    "gh api --template graphql repos/o/r",
    "gh api -H 'Accept: application/vnd.github.diff' repos/o/r/pulls/1",
    "gh api -i --paginate --method=GET repos/o/r/pulls --jq '.[].number'",
    "gh api -XGET --header='accept: application/json' repos/o/r",
    "gh pr checks 1 --repo o/r",
    "GIT_PAGER=cat git log -1",
    "GH_PAGER= gh pr view 1",
    "tail -n 20 log.txt",
    "gh pr view 1 --json title | jq '.title'",
    // Compound commands whose every nested statement reads
    'if [ -d /x/.git ]; then git -C /x status -sb; else echo "No repo"; fi',
    "if test -f a; then cat a; elif test -f b; then cat b; else echo none; fi",
    "if [ -d x ]; then if [ -f x/y ]; then cat x/y; fi; fi",
    "(git status)",
    "{ git status; git log -1; }",
    "{ git status; } 2>/dev/null",
    "(cd /x && git log -1) | head -5",
    "if [ -d x ]; then git -C x log -1; fi 2>/dev/null && echo done",
  ])("allows %s", (command) => {
    expect(classifyReadOnlyShellCommand(command)).toEqual({ readOnly: true });
  });

  it.each([
    // Compound commands
    "if [ -d x ]; then git log; else rm -rf x; fi",
    "if rm -rf x; then echo gone; fi",
    "if [ -d x ]; then git log; fi > out",
    "{ git status; } > out",
    "(git status; touch x)",
    "if [ -d x ]; then git log; elif true; then git push; fi",
    "for f in a b; do cat $f; done",
    "for f in a b; do cat a; done",
    "while true; do echo x; done",
    "until false; do echo x; done",
    "case x in x) echo x;; esac",
    "f() { cat a; }",
    "[[ -d x ]]",
    "(( 1 + 1 ))",
    "! git status",
    "time git status",
    "if [ -d x ]; then git log & fi",
    "( ".repeat(10) + "git status" + " )".repeat(10),
    // Shape
    "gh pr diff 1 > x.diff",
    "gh pr diff 1 >> x.diff",
    "echo $(rm -rf x)",
    "echo `rm -rf x`",
    "cat <(rm -rf x)",
    "sleep 1 &",
    "/usr/bin/git status",
    "cat <<EOF\nhi\nEOF",
    "X=1",
    // Mutating flags and subcommands
    "sed -i 's/a/b/' f",
    "sed -n 's/a/b/w out' f",
    "sed 's/a/b/' f",
    "find . -delete",
    "find . -exec rm {} ;",
    "find . -fprint out",
    "rg --pre sh foo",
    "fd -x rm",
    "sort -o out in",
    "uniq in out",
    "git push",
    "git fetch",
    "git -c core.pager=sh log",
    "git branch new",
    "git diff --output=x.patch",
    "git remote add origin x",
    // Abbreviated long options that GNU getopt and git expand to refused ones
    "git diff --outp=x.patch",
    "git diff --ext",
    "git show --textc HEAD",
    "sort --out=x in",
    "sort --compress-program=sh in",
    "sort -T /tmp in",
    "file --comp magic",
    "uniq -- in -out",
    "gh constructor list",
    "gh api --hostname graphql graphql",
    // Disallowed programs
    "xargs rm",
    "awk '{system(\"x\")}'",
    "rm -rf x",
    "tee out",
    "env rm x",
    "command rm x",
    "bash -c 'git status'",
    // gh
    "gh api -X POST repos/x/y/issues",
    "gh api --method=PATCH repos/x/y",
    "gh api -f a=b repos/x/y/issues",
    "gh api repos/x/y/issues --input body.json",
    "gh api graphql -f query='{viewer{login}}'",
    "gh api graphql",
    "gh auth token",
    "gh pr checkout 1",
    "gh pr merge 1",
    "gh pr view 1 --web",
    "gh pr view 1 -cw",
    // pflag groups short flags, so method and body flags hide inside a group
    "gh api -iXDELETE repos/o/r/git/refs/heads/main",
    "gh api -iX DELETE repos/o/r/git/refs/heads/main",
    "gh api -if body=hi repos/o/r/issues/1/comments",
    "gh api repos/o/r DELETE",
    "gh api -H 'Authorization: token x' repos/o/r",
    "gh api --hostname example.com repos/o/r",
    "gh api --cache 1h repos/o/r",
    // git grep opens matches in a program with -O, also inside a group or abbreviated
    "git grep -iO'touch /tmp/x' hello",
    "git grep --open-files='touch /tmp/x' hello",
    "git grep hello",
    // Commands that never exit
    "tail -f log.txt",
    "tail -nF 5 log.txt",
    "tail --follow=name log.txt",
    "tail --fol log.txt",
    "gh pr checks 1 --watch",
    // Environment and parsing
    "GIT_EXTERNAL_DIFF=x git diff",
    "GIT_DIR=/tmp git log",
    "GIT_PAGER='touch /tmp/x' git log -1",
    "PAGER='sh -c id' gh pr view 1",
    "GH_PAGER=less gh pr diff 1",
    "env",
    "echo $GH_TOKEN",
    'cat "$HOME/notes.md"',
    "echo ${GITHUB_TOKEN:-x}",
    "jq -n env",
    "jq -n '$ENV.GH_TOKEN'",
    "git log $FLAGS",
    "ls {a,b}",
    "find . -{delete,}",
    "echo 'unterminated",
    "",
  ])("refuses %s", (command) => {
    expect(readOnly(command)).toBe(false);
  });

  it("explains why a command was refused", () => {
    expect(classifyReadOnlyShellCommand("git push")).toEqual({
      readOnly: false,
      reason: "`git push` is not on the read-only allowlist",
    });
  });

  // zsh-only compound forms. unbash keeps a harmless first part and drops the rest, so only the
  // parse-error check stands between these and approval.
  it.each([
    "{ git status; } always { rm -rf x; }",
    "(echo a)(rm x)",
    "{ echo a; } { rm x; }",
    "if [ -d x ] { echo hi }",
  ])("refuses the zsh-only form %s as unparseable", (command) => {
    expect(classifyReadOnlyShellCommand(command)).toEqual({
      readOnly: false,
      reason: "command could not be parsed",
    });
  });

  it.each([
    ["for f in a b; do cat a; done", "For commands are not allowed"],
    ["[[ -d x ]]", "TestCommand commands are not allowed"],
    ["! git status", "Negation commands are not allowed"],
    ["time git status", "Time commands are not allowed"],
    ["if [ -d x ]; then git log & fi", "background commands are not allowed"],
    ["{ git status; } <<EOF\nhi\nEOF", "heredocs are not allowed"],
    ["( git status ) >| x", "`>|` redirection is not allowed"],
    ["{ git status; } >&x", "output may only be redirected to /dev/null"],
    ["{ git status; } 2>/dev/null >out", "output may only be redirected to /dev/null"],
  ])("refuses %s with a reason", (command, reason) => {
    expect(classifyReadOnlyShellCommand(command)).toEqual({ readOnly: false, reason });
  });

  const nested = (levels: number) => "( ".repeat(levels) + "git status" + " )".repeat(levels);
  const elifChain = (clauses: number) =>
    "if test -f a0; then cat a0; " +
    Array.from(
      { length: clauses - 1 },
      (_, i) => `elif test -f a${i + 1}; then cat a${i + 1}; `,
    ).join("") +
    "fi";

  it("allows eight levels of nesting and refuses nine", () => {
    expect(classifyReadOnlyShellCommand(nested(8))).toEqual({ readOnly: true });
    expect(classifyReadOnlyShellCommand(nested(9))).toEqual({
      readOnly: false,
      reason: "commands are nested too deeply",
    });
  });

  it("does not count a flat elif chain as nesting", () => {
    expect(classifyReadOnlyShellCommand(elifChain(9))).toEqual({ readOnly: true });
    // An if seven levels deep with an elif is eight levels, not nine.
    expect(classifyReadOnlyShellCommand("( ".repeat(7) + elifChain(2) + " )".repeat(7))).toEqual({
      readOnly: true,
    });
    expect(classifyReadOnlyShellCommand("( ".repeat(8) + elifChain(2) + " )".repeat(8))).toEqual({
      readOnly: false,
      reason: "commands are nested too deeply",
    });
  });

  it("refuses a write in any elif clause and caps the chain", () => {
    expect(readOnly(elifChain(5).replace("cat a3", "rm a3"))).toBe(false);
    expect(classifyReadOnlyShellCommand(elifChain(32))).toEqual({ readOnly: true });
    expect(classifyReadOnlyShellCommand(elifChain(33))).toEqual({
      readOnly: false,
      reason: "too many `elif` clauses",
    });
  });

  it("counts an if nested in an else as nesting", () => {
    const elseIf = (levels: number): string =>
      levels === 0 ? "cat a" : `if test -f a; then cat a; else ${elseIf(levels - 1)}; fi`;
    expect(classifyReadOnlyShellCommand(elseIf(8))).toEqual({ readOnly: true });
    expect(classifyReadOnlyShellCommand(elseIf(9))).toEqual({
      readOnly: false,
      reason: "commands are nested too deeply",
    });
  });
});
