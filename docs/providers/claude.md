# Claude

Set up Claude Code in F5. You can use one account, separate work and personal accounts, or route
Claude through OpenRouter or Claude Code Router.

![Settings → Providers with Codex and Claude signed in](../images/settings-providers.webp)

## How to

1. Run `claude auth login` once in a terminal.
2. Open **Settings → Providers**. The default Claude provider uses the executable bundled with
   F5, so you don't need a global `claude` command.
3. Leave **Claude HOME path** empty to use your normal home directory.
4. Pick a Claude model in the composer and start a thread.

## Work and personal accounts

Give each account its own Claude home:

```bash
mkdir -p ~/.claude_personal_home
HOME=~/.claude_personal_home claude auth login
```

Then add a second Claude provider in **Settings → Providers** with **Claude HOME path** set to
`~/.claude_personal_home`. Name both providers clearly (for example "Claude Work" and "Claude
Personal"). Each provider row shows the signed-in email; click the blurred email to reveal it.

An existing thread only offers Claude providers that use the same Claude home, because Claude Code
keeps account and session state together in that home.

## OpenRouter

Add a Claude provider with its own home (for example `~/.claude_openrouter_home`) and set these
**Environment variables** on it:

| Variable               | Value                                       |
| ---------------------- | ------------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`                 |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter key (mark it **Sensitive**) |
| `ANTHROPIC_API_KEY`    | Empty                                       |

Use `https://openrouter.ai/api`, not `/api/v1`. To pin models, also set
`ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`
and `CLAUDE_CODE_SUBAGENT_MODEL`. Run `/status` in a Claude session to confirm the base URL. See
[OpenRouter's Claude Code guide](https://openrouter.ai/docs/guides/guides/claude-code-integration)
for current details.

## Claude Code Router

F5 needs no special provider for [Claude Code Router](https://github.com/musistudio/claude-code-router).
Start the router, add a Claude provider with a dedicated home, and copy the variables that
`ccr activate` exports into that provider's **Environment variables**. Mark tokens as sensitive.

## Presets on the same account

Add another Claude provider when you want a named preset ("Claude Experimental") rather than a
new account. Use a different **Claude HOME path** for different Claude files, and **Environment
variables** for keys, base URLs or router settings. Don't put variable assignments in **Launch
arguments**.

## Good to know

- Sensitive variables are stored as server secrets and never sent back to the app.
- **Auto** access mode lets Claude's own reviewer approve actions. It can approve risky commands
  without asking; use it only where that is acceptable.
- Use `/goal <objective>` to set a native Claude goal, `/goal` to check it, and
  `/goal clear` to clear it. The chat header shows the goal and its status. Claude owns
  the evaluation and continuation; F5 mirrors its native output. A stopped or failed turn
  keeps the goal active. SDK mode does not distinguish a passed check from an evaluator
  timeout or an impossible verdict when Claude reports a successful completion.
- Native compaction and file checkpointing are on by default. You can turn either off per
  provider; the change applies at the next session start.
- **Prompt before compacting resumed sessions** (off by default) shows Claude's resume dialog
  before compacting. **Auto-compact window** sets when automatic compaction starts.
- F5 keeps Claude transcripts for 3,650 days so old threads can resume. Deleting a thread removes
  its transcript from F5-owned homes.
- Provider instances and [profiles](../profiles.md) solve different problems. Instances are several
  Claude entries inside one profile, each with its own Claude home. A profile is a separate F5
  environment with its own projects, threads, accounts and in-app login.

<details>
<summary>Details and limits</summary>

| Topic                | Detail                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Bundled runtime      | Claude Code v2.1.295 (Agent SDK 0.3.295)                                                                                         |
| Model requirements   | Fable 5.1 needs v2.1.257+; Opus 5.5 needs v2.1.280+; Sonnet 5.5 and Haiku 5.5 need v2.1.299+                                     |
| Default model        | Opus 5.5 with `medium` effort                                                                                                    |
| Custom executables   | Known older versions hide models they can't run and show an upgrade notice; unknown versions list all models                     |
| Auto-compact window  | `0` for the CLI default, or 100,000–1,000,000 tokens                                                                             |
| Transcript retention | `F5_CLAUDE_CLEANUP_PERIOD_DAYS` overrides the 3,650-day default; a value in the instance's `settings.json` wins                  |
| Task tools           | Native `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet` by default; set `CLAUDE_CODE_ENABLE_TASKS=0` on the server for `TodoWrite` |
| Thinking             | Provider option `thinking`: `{ "type": "adaptive" }`, `{ "type": "enabled", "budgetTokens": 8000 }` or `{ "type": "disabled" }`  |
| Account usage        | One card per Claude provider on the Usage page; values above 100% are shown as reported                                          |

</details>

## Related

- [Usage and limits](../user/usage-limits.md)
- [Provider prerequisites](../provider-prerequisites.md)
- [Codex](codex.md)
- [Claude implementation and release notes](../reviews/claude-provider-releases.md) (contributors)
