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

`scripts/upstream-ports.json` is the only authoritative tracking file. Schema 6
stores one SHA-sorted `entries` collection, append-only pinned `intervals`, explicit
`legacyCoverage`, and historical `legacyProvenance` categories. There is no rolling
window, separate manifest, or current/historical record split.

Each interval freezes `{baseSha, targetSha, selection, count, digest, upstreamShas}`.
The base is excluded and the target included; SHA lists are newest-first. Intervals
are ordered oldest-first and must be contiguous. The digest is SHA-256 over the
ordered full SHAs joined by LF with a final LF. `legacyCoverage` uses the same
count/digest/list format, sorted by SHA. Its explicit membership replaces the old
blanket exemption for records marked `legacy`.

Every tracked SHA must occur once in `entries` and once in coverage. The old
backlog categories retain their original explanations and references, but never
supply active decisions or coverage. The initial migration retains all 2,322
individual records and materializes 10 exact-SHA category members, for 2,332 records:
1,836 in the September interval and 496 in legacy coverage.

### Checking and discovering upstream commits

```sh
bun run upstream-ports:check
bun scripts/check-upstream-ports.ts --refresh --head <full-40-character-sha>
F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check
```

Validation is read-only. Offline it checks schemas, coverage, digests, decisions
and file:line evidence. If the upstream remote is present, it additionally checks
provenance; CI requires this with `F5_REQUIRE_UPSTREAM=1`. Interval boundaries and
ordered selections must match `refs/remotes/upstream/main` first-parent history.
Legacy commits must be reachable from pinned upstream history, including recorded
non-first-parent commits. Batched history reads also verify subjects; no Git
process is launched per record. Unresolvable historical f5 implementation SHAs
remain allowed because squash merges can remove those objects.

Refresh fetches without pruning from the verified read-only upstream repository,
before acquiring the ledger writer lock. An interrupted network fetch therefore
leaves no ledger lock. Once the immutable head is selected, the writer takes the
lock and reads the current ledger so another writer’s intervening changes are retained.
Plain `--refresh` selects the fetched head once; `--head` must be a full SHA on its
first-parent ancestry. New commits extend coverage with another interval. Existing
records and proof stay unchanged. Repeated or older pins are no-ops, never a request
to shrink coverage. Invalid or divergent pins fail without publishing changes.

New suggestions have `reviewStatus: "pending"` and cannot pass the checker until
reviewed. A refresh can succeed while the subsequent check fails for pending work;
that is intentional. Output separates tracked coverage, pending reviews, planned
work, and completed dispositions. The latest tracked commit is not the latest
implemented port.

### Applying classifications

```sh
bun scripts/generate-upstream-gap.ts scripts/upstream-port-plan-2026-09.json
```

Classification files keep schema 1: `{schemaVersion, baseSha, targetSha, entries}`.
Each entry supplies `upstreamSha`, `classification`, `reason`,
`reviewStatus: "reviewed"`, and optional `evidence` and `f5Shas`.
Supported classifications are `planned:<phase>`, `declined`, `deferred`,
`equivalent:<repository-path:line>`, and `not-applicable:<reason-key>`. Reason keys
are `mobile`, `relay-cloud`, `multi-environment`, `devices`, `marketing`,
`release-ci`, `maintenance`, and `upstream-only-subsystem:<name>`.

A plan can select any nonempty contiguous subinterval already covered, including
one spanning interval boundaries or an older review after a later refresh. It must
supply exactly one reviewed decision per selected SHA. It cannot expand coverage.
Planned work stays deferred with a workstream; it is never marked implemented.
Reapplication preserves ported, equivalent and already-present records verbatim.
Equivalent decisions require file:line evidence and f5 implementation SHAs.
Unrelated pending records remain pending when applying a smaller plan; the full
checker still rejects them until reviewed.

### Migrating schema 5

```sh
bun scripts/check-upstream-ports.ts --migrate
```

Migration requires the verified upstream remote and its history. It validates the
old ledger/manifest pair, preserves all individual records, materializes exact-SHA
backlog members, and publishes schema 6 before removing the obsolete manifest.
Normal commands never migrate implicitly. Migration preserves pending reviews;
structural and provenance validation remain mandatory, while the normal checker
continues to reject pending records. If a schema-5 refresh advanced the manifest
beyond its audit, migration appends that verified first-parent interval. Any gap
that the old 500-entry window never recorded receives pending suggestions, never
review approval. Existing decisions and the original audit remain unchanged.
Repeating migration on schema 6 validates structure and provenance while allowing
pending reviews; an obsolete manifest left by interrupted cleanup is ignored.
Schema 4 must first be upgraded with the previous schema-5 tooling.

Old two-file journal recovery is available only during schema-5 migration. It
refuses active or unverifiable writers. Empty/truncated journals, foreign-host
journals and leftover recovery locks produce instructions naming the files to
inspect. No schema-6 reader depends on that recovery machinery.

Compatibility consumers are developer branches and worktrees based on the
schema-5 tooling shipped in PRs #28 and #31, including branches with an unfinished
refresh or an interrupted two-file publication. Migration support is scheduled
for removal on **2026-10-24** in a follow-up that removes `--migrate` and the legacy
validator/recovery modules together. There is no automatic date-based expiration;
those consumers should migrate before that cleanup. Schema-6 operation and CI do
not depend on the compatibility path.

### Atomic publication

Refresh, classification and migration share an exclusive writer lock. Each lock
has a random ownership token; cleanup removes it only if that token still matches.
A replacement lock is left intact. Cleanup failures produce actionable warnings
without replacing the operation’s result or original exception. A writer
compares the canonical bytes against its original read, writes and syncs a
same-directory temporary file with the original permissions, checks for intervening
edits again, atomically renames it, and syncs the directory where supported.
Readers see the complete old or new ledger; validation never changes files or
performs recovery, even when locks or temporary files remain after a crash.

Locks are never stolen automatically, even if their owner appears dead. On a lock
error, inspect the named lock and ledger, confirm no writer is active, then remove
the stale lock and listed temporary files before retrying. These artifacts are
Git-ignored. Do not manually edit the ledger while a writer is active; the lock is
advisory for external editors. On Windows, directory fsync is unavailable through
the Node filesystem API, so this does not promise power-loss durability there.
