# Codex

Set up Codex in F5. You can use a single account, or work and personal accounts that share one
Codex history.

![Settings → Providers with Codex and Claude signed in](../images/settings-providers.webp)

## How to

1. Install the [Codex CLI](https://github.com/openai/codex) and run `codex login`.
2. Open **Settings → Providers**. The default Codex provider uses **CODEX_HOME path** `~/.codex`
   with an empty **Shadow home path**.
3. Pick a Codex model in the composer and start a thread.

## Work and personal accounts

Keep one shared Codex home and give the second account a shadow home that holds only its login:

```bash
codex login                                  # first account, uses ~/.codex
mkdir -p ~/.codex_p
CODEX_HOME=~/.codex_p codex login            # second account
```

In **Settings → Providers**, configure two Codex providers:

| Display name   | CODEX_HOME path | Shadow home path |
| -------------- | --------------- | ---------------- |
| Codex Work     | `~/.codex`      | empty            |
| Codex Personal | `~/.codex`      | `~/.codex_p`     |

Both providers see the same sessions, and each keeps its own login. Existing threads can continue
with either account, which helps when one account hits its limits.

## Which account am I using?

Each provider row shows the signed-in email, blurred by default; click it to reveal it. Give each
provider a clear display name and accent color so you can tell them apart in the model picker.

## If both accounts look the same

1. Check the email in **Settings → Providers** and refresh provider status.
2. Confirm the second provider has **Shadow home path** set.
3. Confirm the shadow directory has its own `auth.json`.
4. If you copied `~/.codex` into the shadow directory, delete everything except `auth.json`:

```bash
find ~/.codex_p -mindepth 1 ! -name auth.json -exec rm -rf {} +
```

## Good to know

- An existing thread only offers Codex providers with the same **CODEX_HOME path**. A provider
  with a different home is a separate workspace with separate sessions.
- Add account-specific keys or endpoints under the provider's **Environment variables** and mark
  secrets **Sensitive**. Sensitive values are never sent back to the app.
- Provider instances and [profiles](../profiles.md) solve different problems. Instances are several
  Codex entries inside one profile, each with its own home or shadow home. A profile is a separate
  F5 environment with its own projects, threads, accounts and in-app login.
- F5 cleans up the large marketplace clones Codex can leave behind. **Settings → Storage →
  Provider homes** runs the same cleanup on demand.

> [!NOTE]
> On Windows, keep the shared and shadow homes on the same drive. Across drives F5 has to copy
> files instead of linking them, and the copy does not update during a running session.

<details>
<summary>Details and limits</summary>

| Topic                | Detail                                                                                                                                                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Managed profiles     | Need Codex 0.144.3+ and file-backed credentials. Versions older than 0.162.0 show a notice that newer features may be missing                                                                                                                                                             |
| Windows shadow homes | Directories use junctions and files use hard links, so no Developer Mode or elevation is needed                                                                                                                                                                                           |
| Background prompts   | Session notes, compaction and validation share one warm app-server per launch config. It stops after 5 minutes idle, 50 prompts or a failed prompt, and may use the previous login briefly after `codex login` switches accounts                                                          |
| Plugins              | One-off app-servers and `codex exec` runs (titles, commit messages, PR text, branch names) start with plugins off; thread sessions keep them on                                                                                                                                           |
| Marketplace cleanup  | Hourly, F5 deletes `marketplace-upgrade-*` clones older than 2 hours in every Codex home it launches, even with automatic cleanup off. A `marketplace-backup-*` is deleted only when an installed copy of the same source sits next to it. Each deletion is logged in the cleanup history |

</details>

## Related

- [Provider prerequisites](../provider-prerequisites.md)
- [Claude](claude.md)
- [Worktrees and storage automation](../user/worktrees-and-storage-automation.md)
- [Codex implementation and release notes](../reviews/codex-provider-releases.md) (contributors)

## Interactive MCP apps

Completed MCP tools that supply a UI resource can open an app inside the thread.
Apps run in an isolated frame and use the current Codex session. Send a message
to reconnect when the session is offline. Older apps remain visible when earlier
work logs collapse.

F5 asks before running a tool unless the server explicitly declares it read-only.
Every message sent by an app also needs confirmation. The approval shows the full
arguments in a scrollable area. Navigating away stops the app; reload it to start
a fresh frame. Escape or a pending approval returns fullscreen apps to the thread.

Apps can save their latest state for the next user turn. This state is kept as
separate tool data and does not replace the composer draft. Calls that fail or time
out are never retried automatically; inspect the session before retrying an action.
