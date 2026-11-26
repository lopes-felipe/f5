- MCP settings without a selected project no longer show a "Checking..." provider badge that never
  finishes.
- MCP settings now label the bearer token environment variable, OAuth client ID and OAuth callback
  port as used by Codex and Claude, and mark a stdio server's working directory as ignored by
  Claude.
- A Claude MCP server's bearer token environment variable is now sent as an `Authorization`
  header, as it already was for Codex and Cursor. A literal `Authorization` header wins for every
  agent and for Test, and variables reserved for F5 and provider credentials (`F5_*`,
  `ANTHROPIC_*`, `CLAUDE_*`, `AWS_*`, `OPENAI_*`, `CODEX_*`) are never sent. Import warns whenever
  an entry sends a variable as a bearer token, and names the server it goes to.
- Importing a server that is already saved under its original legacy name offers Replace, which
  renames it, instead of adding a second copy. Two entries that import under the same name can
  each be selected.
- After a save, MCP settings no longer shows the previous configuration check's results as
  current; it says the servers were not checked since the save.
- Testing an MCP server while another test of the same server runs now says so, instead of
  reporting the four-test limit as "A test is already running".
