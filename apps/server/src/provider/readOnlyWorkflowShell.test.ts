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
    'cat "$HOME/notes.md"',
    "find . -name '*.ts' -not -path './node_modules/*'",
    "grep -rn TODO src < /dev/null",
    "command -v gh",
    "[ -d .git ] && echo yes || echo no",
    "sort -u file | uniq -c",
    "wc -l a b; du -sh .",
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
    // Environment and parsing
    "GIT_EXTERNAL_DIFF=x git diff",
    "GIT_DIR=/tmp git log",
    "git log $FLAGS",
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
