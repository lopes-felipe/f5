- Read-only workflow stages can read pull requests, CI logs, review guides and repository files
  through F5's forge tools on Codex, Claude, Cursor, Antigravity and Pi. Write tools such as
  merge, review and re-run stay out of those stages, including on Pi. The new `repository_file_read` tool
  reads a file or lists a directory at a branch, commit or PR head on GitHub. These reads also work
  when the stage's folder holds several repositories, as long as the PR's host has a connected
  account.
- Each read-only stage's thread records how it is kept read-only: sandboxed, or policy-enforced.
