# Privacy

F5 has no product analytics, usage telemetry or crash reporting, and no identifier that leaves
your machine. This page lists every request F5 makes on its own, what `DO_NOT_TRACK` turns off,
and what F5 keeps on disk.

Requests you start yourself are not listed: sending a prompt to a provider, opening a pull
request, cloning, signing in, installing a provider CLI and so on.

## `DO_NOT_TRACK`

Set `DO_NOT_TRACK=1` (or `true`, `yes`, `on`) in the environment F5 starts with. On macOS the
desktop app also reads it from your login shell when it is launched from Finder or the Dock. While
it is set:

- provider CLI update lookups run only when you press **Check for updates**
- the remote model manifest is never fetched, even when it is enabled in Settings
- file and folder icons are drawn locally instead of loaded from jsDelivr

It does not turn off desktop app updates (see below), an OTLP collector you configured in
Settings, or anything you start yourself.

## Requests F5 makes on its own

| Request                     | Destination                                                      | When                                                                                     | Turn off                                                                               |
| --------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Desktop app updates         | GitHub Releases for `lopes-felipe/f5`                            | At startup and every 4 hours                                                             | `T3CODE_DISABLE_AUTO_UPDATE=1`                                                         |
| Provider CLI update lookups | npm registry, Homebrew API, GitHub Releases                      | Periodically, for installed providers                                                    | **Settings → Providers → Automatically check for provider updates**, or `DO_NOT_TRACK` |
| Remote model manifest       | `raw.githubusercontent.com/lopes-felipe/f5`                      | Only when **Refresh model classification online** is on (off by default)                 | Leave the setting off, or `DO_NOT_TRACK`                                               |
| File icons                  | `cdn.jsdelivr.net` (vscode-icons)                                | When file lists, diffs or mentions show a file                                           | `DO_NOT_TRACK`                                                                         |
| List-price table            | `raw.githubusercontent.com/BerriAI/litellm`                      | Only when **Usage → Use model list prices** is on (off by default), at most daily        | Leave the setting off                                                                  |
| Account limits and history  | Each provider's own endpoint (see below)                         | To show account limits, and Cursor history when **Include Cursor account history** is on | Don't open limits for that account; leave the setting off                              |
| Forge APIs                  | GitHub, GitLab, Bitbucket, Azure DevOps, Forgejo hosts you added | PR Hub, branch and pull request status                                                   | Remove the forge account                                                               |

None of these requests carries an F5 identifier. Update lookups send the package name and, for
GitHub, the repository.

### Account limits and the credentials F5 reads

To show remaining quota, F5 reads the sign-in each provider CLI already stores and sends it only
to that provider:

- **Claude**: the Claude Code entry in the macOS Keychain, sent to `api.anthropic.com`
- **Cursor**: Cursor's Keychain token, sent to `api2.cursor.sh` and `cursor.com`
- **Codex, Grok, Antigravity**: their `auth.json` files, sent to the provider's usage endpoint
  (`cli-chat-proxy.grok.com`; Google's OAuth token, userinfo and Cloud Code quota endpoints for
  Antigravity)
- **OpenCode Zen**: the configured key, sent to `opencode.ai`

F5 does not copy these credentials into its own files, logs or backups. **Include local provider
history** reads OpenCode and Antigravity history from their local stores and sends nothing.

## Provider CLIs

Agent processes start with `DO_NOT_TRACK=1`, `DISABLE_TELEMETRY=1` and
`DISABLE_ERROR_REPORTING=1`, which opt Claude Code and other CLIs that honor them out of usage
metrics and crash reports. Codex also gets `analytics.enabled=false`, and inherited `OTEL_*`
variables never reach any agent. A value already in your environment wins, and a provider
instance's **Environment** setting can override each one.

Terminals and git commands keep your environment unchanged.

**Known vendor telemetry.** The Cursor SDK includes Statsig-based telemetry with no switch F5
can set. F5 still passes `DO_NOT_TRACK`, which the SDK may ignore.

## Observability export

F5 records traces and metrics locally for **Settings → Diagnostics**. It exports them only to an
OTLP collector you enter there. `OTEL_EXPORTER_OTLP_*` endpoints, headers and resource attributes
in the environment are ignored, so a workstation-wide collector never receives F5 data.
`OTEL_SDK_DISABLED=true` still turns export off.

## What F5 keeps on disk

Everything lives under the state directory (`~/.f5` by default; see
[Environment variables](environment.md)).

- **Provider logs** (`logs/provider/`): each thread's raw provider events, rotated at 10 MB with
  up to 10 files per thread, and removed by storage cleanup once the thread is deleted. API keys,
  tokens, JWTs, `Bearer` and `Basic` credentials, passwords in URLs and private keys are replaced
  with `[REDACTED]` before writing. A secret split across two streamed chunks is not caught.
  Screenshots and other inline images are replaced with a placeholder.
- **Attachments** (`attachments/`): images and files you or an agent attach, including
  screenshots, kept with their thread.
- **Secrets** (`secrets/`): provider API keys, forge tokens and similar values, stored as files
  readable only by your user (mode 0600). Moving them to the OS keychain is planned.
- **Backups**: a backup includes credentials (`secrets/` and unredacted settings) only when you
  choose to, and then encrypts them with the backup password. The database and attachments in it
  are not encrypted.
- **Browser cookies**: the preview browser keeps its own cookies, including any you import from
  another browser. The desktop app stores them encrypted with the same OS key it uses for
  `safeStorage`.

There is no installation-wide identifier sent anywhere. `installation-id` under the profiles
directory stays local; backups and the profile registry use it.
