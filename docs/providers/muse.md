# Muse Code

Use Meta's Muse Code CLI as an F5 provider. It is not the Muse personal agent, which has no public
API; F5 doesn't imitate it.

## How to

1. Install the CLI yourself. F5 shows this command when `muse` is missing but never runs it:

   ```bash
   curl -fsSL https://dev.meta.ai/install.sh | bash
   ```

2. Sign in by running `muse` once in a terminal, using `muse auth set`, or adding `META_API_KEY` to
   the provider's environment variables.
3. Optionally, set a custom binary path on the provider in **Settings → Providers**.
4. Pick Muse Code in the composer.

## Access modes

Muse Code always approves file edits inside the workspace, so F5 doesn't offer **Supervised** for
it.

| F5 mode           | What still asks you                                |
| ----------------- | -------------------------------------------------- |
| Auto-accept edits | Unlisted commands and writes outside the workspace |
| Full access       | Nothing                                            |

Plan mode and read-only workflow steps aren't supported, and Muse Code is never available through
the [Agent Bridge](../agent-bridge.md).

## Approvals

Approval buttons use Muse's own choices: allow once, allow for session, always allow, deny and
abort. If Muse changes an approval while you are deciding, F5 reloads it and asks again; it never
resends a decision on its own. Pending approvals and questions come back after a resume.

## Good to know

- `META_API_KEY` takes precedence over a stored browser sign-in, and the status card says so.
- Muse Code is not available in isolated profiles.
- Rollback is not supported.
- F5 never passes `--yolo`, `--disable-approval` or `--disable-sandbox`.

- F5 preview and computer catalogs are unavailable: the pinned Muse SDK session API does not accept MCP configuration.

<details>
<summary>Details and limits</summary>

**Runtime.** F5 starts `muse serve --approval-judge off` and talks to it through Meta's
`@muse-code/sdk` (1.4.8, versioned with the CLI) over the Muse Session Protocol (MSP). F5's modes
map to MSP's `promptUnmatched` and `allowAll`. Each start and resume reads the mode back and
requires the host sandbox, and a mismatch stops the session. If another client changes the mode,
F5 interrupts the turn and stops the session. Titles and commit messages use a separate read-only
session.

**Approvals.** Each MSP approval stage is its own F5 request, and a new stage replaces the
previous one. Approvals answered in another client close in F5. If F5 can't read an approval, it
denies it when a deny choice exists, and otherwise stops the session.

**Reliability.** Command ids are stored before the first send, so retries are deduplicated. A
command the host never accepted is reported as not sent, and a timeout after sending stays
ambiguous. Resume continues from the stored cursor. If history was pruned, F5 warns and reloads
the current state. Stop cancels the turn and waits up to 10 seconds.

**Protocol pin.** `packages/shared/src/museProtocolManifest.ts` records the expected SDK version
and schema fingerprint. `bun run protocol:audit:muse` checks the installed SDK, and
`MUSE_LIVE=1` adds a run against the real binary. A host with a different fingerprint still works,
with an "untested Muse Code protocol" warning.

</details>

## Related

- [Provider prerequisites](../provider-prerequisites.md)
- [Runtime modes](../runtime-modes.md)
