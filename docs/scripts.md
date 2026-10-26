# Scripts

> Contributors: every root `bun run` script and what it does.

**Contents:** [Desktop `.dmg` packaging notes](#desktop-dmg-packaging-notes) · [Running multiple dev instances](#running-multiple-dev-instances) · [Upstream port ledger](#upstream-port-ledger)

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
- `bun run perf:server` — Records the deterministic server component performance suite; `--smoke` checks the harness with fewer repetitions. See [performance scope and gates](performance.md).
- `bun run perf:compare <before.json> <after.json> [CPU targets...]` — Checks matching server reports against the approved regression and resource limits.
- `bun run screenshots:capture [-- --skip-build] [-- --only <id,...>]`: Builds the server and web app, seeds demo data into a fresh temp directory with an isolated HOME, and regenerates the README screenshots, the marketing hero image and the docs images in `docs/images/` (listed in `scripts/docs-screenshots.manifest.ts`). No real provider binary runs: on macOS and Linux, Codex and Claude point at a probe-only shim; on Windows they are disabled, so provider shots show them as disabled. Other providers are always disabled. `--only` recaptures the listed docs shots and skips the README shots. Requires Playwright's Chromium (`bun run --cwd apps/web test:browser:install`).
- `bun run scripts/run-demo.ts [--skip-build]`: Builds the desktop app, seeds the same demo data into a fresh temp root (never reused or deleted) and launches the desktop app on it, for manual screenshots of desktop-only surfaces such as the Preview browser.
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

Upstream t3code tracking lives in ledger v7, declared by the `upstream` block in
`f5.json`. The ledger directory is `upstream/` by default; `ledgerDir` overrides it, and
the paths below are relative to it. Apart from the one-time
[schema 6 migration](#migrating-from-schema-6), F5's Upstream page is the only writer of
the ledger-state files; see [Upstream ports](user/upstream-ports.md) for the workflow.

```
upstream/
  policy.md                        # human-edited triage and porting guidance (16 KiB max)
  rules.json                       # reason keys and labels, auto-skip path rules, thresholds
  archive/schema6.json             # the schema-6 ledger, moved byte for byte; immutable
  intervals/0001-<target12>.json   # immutable: pinned first-parent coverage and commit membership
  legacy/0001.json                 # immutable: membership for archive deferred SHAs
  topics/<YYYY-MM>.json            # topics created that UTC month, sorted by id
```

- **Intervals** pin `{baseSha, targetSha, selection: "first-parent", count, digest, commits}`.
  Commits are newest first and each names its topic. Interval 1 starts at the archive's last
  target. The digest is SHA-256 over the SHAs, LF-joined with a final LF.
- **Legacy batches** hold archive `deferred` SHAs. Their digest is over the SHAs sorted ascending.
- **Topics** group one upstream feature or fix with its follow-ups. Status is `inbox`, `port`,
  `skip`, `declined`, `watch` or `equivalent`; the `epoch` increments when a topic is reopened
  from `port` or done. A commit with `Upstream-Topic: <id>` (epoch 1) or
  `Upstream-Topic: <id>#<epoch>` reachable from the default branch marks the topic done.
- Every ledger file is canonical JSON (recursively sorted keys, absent optionals omitted,
  2-space indent, trailing LF). `upstream/` is excluded from `bun fmt` so these bytes stay
  exact.

### Checking

```sh
bun run upstream-ports:check
F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check
```

The checker reads the working tree and never writes. It validates the archive's structure,
digests and provenance (schema-6 evidence rules are not re-checked), `rules.json`,
`policy.md`, interval contiguity, counts and digests, legacy membership, that each SHA
belongs to exactly one topic, and per-status topic fields. When the configured remote is
present it also checks that intervals equal the upstream first-parent history with matching
subjects; `F5_REQUIRE_UPSTREAM=1` makes the remote mandatory. Inbox topics never fail the check.

With `F5_LEDGER_BASE_REF=<ref>` (set by CI on pull requests) it also rejects:

- modifying or deleting an existing file under `intervals/`, `legacy/` or `archive/`;
- ledger-state changes mixed with any other path. This applies once the base contains
  `upstream/archive/schema6.json`. `policy.md` and `rules.json` may change in any PR.

Both rules apply to the `ledgerDir` at HEAD and at the base, so moving the directory cannot
sidestep them. `ledgerDir` must be a normalized relative path (no `.`, `..` or empty segments,
no backslashes or trailing slash) so it matches the plain paths Git reports.

Trailers on the checked commits that name unknown topics, or epochs above the ledger's,
are warnings, because a port PR may merge before its ledger PR.

Do not hand-edit `upstream/intervals`, `upstream/legacy`, `upstream/topics` or
`upstream/archive`. After the migration below, only the Upstream page writes them.
`policy.md` and `rules.json` are human-edited.

### Migrating from schema 6

```sh
bun scripts/migrate-upstream-ledger-v7.ts
```

The one-time migration needs the verified `upstream` remote. It refuses a ledger with
pending records, moves `scripts/upstream-ports.json` byte for byte to
`upstream/archive/schema6.json`, writes any missing seed files (`rules.json`, `policy.md`,
the `f5.json` block), verifies the whole destination, and deletes the old file last. Each
write is atomic, so an interrupted run resumes from where it stopped; a rerun on a migrated
checkout only verifies. While `origin/main` (or `F5_UPSTREAM_MAIN_REF`) still has
`scripts/upstream-ports.json`, a rerun also requires the archive to match it byte for byte,
so an older archive cannot be frozen as immutable.
