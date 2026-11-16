# Antigravity

Use Google's Antigravity agent as an F5 provider. It's off by default, and F5 installs its
runtime only when you ask.

## How to

1. Open **Settings → Providers** and add or enable the Antigravity provider.
2. Click **Install Antigravity**.
3. Click **Sign in** and follow the Google link.
4. Pick **Antigravity Default** or another model in the composer.

Status checks and new threads never download software or open a browser on their own.

## Models and conversations

The composer lists the models the running agent reports. Until the first session starts,
**Antigravity Default** uses your account's default model; custom model names also work. Slash
commands, reasoning, questions, approvals and forms use the normal F5 thread UI. Approval buttons
show only Antigravity's own choices.

## Good to know

- Antigravity supports **Supervised** and **Full access** modes. Questions still need an answer in
  full access.
- Native `/compact` is off by default; turn it on in the provider settings to use it instead of
  F5's compaction.
- Google sign-ins belong to one F5 profile and provider, survive restarts, and are never copied
  from your global Google setup.
- Stop running turns before changing accounts.
- Attachments are limited to 50 MiB per turn.

- F5 preview tools remain gated pending startup verification and negotiated HTTP MCP support; F5 computer tools await Antigravity live privacy verification.

<details>
<summary>Details and limits</summary>

| Topic             | Detail                                                                                                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pinned release    | `agy_acp_server_1.1.1` for macOS arm64, Linux x64/arm64 and Windows x64/arm64                                                                                                                                                    |
| Install           | Streams to a staging folder, checks SHA-256 and exact size, extracts only the two pinned executables and publishes atomically. A damaged install reports its folder instead of being overwritten                                 |
| Account changes   | Idle runtimes stop first. New sessions, turns, compaction and metadata are blocked until the account job ends. Installing doesn't block other sign-ins                                                                           |
| Forms             | Optional fields can be skipped. Unsupported forms are cancelled, never auto-approved                                                                                                                                             |
| Subagents         | A launched subagent counts as running work until the parent turn finishes                                                                                                                                                        |
| Skills            | Only `~/.gemini/config/skills` and `~/.gemini/antigravity-cli/skills` are linked in. Credentials, hooks and MCP config are not. The same folders in the provider's home form its own skill catalog, scanned on each status check |
| Process isolation | Each process gets its own temp folder, removed at shutdown. Agent commands keep Python and Google Cloud config, but Antigravity auth overrides are removed                                                                       |

</details>

## Related

- [Provider prerequisites](../provider-prerequisites.md)
- [Usage and limits](../user/usage-limits.md) (Antigravity quotas through CLIProxyAPI)
