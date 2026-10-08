# Codex

This guide is for people who want to use more than one Codex account in T3 Code.

Common reasons:

- use a work account for work projects
- use a personal account for personal projects
- switch to another account when one account hits limits
- keep one shared Codex history instead of maintaining two separate Codex setups

## I Only Use One Codex Account

Use the default provider.

In Settings, your Codex provider can stay like this:

```text
Display name: Codex
CODEX_HOME path: ~/.codex
Shadow home path: empty
```

Log in with Codex normally:

```bash
codex login
```

## I Want Work And Personal Codex Accounts

Use one real Codex home and one shadow home.

Recommended setup:

```text
~/.codex      shared Codex home
~/.codex_p    second account auth
```

The idea is:

- both accounts can see the same T3/Codex sessions
- each account keeps its own login
- existing threads can continue with either account

### Set Up The First Account

Log in normally:

```bash
codex login
```

This is the account used by `~/.codex`.

In T3 Code Settings, name it something obvious:

```text
Display name: Codex Work
CODEX_HOME path: ~/.codex
Shadow home path: empty
```

### Set Up The Second Account

Log in with a separate Codex home:

```bash
mkdir -p ~/.codex_p
CODEX_HOME=~/.codex_p codex login
```

In T3 Code Settings, add another Codex provider:

```text
Display name: Codex Personal
CODEX_HOME path: ~/.codex
Shadow home path: ~/.codex_p
```

The important part is that both providers use the same `CODEX_HOME path`, but only the second one
has a `Shadow home path`.

On Windows, keep the shared and shadow homes on the same drive. F5 uses junctions for shared
directories and hard links for shared files so shadow homes work without Developer Mode or an
elevated process. Windows cannot hard-link files across drives; in that case F5 copies the file and
logs a warning. The copy cannot reflect changes during a running session, but F5 refreshes its
managed copy the next time it materializes that shadow home.

## Which Account Am I Using?

Open Settings and look at the provider row.

T3 Code shows the authenticated email for providers that report one. Emails are blurred by default;
click the blurred email to reveal it.

Use display names and accent colors to make accounts easy to tell apart in the model picker.

## I Need A Different API Key Or Endpoint

Use the provider's Environment variables section in Settings.

This is useful when a Codex-compatible setup needs account-specific variables. Add the variables to
the provider instance that should receive them, and mark API keys or tokens as sensitive. Sensitive
values are stored as server secrets and are not sent back to the app after saving.

## Can I Switch Accounts In An Existing Thread?

Yes, when both Codex providers share the same `CODEX_HOME path`.

For example:

```text
Codex Work      CODEX_HOME path: ~/.codex
Codex Personal  CODEX_HOME path: ~/.codex, Shadow home path: ~/.codex_p
```

Those two providers are considered compatible for continuation, so the locked model picker can show
both.

If you add a third Codex provider with a completely different `CODEX_HOME path`, T3 Code treats it
as a different workspace. It will not be offered for existing threads created under `~/.codex`.

## If Both Accounts Look The Same

If two Codex providers show the same account or the same unexpected model list:

1. Check the email in Settings.
2. Refresh provider status.
3. Confirm the second provider has `Shadow home path` set.
4. Confirm the shadow directory has its own `auth.json`.
5. If you copied `~/.codex` into the shadow directory, remove everything except `auth.json`.

Example cleanup:

```bash
find ~/.codex_p -mindepth 1 ! -name auth.json -exec rm -rf {} +
```

## When To Use A Separate CODEX_HOME

Use a totally separate `CODEX_HOME path` only when you want a separate Codex workspace.

That means separate sessions and less account switching inside old threads. Most dual-account users
should use the shared-home plus shadow-home setup instead.

### Isolated profiles

[Profiles](../profiles.md) provide independent managed Codex homes and in-app login for work and personal accounts. Managed profiles require Codex 0.144.3 or newer and file-backed credentials; versions beyond the audited baseline show an informational notice; legacy Default shadow-home behavior is unchanged.

## Disk space from Codex marketplace upgrades

When a Codex home has a Git-sourced plugin marketplace configured, each `codex app-server`
start clones the whole marketplace into `.tmp/marketplaces/.staging/marketplace-upgrade-*`
and then swaps it in. If the process stops before the swap, Codex never removes the clone.
These clones can be hundreds of MB each.

F5 limits this in three ways:

- Session-note, compaction and harness-validation prompts share one warm app-server per
  Codex launch config instead of starting one per prompt. The warm process stops after
  5 minutes idle, after 50 prompts, or after any failed prompt. It is not tied to the
  signed-in account: after `codex login` switches accounts in the same home, background
  prompts can use the previous login until the warm process stops.
- These one-off app-servers, and the `codex exec` runs that generate titles, commit messages,
  PR text and branch names, start with `-c features.plugins=false`, so they never begin a
  marketplace upgrade. Thread sessions keep plugins on.
- Every hour, F5 deletes `marketplace-upgrade-*` dirs older than 2 hours in every Codex home
  it launches, even when automatic storage cleanup is off. It deletes a
  `marketplace-backup-*` dir only when an installed marketplace from the same source sits
  next to it; a backup Codex kept after a failed rollback may be the only copy and is left
  alone. Each deletion is recorded in the automatic cleanup history. **Settings → Storage →
  Provider homes** offers the same cleanup on demand.

## Release 0 rewind compatibility

F5 resolves the retained history boundary once, then tries `thread/revert`, legacy
`thread/rollback`, and finally a boundary-limited `thread/fork`. Unknown-method support
is cached per process. The exact paginated-history error is cached per native thread,
so rewinding a legacy thread does not disable revert for its adopted fork.

Fork fallback uses the experimental API, validates paged retained turn IDs before
adoption, and persists the new cursor before its final read. Early fork events are
buffered and routed to the original F5 thread after validation. A lost fork response
blocks further rewind in that process and logs a possible orphan instead of retrying
blindly. The old native thread is unsubscribed best-effort. Recovery checks the stored
source thread ID as well as the retained boundary. Active turns must be interrupted
before conversation rewind; the orchestration command already rejects active turns.

The generated experimental **0.160.1** request types certify F5's actual initialize,
thread/start, thread/resume, thread/fork, thread/revert, turn/start and turn/steer builders.
Run `bun run protocol:audit:requests:baseline`. Selected schema checksums are recorded in
`scripts/fixtures/codex-requests/baseline.json`. Source revision
`d27764b82f7118f674371e6d6e76271d9d606edb` emits the pinned legacy-history error.
The 0.156.0 protocol source at `fe74a774532af67b5a4a3dec03ce9469e17f89af`
has no thread/rollback method and gates fork.beforeTurnId experimentally. The generated
0.156.0 experimental schemas also confirm both fork.beforeTurnId and excludeTurns;
checksums are in `scripts/fixtures/codex-requests/legacy-0.156.0.json`. These facts
were checked against the official repository, not inferred from CLI version alone.
The [0.147.0 request declaration](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)
marks rollback deprecated. The [0.158.0 start implementation](https://github.com/openai/codex/blob/rust-v0.158.0/codex-rs/app-server/src/request_processors/thread_processor.rs)
defaults persistent threads to paginated history when the thread store supports history lists
(source revision `064c6b8c737f5b41d171fdda80bd9ef10ad06eb3`).

The full protocol manifest remains audited at **0.144.3** until Release 1; its fixed
baseline audit still passes. The minimum permitted CLI remains 0.37.0; versions below
0.144 are unverified. Custom executable paths and CODEX_HOME isolation are preserved;
certification installs use temporary directories and never replace the operator CLI.

For a credential-free native startup smoke, set `CODEX_BINARY_PATH` to the chosen
executable and run `bun scripts/certify-codex-runtime.ts`. It uses a temporary CODEX_HOME
and checks initialize, start and unsubscribe. Empty threads have no rollout yet, so
read, fork and resume require a first authenticated model turn.

For model-backed certification, run `bun apps/server/scripts/certify-codex-rewind.ts` with
`F5_CODEX_LIVE_TEST=1`, `CODEX_BINARY_PATH`, and `F5_CODEX_CERTIFICATION_HOME` (or
`CODEX_HOME`) pointing to an authenticated profile. It copies only auth/config into a
private temporary home, creates two trivial turns, rewinds one, validates retained IDs,
and completes a follow-up. `F5_CODEX_RESUME_BINARY` switches executables after the seed
turns, allowing a 0.147 thread to exercise the 0.156 legacy-history fork. Model selection
uses the seed runtime's native catalog default; `F5_CODEX_CERTIFICATION_MODEL` overrides it.
This matters: the account rejected gpt-5.4 on 0.160.1 and gpt-6.1-sol on 0.147, while the
catalog defaults below succeeded.

Release 0 authenticated checks on **macOS arm64**, 2026-10-07:

| Runtime | History              | Successful rewind path                          | Model       | Retained IDs and follow-up |
| ------- | -------------------- | ----------------------------------------------- | ----------- | -------------------------- |
| 0.144.3 | new legacy thread    | revert rejected → rollback                      | gpt-5.6-sol | passed                     |
| 0.147.0 | new legacy thread    | legacy revert rejected → rollback               | gpt-5.6-sol | passed                     |
| 0.156.0 | resumed 0.147 thread | legacy revert rejected → rollback absent → fork | gpt-5.6-sol | passed                     |
| 0.160.1 | new paginated thread | revert                                          | gpt-6.1-sol | passed                     |

Native startup/unsubscribe also passed on all four isolated executables. The automated
fake-server matrix covers exact fork requests, retained-history mismatch, lost responses,
early events, cached flags and failed post-adoption reads. Provider-directory and
orchestration recovery tests prove the validated fork cursor survives final-read failure.
Manual browser UI acceptance and Linux/Windows release-environment runs remain unverified;
the model-backed matrix above exercises the actual manager, not a fake server.
