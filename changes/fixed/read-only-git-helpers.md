- Read-only workflow stages whose commands F5 approves without a sandbox (Cursor, and Codex or
  Antigravity in the macOS desktop app) no longer let an approved `git diff`, `git status` or
  `git log` run a helper from the repository's own `.git/config`, such as an external diff, a
  diff driver, a clean filter or an fsmonitor hook. Git refuses to run it instead.
