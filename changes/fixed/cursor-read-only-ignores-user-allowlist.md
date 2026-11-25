- Cursor read-only workflow stages no longer run commands from your Cursor allowlist or under an
  `unrestricted` or `auto-review` approval mode without F5 checking them. They start with an
  F5-owned copy of your Cursor CLI config with those settings turned off. A repository whose
  `.cursor/cli.json` sets an allowlist or a looser approval mode can't run read-only Cursor stages;
  the stage fails to start and names the file.
