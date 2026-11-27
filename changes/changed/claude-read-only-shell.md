- Claude read-only workflow stages now run shell commands under the same read-only allowlist as
  Cursor, Codex and Antigravity. Commands Claude's Plan mode used to let through, such as
  `git fetch`, `mkdir` or output redirected to a scratch file, are refused with F5's reason, and
  the stage is told the rules up front.
- Allow rules in Claude settings (`permissions.allow`) no longer stop a Claude read-only stage
  from starting, and can no longer let one write or run a command outside the allowlist. A
  settings file that sets a command setting, an unsafe `env` variable or a permissive
  `defaultMode` still blocks the stage.
