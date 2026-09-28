# Profiles

A Profile is an independent F5 environment with its own accounts, projects, conversations, settings, secrets, attachments, logs and worktrees. A project's `workspaceRoot` remains its source directory. **Display profile** remains the appearance-density setting. Electron session storage is called a **partition**.

Create a profile in **Settings → Profiles**, then open it and use its account panels to sign in. Account setup works before adding a project. Login output is streamed in memory and is never written to terminal history or server logs. Cancel terminates the owned login process. Only one provider or MCP OAuth login can run per installation at a time; another login receives a visible conflict. F5 never terminates an unrelated callback-port owner.

Codex 0.144.3 and newer versions are allowed for subscription and API-key accounts. Claude uses the bundled Agent SDK 0.3.280. Other drivers and unsupported Claude executables remain preserved but are unavailable in isolated profiles. Managed Codex homes use file-backed credentials and do not share shadow-home overlays. Profile isolation must pass the real-provider release gate below; environment-variable tests alone do not certify platform credential storage.

Account usage is read through each configured provider instance, using the same home and environment as its sessions. Codex usage caches are instance-local; an unavailable instance never falls back to the machine account. Provider-reported subscription limits can still match when two profiles deliberately sign into the same upstream account.

## Existing data and layout

Default keeps its existing paths and provider logins. No existing data moves. Default continues to inherit shell provider credentials. Other profiles discard ambient provider credentials and use their managed homes; explicit provider API tokens configured on an instance still take precedence. GitHub credentials are profile-owned in every profile, including Default; shell GitHub tokens and workstation gh logins are not inherited.

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

## GitHub authentication

Connect in **Settings → Integrations → GitHub**. **Sign in with GitHub** (github.com) displays a device code and opens GitHub in your browser. Select the account intended for this profile. The verified username is shown after authorization. Use **Reconnect** to change accounts and **Disconnect** to remove the local connection.

A personal access token remains available for github.com and GitHub Enterprise hosts. **Use GitHub CLI login** imports an account your terminal's `gh` is already logged in to (see below). The profile connection is used by F5’s GitHub features and by ordinary `gh` commands in its agents and terminals. Default must connect explicitly once; F5 never imports workstation credentials automatically. Existing saved profile tokens migrate automatically, without requiring network access at startup.

Credentials are stored in the existing profile secret store and projected into `<profile-state>/github/hosts.yml`. The directory and files are private to the OS user (0700/0600 on POSIX, a user-only DACL on Windows). This is file-based credential storage, not encryption at rest. If reconciliation fails, the backend remains available and logs the cause, while GitHub consumers fail closed until the connection is repaired. Windows permission updates are batched into one PowerShell invocation per projection write. Generated CLI files are excluded from backups; restore regenerates them from secrets supplied through the encrypted-backup flow. Do not edit the generated file or run `gh auth login/logout/switch` to manage an F5 connection: use Settings so all consumers stay consistent and workstation keychain entries remain untouched.

F5 installs a profile CLI launcher and restores its PATH entry after Default shell startup files run. It clears inherited GitHub token overrides while preserving other shell customizations and explicit `GH_HOST`/`GH_REPO` routing. Already-running sessions pick up connection changes on their next `gh` invocation. An in-flight command may finish with the credential it already captured. Disconnected known hosts (those listed in the projection) use an invalid placeholder token to prevent implicit OS-keychain fallback; gh can still consult the keychain for hosts the profile has never connected, so Git credentials never come from gh (see below). Profile isolation controls F5-managed execution; it is not a security boundary against arbitrary programs running as the same OS user.

Non-default profiles require explicit HTTPS remotes without embedded credentials or URL rewrites for managed Git network operations and use the profile’s token. Default preserves workstation Git transports, SSH agents, URL rewrites, and credential helpers for unconnected hosts. For a single HTTPS remote with a saved profile token, F5 selects that token through a host-specific credential helper. Configure Git author name/email separately; signing into GitHub does not change commit authorship. Default retains its local Git settings and author fallback.

The profile launcher answers Git credential requests (`gh auth git-credential get`) itself, from `<profile-state>/github/git-credentials.json`. That file lists connected hosts only and has the same protection as `hosts.yml`. The launcher never delegates to gh, so workstation keychain credentials are never returned. It answers nothing for any other host, so Git falls through to the next helper. `store`/`erase` requests are ignored.

**Non-default profiles.** Agents and terminals get these `GIT_CONFIG_*` environment entries:

- **Credential helper:** for each GitHub host known to the profile (github.com plus hosts listed in the projection when the session starts), inherited helpers are reset through `credential.https://<host>.helper` and the profile launcher is used. Connecting, reconnecting, or disconnecting a known host applies to running sessions. An Enterprise host connected for the first time needs a new session. Other hosts, such as GitLab, Bitbucket, or Azure DevOps, keep their inherited helpers.
- **Git author:** `<profile-state>/git-author.gitconfig` is included. F5 rewrites it whenever the Git author setting changes. Once both name and email are set, they override repository `user.name`/`user.email` for agent and terminal commits. Clearing both restores normal Git resolution.

**Default.** F5 adds no Git configuration to agents and terminals. Each repository keeps its own identity, and workstation helpers stay untouched: an F5-added helper would let Git `store` the profile token into helpers such as the OS keychain. A bare `!gh auth git-credential` helper resolves to the profile launcher through PATH and behaves as described above.

Known limitation: `gh auth setup-git` normally writes the full path (for example `!/opt/homebrew/bin/gh auth git-credential`). That helper bypasses the launcher and runs the real gh with the profile's `GH_CONFIG_DIR`. For a disconnected github.com it returns the placeholder token, and the push fails with bad credentials instead of falling through. Connect github.com in Settings, or change the helper to the bare `!gh auth git-credential` form.

### Use GitHub CLI login

**Use GitHub CLI login** lists the accounts your terminal's GitHub CLI is logged in to, on any host, and imports the one you choose. Nothing is imported until you click **Import**.

- **Read-only.** F5 runs only `gh auth status --json hosts` to list accounts; its output contains no tokens. It then runs `gh auth token --hostname <host> --user <login>` for the account you pick. Neither command changes your gh login or keychain, unlike `gh auth login`.
- **Your normal gh setup.** F5 runs the real `gh` found on PATH, skipping F5 launcher directories. It removes inherited token and routing overrides (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GH_HOST`) and any F5 profile `GH_CONFIG_DIR`, so gh reads your normal configuration and keychain. A custom `GH_CONFIG_DIR` of your own is kept.
- **Checked before saving.** The token is verified against the host, and the account must match the one you picked. Otherwise nothing is saved and an existing connection is kept. The token goes only into the profile secret store; it never reaches the UI or logs.
- **A snapshot.** Later logouts, account switches, or refreshes in your terminal don't affect F5. Use the button again to update.
- **Scopes.** F5 needs `repo`, `read:org`, and `notifications`. gh logins usually lack `notifications`, so F5 flags missing scopes and suggests `gh auth refresh -h <host> -s notifications` followed by importing again. F5 does not run that command itself, because it would change your terminal login.
- **Isolated profiles.** The button is available in isolated profiles too. Importing a workstation account there is a deliberate choice, since the account then becomes that profile's GitHub identity.

### Shared repositories

Profiles can open the same repository. Linked worktrees share Git metadata; separate clones are the strongest way to avoid accidental source changes affecting another profile. Profiles isolate F5-owned state, not access to the host filesystem. Deliberately sourcing external shell configuration or manually entering a preview URL is outside the account-isolation guarantee. Automatic preview discovery only considers URLs emitted by owned terminals and provider command output, rather than scanning unrelated listening processes. This applies to Default too: externally started servers and URLs emitted before an F5 restart must be entered manually.

### Browser sign-in

F5 runs GitHub's OAuth device flow itself and saves the token through the profile secret store. It does not need gh installed.

- **OAuth app.** By default it uses GitHub CLI's public OAuth client ID, so no app registration is needed. Device-flow client IDs are public, and no client secret exists. Set `F5_GITHUB_OAUTH_CLIENT_ID` to use a different app, such as an F5-owned one with Device Flow enabled and expiring tokens disabled. Set it to an empty value to turn browser sign-in off.
- **Why not `gh auth login`.** F5 deliberately does not run it: gh's login always rewrites the OS keychain entry of the workstation gh (it deletes `gh:<host>` before activating the new account), even with `--insecure-storage`, so it would sign your terminal gh out.
- **Scopes.** The sign-in requests `repo`, `read:org`, and `notifications`, the same scopes as the token-creation link in Settings.
- **Revoking.** With the default app, GitHub lists the grant under **Authorized OAuth Apps** as “GitHub CLI”. Revoking it there also revokes gh sessions on this computer that were authorized by the same app. Disconnect in F5 does not revoke anything on GitHub.

Every agent and terminal in the connected profile can exercise those privileges, including repository writes allowed by the account. This also applies to Default; prompt injection into an agent can misuse those credentials. Profile separation selects accounts predictably and does not sandbox agent permissions. Organization approval/SSO restrictions can still require additional authorization on GitHub.

Browser sign-in targets github.com; GitHub Enterprise hosts connect with a token. Pending device grants are held only in memory; after a backend restart, start sign-in again. F5 rejects expiring OAuth tokens (refresh-token support is not implemented) instead of silently persisting a short-lived connection.

## Removal and restore

Default cannot be removed. Stop another profile before removing it; desktop also offers Stop and remove. Removal moves its state and provider logins to `.trash`, rather than deleting them. Git worktrees remain registered until `git worktree prune`. Inspect `.trash` in the sibling metadata directory when recovering removed data.

Backups contain the database, settings, keybindings, attachments and optionally encrypted secrets. They exclude provider-home directories, the registry, locks, trash and sibling profiles. New manifests identify their source installation and profile. Legacy archives without identity can only restore into Default. Managed provider-home paths are rebound to the destination; external paths are preserved. The restore UI warns about another source profile. Provider login files are not carried by backups; sign in where required after restoring. Cross-profile restores also leave destination secrets in place and discard source provider token references. Missing or incompatible project and worktree paths remain visible in Profiles settings, and execution rejects those directories until repaired.

## Real-provider release gate

Before release, record authenticated runs on Windows, macOS and Linux with dedicated accounts. Run two subscription accounts concurrently, then subscription versus API billing. Refresh and log out one while verifying the other remains operational. Check that host credential files remain unchanged, Codex writes only its managed file store, and Claude uses distinct macOS keychain service identities. Exercise login, usage, MCP, terminals and restart, then verify author and fetch/push identity against disposable GitHub repositories. A failure blocks release; do not silently narrow the supported matrix. Authenticated tests must never run in untrusted pull-request jobs.

Release evidence must identify the tested commit, OS, exact executable version, anonymized account labels, native credential locations, and the result of each acceptance step. Keep raw login output and credentials out of the evidence. The macOS CI storage checks are not keychain certification. Until dedicated-account runs are recorded for all three operating systems, the real-provider release gate remains **pending**.

The short-lived registry lockfile is paired with an OS-held SQLite guard. A crashed writer's marker is reclaimed only after acquiring that guard, which proves no live writer owns it. This lets startup reconciliation proceed after a crash without heartbeat or PID-based lock stealing.

Retired browser ports remain reserved permanently. A 32-entry retirement queue would eventually let a new profile inherit an older profile's browser storage; the registry therefore retains all retired ports (bounded by the TCP port range). Default's stable, case-normalized identity keeps its recovery lock consistent when the registry cannot be read; newly created profiles receive random UUID-based IDs.

## Shell startup and recovery storage

Non-default terminals intentionally do not source machine shell startup files. F5 preserves the launching process's PATH and discovered executable paths, plus permitted explicit PATH overrides. Tools installed only by an rc-file hook (nvm, pyenv, asdf or similar) may require adding their executable directories to PATH before launching F5 or in the terminal environment. Automatically sourcing those files could load another account's credentials; Default retains its existing shell startup behavior.

Trash has no automatic retention period. Removal preserves recovery data and does not reclaim its disk space; inspect the displayed `.trash` directory and remove unwanted recovery directories using the operating system when recovery is no longer needed. Small lock metadata files are deliberately retained so concurrent processes never acquire different lock inodes for the same identity. Successful startup clears its previous startup-error record. Ports are never automatically recycled into another profile's browser storage.

Browser authentication cookies include the stable profile ID because cookies are shared across ports on the same hostname. Login output and input handles belong to the connection that started the operation, including sign-out. Disconnecting terminates its account terminal before releasing the OAuth lease. MCP's CLI login timeout is nine minutes, leaving teardown time within the installation-wide ten-minute login budget.

### Codex version mismatch

Isolated profiles require Codex 0.144.3 or newer. This minimum is independent of the protocol audit baseline: auditing a newer release does not automatically raise the minimum. Versions differing from the audited baseline show an informational notice, but sign-in and sessions remain available. Global Codex updates no longer require downgrading or installing a separate executable. Missing executables, failed or unreadable version probes, and versions below the minimum still produce actionable errors.

Managed homes, file-backed credentials, environment filtering and protection against account-home overrides remain mandatory. Startup and protocol failures retain their cause; F5 never falls back to a host account. Version checks and successful startup do not prove credential isolation: the real-provider release gate above still applies.

Claude's Signed in badge is determined by the instance's `auth status` result. SDK initialization and model discovery alone do not prove authentication. Recheck refreshes both account details and the provider snapshot.

### Login troubleshooting

On macOS, F5 keeps the real user HOME for managed Claude processes so the OS can access the existing login keychain. `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR` remain profile-specific; Claude uses the config directory to distinguish keychain entries. F5 does not reset or create a system keychain. A successful browser page or CLI exit is not proof that credentials were saved: use Recheck and verify the profile's signed-in status. The cross-account macOS acceptance gate still requires a real-machine run.

If Codex browser sign-in fails, select **Use device code**. F5 cancels the current attempt and starts `codex login --device-auth` using the same managed credential home. This flow does not bind the localhost callback port; it still holds the shared login lease until the process exits. Device-code login must be enabled for the ChatGPT account or allowed by its workspace administrator. See [Codex authentication](https://developers.openai.com/codex/auth). This alternative does not guarantee recovery from an upstream authentication outage.
