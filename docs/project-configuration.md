# Project configuration

Check project defaults into the repository with an `f5.json` file at the project root. Everyone
who opens the project in F5 then starts from the same defaults.

## How to

1. Create `f5.json` at the root of the registered project.
2. Add the fields you want. For example:

```json
{
  "$schema": "https://example.invalid/f5-project.schema.json",
  "defaultRuntimeMode": "approval-required",
  "defaultThreadEnvMode": "worktree",
  "worktreeSubmodules": "shallow",
  "prHubDefaultMergeMethod": "squash",
  "iconPath": "assets/project-icon.png"
}
```

3. Open **Settings**, choose the project, and check that each value shows `f5.json` as its source.

## Fields

- `iconPath`: a relative path to a PNG, JPEG, GIF, WebP, ICO, SVG or macOS `.icns` image inside
  the project. Without it, F5 looks for common favicon paths, then `Resources/AppIcon.icns` and
  `AppIcon.icns`. An `.icns` icon is shown from its embedded PNG.
- `defaultThreadEnvMode`: `"local"` or `"worktree"`.
- `upstream`: tracks the repository this project was forked from on the
  [Upstream page](user/upstream-ports.md). `repository` is the upstream GitHub URL; `remote`
  (default `"upstream"`), `branch` (default `"main"`) and `ledgerDir` (default `"upstream"`) are
  optional. The schedule and triage model are personal settings and are never read from here.
- Most project-scoped settings, such as `defaultRuntimeMode`, `worktreeSubmodules`,
  `enableAssistantStreaming`, `textGenerationModelSelection`, `sourceControlWriting` and
  `prHubDefaultMergeMethod`. [Project settings](user/project-settings.md) lists them with their
  defaults.

Malformed fields are reported one by one in **Settings**. The other fields still apply.

## Good to know

- F5 also reads `t3.json` when `f5.json` is absent, for compatibility with upstream T3 Code. It
  never writes `t3.json`.
- Your project override in Settings always wins over the checked-in file.
- `$schema` is metadata only. F5 never downloads it.

> [!WARNING]
> Executable `scripts` and MCP server definitions are ignored. They never run just because you
> cloned or opened a repository. Settings that widen what F5 does on your machine are also never
> read from `f5.json`: automatic worktree cleanup, auto-pull, external preview hosts, Claude in
> Chrome and computer use.

<details>
<summary>Details and limits</summary>

- Configuration and icon files have strict size limits (64 KiB for `f5.json`), cannot be
  symlinks, and must resolve inside the registered project root.
- Workspace mode is picked from the first of these that is set: an explicit composer or workflow
  choice, the project override, the checked-in file, then the global default.

</details>

## Related

- [Project settings](user/project-settings.md)
- [Runtime modes](runtime-modes.md)
