- Codex read-only workflow stages get only F5's read-only forge and thread tools. Your own Codex MCP
  servers, the preview browser and Codex plugins are left out of those stages, since Codex uses MCP
  tools without asking and they run outside its sandbox.
- Read-only stages on Cursor and Antigravity allow F5's forge tools only when the call really
  targets them, and Antigravity's own calls to those tools are no longer refused.
- `repository_file_read` reads files whose names contain spaces, `#`, `:` or parentheses, and the
  forge tools look up the thread's repository without running `git status`.
- A pre-release of a certified provider version is no longer treated as certified, and an excluded
  version also excludes its hotfix and build variants.
