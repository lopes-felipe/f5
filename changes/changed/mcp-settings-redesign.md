- MCP settings follow the settings scope switcher instead of their own Scope and Provider
  toggles. Each server is a row with its live status, tool count or failure reason, an on/off
  switch, and a menu to edit, duplicate, move between common and project scope, reconnect,
  export, or remove it. Selecting a server opens a side panel with Overview, Tools, Prompts and
  resources, Sign-in, and Configuration tabs. Add server opens a dialog with a form, a paste box
  for JSON or TOML, and import from other clients. In a project, servers inherited from common
  scope have their own group, where you can turn them off for the project or override them.
  Servers that Codex or Claude configure themselves, and F5's built-in servers, are in a
  collapsed read-only "Provider-managed servers" section.
- A server's Overview keeps read-only Diagnostics for the observed conversation. After an Apply
  in common scope it lists conversations from every project, and each retry runs where that
  conversation lives.
