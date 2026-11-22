# Linux VM profiles

> Contributors: the opt-in Linux VM execution environment for profiles on Apple Silicon. Status, invariants that already hold, the runtime behind its hidden flag, and the feasibility gate it passed.

**Contents:** [Status](#status) · [Invariants](#invariants) · [Runtime](#runtime) · [Phase 0 feasibility gate](#phase-0-feasibility-gate) · [Remaining delivery](#remaining-delivery)

A Linux VM profile runs its backend, providers, terminals, Git and local MCP processes inside a Lima VZ guest (Apple Virtualization.framework), instead of on the host. Host profiles are unchanged.

## Status

| Step                                                 | State                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| Phase 0 feasibility gate                             | **Passed** 2026-11-22, with two caveats ([result](#gate-result-2026-11-22)) |
| Profile model, lazy registry v2, fail-closed refusal | Done                                                                        |
| Backend channel and launcher abstraction             | Done                                                                        |
| Guest image pipeline, VM launcher, lifecycle         | Done behind a hidden flag; no image pinned yet ([runtime](#runtime))        |
| Exports, clones, network, forwards, login            | Not started; unblocked                                                      |
| UI, packaging and signing, certification, preview    | Not started                                                                 |

Without the hidden flag, this build can't create or start a Linux VM profile. `ProfileRegistryStore.create` refuses `executionEnvironment: "linux-vm"`, and desktop has no VM launcher. A VM record can still show up, for example after rolling back from a VM-capable build, so everything below handles one.

## Invariants

These already hold and must keep holding as the runtime lands.

- **Never on the host.** `executionEnvironment` is fixed at creation; absent means `host`. Desktop resolves a launcher for the recorded environment with no fallback (`apps/desktop/src/profileBackendLauncher.ts`), before it reserves a port or counts the profile against the backend cap. Server startup and CLI profile selection refuse a `linux-vm` record. A refused profile reports its reason once.
- **Lazy registry v2.** `profiles.json` is written as version 2 only while at least one `linux-vm` record exists, and as version 1 otherwise, including after the last VM profile is removed. Builds without VM profiles ignore unknown record fields and would run a VM profile on the host, so the bump makes them refuse the registry instead. Installations that never create a VM profile stay readable by older builds. Every reader rejects a version 1 file containing a VM record and a VM Default. Version 2 is reserved for this meaning: any other registry format change must use version 3 or later.
- **No host state for the guest.** A VM profile's host directory holds only main-owned VM metadata. Provider homes, settings and SQLite live on the guest's data disk. Cross-profile host readers (checkout ownership, managed worktree roots, repository-sharing warnings) skip VM profiles instead of looking for host state that isn't there.
- **An unforgeable channel.** `ComputerHostChannel` depends on `BackendChannel`, not on `ChildProcess`. Main creates every channel and registers it with the profile and incarnation it launched. Host backends use inherited IPC. Guest backends will use length-prefixed JSON frames (`@t3tools/shared/backendFrames`) over the stdio of the `limactl shell` process main spawns. There is no listener, malformed frames close the channel, and end of stream disconnects it. The decoder copies each byte once, however a frame is split. Main queues at most two maximum-size frames for a guest that stops reading, then disconnects it.
- **No host-process integrations for guests.** A channel without `hostPid` is refused Chrome leases, validation, restore, process registration and adoption, and Sky's foreground lease, whatever capabilities it advertises. Its browser-open requests always show the prompt; a guest's `preapproved` flag is ignored. F5-mediated computer tools stay available.

## Runtime

Behind `F5_EXPERIMENTAL_LINUX_VM=1`, on Apple silicon, desktop registers a VM launcher (`apps/desktop/src/vm/`) and the server lets a host profile create a `linux-vm` record. A VM record gets only an empty, `0700` host directory: its provider homes, settings and SQLite live on the guest's data disk.

**Assets.** The launcher needs three things, and without any one of them VM profiles stay refused:

| Asset                   | Packaged location (not bundled yet)                  | Development override                                         |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| Lima 2.3.0 `limactl`    | `Resources/native/lima/bin/limactl`                  | `F5_VM_LIMACTL`                                              |
| linux-arm64 CLI archive | `Resources/vm/f5-<version>-linux-arm64.tar.gz`       | `F5_VM_BACKEND_ARCHIVE`, with its `.json` manifest beside it |
| Guest image pin         | `apps/desktop/vm-guest/image.lock.json` (now `null`) | `F5_VM_IMAGE_URL`, `F5_VM_IMAGE_SHA256`, `F5_VM_IMAGE_SIZE`  |

The archive is what `bun run dist:cli:archive` builds on a linux-arm64 machine. A pin accepts only release assets of this repository; the development override accepts any HTTPS URL.

**Guest image.** `apps/desktop/vm-guest/build-image.sh` customizes the digest-pinned Debian 13 genericcloud arm64 image offline with `virt-customize`. Packages come from a pinned `snapshot.debian.org` timestamp, and nothing runs apt at runtime. It adds:

- the root-owned guest tool `/opt/f5/bin/f5-guest`
- the egress policy (`f5-egress-apply` and its unit)
- user `f5` (uid 1500, no sudo, home on the data disk)
- `/opt/f5/policy.sha256`, which every guest command checks

The `vm-guest-image` workflow builds it on pull requests that touch `vm-guest/`. A manual run with `publish` attaches it to a `vm-guest-image-<commit>` prerelease and prints the lock entry to copy into `image.lock.json`.

**Start sequence.** Main spawns the VM supervisor (`vmSupervisorEntry.js`) as the profile's backend process, inside the same `sandbox-exec` GUI-denial profile as host backends. Its environment holds only `PATH`, `HOME`, `TMPDIR`, `LANG` and the supervisor configuration, which contains no secrets. The supervisor then:

1. Refuses a foreign `_config/default.yaml` or `override.yaml` in LIMA_HOME, which Lima would merge into the instance.
2. Downloads the pinned image into the installation-wide cache `<state>/vm/images/`. The download resumes, and the whole file is verified by SHA-256.
3. Replaces the instance (the root disk) if the image digest changed, keeping the data disk.
4. Creates the sparse data disk (40 GiB, raw), then the instance from `buildLimaInstanceConfig`.
5. Boots the VM and checks `f5-guest status`: data disk mounted at `/var/lib/f5`, policy hashes, the `f5_egress` table loaded, `f5` without sudo.
6. Installs the backend when the guest lacks its version: `limactl copy` into the guest, then `f5-guest install`. That hashes and extracts a single root-owned copy of the archive, keeping the current and previous versions.
7. Starts an ssh ControlMaster that owns the `127.0.0.1:<port>` forward. `ExitOnForwardFailure` turns an occupied port into an error.
8. Runs `limactl shell … sudo f5-guest launch <incarnation> <version>` on its own stdin and stdout.

First start may take up to 15 minutes before recovery is offered; host profiles keep 3.

**Channel.** The supervisor's stdin and stdout are main's pipes, and it never reads them. Main writes one boot line, `{port, authToken, profileId}`, followed by frames. `f5-guest launch` reads exactly that line and starts the backend as `f5` in a transient systemd scope. The auth token reaches it through systemd-run's environment, never a command line.

The backend reads frames on fd 3 and writes them on fd 4, and its stdout is redirected to stderr. `F5_DESKTOP_COMPUTER_HOST=frames` selects `frameStreamIpc`. The backend says hello with the host profile id from the boot line; main checks it against the profile and incarnation it launched. Every Lima child except the final `limactl shell` gets fresh stdio. Otherwise the daemonized hostagent would inherit the channel and hold it open.

**Lifecycle.** At most two VM profiles run at once, within the six-backend cap. Stop sends SIGTERM to the supervisor. It kills `limactl shell`, so the guest launcher sees EOF and stops the scope, then it runs `limactl stop`. Main waits 5 s before killing the supervisor. A VM still running after that is reused on the next start. A crash restarts the incarnation, and the VM keeps running. Losing the port forward also ends the incarnation. A refusal writes `last-startup-error-<id>.json` and exits 78, so the recovery window shows the reason.

**Paths.** LIMA_HOME is `<state>/vm/<first 16 hex of the profile id>`, not `<profile-state>/vm/lima`. Under a typical home directory, the profile path leaves no room for ssh's ControlMaster socket within macOS's 104-byte limit. A state directory that is still too long is refused. Main-owned metadata (`lima.yaml`, `instance.json`) stays in `<profile-state>/vm/`.

**Known gaps** before the preview:

- Removing a VM profile moves its host directory to `.trash`, but leaves its LIMA_HOME and data disk. Stopping the VM and moving LIMA_HOME belong to the removal flow in step 5.
- Quitting F5 doesn't stop running VMs.
- Lima's admin user keeps Lima's passwordless sudo. Only main holds its ssh key, and `f5` can't reach it.
- Nothing has run end to end yet. That needs a published image, a linux-arm64 archive and a real boot, which goes in Terminal per the [gate's two-phase rule](#gate-result-2026-11-22).

## Phase 0 feasibility gate

Run from a packaged, Developer-ID-signed F5 build on Apple Silicon, with `MAC_BACKEND_COMPUTER_SANDBOX` unchanged. This is a throwaway spike branch, not merged. Every check must pass:

1. Bundled pinned `limactl` 2.3.0, re-signed with hardened runtime and `com.apple.security.virtualization`, boots a VZ guest from inside the sandboxed backend subtree, without QEMU. Virtualization's XPC VM service starts under `(deny job-creation)`.
2. Host GUI probes run from Lima's host processes stay denied: AppleEvents, screencapture, AX and TCC lookups.
3. A virtiofs export mounts at its canonical host path.
4. As a non-sudo `f5` guest user, bubblewrap and socat let the Claude CLI sandbox enforce a child sandbox.
5. Root-owned nftables drop new outbound connections to the host gateway, RFC1918, 100.64/10, 169.254/16, fc00::/7 and fe80::/10, while DNS to the Lima resolver and public HTTPS work. `f5` can't flush the rules or sudo.
6. The `limactl shell` stdio channel carries backend frames both ways. Closing its stdin stops the guest backend's transient systemd scope and every process in it.
7. An ssh ControlMaster built from Lima's ssh config adds and cancels `127.0.0.1` forwards at runtime (`-O forward`, `-O cancel`) under the sandbox.
8. Cold-boot time and resident memory are recorded for 2 vCPU / 4 GiB.

Record the results as `docs/computer-certification/<date>-macos-linux-vm-gate.json`, including the tested commit, macOS version, hardware, Lima and image digests, and each check's result and evidence. Keep credentials out of the evidence. If check 1 or 2 fails, stop for design review. Never weaken the host policy to pass.

GitHub-hosted macOS ARM64 runners can't run nested Virtualization.framework VMs. VM integration coverage needs a self-hosted Apple Silicon runner, or a recorded manual gate like the [real-provider release gate](profiles.md#real-provider-release-gate).

### Gate result (2026-11-22)

**Passed.** The evidence is in [`2026-11-22-macos-linux-vm-gate.json`](computer-certification/2026-11-22-macos-linux-vm-gate.json). It was run on F5 0.1.11-beta.15 (Developer ID, hardened runtime) on an M4 Pro with macOS 27.2.1, using Lima 2.3.0 and the digest-pinned Debian 13 image. The run had two phases, so that a Cortex XDR kill couldn't cost in-progress work:

- **Phase A**, in Terminal outside F5: download, first boot, provisioning and every guest-side check.
- **Phase B**, in an F5 agent shell inside the unchanged backend sandbox: the same VM restarted, plus every check that depends on the sandbox. The shell's AppleEvents were refused, and the protected GUI service lookups were denied, before Lima started and while it ran.

Two caveats carry into delivery:

- **Signing.** Lima's own ad hoc signature (with the virtualization entitlement) was used. Re-signing the bundled `limactl` with Developer ID and hardened runtime is part of the release pipeline in step 3 and must be rechecked there.
- **Claude sandbox.** Child sandboxing was verified with `@anthropic-ai/sandbox-runtime` 0.0.83, the library the Claude CLI's sandbox is built on, run through `srt` as `f5`: commands ran, while network access and writes outside the working directory were blocked. The Claude CLI driving a model still needs the fake-model provider test.

Measured: cold boot of a provisioned guest took 8 to 10 s inside the sandbox and 6.5 s outside it. First boot with apt provisioning took 84 s. At idle, the host's VZ process used about 690 MiB RSS and the guest used 250 MiB.

Findings that change the remaining steps:

- **virtiofs ignores guest identity.** Every guest write lands as the host user, whatever the guest UID, so guest users don't protect exported files. That fits the rule that exports are fully guest-writable.
- **A bubblewrap sandbox that binds `/` still reaches guest UNIX sockets.** DNS resolved through systemd-resolved's socket with the network namespace unshared. The child-sandbox policy must hide `/run/systemd`, the D-Bus socket and similar paths.
- **`sandbox-runtime` refuses to run without ripgrep,** so the image must keep it.
- **The guest's DNS server is the host gateway** (192.168.5.2, served by Lima's gvproxy). The egress policy's only exception on the gateway is port 53.
- **Judge channel shutdown by the scope, not the exit code.** In one run, the `limactl shell` process exited 241 after main closed the channel, even though the scope had stopped correctly.

## Remaining delivery

The gate has passed, so these steps are unblocked:

- **End-to-end run.** Publish the first image, pin it, then boot a VM profile with a linux-arm64 archive, outside F5 first and then inside it, as in the gate.
- **Packaging and signing.** Bundle Lima and the linux-arm64 archive into the macOS build, re-sign `limactl` with Developer ID, hardened runtime and the virtualization entitlement, record the pins in `docs/dependency-pins.md` and the steps in `docs/release.md`, and recheck the gate's signing caveat.
- **Sharing and network.** Folders are exported only through the picker and only as separate clones, never a host repo's `.git`. Guest egress is internet-only. Main owns every port forward on `127.0.0.1`. The installation-wide login lease is held through the channel. VM-profile backends can't mutate installation state.
- **UI.** Visible provisioning states (downloading, provisioning, booting, installing, ready, failed), a removal flow that stops the VM and trashes its LIMA_HOME, and stopping VMs on quit. "Linux VM (preview)" appears only on darwin-arm64, macOS 13+, in builds with guest assets.

The paid benchmark is a separate follow-up plan that depends on certification.
