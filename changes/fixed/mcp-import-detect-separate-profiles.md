- MCP **Import → Detect configurations** no longer looks like it did nothing when it finds no
  servers. It says so and lists the files it read. It now also reads VS Code's user `mcp.json`, and
  warns that VS Code's `envFile` and sandbox settings are not imported.
- In a separate profile, Detect reads only the profile's own home folder, where other clients'
  configuration usually doesn't exist. It now offers **Also look in my home folder**, which adds
  your own `~/.claude.json`, `~/.codex/config.toml` and other clients' files, all unselected.
