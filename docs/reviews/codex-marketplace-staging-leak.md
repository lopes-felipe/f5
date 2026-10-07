# Codex marketplace staging leak

Status: F5 mitigations shipped (one-off app-server reuse, plugins off for one-offs, hourly
sweep). The upstream report below is a draft and has not been filed.

## What happened

On 2026-10-06, about 90 GB had built up in `~/.codex/.tmp/marketplaces/.staging` and in the
Personal profile's Codex home. Each `marketplace-upgrade-*` dir was a full, non-shallow clone of
the `doordash/agentskills-release` marketplace (2,143 commits; `.git` about 130 MB, checkout
about 260 MB). After a manual cleanup, 42 GB had built up again within about 17 hours.

New staging dirs per 10 minutes matched F5's Work-profile `codex app-server` spawns per 10
minutes (4, 4, 2, 4, 19, 11, 2 dirs against 4, 4, 3, 4, 17, 12, 2 spawns). Of the 17 spawns in
the busiest window, 15 were one-off prompts that started and stopped an app-server.

## Cause (`codex-rs/core-plugins` on Codex main; the 0.159.2 binary has the same symbols)

- `PluginsManager::maybe_start_plugin_startup_tasks_for_config` starts the
  `plugins-marketplace-auto-upgrade` thread on every app-server start when the `plugins`
  feature is on.
- `upgrade_configured_git_marketplace` compares the remote revision with the installed
  snapshot. If they differ, it runs a full `git clone` (no `--depth`, because the marketplace
  has no `sparse_paths`) into a `tempfile::TempDir` under `.staging`.
- `activate_marketplace_root` swaps the clone in and moves the old root to a
  `marketplace-backup-*` `TempDir`.
- Both dirs are removed only when their `TempDir` is dropped. A process stopped with a signal
  never drops them. If the `git clone` child outlives its parent, it can still finish the clone
  after Codex has exited.
- The installed snapshot is never updated, so the next app-server start sees the same
  revision mismatch and clones again.

Reproduced on 2026-10-07 with the 0.159.2 binary and an empty temporary `CODEX_HOME` (the
marketplace comes from the enterprise-managed config layer, so it applies to any home): a
staging clone appeared within 20 seconds of `initialize`. After the app-server was killed, its
`git clone` child kept running. F5 stops app-servers on macOS and Linux with SIGTERM to the
app-server PID only (`killChildTree` with `isGroupLeader: false`), so the clone outlives Codex
and completes into a dir nothing will swap in. With `-c features.plugins=false`, the same probe
created no `.tmp` entries at all.

Of the dirs present on 2026-10-06, 99 of 138 in `~/.codex` and 71 of 82 in the Personal home
were complete clones that were never swapped in. The rest held only `.git` (killed mid-clone).

## F5 mitigations

- One-off prompts reuse one warm app-server per launch config (`CodexAppServerManager`).
- One-off app-servers run with `-c features.plugins=false`, which skips all plugin startup
  tasks, including the marketplace auto-upgrade.
- `StorageCleanupWorker` deletes `marketplace-upgrade-*` and `marketplace-backup-*` dirs older
  than 2 hours in every Codex home F5 launches, every hour, and audits each deletion as
  `codex-marketplace-staging`. It runs even when automatic storage cleanup is off.
- Storage maintenance offers the same cleanup on demand.

Thread sessions keep plugins on, so a thread's app-server that is stopped mid-upgrade can
still leak one clone. The hourly sweep removes it.

Possible follow-up: start app-servers in their own process group and stop the whole group, so an
in-flight `git clone` dies with Codex instead of finishing a clone nobody uses. This changes
signal handling for every Codex child, so it was left out of this change.

## Draft upstream report (openai/codex)

> **Marketplace auto-upgrade leaks full clones in `.tmp/marketplaces/.staging` when app-server
> stops mid-upgrade**
>
> Codex 0.159.2, macOS. A Git-sourced marketplace configured without `sparse_paths`.
>
> Every `codex app-server` start runs the configured marketplace auto-upgrade. When the remote
> revision differs from the installed one, it clones the full repository into a `TempDir` under
> `<CODEX_HOME>/.tmp/marketplaces/.staging/marketplace-upgrade-*`. When the app-server is
> stopped by a signal before the upgrade finishes, the `TempDir` is never dropped, so the clone
> stays on disk. A `git clone` that outlives the app-server can also finish into the orphaned
> dir. Because the installed revision is unchanged, the next start clones again.
>
> Clients that start short-lived app-servers (one per background prompt) hit this on almost every
> start. We saw about 90 GB in a day: 138 staging dirs, 99 of them complete clones that were never
> swapped in, and the rest partial clones.
>
> Suggestions:
>
> 1. On startup, remove `marketplace-upgrade-*` and `marketplace-backup-*` dirs that no live
>    upgrade owns (for example, guarded by `.tmp/plugins.sync.lock` or an age check).
> 2. Clone with `--depth 1` (or `--filter=blob:none`) when no history is needed.
> 3. Don't start the upgrade again while a recent attempt for the same revision is unfinished,
>    and cap how often it runs per home.
> 4. Document a config key that turns off the startup marketplace upgrade without disabling
>    plugins entirely. Today `features.plugins=false` is the only way to opt out.

## Release-side suggestion (agentskills)

A history-squashed release branch for `agentskills-release` would shrink each clone from about
260 MB to about the checkout size. That helps every marketplace user, including the leaked
clones and the legitimate ones.
