# Antigravity

Use Google's Gemini models in F5 through the Antigravity agent. Antigravity is off by default, and
F5 installs it only when you ask. In **Add provider**, searching for "Gemini" or "Google" finds it.

## How to

1. Open **Settings → Providers** and add or enable the Antigravity provider.
2. Click **Install Antigravity**.
3. Choose a **Sign-in method**:
   - **Google account** uses your Google subscription. Click **Sign in** and follow the Google
     link.
   - **Gemini API key** is billed per token by Google. Paste the key, save, then click
     **Connect** in the account panel. Threads start only after Antigravity accepts the key on
     Connect, and a changed key needs a new Connect.
4. Pick a Gemini model in the composer, and a **Thinking** level if the model offers one.

Status checks and new threads never download software or open a browser on their own.

## Models and thinking

The composer lists the models your account offers, with Orchestrator first, then Carbon, Neon and
the rest. Each model shows only the thinking levels it supports. Orchestrator has none.

- F5 learns each model's levels after you sign in or connect, or when you click **Refresh
  provider status**, and from the models threads use. Until then, a model shows no thinking
  control. Starting F5 never runs this check.
- With no level picked, the model uses its own default.
- If a saved level isn't available for a model, F5 uses the model's default and warns once.
- If a saved model isn't available to your account, the message isn't sent and your draft stays.
- Older model names with a level suffix, such as `gemini-3-flash-high`, still work when both the
  model and the level exist.
- Titles, branch names and commit messages use a light model (Hydrogen, then any Flash model) at
  its lowest level, so they don't spend your Neon quota.

## Modes and plan

| F5 mode               | What happens                                                                |
| --------------------- | --------------------------------------------------------------------------- |
| **Supervised**        | F5 asks before every action                                                 |
| **Auto-accept edits** | F5 approves file edits inside the workspace and asks before everything else |
| **Auto**              | Offered once your Antigravity version has advertised its own reviewer       |
| **Full access**       | F5 approves each action once, without asking                                |

- Turn on **Plan** in the composer to make Antigravity plan first. In plan mode F5 asks before
  every action, even in Full access. "Allow for this thread" isn't offered there, and earlier
  thread grants don't apply.
- If your Antigravity version has no plan mode, or a session can't leave it, the turn stops
  before anything is sent.
- If Antigravity rejects Auto when a session starts or a turn begins, that session runs as
  Supervised and shows one warning.
- Questions, forms and computer-use consent always wait for your answer.
- The composer's context meter shows how much of the model's context window the thread uses.

## Accounts

- Sign-ins and keys belong to one F5 instance. They survive restarts and are never copied from your
  global Google setup or from Google environment variables.
- The API key is kept in F5's secret store, never in settings files. **Remove stored key**
  deletes it.
- Changing the sign-in method, the key or the Google account starts fresh Antigravity sessions on
  the next message. F5 keeps the thread history; the old account's native session is never resumed.
  While new sign-in settings are being applied, new turns ask you to retry in a moment.
- Stop running turns before changing accounts.

> [!WARNING]
> With a Gemini API key, commands that Antigravity runs can read the key from their environment.
> The Google account sign-in has the same exposure through its token file. F5 removes the key
> from its own logs, errors and thread events, but not from what those commands do with it.

## Good to know

- Native `/compact` is off by default; turn it on in the provider settings to use it instead of
  F5's compaction.
- Attachments are limited to 50 MiB per turn.
- With an API key, **Usage → Limits** shows "Billed per token" instead of subscription quota.
- The provider card shows the runtime version and whether it is bundled with F5 or an installed
  update, when models were last discovered, and the kind of the last discovery failure (never its
  message).
- Subscription quota, turn-failure details and native child work read Antigravity's private files.
  F5 reads them only on versions it has certified (1.5.13 today); on other versions the card shows
  "Native readers: Off" and threads run on standard ACP only.
- F5 preview tools remain gated pending startup verification and negotiated HTTP MCP support; F5
  computer tools await Antigravity live privacy verification.

<details>
<summary>Details and limits</summary>

| Topic             | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pinned release    | `agy_acp_server_1.1.1` for macOS arm64, Linux x64/arm64 and Windows x64/arm64                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Install           | Streams to a staging folder, checks SHA-256 and exact size, extracts only the two pinned executables and publishes atomically. A damaged install reports its folder instead of being overwritten                                                                                                                                                                                                                                                                                                                                                |
| Sign-in methods   | `oauth-personal` (Google account) and `gemini-api-key`. Gemini Enterprise and Agent Platform are not offered yet. F5 writes the selected method to the instance's `settings.json` before every launch                                                                                                                                                                                                                                                                                                                                           |
| Account revision  | Kept in `f5-auth-state.json` in the instance profile. It advances on sign-in, sign-out, key or method change, and when the signed-in Google account changes. Resume cursors carry it; older cursors count as revision 0                                                                                                                                                                                                                                                                                                                         |
| Account changes   | Idle runtimes stop first. New sessions, turns, compaction and metadata are blocked until the account job ends. Settings saves that change the method or key wait for the same guard. Installing doesn't block other sign-ins                                                                                                                                                                                                                                                                                                                    |
| Model discovery   | Runs only after a successful sign-in or connect, or **Refresh provider status**, in the background, in a throwaway session in a temporary folder without project MCP servers: at most 24 model changes and 90 seconds, current model, Neon and Orchestrator first. It restores the original model after any switch, including on failure or timeout, and retries after a failure no sooner than a minute later. The catalog, and whether Auto was offered, is reused after a restart only for the same account revision and Antigravity version |
| Session modes     | F5 writes one native mode per session: `plan` while Plan is on, `auto` for Auto when advertised, `default` otherwise. It uses `session/set_mode` when the session reports modes, otherwise the `mode` option, and skips the write when the mode already matches                                                                                                                                                                                                                                                                                 |
| Auto-accept edits | Approves only a request whose kind is `edit` and that is shaped like one of Antigravity's file-edit tools, carries no command field, and whose every target is an absolute path inside the workspace after resolving links. Anything ambiguous is asked                                                                                                                                                                                                                                                                                         |
| Context meter     | Read from Antigravity's `usage_update` samples. These measure context, not billing; repeated values are ignored                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Forms             | Optional fields can be skipped. Unsupported forms are cancelled, never auto-approved                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Subagents         | A launched subagent counts as running work until the parent turn finishes                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Skills            | `~/.gemini/config/skills`, `~/.gemini/antigravity-cli/skills`, `~/.gemini/AGENTS.md`, `~/.gemini/GEMINI.md` and `~/.gemini/config/skills.json` are linked in (copied on Windows) and never overwrite profile files. Credentials, hooks and MCP config are not                                                                                                                                                                                                                                                                                   |
| Skill catalog     | User and project skill folders, `skills.json` entries (`inherits`, `include_only`, `exclude`) and enabled plugins. Every folder and `SKILL.md` read, after following links, must stay under your home, the instance profile or the project. The home catalog is rescanned only when its folders change                                                                                                                                                                                                                                          |
| Process isolation | Each process gets its own temp folder, removed at shutdown. Inherited Gemini and Google credentials, ADC files and Google Cloud project settings are removed; only the selected method's own credential is added back                                                                                                                                                                                                                                                                                                                           |

</details>

## Related

- [Provider prerequisites](../provider-prerequisites.md)
- [Runtime modes](../runtime-modes.md)
- [Usage and limits](../user/usage-limits.md) (Antigravity quotas)
