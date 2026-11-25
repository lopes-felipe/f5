- Cursor and Antigravity reviewers in workflows can run read-only commands such as `gh pr view`,
  `gh pr diff` and `git log`, and fetch web pages, instead of failing with "Workflow read-only
  profile violation". Anything that would change files is refused and the model keeps working; a
  stage fails only after three refused operations in one turn.
- A workflow stage that failed for a read-only violation stays failed even if the provider
  finishes the turn afterwards, and shows the first violation instead of the last.
