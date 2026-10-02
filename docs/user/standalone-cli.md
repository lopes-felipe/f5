# Standalone F5 CLI

The CLI release archive contains a Node single-executable server, the web client, native PTY/search dependencies, and a private Node runtime for JavaScript helpers. End users need neither Node, npm, nor a compiler. Git and provider credentials remain prerequisites for their respective features.

Supported archive targets: `darwin-arm64`, `linux-x64`, `linux-arm64`, `win32-x64`, and `win32-arm64`. Linux archives use glibc. Intel macOS users retain the desktop package. WSL and SSH remote launch are outside this scope.

## Install and run

Download the matching archive from an F5 release, unpack it, and run its `f5` executable (`f5.exe` on Windows):

```sh
./f5 install
# Add ~/.f5/cli/bin to PATH.
f5 serve --state-dir ~/.f5/cli-state
```

The installer consumes `https://github.com/lopes-felipe/f5/releases/latest/download/f5-cli-release.json`. `--manifest HTTPS_URL` selects an explicit release manifest; `--install-dir PATH` selects a separate installation. Archives are downloaded with bounded size/time, checked against exact byte length and SHA-256, inspected for traversal and links, then staged into immutable version directories. Native PTY/search, version, architecture, and launcher protocol are checked before use. Existing version contents cannot be silently replaced.

Existing `t3`/`f5` server flags and `bun apps/server/src/index.ts` development invocations continue to work. The no-subcommand invocation runs the server directly. Use `serve` for supervised standalone operation and updates. A launcher owns the default profile of its explicit state directory; it rejects `--profile` overrides and validates the actual database path before migrations. Use a separate install/state directory for another supervised profile.

## Services

```sh
f5 service install --state-dir ~/.f5/cli-state
f5 service status
f5 service restart
f5 service stop
f5 service start
f5 service uninstall
```

Linux uses a user systemd unit; macOS uses a user launchd agent. Installation fails if an existing service definition would be replaced. macOS login-shell PATH discovery retains the private Node runtime. Windows supports foreground `f5 serve` and the desktop app; Windows service registration is intentionally unsupported.

## Update and recover

```sh
f5 update
f5 update-status
```

Run the launcher/service before requesting an update. `update` stages and verifies the same-architecture release and queues a unique update ID. It does not replace a running executable or run npm. The stable built-in-only launcher preflights the candidate, stops the old child, and snapshots SQLite main/WAL/SHM. The trial completes migrations and service acquisition before reporting prepared. Background workers and HTTP activation wait for the launcher to durably commit the new version. Startup failure stops the trial, restores the snapshot, and restarts the old runtime.

`current.json`, `pending.json`, `handoff.json`, and `outcome.json` record the handoff. Interrupted trials restore the snapshot; a durable committed handoff rolls forward. An incomplete snapshot or a live previous child blocks recovery. The child exits when its launcher's IPC channel disappears. Reconnect bootstrap carries the update ID, terminal outcome, and actual version; the UI reports success or rollback from those fields, never from a connection opening alone.

Runtime versions and database backups are retained for inspection. No automatic deletion or downgrade is performed. If an installer itself is interrupted, confirm that no installer is running before removing its `.install-lock`. A launcher recovery lock also requires operator inspection if its recovery process was interrupted. Service removal only removes its unit/agent, preserving runtime versions and profile data.

The Windows desktop updater explicitly relaunches through NSIS after bounded profile shutdown. Download progress is reported in whole-percentage increments and clamped to finite 0–100 values.

## Build and validate releases

Use a matching native runner and Node **26.10.0** for each target:

```sh
bun run dist:cli:archive --target darwin-arm64 --node /path/to/node
bun run test:cli-smoke release-cli/f5-0.0.10-darwin-arm64.tar.gz release-cli/f5-0.0.10-darwin-arm64.json
bun run dist:cli:manifest release-cli/f5-cli-release.json release-cli/f5-0.0.10-{darwin-arm64,linux-x64,linux-arm64,win32-x64,win32-arm64}.json
```

`--output PATH` selects an artifact directory; `--skip-build` uses existing server web assets. The script bundles the standalone server, builds a SEA with snapshots/code cache disabled, stages production native dependency roots and their runtime closure, and emits an archive plus its manifest fragment. It rejects unsupported and cross-architecture native builds. A universal macOS Node is thinned to arm64 before injection. macOS artifacts are ad hoc signed for local execution; public distribution signing/notarization is a separate release workflow. Desktop's narrow ASAR unpack policy is unchanged.

The merge script requires all five targets and matching versions. Release publishing automation and credentials belong in a separate PR; these scripts do not publish, change secrets, or configure repository access.

Validation in this PR: macOS arm64 archive build and smoke with a disposable home and restricted PATH; native PTY and native file search; update rollback after a failing migration; interrupted trial/restoration and durable-commit recovery; architecture rejection; required workspace and real-Git checks. Packaged Windows/Linux and clean-machine VM smoke runs remain release gates and are not certified by a macOS-only run.

The real archive integration test can also run on each release runner with `F5_CLI_SMOKE_ARCHIVE` and `F5_CLI_SMOKE_MANIFEST` set, using `bun run --cwd apps/server test:file integration/standaloneArchive.integration.test.ts`. It stages the archive, preflights the stable launcher, verifies that a prepared trial has no HTTP listener, rejects an activation message for another update ID, and checks the correlated bootstrap after activation. It uses a disposable state directory and leaves the user profile untouched.
