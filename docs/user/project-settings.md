# Project settings

Override global settings for one project, such as its default permissions, workspace or PR merge
method. Each value shows where it comes from, so you can tell an override from a checked-in
default.

![Project settings showing checked-in values from f5.json](../images/settings-project.webp)

## How to

1. Open **Settings**.
2. Click **Global settings** at the top and pick a project.
3. Change a setting. The field shows that it is now a project override.
4. Use **Reset** on a field, or **Reset all project overrides**, to go back to the inherited value.

Project scope only lists settings a project can override. Accounts, profiles and models stay in
global settings.

## Where values come from

F5 uses the first value it finds:

1. Your project override.
2. The project's older workspace default (workspace mode only).
3. The repository's `f5.json` (or `t3.json` if there is no `f5.json`).
4. The global setting.
5. The built-in default.

A checked-in `f5.json` can change permissions, the text-generation account and writing
instructions, so review it in repositories you don't trust. To keep your own choice, set a project
override, which wins over the file. See [Project configuration](../project-configuration.md).

## When changes apply

Permission and workspace defaults apply to new drafts; existing threads keep their modes. Commit,
branch and PR text use the project's account, model and writing settings. The PR Hub uses the
project's merge default when the checkout maps to one project, and a method you pick by hand still
wins.

## Good to know

- Automatic thread settlement, worktree cleanup, auto-pull, external preview hosts, Claude in Chrome and computer use
  are never read from `f5.json`. Only you can turn them on.
- Deleting a project removes its overrides.
- Skill scan problems appear above project settings with the affected path. **Refresh
  diagnostics** reloads them.
- If draft settings can't load, a new draft falls back to the project's last permission mode, or
  to approval-required.

<details>
<summary>Details and limits</summary>

| Setting                             | Built-in default                                           |
| ----------------------------------- | ---------------------------------------------------------- |
| Default permissions for new threads | Full access                                                |
| Default workspace for new threads   | Local                                                      |
| Worktree submodules                 | Recursive                                                  |
| Text generation model/account       | The global text generation selection                       |
| Source control writing              | The global writing defaults                                |
| Assistant streaming                 | The server streaming preference                            |
| PR merge method                     | Last used, then squash, subject to repository capabilities |
| Automatic worktree cleanup          | The global rules in Settings → Storage                     |
| Auto-pull the default branch        | Off                                                        |

**Submodules.** `none`, `shallow` (top-level modules only) or `recursive`. Modules are initialized
with local file transport disabled and credential prompts suppressed; SSH still works for private
modules. A failed initialization logs a warning and keeps the worktree.

**Reading `f5.json`.** The file is always read from the registered project root, even when a
worktree is missing or on another branch. Fork worktree branches don't supply settings. The file
must be a regular file of at most 64 KiB, and symlinks are not followed. Each invalid field falls
back independently. A partial source-control writing object inherits missing fields from the next
layer.

**Storage.** Overrides are stored by project ID in the profile's server settings. Saving one
project replaces its whole override object without touching other projects.

**Invalid overrides.** A broken stored override leaves global and other project settings intact.
That project uses approval-required with no submodule initialization. Writes stay blocked until
the file is repaired, and F5 never silently rewrites it.

**Failure fallbacks.** If the PR preference can't load, the merge dialog uses the global
preference and shows a notice. A disabled text-generation provider falls back the same way global
settings do, while keeping your stored choice.

**Streaming.** Streaming used to default to on in the browser, and unmigrated defaults keep that
behavior. The first time a client connects, a browser-stored preference is migrated to the server
once per profile, and the first client wins.

</details>

## Related

- [Project configuration (`f5.json`)](../project-configuration.md)
- [Worktrees and storage automation](worktrees-and-storage-automation.md)
- [Runtime modes](../runtime-modes.md)
- [PR Hub and forges](pr-hub-forges.md)

See [MCP servers](mcp-servers.md) for common and project inheritance, provider support, live status, Apply, Reconnect, connection tests, tool filters, and the limits of stored-secret protection.

Thread settlement overrides live in the project's Git settings. Resolved-PR and
inactivity settlement both start disabled. Removing a project override restores
the global rule; a checked-in configuration cannot enable these automatic actions.

## Providers for one project

Open Settings, choose a project, then open Project → Providers. Each switch
controls one configured provider instance for that project. A project can enable
an instance that is globally off, or disable an instance used elsewhere. Use
**Use global providers** to restore inheritance.

New-thread defaults, model pickers, Agent Bridge provider lists, and title/commit
message generation follow these choices. If a saved helper model is disabled,
background generation uses an enabled fallback; if every provider is off, it stops
with an error. Disabling a provider blocks new turns and automatic recovery while
allowing the current session to be stopped. Existing thread history stays available.

Provider overrides are user settings. Checked-in project configuration cannot
change them. Older clients editing unrelated project settings preserve the saved
provider choices.
