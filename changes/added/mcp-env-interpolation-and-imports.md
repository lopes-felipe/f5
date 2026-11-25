- MCP server commands, arguments, environment values, working directories, URLs, and headers can
  use `${env:NAME}` or `${env:NAME:-default}`, resolved from the provider account's environment
  when the server starts. A server that needs an unset variable is skipped, and settings name the
  variable. Import converts `${NAME}` references to this form.
- MCP import detects Cursor, VS Code, Claude Desktop, and OpenCode configuration, and accepts
  pasted VS Code and OpenCode documents, including comments and trailing commas.
