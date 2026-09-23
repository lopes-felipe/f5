# Scripts

- `bun run dev` — Starts contracts, server, and web in `turbo watch` mode.
- `bun run dev:server` — Starts just the WebSocket server (uses Bun TypeScript execution).
- `bun run dev:web` — Starts just the Vite dev server for the web app.
- Dev commands default `F5_STATE_DIR` to `~/.f5/dev` to keep dev state isolated from desktop/prod state.
- Override server CLI-equivalent flags from root dev commands with `--`, for example:
  `bun run dev -- --state-dir ~/.f5/another-dev-state`
- `bun run start` — Runs the production server (serves built web app as static files).
- `bun run build` — Builds contracts, web app, and server through Turbo.
- `bun run typecheck` — Strict TypeScript checks for all packages.
- `bun run test` — Runs the fast workspace suite, including service-boundary Git tests and a representative real-Git smoke suite.
- `bun run test:server:git:smoke` — Runs only the representative real-Git smoke contracts.
- `bun run test:server:git` — Runs both smoke and exhaustive real-Git contracts.
- `bun run test:server:git:extended` — Runs the exhaustive real-Git edge-case matrix.
- `bun run test:full` — Runs the fast workspace suite followed by the exhaustive real-Git matrix; required before declaring work complete, releases, and after major Git subsystem changes.
- `bun run dist:desktop:artifact -- --platform <mac|linux|win> --target <target> --arch <arch>` — Builds a desktop artifact for a specific platform/target/arch.
- `bun run dist:desktop:dmg` — Builds a shareable macOS `.dmg` into `./release`.
- `bun run dist:desktop:dmg:x64` — Builds an Intel macOS `.dmg`.
- `bun run dist:desktop:linux` — Builds a Linux AppImage into `./release`.
- `bun run dist:desktop:win` — Builds a Windows NSIS installer into `./release`.

## Desktop `.dmg` packaging notes

- Default build is unsigned/not notarized for local sharing.
- The DMG build uses `assets/macos-icon-1024.png` as the production app icon source.
- Desktop production windows load the bundled UI from `f5://app/index.html` (not a `127.0.0.1` document URL).
- Desktop packaging includes `apps/server/dist` (the `f5` backend) and starts it on loopback with an auth token for WebSocket/API traffic.
- Your tester can still open it on macOS by right-clicking the app and choosing **Open** on first launch.
- To keep staging files for debugging package contents, run: `bun run dist:desktop:dmg -- --keep-stage`
- To allow code-signing/notarization when configured in CI/secrets, add: `--signed`.
- Windows `--signed` uses Azure Trusted Signing and expects:
  `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
  `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.
- Azure authentication env vars are also required (for example service principal with secret):
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.

## Running multiple dev instances

Set `F5_DEV_INSTANCE` to any value to deterministically shift all dev ports together.

- Default ports: server `3773`, web `5733`
- Shifted ports: `base + offset` (offset is hashed from `F5_DEV_INSTANCE`)
- Example: `F5_DEV_INSTANCE=branch-a bun run dev:desktop`

If you want full control instead of hashing, set `F5_PORT_OFFSET` to a numeric offset.

## Upstream port ledger

`bun run upstream-ports:check` validates the frozen manifest and the ledger. With an
`upstream` remote configured, it also verifies first-parent provenance against the
read-only `https://github.com/pingdotgg/t3code.git` remote. CI requires that remote
with `F5_REQUIRE_UPSTREAM=1`.

The ledger now supports schema 5. The checked-in migration preserves the existing
500-commit window ending at `196c8ea0d`; it does **not** claim the September
1,836-commit interval has been classified or implemented. Existing schema-4 records
are labeled `reviewStatus: "legacy"`, retaining their dispositions, reasons,
implementation SHAs, and evidence without manufacturing a new review. The old
backlog categories remain as provenance. Schema 4 is still readable for migration.

### Refreshing a window

```sh
bun scripts/check-upstream-ports.ts --refresh --head <full-40-character-sha>
```

The pin must lie on `upstream/main`'s first-parent ancestry after a non-pruning fetch.
Refresh freezes exactly 500 commits ending at that SHA. Plain `--refresh` selects
the fetched head, resolved once so a moving remote cannot change the selection.
Invalid pins fail before the manifest or ledger is changed.

Entries leaving the window move intact to `historicalEntries`. Entries returning
from history retain their decisions. Legacy category members promoted to records
are retained as `promotedUpstreamShas` references, not counted a second time.
Prefix maps offer explicit disposition/reason suggestions only. New suggestions
have `reviewStatus: "pending"`; the checker rejects them until they have a concrete
reviewed decision. Generic manual-assessment placeholders also fail validation.

The refresh preserves an existing audit interval independently of the rolling
window. On schema-4 migration it initializes an audit for the selected window.
An audit freezes `{baseSha, targetSha, selection, count, digest, upstreamShas}`;
`upstreamShas` is newest-first and excludes `baseSha`. The digest is SHA-256 of the
ordered SHAs joined by LF with a final LF. The stored list permits offline set and
digest checks; Git independently verifies the interval when upstream is available.

### Applying reviewed classifications

```sh
bun scripts/generate-upstream-gap.ts scripts/upstream-port-plan-2026-09.json
F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check
```

The classification file is an audit artifact supplied by an actual per-SHA review;
the generator does not infer decisions from subjects. Its shape is:

```json
{
  "schemaVersion": 1,
  "baseSha": "<full SHA, excluded>",
  "targetSha": "<full SHA, included>",
  "entries": [
    {
      "upstreamSha": "<full SHA>",
      "classification": "planned:7b",
      "reason": "Generic attachments are approved for Phase 7b; implementation is pending.",
      "reviewStatus": "reviewed"
    }
  ]
}
```

Supported classifications are `planned:<phase>`, `declined`, `deferred`,
`equivalent:<repository-path:line>`, and `not-applicable:<reason-key>`. Equivalent
records also require existing `f5Shas`; extra evidence can be supplied in `evidence`.
Reason keys are `mobile`, `relay-cloud`, `multi-environment`, `devices`, `marketing`,
`release-ci`, `maintenance`, and `upstream-only-subsystem:<name>`.

The generator requires exactly one reviewed classification for every SHA in the
first-parent interval, lists missing and extra SHAs, and rejects duplicates and
unknown phases/reason keys. Planned work becomes **deferred**, with its
`plannedWorkstream`; it is never marked ported. Reapplying triage preserves later
ported, equivalent, and already-present records unchanged, including their implementation proof. The full checker validates the
candidate, including file/line evidence, before publication. Older legacy records
outside the audited interval remain preserved and are not counted as new decisions.

### Interrupted updates

Manifest and ledger publication uses staged files and a synced undo journal.
Two separate path replacements cannot be atomic together: readers fail closed
when a journal is present. Validation is strictly read-only and reports the journal
path with recovery instructions. Refresh and classification commands recover first:
if both canonical files match the recorded new-generation digests, they keep the
finished publication; otherwise they restore the prior pair byte-for-byte. A real
subprocess-kill test covers the boundary between renames. Concurrent edits cause
publication to fail rather than overwrite the edits.

Recovery verifies the originating host, file paths, and OS process creation time
alongside its PID; it never steals a live writer's journal, including older journals
without a recorded creation time. A reused PID with a different creation time does
not block recovery. A truncated journal, a journal
from another host, or interruption of recovery itself fails closed for manual
inspection. Node's Windows filesystem API does not support the directory fsync used
on POSIX, so this is process-interruption recovery, not a cross-platform guarantee
against power loss. Do not edit the canonical files while a refresh is running.

Publication preserves each canonical file's permission bits; only the journal is
private (0600). Recovery artifacts are gitignored. Malformed journals and leftover
recovery locks name the exact paths requiring inspection; remove them only after
confirming no writer/recovery is active and repairing the canonical pair if needed.

Provenance uses `refs/remotes/upstream/main` explicitly, so same-named local tags
or branches cannot redirect it. Both manifest and audit targets must belong to its
first-parent history. CI fetches this ref without pruning and requires provenance
validation. Historical object existence checks use one `git cat-file --batch-check`
process.
