# Project settings

Open Settings and use the **Global › Project** selector to choose a project. The selector supports search and scrolling. Project scope shows only settings that can be overridden; account credentials, profiles, models and other global controls remain in Global settings.

The initial project settings are:

| Setting                             | Built-in default                                           |
| ----------------------------------- | ---------------------------------------------------------- |
| Default permissions for new threads | Full access                                                |
| Default workspace for new threads   | Local                                                      |
| Worktree submodules                 | Recursive                                                  |
| Text generation model/account       | The global text generation selection                       |
| Source control writing              | The global writing defaults                                |
| Assistant streaming                 | The server streaming preference                            |
| PR merge method                     | Last used, then squash, subject to repository capabilities |

Each field shows its source and an override has a Reset action. Reset all project overrides removes the project's override object. Overrides are stored by project ID in the profile's server settings and removed when the project is deleted. Updating one project's overrides replaces its complete override object, without changing other projects.

Values resolve in this order:

1. Project override.
2. The project's legacy workspace default, for workspace mode only.
3. `f5.json`, or `t3.json` when `f5.json` is absent.
4. Global server setting.
5. Built-in default.

For example, a checked-in `f5.json` can contain:

```json
{
  "defaultRuntimeMode": "approval-required",
  "defaultThreadEnvMode": "worktree",
  "worktreeSubmodules": "shallow",
  "enableAssistantStreaming": true,
  "prHubDefaultMergeMethod": "squash"
}
```

`worktreeSubmodules` accepts `none`, `shallow` (top-level modules only), or `recursive`. Worktree creation and recreation initialize modules with local file transport disabled. Initialization failures produce a server warning and keep the created worktree available. Configuration is always read from the registered project root, including when a worktree is missing or checks out a different branch. Repository configuration is read as bounded regular files (64 KiB); symlinked files are not followed. Invalid checked-in fields fall back independently. Partial source-control writing objects inherit unspecified fields from the lower-precedence layer. Repository scripts and MCP configuration retain their existing explicit-approval rules.

Permission and workspace defaults apply to new drafts. Existing threads and reused drafts keep their chosen modes. An explicit project model default takes precedence over remembered model preferences for a fresh draft. Commit, branch and PR text generation use the project's resolved account/model and writing settings. Streaming preferences are tracked separately for concurrent threads. The PR hub uses a project merge default when its local checkout resolves to one project; an ambiguous or missing project uses the global default. A manually selected merge method still wins.

## Compatibility

Protocol version 9 requires an existing open tab to reload. Existing persisted settings decode with empty project overrides and migration markers. Explicit browser-local workspace and streaming preferences migrate once per profile using server-side compare-and-set; the first client wins. Absent keys are not migrated, failed requests retain the browser value, and acknowledged keys are removed from local storage. Settings routing remains derived from the web-local schema.

There is no environment settings layer. New scoped settings from later phases are not exposed yet.

## Failure handling and trust

Checked-in settings intentionally take precedence over global settings, as described above. They can select permission defaults, a text-generation account and writing instructions. Review a repository's project configuration; use an explicit project override to pin a user choice above checked-in configuration. Fork worktree branches do not supply these settings. Submodule initialization retains the approved recursive default and normal Git transports (including SSH for private modules), with file transport disabled and credential prompts suppressed.

If draft settings cannot be fetched, the draft uses its last resolved project permission mode; without one it uses approval-required. Concurrent new-thread requests reuse the same draft. Failed PR preference lookups open the merge dialog using the global preference and show a notice. Disabled text-generation providers use the same read-time fallback as global settings while keeping the stored selection.

An invalid persisted project override does not reset valid global or other project settings. The affected project uses approval-required and no submodule initialization; writes remain blocked until the original file is repaired. The file is not silently rewritten.

Streaming previously defaulted to on in the browser. Unmigrated server streaming defaults retain that behavior. A migrated browser preference or explicit global edit records the choice and takes precedence over later migration requests. Old browser storage does not distinguish a saved default from an explicit choice, so migration preserves present keys as recorded rather than guessing intent.
