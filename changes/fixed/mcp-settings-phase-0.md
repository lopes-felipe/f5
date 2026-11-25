- MCP settings without a selected project no longer show a "Checking..." provider badge that never
  finishes.
- MCP settings now label the bearer token environment variable, OAuth client ID and OAuth callback
  port as used by Codex and Claude, and mark a stdio server's working directory as ignored by
  Claude.
- A Claude MCP server's bearer token environment variable is now sent as an `Authorization`
  header, as it already was for Codex and Cursor.
- Testing an MCP server while another test of the same server runs now says so, instead of
  reporting the four-test limit as "A test is already running".
