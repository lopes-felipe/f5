# Profiles

A Profile is an independent F5 environment with its own accounts, projects, conversations, settings, secrets, attachments, logs and worktrees. A project's `workspaceRoot` remains its source directory. **Display profile** remains the appearance-density setting. Electron session storage is called a **partition**.

Create a profile in **Settings → Profiles**, then open it and use its account panels to sign in. Account setup works before adding a project. Login output is streamed in memory and is never written to terminal history or server logs. Cancel terminates the owned login process. Only one provider or MCP OAuth login can run per installation at a time; another login receives a visible conflict. F5 never terminates an unrelated callback-port owner.

Codex 0.144.3 supports subscription and API-key accounts. Claude uses the bundled Agent SDK 0.3.261. Other drivers and unrecognized executables remain preserved but are unavailable in isolated profiles. Managed Codex homes use file-backed credentials and do not share shadow-home overlays. Profile isolation must pass the real-provider release gate below; environment-variable tests alone do not certify platform credential storage.

## Existing data and layout

Default keeps its existing paths and provider logins. No existing data moves. Default continues to inherit shell provider credentials. Other profiles discard ambient provider and GitHub credentials and use their managed homes; explicit API tokens configured on an instance still take precedence.

For a resolved default state directory `D`, profile metadata lives in the sibling directory `D-profiles`, never inside `D`:

```text
D/                              existing Default state
D-profiles/profiles.json         registry
D-profiles/installation-id       shared anonymous installation identity
D-profiles/locks/                process and mutation locks
D-profiles/<32-hex-id>/          another profile's state
  provider-homes/codex/
  provider-homes/claude/
  worktrees/
D-profiles/.trash/               removed profiles
```

Production defaults to `~/.f5/userdata`; the dev runner uses `~/.f5/dev`. `--state-dir`, `F5_STATE_DIR`, `T3CODE_STATE_DIR`, `F5_HOME` and `T3CODE_HOME` retain their existing meaning. Default worktrees stay in `<baseDir>/worktrees`. Profile ids are disk-safe identities; slugs are only selection and display names.

SQLite OS locks prevent two processes from opening the same profile or removing a running profile. Locks disappear when the owning process exits, including after a crash. Network filesystems are unsupported for F5 state. A corrupted or newer registry is never rewritten: explicit selection fails closed; an unselected startup uses literal Default state and shows a diagnostic. A crash while holding the short registry mutation lock requires stopping all backends before removing the indicated `registry.lock` file.

## Browser, CLI and remote access

Launch separate processes with `t3 --profile default` and `t3 --profile work`, or set `F5_PROFILE`. Each non-default profile owns its recorded port. An occupied port is an error, with no fallback scan. Change the port in Settings → Profiles and restart. Recently retired ports are withheld from allocation to reduce browser-storage reuse.

Browser state is isolated by origin, so keep a consistent hostname and protocol. Links preserve the current hostname. Explicit `--port` or `T3CODE_PORT` overrides transfer origin-isolation responsibility to the operator. Every remotely exposed profile needs its own port, origin and `#token=` exchange. Pass the shared `--auth-token` to each server and configure each port on the reverse proxy or private network.

## Desktop lifecycle

Opening a profile starts its backend and opens a window in its own persistent partition. Default retains the existing default partition. Preview browsing uses a separate partition for each profile. At most six backends run concurrently; use **Stop** to free a slot. Closing a profile's window retains its backend while the app remains open. Closing the last window on Windows or Linux quits the app and stops all backends. macOS retains the existing app lifecycle. A second app launch focuses the existing application.

## Git, GitHub and shared repositories

Configure a hostname and token in **Settings → Integrations**. F5 verifies the token with that host and stores it in the current profile's secret store. Ambient `GH_TOKEN`, `GITHUB_TOKEN` and machine `gh auth` logins are no longer used for managed requests, including Default. Configure the profile's Git author name and email before committing. Managed authenticated remote operations require HTTPS without embedded credentials; SSH authentication is not supported. Tokens are passed through a host-restricted credential helper, never command arguments or remote URLs. Repository-local config is not rewritten.

Profiles can open the same repository. Linked worktrees share Git metadata; separate clones are the strongest way to avoid accidental source changes affecting another profile. Profiles isolate F5-owned state, not access to the host filesystem. Deliberately sourcing external shell configuration or manually entering a preview URL is outside the account-isolation guarantee. Automatic preview discovery only considers URLs emitted by owned terminals and provider command output, rather than scanning unrelated listening processes.

## Removal and restore

Default cannot be removed. Stop another profile before removing it; desktop also offers Stop and remove. Removal moves its state and provider logins to `.trash`, rather than deleting them. Git worktrees remain registered until `git worktree prune`. Inspect `.trash` in the sibling metadata directory when recovering removed data.

Backups contain the database, settings, keybindings, attachments and optionally encrypted secrets. They exclude provider-home directories, the registry, locks, trash and sibling profiles. New manifests identify their source installation and profile. Legacy archives without identity can only restore into Default. Managed provider-home paths are rebound to the destination; external paths are preserved. The restore UI warns about another source profile. Provider login files are not carried by backups; sign in where required after restoring. Cross-profile restores also leave destination secrets in place and discard source provider token references. Missing or incompatible project and worktree paths remain visible in Profiles settings, and execution rejects those directories until repaired.

## Real-provider release gate

Before release, record authenticated runs on Windows, macOS and Linux with dedicated accounts. Run two subscription accounts concurrently, then subscription versus API billing. Refresh and log out one while verifying the other remains operational. Check that host credential files remain unchanged, Codex writes only its managed file store, and Claude uses distinct macOS keychain service identities. Exercise login, usage, MCP, terminals and restart, then verify author and fetch/push identity against disposable GitHub repositories. A failure blocks release; do not silently narrow the supported matrix. Authenticated tests must never run in untrusted pull-request jobs.

Release evidence must identify the tested commit, OS, exact executable version, anonymized account labels, native credential locations, and the result of each acceptance step. Keep raw login output and credentials out of the evidence. The macOS CI storage checks are not keychain certification. Until dedicated-account runs are recorded for all three operating systems, the real-provider release gate remains **pending**.

The short-lived registry lockfile is paired with an OS-held SQLite guard. A crashed writer's marker is reclaimed only after acquiring that guard, which proves no live writer owns it. This lets startup reconciliation proceed after a crash without heartbeat or PID-based lock stealing.

Retired browser ports remain reserved permanently. A 32-entry retirement queue would eventually let a new profile inherit an older profile's browser storage; the registry therefore retains all retired ports (bounded by the TCP port range). Default's stable, case-normalized identity keeps its recovery lock consistent when the registry cannot be read; newly created profiles receive random UUID-based IDs.
