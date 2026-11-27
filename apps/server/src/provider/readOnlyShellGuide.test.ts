import { describe, expect, it } from "vitest";

import { READ_ONLY_SHELL_GUIDE, READ_ONLY_SHELL_GUIDE_EXAMPLES } from "./readOnlyShellGuide.ts";
import { classifyReadOnlyShellCommand } from "./readOnlyWorkflowShell.ts";

describe("READ_ONLY_SHELL_GUIDE", () => {
  it.each(READ_ONLY_SHELL_GUIDE_EXAMPLES.runs)("promises only what runs: %s", (command) => {
    expect(classifyReadOnlyShellCommand(command)).toEqual({ readOnly: true });
    expect(READ_ONLY_SHELL_GUIDE).toContain(command);
  });

  it.each(READ_ONLY_SHELL_GUIDE_EXAMPLES.refused)(
    "warns only against what is refused: %s",
    (command) => {
      expect(classifyReadOnlyShellCommand(command).readOnly).toBe(false);
      expect(READ_ONLY_SHELL_GUIDE).toContain(command);
    },
  );

  // The lists in prose: every program and git subcommand named as running must run.
  it.each([
    ...["cat", "head", "tail", "nl", "wc", "ls", "stat", "file", "find", "fd", "rg", "grep"].map(
      (program) => `${program} a.txt`,
    ),
    ...["diff", "cmp"].map((program) => `${program} a.txt b.txt`),
    ...["sort", "uniq", "shasum"].map((program) => `${program} a.txt`),
    "cut -f1 a.txt",
    "tr a b",
    "jq .name package.json",
    "base64 -d a.txt",
    "sed -n 1,5p a.txt",
    ...[
      "status",
      "log",
      "show",
      "diff",
      "grep x",
      "blame a.ts",
      "rev-parse HEAD",
      "rev-list HEAD",
      "merge-base a b",
      "ls-files",
      "ls-tree HEAD",
      "cat-file -t HEAD",
      "for-each-ref",
      "branch --contains abc",
      "tag --list 'v*'",
      "remote -v",
      "worktree list",
      "stash list",
    ].map((subcommand) => `git ${subcommand}`),
    "gh pr view 1",
    "gh pr diff 1",
    "gh pr checks 1",
    "gh pr list",
    "gh issue view 1",
    "gh run view 1",
    "gh api repos/o/r/pulls/1",
    "if test -f a; then cat a; fi 2>/dev/null",
  ])("runs %s", (command) => {
    expect(classifyReadOnlyShellCommand(command)).toEqual({ readOnly: true });
  });

  it.each([
    "cat a | tee b",
    "sed -i s/a/b/ f",
    "mkdir x",
    "cat `ls`",
    "cat <<EOF\nx\nEOF",
    "f() { cat a; }; f",
    "while true; do cat a; done",
    "for f in *.ts; do cat $f; done",
    "node -e 1",
    "python3 -c 1",
    "npm view x",
    "awk '{print}' a",
    "ls | xargs cat",
    "git ls-remote origin",
    "curl https://example.com",
    "/usr/bin/grep x a",
  ])("refuses %s", (command) => {
    expect(classifyReadOnlyShellCommand(command).readOnly).toBe(false);
  });

  it("fits in one Codex context entry", () => {
    // Codex truncates the middle of a value longer than 1,000 tokens at 4 bytes each.
    expect(Buffer.byteLength(READ_ONLY_SHELL_GUIDE)).toBeLessThan(4_000);
  });
});
