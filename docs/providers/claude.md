# Claude

This guide is for people who want to use more than one Claude setup in T3 Code.

Common reasons:

- use separate work and personal Claude accounts
- try a different Claude Code configuration without disturbing your main setup
- run Claude through a router such as Claude Code Router
- use external providers exposed through a Claude-compatible workflow

## I Only Use One Claude Account

Use the default provider.

Log in with Claude Code normally:

```bash
claude auth login
```

In T3 Code Settings, your Claude provider can stay like this:

```text
Display name: Claude
Binary path: claude
Claude HOME path: empty
```

The default `claude` binary setting selects the executable bundled with the Claude Agent SDK; it
does not require a global `claude` command on `PATH`. An empty `Claude HOME path` means T3 Code uses
your normal home directory.

F5 pins Claude Agent SDK 0.3.261, which bundles Claude Code v2.1.261. Claude Fable 5.1
requires v2.1.257+ and provides native 1M context. Opus 5 remains the default Claude model.
F5 enables task tools and selects the legacy TodoWrite surface to match its assistant contract.

With a custom executable, known versions below v2.1.257 omit Fable 5.1 and show an upgrade
advisory. Unknown versions remain permissive. Bare `fable` and `claude-fable` aliases now
resolve to Fable 5.1; explicit `fable-5` stays on Fable 5. Unavailable picker selections
fall back to a supported option. Persisted thread models and sub-agent overrides are forwarded
without silent substitution, so an older executable can reject them. Select a supported model
or upgrade the custom executable to recover.

### Reproducing bundled-runtime release checks

Run `bun run --cwd apps/server test:claude:live` using Node 24.13.1+ on `PATH` and an
authenticated Claude account with Fable 5.1 access. This opt-in suite consumes account quota;
ordinary test runs skip it. Authentication, quota, entitlement, timeout, and response-shape
failures fail the live run rather than being reported as passes or automatic skips.

The suite uses the bundled executable and the adapter's production query environment. It checks
account usage through `normalizeClaudeAccountUsage`, native 1M context, cancellation and child
process exit, streamed `TodoWrite` calls completing a three-step task, and structured `xhigh`
generation through the production generator and schema validator.

On September 5, 2026 at 17:47 CEST, all three live checks passed with SDK 0.3.261 / Claude Code
2.1.261 on Windows under Node 24.13.1 (30.75 seconds). The earlier account session-limit blocker
had cleared. These results do not claim live historical-CLI or workflow/sub-agent dispatch coverage.

`ClaudeRecovery.test.ts` separately runs the real SDK against a deterministic executable fixture:
an unsupported parent or sub-agent alias makes the child exit nonzero, F5 emits a bounded failed
turn and session exit, and correcting the corresponding configuration produces a successful
retry. It verifies both child processes exit. This is transport/adapter coverage, not a smoke test
of an actual older Anthropic release.

## I Want Work And Personal Claude Accounts

Use a different Claude home for each account.

Example:

```text
default home                 work account
~/.claude_personal_home       personal account
```

### Set Up The First Account

Log in normally:

```bash
claude auth login
```

In T3 Code Settings:

```text
Display name: Claude Work
Binary path: claude
Claude HOME path: empty
```

### Set Up The Second Account

Log in with a separate home:

```bash
mkdir -p ~/.claude_personal_home
HOME=~/.claude_personal_home claude auth login
```

Then add another Claude provider in T3 Code:

```text
Display name: Claude Personal
Binary path: claude
Claude HOME path: ~/.claude_personal_home
```

Use the email shown in Settings to confirm each provider is using the intended account. Emails are
blurred by default; click the blurred email to reveal it.

## Can I Switch Claude Accounts In An Existing Thread?

Usually, no.

T3 Code only offers Claude providers that use the same Claude home for an existing thread. A
different Claude home is treated as a different Claude environment.

This is different from the recommended Codex setup. Claude Code keeps account and local state across
multiple files under its home directory, so T3 Code keeps separate Claude homes isolated instead of
trying to share part of the state.

## I Want To Use OpenRouter

Use this when you want Claude Code to talk to OpenRouter directly, without running a local router.
This is the simplest external-provider setup.

OpenRouter provides a Claude Code integration through Claude's Anthropic-compatible environment
variables.

### Configure A Claude OpenRouter Provider

Add or edit a Claude provider in T3 Code Settings:

```text
Display name: Claude OpenRouter
Binary path: claude
Claude HOME path: ~/.claude_openrouter_home
```

In that provider's Environment variables section, add:

```text
ANTHROPIC_BASE_URL   https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN sk-or-...                Sensitive
ANTHROPIC_API_KEY                              Empty value
```

Mark `ANTHROPIC_AUTH_TOKEN` as sensitive. T3 Code stores the value as a server secret and does not
send it back to the app after saving.

If you want this setup isolated from your normal Claude account, create that home first:

```bash
mkdir -p ~/.claude_openrouter_home
```

If you previously used the same Claude home with a normal Anthropic login, run `/logout` in a Claude
Code session for that home before using OpenRouter. Otherwise Claude Code may keep using cached
Anthropic credentials instead of the OpenRouter token.

### Pick OpenRouter Models

OpenRouter can route Claude Code's default model roles to OpenRouter model IDs.

Example:

```text
ANTHROPIC_DEFAULT_OPUS_MODEL    anthropic/claude-opus-4.6
ANTHROPIC_DEFAULT_SONNET_MODEL  anthropic/claude-sonnet-4.6
ANTHROPIC_DEFAULT_HAIKU_MODEL   anthropic/claude-haiku-4.5
CLAUDE_CODE_SUBAGENT_MODEL      anthropic/claude-sonnet-4.6
```

Add those to the same provider's Environment variables section if you want stable model choices.

### Verify OpenRouter Is Being Used

Open a Claude session and run:

```text
/status
```

You should see the Anthropic base URL set to:

```text
https://openrouter.ai/api
```

You can also check the OpenRouter activity dashboard for requests from your API key.

### Common OpenRouter Mistakes

- Use `https://openrouter.ai/api`, not `https://openrouter.ai/api/v1`, for Claude Code.
- Set `ANTHROPIC_AUTH_TOKEN` to your OpenRouter API key.
- Set `ANTHROPIC_API_KEY` to an empty string so Claude Code does not try to use an Anthropic login.
- Put these variables on the Claude provider instance, not in global shell startup files.

OpenRouter's setup can change over time. Use its upstream Claude Code guide for the current details:
<https://openrouter.ai/docs/guides/guides/claude-code-integration>.

## I Want To Use Claude Code Router

Claude Code Router is useful when you want a local routing layer with more control than a direct
OpenRouter setup.

T3 Code does not need a special Claude Code Router provider. Treat the router as a Claude
environment.

Use this when you want Claude Code Router to decide which upstream model or provider handles Claude
requests.

High-level flow:

1. Start Claude Code Router.
2. Add or configure a Claude provider in T3 Code.
3. Put the router's required variables on that provider instance.

Configure a Claude provider:

```text
Display name: Claude Router
Binary path: claude
Claude HOME path: ~/.claude_router_home
```

Then copy the variables that `ccr activate` would export into the provider's Environment variables
section. Mark tokens and API keys as sensitive.

If you want the router-backed setup to stay separate from your normal Claude account, create and log
in with a dedicated home first:

```bash
mkdir -p ~/.claude_router_home
ccr start
ccr activate
HOME=~/.claude_router_home claude auth login
```

Claude Code Router's setup can change over time. Use its upstream README for the current install and
configuration steps: <https://github.com/musistudio/claude-code-router>.

## I Want Different Claude Settings, Not A Different Account

Create another Claude provider with the same account if you want a named preset.

Examples:

- "Claude Default"
- "Claude Router"
- "Claude Experimental"

If the preset needs different Claude files, give it a different `Claude HOME path`. If it needs
different API keys, base URLs, or router settings, use Environment variables.

Do not put environment variable assignments in `Launch arguments`.

## Account Usage and Limits

The Usage page shows one account card for each configured Claude instance, alongside F5 activity.
Account cards use the instance's server-default authentication context: its configured HOME and
environment, with the server working directory and user/project/local settings. A conversation's
project-specific overrides can select another authentication context and are outside these cards.

Account usage uses the installed Claude Agent SDK's experimental structured `/usage` control API.
Its method and response can change between SDK releases. Unsupported versions receive an explicit
unsupported state; an initialization, authentication, executable, or response failure is reported
separately. Raw provider errors and account payloads are not sent to the browser.

Opening Usage schedules stale account reads without blocking historical activity. Attempts are reused
for five minutes after completion, with at most two account probes running across all instances. Refresh updates
history and requests fresh account data; force refresh bypasses the five-minute cache after a
30-second minimum interval and coalesces with any queued or running job. Each probe has an eight-second
budget after acquiring a permit. Switching the history range or provider does not trigger account
reads. Focus and reconnect refresh stale account snapshots. While jobs run, the page polls in-memory
progress; it does not periodically launch external usage probes. Account snapshots live only in memory.
Disabling, removing, or replacing an instance cancels its account work.

Claude percentages are already percentages, including values above 100%. Missing utilization is shown
as Unknown. If plan limits are not reported, the card says so without inferring the authentication
cause. Extra usage shows enabled state and utilization only; monetary amounts are omitted because the
SDK does not establish their denomination. A failed refresh keeps the last successful data and its own
fetch timestamp visible. Updated labels use absolute local timestamps, so they remain accurate on
an idle page without periodic external reads. History loading or failures do not hide account cards.
Codex token history and quota snapshots share one account card and retain successes independently;
each Codex refresh owns a short-lived control client that closes on completion or cancellation.

F5 historical Claude tokens use reported main-agent usage fields. Whole-tree `modelUsage` fields do
not fill gaps in these token facts. As a result, some older or repaired events can have unreported
tokens. SDK-reported cost estimates can cover a broader scope and are not invoice data; an exact
cost-per-token or cache-ratio relationship should not be inferred. This feature neither rewrites
persisted facts nor changes cost accounting.

The structured usage operation can scan local transcripts; omitting those fields from the UI does
not avoid that work. On 2026-09-05, a prompt-free OAuth Pro read took approximately 1.1 seconds against
183 files (30 MB) under the local Claude projects history. A process inventory after completion showed
no additional Claude process. Larger histories still need representative latency checks if usage
refresh feels slow.
