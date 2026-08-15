# Project configuration

F5 can read non-executable project defaults from `f5.json` at the root of a registered project.
For interoperability with upstream tooling, it also reads `t3.json` when `f5.json` is absent. F5
only uses `f5.json` for its own file name and never writes `t3.json`.

```json
{
  "$schema": "https://example.invalid/f5-project.schema.json",
  "defaultThreadEnvMode": "worktree",
  "iconPath": "assets/project-icon.png"
}
```

Supported fields:

- `defaultThreadEnvMode`: `"local"` or `"worktree"`.
- `iconPath`: a relative path to a PNG, JPEG, GIF, WebP, ICO, or SVG image inside the project.

The `$schema` value is metadata only. F5 never downloads it. Configuration and icon files have
strict size limits, cannot be symbolic links, and are authorized against the registered project
root. Malformed fields are reported individually in Settings → Projects, while other valid fields
continue to apply.

Executable `scripts` and MCP server definitions are deliberately ignored until an explicit
repository-approval design is available. They never run merely because a repository was cloned or
opened.

Workspace mode precedence is: an explicit composer or workflow choice, the local per-project
override, the checked-in configuration, then the global default.
