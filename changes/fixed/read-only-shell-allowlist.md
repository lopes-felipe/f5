- Read-only workflow stages on Cursor, and on Codex and Antigravity in the macOS desktop app, no
  longer refuse the commands reviewers run most. `git grep`, `base64` decoding, `shasum`,
  `sed -n` with several ranges or `/regex/` addresses, `git branch` and `git tag` listings with
  filters, `git worktree list`, `git stash list`, bare `git remote` and `git --no-lazy-fetch` now
  run. So do a variable set after `cd dir &&` and a `for` loop over a written-out list of words.
- Read-only workflow stages no longer approve `git branch name=value` or `uniq in=1 out=2`, which
  created a branch or wrote a file: an argument shaped like `NAME=value` was left out of the check.
