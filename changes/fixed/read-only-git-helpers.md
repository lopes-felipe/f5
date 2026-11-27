- Read-only workflow stages whose commands F5 approves without a sandbox (Cursor, and Codex or
  Antigravity in the macOS desktop app) no longer let an approved `git diff`, `git status` or
  `git log` run a helper from a repository's own `.git/config`, such as an external diff, a
  diff driver, a clean filter, a pager or an fsmonitor hook. In the stage's folder F5 turns those
  helpers off when the stage starts. For any other repository a command reaches (`cd`, `git -C`,
  a submodule), and for a helper added later, F5 refuses the command and says which setting it
  found. These stages also no longer fetch a missing object from a partial clone's remote.
