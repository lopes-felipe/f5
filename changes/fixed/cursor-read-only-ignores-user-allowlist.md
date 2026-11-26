- Cursor read-only workflow stages no longer run commands from your Cursor allowlist or under an
  `unrestricted` or `auto-review` approval mode without F5 checking them. They start with an
  F5-owned copy of your Cursor CLI config that keeps only display, model and account settings.
  Their session history is kept in F5's state folder instead of `~/.cursor`.
- Read-only Cursor stages refuse to start, naming the file, in a repository whose
  `.cursor/cli.json` sets an allowlist, a looser approval mode or any setting other than deny
  rules, whose `.cursor/hooks.json` defines hooks, or whose `.cursor/mcp.json` defines servers.
  A file F5 can't read as strict JSON is refused too. F5 checks again before every turn.
