# Releasing F5

> Maintainers: one-time setup, the release procedure and checklist, and CLI archive builds.

**Contents:** [Desktop release profiles](#desktop-release-profiles) · [One-time maintainer setup](#one-time-maintainer-setup) · [Prepare and publish](#prepare-and-publish) · [Windows-only checklist (`windows` profile; record results in the PR)](#windows-only-checklist-windows-profile-record-results-in-the-pr) · [Full checklist (`all` profile; record results in the PR)](#full-checklist-all-profile-record-results-in-the-pr) · [Build and validate CLI archives](#build-and-validate-cli-archives) · [Signing hardening and remaining backend limitation](#signing-hardening-and-remaining-backend-limitation)

Every release includes all five CLI archives (darwin-arm64, linux-x64/arm64, win32-x64/arm64) and `f5-cli-release.json`. Never publish desktop-only: `f5 install` and `f5 update` use the stable release's `f5-cli-release.json`.

## Desktop release profiles

`release-profile.json` selects the desktop platforms; `scripts/lib/release-profile.ts` is the single definition of each profile's build matrix, required installers, blockmaps and updater manifests.

- `windows`: Windows x64 NSIS installer, its blockmap, and `latest.yml` (or `beta.yml`). No macOS or Linux jobs run and no macOS manifests are merged.
- `all`: additionally macOS arm64/x64 DMG + ZIP with a merged `*-mac.yml`, and Linux x64 AppImage with `*-linux.yml`.

Tagged releases read the profile from the tagged commit. Dry runs may override it with the `profile` dispatch input. Assembly verifies the exact asset set for the profile, every manifest hash, and every `SHA256SUMS` line.

Stable updaters read their manifest from `/releases/latest`, so a release that omits a platform breaks that platform's updates. Preflight, and publication again before creating the draft, therefore reject the `windows` profile once any published release contains `latest-mac.yml`, `beta-mac.yml`, `latest-linux.yml` or `beta-linux.yml`. After macOS or Linux updates launch, `all` is the permanent release path.

## One-time maintainer setup

Create the `release` environment, allow deployment refs `v*` and `main`, and require reviewer `lopes-felipe`. Store Developer ID Application `.p12` credentials as `CSC_LINK` (base64 or certificate URL) and `CSC_KEY_PASSWORD`. Store the App Store Connect `.p8` key contents as `APPLE_API_KEY`, plus `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. Signed macOS builds fail closed when any credential is absent. The workflow writes the key into the runner's temporary directory.

Optional Windows signing secrets: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`, `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`. Once available, set repository variable `F5_WINDOWS_SIGNING_REQUIRED=true`; missing credentials then fail builds. Otherwise Windows artifacts are explicitly unsigned: packaging sets `signExecutable: false` (keeping the icon and version metadata) and `verifyUpdateCodeSignature: false`, so `app-update.yml` carries no `publisherName`. Every versioned build bakes the `lopes-felipe/f5` feed, and packaging fails if the packaged `app-update.yml` points elsewhere, uses another channel, or has an unexpected `publisherName`. The first signed release must be a higher version that keeps the application identity, install path, profile storage and feed; never replace published unsigned assets.

Apply a tag ruleset restricting create/update/delete of `refs/tags/v*` to admins and enable GitHub release immutability. These repository settings require maintainer setup. Prevent upstream tags entering origin: `git config remote.upstream.tagOpt --no-tags`. Never push all upstream tags.

## Prepare and publish

First public release: Windows-only `v0.1.0` stable. It is rehearsed without publishing anything: by the Windows update rehearsal (on every dry run and tag) and by the manual acceptance checks below. No public beta precedes it.

The Windows CLI archives and the rehearsal live in `.github/workflows/windows-release-checks.yml`. The release workflow calls it, and pull requests that touch packaging, distribution, desktop or release files run it as well, with no secrets or environment approval. Get it green on the pull request before merging; a release dry run then only has to confirm the signed and cross-platform parts.

The rehearsal job builds two unpublished installers from the release commit, on the release channel. Stable pairs are the base version and its next patch; beta pairs are `<base>-beta.1` and `<base>-beta.2`, which resolve through the Atom feed. It then runs `scripts/windows-update-rehearsal.ts` on a fresh Windows runner, which:

- installs the baseline silently and redirects that installation's `app-update.yml` to a loopback GitHub emulator, so the real GitHub provider code path runs;
- renames every directory providing Node or Bun on F5's effective PATH (inherited, registry machine/user, and the known install folders F5 adds at startup), then launches the app and checks that no Node or Bun process starts;
- through the renderer bridge and UI Automation, exercises an offline check, sha512 rejection, an interrupted download and retry, cancellation, installer-launch failure recovery, and the real restart into the target;
- verifies the version, install path, Start Menu shortcut and preserved profile data (seeded settings, markers and the app's own state files);
- uninstalls silently and checks that user data stays.

`assemble` depends on it, so no draft is created without it.

What the rehearsal does **not** prove:

- **Published clients:** both builds contain the release commit's updater, so it cannot show that already-published clients can update to the new release. That matters from the second Windows release on. Before tagging `v0.1.1` (or any Windows release after `v0.1.0`), change the job to use the latest published stable installer as the baseline and the `desktop-win-x64` build artifact as the target.
- **Signed builds:** its builds are always unsigned. When Windows signing is enabled, extend it to signed-to-signed upgrades and to rejecting unsigned or wrongly signed updates.

A green dry run with the release's profile is a hard precondition for tagging. The rehearsal has no non-blocking mode; a flaky failure means re-running the job.

1. Run `node scripts/prepare-release.ts <version>`: `0.1.0` for the Windows-only first release (no beta). With the `all` profile, rehearse as `X.Y.Z-beta.N` first. It updates four manifests and the lockfile. Stable preparation moves Unreleased into a dated section; beta preparation leaves it untouched. Follow the printed commands to open a release PR.
2. Merge and wait for a successful **CI push** run on main at the exact release SHA.
3. Run `git tag vX.Y.Z <sha>` and `git push origin vX.Y.Z` (use `-beta.N` for beta). Only stable and beta.N tags are accepted. The version must exceed every published stable/beta version.
4. Approve the release environment. The workflow builds the profile's desktops (with `all`, it also signs and notarizes macOS; with `windows`, it produces only the unsigned Windows installer), runs the Windows rehearsal, checks all hashes/manifests, and creates a **draft**. Updaters cannot see drafts. `workflow_dispatch` with `dry_run=true` on main rehearses builds with a unique dryrun version and creates no release.
5. Smoke-test using the checklist for the profile below: Windows only for `windows`; one installer per OS and both macOS architectures for `all`. Inspect `release-bundle`, staged dependency lock artifacts, and the draft's asset names and sizes. Changelog text is the release body; YAML never contains releaseNotes.
6. Publish with `bun run release:promote --tag <tag>`, then `gh release edit <tag> --latest` for stable. Beta releases remain prereleases. The promote script is the only supported way to undraft: when the tag embeds a certified provider integration record, it publishes only after main holds an all-passed acceptance report for the draft's exact macOS DMG (see "Single certification source" in `docs/agent-browser.md`); otherwise it just publishes.

Published releases are immutable. Fix regressions with a higher patch release; never overwrite assets or enable downgrades. Existing drafts are preserved on retry for inspection. After verifying that an existing release is still a draft and saving anything needed for investigation, the maintainer can remove only that draft with `gh release delete <tag> --yes` (without `--cleanup-tag`), then rerun publication. The tag is retained. Agents do not perform this destructive operation under this repository's Git/GitHub policy.

Beta uses electron-updater 6.8.3's first stable-or-beta release in Atom feed order. Other suffixes are skipped. Stable users resolve `/releases/latest`.

Releases across both channels must increase globally. If a higher beta is already published, choose a stable hotfix version above that beta; a lower stable hotfix is rejected. When a beta branch is still maintained, include stable fixes in its next beta. The provider feed-order test documents why a lower stable release would otherwise hide a higher beta; that publication pattern is not permitted by this policy.

## Windows-only checklist (`windows` profile; record results in the PR)

- Dry run on main with `profile=windows`: the Windows installer, blockmap and `latest.yml`, five CLI archives, the CLI manifest and `SHA256SUMS` assemble, the `windows / update-rehearsal` job passes, and no release is created.
- Confirm that the `refs/tags/v*` tag ruleset is active and release immutability is enabled. With unsigned Windows updates, these controls, plus the sha512 in the release's `latest.yml`, are the only protection for installed clients until a signed release embeds `publisherName`.
- Before publishing, confirm the macOS preview app has no `resources/app-update.yml`, so it shows no update errors once a Windows-only release becomes latest.
- On clean Windows 10 and Windows 11 x64 VMs, using the **draft's** installer:
  - Download through a browser (SmartScreen path), verify its hash against `SHA256SUMS`, install, launch without Node/Bun, create data, and uninstall (data is kept).
  - On Windows 11, record Smart App Control behaviour and confirm it matches `docs/install.md`.
  - Test import and side-by-side operation with F5 (Alpha), as in the full checklist.
- Publish with `bun run release:promote --tag v0.1.0`, then `gh release edit v0.1.0 --latest`.
- Then confirm that `releases/latest/download/F5-0.1.0-x64.exe`, `latest.yml` and `f5-cli-release.json` return 200 with the expected version. An installed 0.1.0 must report "up to date" against the production feed, and `f5 install` must work from the new manifest.

## Full checklist (`all` profile; record results in the PR)

- Dry run on main produces signed/notarized desktops and five CLI archives, passes assembly, and creates no release.
- Publish beta.1 after inspecting its exact asset set. Install without source, Node or Bun on each OS. macOS passes `codesign --verify --deep --strict`, `xcrun stapler validate`, and `spctl -a -vvv -t execute` with `Notarized Developer ID`.
- Test import with F5 (Alpha) running: launch blocks until it quits; retry imports without changing legacy data. Regrant Screen Recording and Accessibility. On macOS and Linux, record whether legacy preview sign-ins survive; reauthentication may be required because the old Safe Storage key is not migrated. Verify a newly established F5 preview sign-in survives beta.1 → beta.2. On Windows, verify the copied `Local State` preserves profile decryption.
- Run alongside upstream T3 Code on macOS/Windows; verify separate storage and independent single-instance locks. F5 must block computer use against itself (including dev).
- Missing Git/provider CLI leaves F5 open with diagnostics.
- Publish beta.2; check, download, restart on mac arm64/x64, Windows, and AppImage. Test confirmation cancel, window-close veto, offline check, and interrupted download. On a slow Mac, allow Squirrel staging to take more than 60 seconds: windows and agents must stay running until staging completes, with no watchdog recovery or duplicate quit. Squirrel staging has a five-minute timeout before shutdown and shows “Preparing update…”; after a timeout the downloaded payload remains retryable, and a late staging completion does not quit F5. The native handoff after staging remains uncancellable and has no timer-based recovery; native errors still allow retry. Windows and Linux retain the 60-second watchdog.
- Launch from a mounted DMG: Move to Applications works; Not Now leaves updates disabled with an explanation in About.
- Publish stable; beta installs update and retain beta preferences. Stable installs never see betas. Turning beta off never downgrades.
- Verify `f5 install` and `f5 update` with the stable CLI manifest.
- After stable publication, fetch `https://github.com/lopes-felipe/f5/releases/latest/download/latest-mac.yml`, `/f5-cli-release.json`, and one installer under the same base URL; each must return 200 and the expected version.
- Confirm the global monotonicity check rejects a lower stable release when a higher beta exists. Automated provider tests also document that unsupported feed order.

Apple credentials, the release environment, and tag ruleset are prerequisites for publication. Local tests cannot substitute for the signed multi-OS rehearsal.

## Build and validate CLI archives

The user guide for the standalone CLI is [Standalone F5 CLI](user/standalone-cli.md). Use a matching native runner and Node **26.10.0** for each target:

```sh
bun run dist:cli:archive --target darwin-arm64 --node /path/to/node
bun run test:cli-smoke release-cli/f5-0.0.10-darwin-arm64.tar.gz release-cli/f5-0.0.10-darwin-arm64.json
bun run dist:cli:manifest release-cli/f5-cli-release.json release-cli/f5-0.0.10-{darwin-arm64,linux-x64,linux-arm64,win32-x64,win32-arm64}.json
```

`--output PATH` selects an artifact directory; `--skip-build` uses existing server web assets. The script bundles the standalone server, builds a SEA with snapshots/code cache disabled, pins native dependency roots and transitive overrides to the repository lockfile, resolves with scripts disabled, verifies every resulting package version and integrity against that lock, then installs with `--frozen-lockfile`, and emits an archive plus its manifest fragment. It rejects unsupported and cross-architecture native builds. A universal macOS Node is thinned to arm64 before injection. macOS artifacts are ad hoc signed for local execution; public distribution signing/notarization is a separate release workflow. Desktop's narrow ASAR unpack policy is unchanged.

The merge script requires all five targets and matching versions. Release publishing automation and credentials belong in a separate PR; these scripts do not publish, change secrets, or configure repository access.

Validation in the CLI PR: macOS arm64 archive build and smoke with a disposable home and restricted PATH; native PTY and native file search; update rollback after a failing migration; interrupted trial/restoration and durable-commit recovery; architecture rejection; required workspace and real-Git checks. Packaged Windows/Linux and clean-machine VM smoke runs remain release gates and are not certified by a macOS-only run.

The real archive integration test can also run on each release runner with `F5_CLI_SMOKE_ARCHIVE` and `F5_CLI_SMOKE_MANIFEST` set, using `bun run --cwd apps/server test:file integration/standaloneArchive.integration.test.ts`. It stages the archive, preflights the stable launcher, verifies that a prepared trial has no HTTP listener, rejects an activation message for another update ID, and checks the correlated bootstrap after activation. It also starts the installed stable service launcher, verifies that malformed update metadata is quarantined without stopping the server, and checks graceful shutdown. It uses a disposable state directory and leaves the user profile untouched.

### Standalone update internals

`update` stages and verifies the same-architecture release and queues a unique update ID. It does not replace a running executable or run npm. The stable built-in-only launcher preflights the candidate, stops the old child, and snapshots SQLite main/WAL/SHM. The trial completes migrations and service acquisition before reporting prepared. Background workers and HTTP activation wait for the launcher to durably commit the new version. Failure before the durable commit stops the trial, restores the snapshot, and restarts the old runtime. After the commit, recovery always rolls forward and preserves the new database, including activation and journal-cleanup failures.

`current.json`, `pending.json`, `handoff.json`, and `outcome.json` record the handoff. The journal records the canonical database path and rejects recovery with another `--state-dir`. An incomplete snapshot or a live previous child blocks recovery. The child exits when its launcher's IPC channel disappears. Reconnect bootstrap carries the update ID, terminal outcome, and actual version; the UI reports success or rollback from those fields, never from a connection opening alone.

Installer archives are downloaded with bounded size/time, checked against exact byte length and SHA-256, inspected for traversal and links, then staged into immutable version directories. Native PTY/search, version, architecture, and launcher protocol are checked before use. A launcher owns the default profile of its explicit state directory; it rejects `--profile` overrides and validates the actual database path before migrations.

## Signing hardening and remaining backend limitation

Signed macOS builds use JIT plus Apple Events only for the main application, JIT only for Electron child processes, and an empty entitlement set for the Swift computer helper. Library validation and unsigned executable memory exemptions are removed. Packaging disables `NODE_OPTIONS` and CLI inspector fuses and enables ASAR integrity validation on macOS/Windows with ASAR-only application loading.

`RunAsNode` remains enabled because the backend currently re-executes the bundled Electron binary through the macOS GUI-denial sandbox and uses Node IPC. These fuse changes do **not** eliminate the risk of another local process launching that signed binary with arbitrary Node code. Before treating the first signed release as hardened against that threat, migrate the backend to a separately signed minimal Node helper or a utility process with equivalent kernel GUI isolation, preserve the computer-host IPC authentication, disable `RunAsNode`, and rehearse backend/session restarts and native modules. Do not substitute an unsandboxed utility process merely to disable a fuse. This architectural follow-up is not implemented by this PR.
