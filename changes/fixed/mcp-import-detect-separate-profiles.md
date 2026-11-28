- MCP **Import → Detect configurations** finds servers again in a separate profile. It used to
  look for Cursor, VS Code, Claude Desktop and OpenCode files in the profile's own home folder, so
  it found nothing and the panel showed nothing. It now reads those files from your own home folder,
  also offers your own `~/.claude.json` and `~/.codex/config.toml` (not selected by default), reads
  VS Code's user `mcp.json`, and says which files it read when none of them list a server.
