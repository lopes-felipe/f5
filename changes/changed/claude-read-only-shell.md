- Claude read-only workflow stages now run shell commands under the same read-only allowlist as
  Cursor, Codex and Antigravity. Commands Claude's Plan mode used to let through, such as
  `git fetch`, `mkdir` or output redirected to a scratch file, are refused with F5's reason, and
  the stage is told the rules up front. Each refusal counts toward the stage's limit of 15
  refused operations in a turn, so a stage that keeps trying them fails sooner than before.
- Allow rules in Claude settings (`permissions.allow`) no longer stop a Claude read-only stage
  from starting, and can no longer let one write, run a command outside the allowlist, or use a
  built-in tool that acts outside the stage, such as creating a worktree or a schedule. A
  settings file that sets a command setting, an unsafe `env` variable or a permissive
  `defaultMode` still blocks the stage.
- Claude read-only stages no longer start with a custom Claude executable older than 2.1.317,
  which can't block a tool call when F5's check fails to answer. Skills loaded in a stage no
  longer run their inline shell commands.
