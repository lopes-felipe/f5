# Releasing F5

Main merges build one immutable candidate alongside CI. Publication joins successful
qualification for the exact source SHA and publishes those files directly. A tag
never starts another build. The automation starts in **shadow** mode; it creates
neither tags nor releases until the maintainer enables publication.

## Routine releases

Betas need no version PR or dispatch. After stable 0.1.1, main candidates are
0.1.2-beta.N, where N is the first-parent distance from the stable base. Rerunning
the same commit keeps its version. Gaps are intentional. The newest commit whose
required CI jobs pass supersedes older unpublished betas, even while its candidate
is still building; a failed newer candidate does not cause an older beta to ship.

For a stable release:

```sh
bun run release:prepare --stable 0.1.2
```

The release App opens a version/changelog PR with `release-intent.json` containing
the version and a UUID. Review and merge that PR. Its exact main merge commit is
the stable candidate, and its merge authorizes publication once all gates pass.
That commit produces no beta. Subsequent main commits target 0.1.3-beta.N.

A pending stable request holds later betas across build failures, reruns, missed
events and restarts. Later merges never cancel or silently change its candidate.
First rerun failed jobs when the source is sound. For a source fix, merge it and
request an explicit recovery PR for the same unpublished version:

```sh
bun run release:prepare --stable 0.1.2 --recover <failed-request-uuid>
```

The recovery PR has a new UUID and `supersedes` the failed request. Its merge pins
a new commit. Published versions, tags and assets are never replaced. Dependency,
signature, hash, upgrade, missing certification and expired-artifact failures block
publication. Missing artifacts require explicit recovery, not an implicit rebuild.
Once publication has reserved a version's immutable tag, resume that exact
candidate's publication; a recovery PR cannot move the reserved tag to another source.

Stable releases become **Latest**. Betas are prereleases and never become Latest.
Global version ordering is enforced across both channels; stable clients retain
stable preferences, beta clients retain beta preferences, and no path downgrades.

## Pipeline and evidence

- `release.yml` plans the version and builds four desktops (macOS arm64/x64, Linux
  x64 and Windows x64) and five native CLI archives. It starts alongside main CI.
  It uses pinned runtimes, Bun/Electron/builder caches and the Windows Rust cache.
- macOS packages are signed/notarized. The final mounted DMG passes codesign,
  stapler, Gatekeeper and the bundled Claude SDK spawn check on its native runner.
- Every native CLI archive passes clean-PATH runtime/server/backup smoke, a real
  isolated HTTPS installation, and a supervised update from the published stable
  CLI baseline. The loopback feed trusts a private test certificate; TLS checking
  stays enabled. No machine-wide service or user installation is touched.
- Windows published-client upgrade checks begin immediately after the Windows
  installer finishes. Stable candidates test stable and beta preferences on fresh
  runners. Synthetic failure/recovery checks reuse the compiled Windows bundles
  in separate fixture staging directories and preserve shipping artifacts.
- Component receipts bind the source SHA, version, run/attempt, native toolchain
  and runner image to each file's size and SHA-256. The candidate manifest binds
  those receipts to immutable Actions artifact IDs and ZIP digests. Failed-job
  reruns can retain successful components from earlier attempts of the same run.
- `release-publish.yml` reconciles on CI/candidate/upgrade completion and every
  ten minutes. A shared concurrency group serializes both channels; selection
  comes from first-parent history and stable intent, not event arrival order.
  Required jobs and matrix variants are derived from that SHA's CI result.
- The publisher validates trusted repository/workflow identities and downloads
  platform artifacts directly. It merges updater/CLI manifests, generates
  checksums and verifies the exact asset set. There is no intermediate release
  bundle upload. `f5-release-candidate.json` is published with the checksums so
  provenance remains available after Actions artifact retention expires.
- Changed published Windows or CLI baselines dispatch `release-upgrade.yml`
  against existing candidate artifacts. Only affected upgrade checks rerun; no
  shipping artifact is rebuilt. The proof binds the candidate run/attempt and
  baseline fingerprint.
- Publication creates an exact-SHA tag and draft, uploads only missing assets,
  verifies uploaded sizes and API SHA-256 digests, preserves the existing provider
  certification policy, then undrafts. A matching complete published release is
  success on retry. Mismatched existing assets block rather than overwrite.
  A retry can remove an expected incomplete `starter` upload from its matching
  draft before uploading it again. Complete assets and public releases are never
  removed or replaced.
- Public checks verify all installer/CLI download URLs, update manifests, candidate
  provenance, the Atom feed, and stable Latest aliases. Transient public/dependency
  failures retry once locally. Persistent failures remain visible for rerun.
  Published retries use public provenance/checksums and API asset digests, so
  expiring Actions artifacts do not break verification or trigger downloads of
  the original multi-gigabyte components.
- `release-summary.json` records source/version, build run/attempt, merge-to-public
  and candidate durations, retries and artifact reuse. Shadow verification is
  memoized by candidate/baseline/publisher identities to avoid repeated large
  downloads on scheduled events.

The desktop profile and asset contract remain in `scripts/lib/release-profile.ts`.
`release-profile.json` currently ships `all`. Once any public Mac/Linux feed
exists, neither preparation nor publication may revert to Windows-only.

The existing certification gates remain mandatory. A certifying integration record
requires exact-source/exact-DMG acceptance evidence on main. Missing evidence blocks
shadow verification and publication; an agent must not fabricate or weaken it.
The mounted runtime smoke is not authenticated provider or physical-input evidence.
See [agent-browser.md](agent-browser.md) for certification procedures.

## One-time maintainer setup

Repository security and credentials are maintained by a human. These settings
must be completed before enabling publication:

1. Install a dedicated GitHub App on **this repository only**, with Contents,
   Pull requests and Actions write permissions. Set repository variable
   `F5_RELEASE_APP_ID` and repository secret `F5_RELEASE_APP_PRIVATE_KEY`.
   Preparation requests Contents/Pull requests write; publication requests
   Contents/Actions write. App-authored preparation PRs start normal CI without
   the extra approval needed by token-authored PRs.
2. Permit that App to **create** `v*` tags. Keep independent rules forbidding tag
   updates/deletion, and retain release immutability. Do not give the App a blanket
   bypass of update/delete restrictions. Publishing never needs main write access.
3. Configure the `release` signing environment to allow trusted `main` automation
   without per-run approval. Do not allow PR or fork refs. Keep signing credentials
   there; the read-only candidate jobs never receive publication credentials.
4. Keep Apple secrets `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY` (p8
   contents), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`. Missing values fail signed
   Mac packaging. The temporary p8 file is removed after packaging.
5. Optional Windows signing uses `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
   `AZURE_CLIENT_SECRET`, `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`,
   `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
   and `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`. Set
   `F5_WINDOWS_SIGNING_REQUIRED=true` when available. Otherwise the installer is
   explicitly unsigned, retaining the existing published-client policy.
6. Set `F5_RELEASE_AUTOMATION_MODE` to `shadow` (also the default when unset).
   Keep scheduled workflows enabled; GitHub may disable them after inactivity.

App setup follows [GitHub token rules](https://docs.github.com/en/actions/concepts/security/github_token).
Publication does not depend on [concurrency dispatch ordering](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

## Rollout and recovery qualification

Keep existing public releases untouched throughout rollout.

1. Pass formatting, lint, typecheck, full tests, upstream ledger validation and
   actionlint. Merge the workflow changes with shadow mode retained.
2. Let main CI and the signed, native cross-platform candidate finish. Require a
   successful shadow publisher summary, component receipts, mounted-DMG checks,
   all five installed CLI checks and both Windows qualification paths. Record
   observed queue/build/validation timings; **20–25 minutes is a target, not a
   measured result of local checks**.
3. Enable `beta` mode after that successful hosted rehearsal. Confirm that a
   routine main merge publishes without action, a duplicate publisher dispatch
   changes no assets, and out-of-order candidate completion does not publish a
   superseded beta.
4. Exercise a stable preparation PR in `all` mode. Verify the stable barrier
   while a later main merge completes, then stable Latest and beta preference
   retention. Verify a failed stable request remains held until explicit recovery.
5. Interrupt an upload into an unpublished draft, rerun the publisher, and verify
   existing asset IDs/digests stay unchanged. Exercise stale-baseline requalification
   against existing artifacts and expired/corrupt artifact rejection.

To retry publication, rerun/dispatch **Release publisher**. To retry a failed
upgrade-only qualification, rerun its failed jobs; reconciliation reuses its proof.
For a corrupt or mismatching draft asset, stop and investigate: automation never
deletes or replaces assets. An administrator handles any destructive cleanup.
A failed public availability check can be retried after publication without
replacing or rebuilding the release.

Manual UI acceptance for import, accessibility permissions, SmartScreen/Smart App
Control, macOS Squirrel staging and AppImage behavior remains useful for product
changes, but routine releases do not depend on laptop commands or an agent polling CI.

## Build and validate CLI archives

The user guide for the standalone CLI is [Standalone F5 CLI](user/standalone-cli.md). Use a matching native runner and Node **26.10.0** for each target:

```sh
bun run dist:cli:archive --target darwin-arm64 --node /path/to/node
bun run test:cli-smoke release-cli/f5-0.0.10-darwin-arm64.tar.gz release-cli/f5-0.0.10-darwin-arm64.json
bun run dist:cli:manifest release-cli/f5-cli-release.json release-cli/f5-0.0.10-{darwin-arm64,linux-x64,linux-arm64,win32-x64,win32-arm64}.json
```

`--output PATH` selects an artifact directory; `--skip-build` uses existing server web assets. The script bundles the standalone server, builds a SEA with snapshots/code cache disabled, pins native dependency roots and transitive overrides to the repository lockfile, resolves with scripts disabled, verifies every resulting package version and integrity against that lock, then installs with `--frozen-lockfile`, and emits an archive plus its manifest fragment. It rejects unsupported and cross-architecture native builds. A universal macOS Node is thinned to arm64 before injection. macOS artifacts are ad hoc signed for local execution; public distribution signing/notarization is a separate release workflow. Desktop's narrow ASAR unpack policy is unchanged.

The merge script requires all five targets and matching versions. Packaging scripts
never publish or change repository settings; the separate trusted publisher owns publication.

The packaged Claude runtime check runs the bundled server's `claude-runtime-smoke.mjs` through Electron with `ELECTRON_RUN_AS_NODE=1`. Windows and Linux run it from `afterPack`; signed macOS builds run it after signing and before notarization. It checks CLI discovery and SDK initialization using a disposable home without a prompt or account credentials. macOS/Linux use F5's process-group wrapper; Windows uses the SDK's native spawn. The check rejects virtual ASAR executable paths, and native Claude platform packages are explicitly unpacked. A failed or timed-out smoke check blocks release packaging.

Validation in the CLI PR: macOS arm64 archive build and smoke with a disposable home and restricted PATH; native PTY and native file search; update rollback after a failing migration; interrupted trial/restoration and durable-commit recovery; architecture rejection; required workspace and real-Git checks. Packaged Windows/Linux and clean-machine VM smoke runs remain release gates and are not certified by a macOS-only run.

The real archive integration test can also run on each release runner with `F5_CLI_SMOKE_ARCHIVE` and `F5_CLI_SMOKE_MANIFEST` set, using `bun run --cwd apps/server test:file integration/standaloneArchive.integration.test.ts`. It stages the archive, preflights the stable launcher, verifies that a prepared trial has no HTTP listener, rejects an activation message for another update ID, and checks the correlated bootstrap after activation. It also starts the installed stable service launcher, verifies that malformed update metadata is quarantined without stopping the server, and checks graceful shutdown. It uses a disposable state directory and leaves the user profile untouched.

### Standalone update internals

`update` stages and verifies the same-architecture release and queues a unique update ID. It does not replace a running executable or run npm. The stable built-in-only launcher preflights the candidate, stops the old child, and snapshots SQLite main/WAL/SHM. The trial completes migrations and service acquisition before reporting prepared. Background workers and HTTP activation wait for the launcher to durably commit the new version. Failure before the durable commit stops the trial, restores the snapshot, and restarts the old runtime. After the commit, recovery always rolls forward and preserves the new database, including activation and journal-cleanup failures.

`current.json`, `pending.json`, `handoff.json`, and `outcome.json` record the handoff. The journal records the canonical database path and rejects recovery with another `--state-dir`. An incomplete snapshot or a live previous child blocks recovery. The child exits when its launcher's IPC channel disappears. Reconnect bootstrap carries the update ID, terminal outcome, and actual version; the UI reports success or rollback from those fields, never from a connection opening alone.

Installer archives are downloaded with bounded size/time, checked against exact byte length and SHA-256, inspected for traversal and links, then staged into immutable version directories. Native PTY/search, version, architecture, and launcher protocol are checked before use. A launcher owns the default profile of its explicit state directory; it rejects `--profile` overrides and validates the actual database path before migrations.

## Signing hardening and remaining backend limitation

Signed macOS builds use JIT plus Apple Events only for the main application, JIT only for Electron child processes, and an empty entitlement set for the Swift computer helper. Library validation and unsigned executable memory exemptions are removed. Packaging disables `NODE_OPTIONS` and CLI inspector fuses and enables ASAR integrity validation on macOS/Windows with ASAR-only application loading.

`RunAsNode` remains enabled because the backend currently re-executes the bundled Electron binary through the macOS GUI-denial sandbox and uses Node IPC. These fuse changes do **not** eliminate the risk of another local process launching that signed binary with arbitrary Node code. Before treating the first signed release as hardened against that threat, migrate the backend to a separately signed minimal Node helper or a utility process with equivalent kernel GUI isolation, preserve the computer-host IPC authentication, disable `RunAsNode`, and rehearse backend/session restarts and native modules. Do not substitute an unsandboxed utility process merely to disable a fuse. This architectural follow-up is not implemented by this PR.
