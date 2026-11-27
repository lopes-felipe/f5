/**
 * What a model is told, before it runs anything, about the shell in a read-only workflow stage
 * that F5's classifier enforces (`readOnlyWorkflowShell.ts`). Codex, Cursor and Antigravity are
 * only told "rejected" when F5 refuses a command, with no reason, so without this they guess,
 * and a stage fails once it keeps guessing wrong. Claude is told the reason, but only after it
 * has spent a call finding out.
 *
 * The examples are data so that `readOnlyShellGuide.test.ts` can run each one through the
 * classifier: the guide can't promise a command the classifier refuses, or warn against one it
 * accepts. Keep it short. It is sent with every such stage, and Codex cuts a context entry at
 * about 4,000 bytes.
 */
export const READ_ONLY_SHELL_GUIDE_EXAMPLES = {
  runs: [
    "git show abc123:src/a.ts | nl -ba | sed -n '40,80p;120,140p'",
    `REV=abc123; cd /repo && git show "\${REV}:src/a.ts" | rg -n 'start|stop'`,
    "git grep -n -E 'start|stop' abc123 -- apps packages",
    "for f in a.ts b.ts; do git show abc123:src/$f | head -20; done",
    "gh api 'repos/OWNER/REPO/contents/a.go?ref=abc123' --jq .content | base64 -d",
  ],
  refused: [
    "git show abc123:src/a.ts > /tmp/a.ts",
    "rg -n start src/{a,b}.ts",
    'F=$(git ls-files | head -1); cat "$F"',
    "REV=abc123; git show $REV:src/a.ts",
    "cd /repo && REV=abc123; git log -1 $REV",
    "git fetch origin pull/1/head",
    "bun run test",
  ],
} as const;

const bullets = (commands: ReadonlyArray<string>) =>
  commands.map((command) => `  ${command}`).join("\n");

const guide = (whatARefusalSays: string) => `# Read-Only Shell Rules

F5 checks every shell command in this stage and runs only the ones it can tell just read. A refused command did not run, and ${whatARefusalSays}. Do not retry it or ask again: rewrite it in a form below, or go on without that result.

Runs:
- Reading and searching: cat, head, tail, nl, wc, ls, stat, file, find, fd, rg, grep, diff, cmp, sort, uniq, cut, tr, jq, shasum, base64 -d, and \`sed -n\` with print commands only.
- git reads: status, log, show, diff, grep, blame, rev-parse, rev-list, merge-base, ls-files, ls-tree, cat-file, for-each-ref; branch and tag listings with a filter or \`--list\`; remote -v, worktree list, stash list.
- gh reads: gh pr view, diff, checks and list; gh issue view; gh run view; \`gh api\` GET.
- Pipes, \`&&\`, \`||\`, \`;\`, \`if\`, output to /dev/null, a variable set to a literal value, and \`for\` over words written out in full.
${bullets(READ_ONLY_SHELL_GUIDE_EXAMPLES.runs)}

Refused:
- Writing a file: \`> file\`, \`tee\`, \`sed -i\`, \`mkdir\`. Keep results in the pipe.
- \`$(...)\`, backticks, brace lists like \`src/{a,b}.ts\`, globs in a \`for\` list, heredocs, functions, \`while\`.
- \`$VAR:path\` without braces: write \`"\${VAR}:path"\`.
- A variable set after \`cd dir &&\` and used after a \`;\`: set it first, \`VAR=value; cd dir && ...\`.
- Interpreters and build tools: bun, node, python3, npm, awk, xargs. Tests cannot run in this stage.
- Network: \`git fetch\`, \`git ls-remote\`, \`curl\`. Read remote state with \`gh\` or F5's forge tools.
- A program named with a path (\`/usr/bin/grep\`): use the bare name.
${bullets(READ_ONLY_SHELL_GUIDE_EXAMPLES.refused)}`;

/** For Codex, Cursor and Antigravity, whose approval protocols carry no reason back. */
export const READ_ONLY_SHELL_GUIDE = guide('you are told "rejected" without a reason');

/** For Claude, which reads the classifier's reason in the denial of its tool call. */
export const READ_ONLY_SHELL_GUIDE_WITH_REASONS = guide("the refusal says why");
