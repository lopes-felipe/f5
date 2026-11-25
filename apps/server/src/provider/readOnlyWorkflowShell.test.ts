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
  ])("allows %s", (command) => {
    expect(classifyReadOnlyShellCommand(command)).toEqual({ readOnly: true });
  });

  it.each([
    // Shape
    'if [ -d /x/.git ]; then git -C /x status -sb; else echo "No repo"; fi',
    "gh pr diff 1 > x.diff",
    "gh pr diff 1 >> x.diff",
    "echo $(rm -rf x)",
    "echo `rm -rf x`",
    "cat <(rm -rf x)",
    "sleep 1 &",
    "/usr/bin/git status",
    "(git status)",
    "{ git status; }",
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
});
