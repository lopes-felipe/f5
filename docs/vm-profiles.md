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

| Asset                   | Packaged location (macOS arm64)                   | Development override                                                     |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------------------------------ |
| Lima `limactl`, pinned  | `Resources/native/lima/bin/limactl`               | `F5_VM_LIMACTL`                                                          |
| linux-arm64 backend pin | `Resources/vm/linux-arm64-backend.json`           | `F5_VM_BACKEND_ARCHIVE`: a local archive, its `.json` manifest beside it |
| Guest image pin         | `apps/desktop/vm-guest/image.lock.json`, built in | `F5_VM_IMAGE_URL`, `F5_VM_IMAGE_SHA256`, `F5_VM_IMAGE_SIZE`              |

Packaged builds ignore all three overrides.

- **Lima** is pinned in `apps/desktop/vm-guest/lima.lock.json` (the `lima-vm/lima` Darwin arm64 release tarball and its SHA-256). `scripts/stage-lima.ts` verifies the tarball and stages only `limactl`, the Linux guest agent, the templates (`limactl` refuses to run without `default.yaml`, though F5 passes its own config) and the license: about 42 MB. The release signs `limactl` with Developer ID, hardened runtime and only `com.apple.security.virtualization` (`apps/desktop/resources/entitlements.lima.plist`), and the build fails unless the signed app passes that check.
- **The backend** isn't in the app: the linux-arm64 CLI archive is about 625 MB, which would more than double the macOS download and every update for a hidden feature. The app instead carries the `dist:cli:archive` manifest of the archive its own release run built, and the supervisor downloads that archive the first time a guest lacks this build: from exactly `https://github.com/lopes-felipe/f5/releases/download/v<app version>/f5-<app version>-linux-arm64.tar.gz`, checked against the pinned size and SHA-256, with the same resumable, locked cache as the guest image (`<state>/vm/backends`, keeping only the current build). A pin for another version or another URL refuses the VM profile. `f5-guest install` checks the digest again inside the guest.
- **The image pin** accepts only release assets of this repository; the development override accepts any HTTPS URL.

**Guest image.** `apps/desktop/vm-guest/build-image.sh` customizes the digest-pinned Debian 13 genericcloud arm64 image offline with `virt-customize`. Packages come from a pinned `snapshot.debian.org` timestamp, and nothing runs apt at runtime. It adds:

- the root-owned guest tool `/opt/f5/bin/f5-guest`
- the egress policy (`f5-egress-apply` and its unit)
- user `f5` (uid 1500, no sudo, home on the data disk)
- `/opt/f5/policy.sha256`, which every guest command checks

The `vm-guest-image` workflow builds it on pull requests that touch `vm-guest/`, after running the guest tool tests (`python3 -B -m unittest discover apps/desktop/vm-guest/tests`). The runners have no KVM, so libguestfs runs under TCG. The build job has a read-only token. A manual run on `main` with `publish` passes the built image to a separate job, the only one that can write: it attaches the image to a `0.0.0-guest-image-<commit>` prerelease and prints the lock entry to copy into `image.lock.json`. The tag is a semver prerelease with a custom channel so the desktop beta updater skips it: that updater takes the newest release in the feed whose tag has no custom channel, so a tag like `guest-image-<commit>` would break every beta update check. Tags starting with `v` are reserved for app releases. Manual runs are never cancelled midway, and publishes run one at a time. Regular CI also runs the guest tool tests, as a user and as root, in the `desktop` job.

**Start sequence.** Main spawns the VM supervisor (`vmSupervisorEntry.js`) as the profile's backend process, inside the same `sandbox-exec` GUI-denial profile as host backends. Its environment holds only `PATH`, `HOME`, `TMPDIR`, `LANG` and the supervisor configuration, which contains no secrets. Lima and ssh run with a private `HOME` inside LIMA_HOME, so they never read the user's `~/.ssh` configuration or keys. The supervisor takes `<LIMA_HOME>/supervisor.lock` first. If an earlier supervisor of the same VM is still starting or stopping, the new one waits up to 2 minutes, then refuses without touching the VM. The lock (like the image cache's) is a kernel `flock` taken atomically with the open (`O_EXLOCK`): the kernel releases it when its holder exits, however that happens, so there are no stale lock files or pids to judge. The supervisor then:

1. Refuses a foreign `_config/default.yaml` or `override.yaml` in LIMA_HOME, which Lima would merge into the instance.
2. Downloads the pinned image into the installation-wide cache `<state>/vm/images/`. The download resumes, and the whole file is verified by SHA-256. A lock next to the image serializes concurrent downloads, so two profiles never write the same partial file. A cached image whose size doesn't match the pin is deleted and downloaded again, but only under that lock. A server that rejects the resume range (416) gets one full request. The pin's URL must be exactly `https://github.com/lopes-felipe/f5/releases/download/<tag>/<file>`, already in normal form.
3. Replaces the instance (the root disk) if the image digest changed, keeping the data disk.
4. Creates the sparse data disk (40 GiB, raw), then the instance from `buildLimaInstanceConfig`.
5. Boots the VM and checks `f5-guest status`: data disk mounted at `/var/lib/f5`, policy hashes, the `f5_egress` table loaded, `f5` without sudo or privileged groups. While a booting guest reports only that the egress policy isn't loaded or the data disk isn't attached yet, the supervisor polls for up to 90 s. Any other answer refuses at once.
6. Installs the backend unless the guest has this exact build: same version and same archive digest. Installing means `limactl copy` into the guest, then `f5-guest install`, which hashes and extracts a single root-owned copy of the archive, keeping the current and previous versions.
7. Starts an ssh ControlMaster that owns the `127.0.0.1:<port>` forward, after ending any master a killed supervisor left behind. `ExitOnForwardFailure` makes an occupied port a refusal that names the port. The supervisor waits until the master answers `-O check`: ssh sets up its forwards before it listens for multiplex clients, so by then the port is the VM's.
8. Writes one frame of its own to stdout, `{type: "f5-vm-forward-ready", incarnation}`. Main sends no authenticated request (readiness checks carry the auth token) to the port before it. Until then the port may belong to any local process.
9. Runs `limactl shell … sudo f5-guest launch <incarnation> <version> <sha256>` on its own stdin and stdout. `f5-guest` starts only an installed backend with that digest. `/var/lib/f5` is root's, so `f5-guest` creates and gives `f5` every directory the backend writes there: `state`, `state-profiles` (the server keeps its profile registry next to its state directory) and `home`.

First start may take up to 15 minutes before recovery is offered; host profiles keep 3.

**Channel.** The supervisor's stdin and stdout are main's pipes. It never reads them, and writes only the forward-ready frame. Main writes one boot line, `{port, authToken, profileId}`, followed by frames. `f5-guest launch` reads exactly that line and starts the backend as `f5` in a transient systemd scope. The auth token reaches it through systemd-run's environment, never a command line.

The backend reads frames on fd 3 and writes them on fd 4, and its stdout is redirected to stderr. `f5-guest` creates both pipes and gives them to `f5`. With `F5_DESKTOP_COMPUTER_HOST=frames`, the server entry's first act is to reopen fds 3 and 4 through `/proc/self/fd`, which Node does close-on-exec, and close the inherited ones. Only then does anything else load, so no agent, shell or tool the backend starts inherits the channel. If the reopen fails, the backend refuses to start (exit 78). The kernel allows the reopen only on pipes the backend's user owns: `f5-guest` runs as root, and a pipe root creates is root's, mode 0600. `f5-guest` also resets the backend's supplementary groups to the `f5` groups it checked. This does not isolate the channel from processes running as `f5`: they can still reach the backend's descriptors and environment, including the auth token, through `/proc`. Main therefore treats everything on the channel as guest input. The backend says hello with the host profile id from the boot line; main checks it against the profile and incarnation it launched. Every Lima child except the final `limactl shell` gets fresh stdio. Otherwise the daemonized hostagent would inherit the channel and hold it open.

**Lifecycle.**

- **The VM runs only while its supervisor does.** Every exit shuts the VM down first: main's stop, a refusal, a backend crash, a lost port forward. The supervisor checks with `limactl list` that the shutdown happened. A graceful `limactl stop` (60 s) is followed by `limactl stop --force` (30 s) if the VM is still up. A crash restart therefore boots the VM again (6 to 10 s once it is provisioned).
- **Cap.** At most two VM profiles run at once, within the six-backend cap. A VM counts until its supervisor has exited, not merely been signalled. A crashed profile waiting for its restart also counts. An opening profile reserves its slot synchronously at the cap check, so concurrent opens can't overshoot. A supervisor that ends while Lima may still be running its VM leaves the profile _stranded_, still counted until a later supervisor of that profile shuts the VM down. That covers exit 75 after a failed shutdown, `vmStillRunning` in a refusal, and a supervisor killed by a signal.
- **Stop.** Main sends SIGTERM to the supervisor. Any preparation step in flight is abandoned: the image download and every `limactl` and `ssh` command take the stop signal. A running backend's `limactl shell` is killed, so the guest launcher sees EOF and stops the scope, retrying until the scope is gone. Then comes the confirmed shutdown. Main gives a VM profile 2.5 minutes, longer than the whole shutdown budget, before force-killing the supervisor's process tree. Host backends get 2 s.
- **Refusal.** The supervisor writes `last-startup-error-<id>.json` and exits 78, so the recovery window shows the reason. A refusal by `f5-guest` exits 77 inside the guest, and the supervisor passes on its stated reason (one line, at most 300 characters). The backend's own 78 is reported separately, and a backend can't fake a 77. A refusal carries one line of a failed Lima command's output; the backend log gets the last 8 KiB of it. Lima rewrites its hostagent log at the next boot, so after a crash restart that copy may be the only one.

**Paths.** LIMA_HOME is `<state>/vm/<first 16 hex of the profile id>`, not `<profile-state>/vm/lima`. Under a typical home directory, the profile path leaves no room for ssh's ControlMaster socket within macOS's 104-byte limit. A state directory that is still too long is refused. Main-owned metadata (`lima.yaml`, `instance.json`) stays in `<profile-state>/vm/`.

**Known gaps** before the preview:

- Removing a VM profile moves its host directory to `.trash`, but leaves its LIMA_HOME and data disk. Stopping the VM and moving LIMA_HOME belong to the removal flow in step 5.
- Quitting F5 sends the same SIGTERM, but doesn't wait for VMs to shut down. A supervisor that outlives F5 finishes the shutdown. One that is killed leaves the VM running until the next start of that profile, and the stranded count lives only in memory, so it is lost when F5 quits.
- **Egress.** The guest reaches the internet over IPv4 only. IPv6 carries only neighbor and router discovery and path MTU messages; everything else is rejected quickly, so clients fall back to IPv4. Through the host's NAT, a LAN peer with a global IPv6 address looks the same as the internet. DNS goes only to the discovered resolvers.
- Lima's admin user keeps Lima's passwordless sudo. Only main holds its ssh key, and `f5` can't reach it.
- **End-to-end run (2026-11-23).** A throwaway harness playing main ran the real supervisor (built from main), the v0.1.11-beta.34 linux-arm64 archive and the guest image `0.0.0-guest-image-28548f885c3a`, in the gate's two phases. From scratch (new profile, image download, new data disk), Phase A in Terminal passed 17 checks and Phase B inside the backend sandbox passed 11. They covered the first-boot checklist: killing `limactl shell` stops the guest scope, the egress policy holds, the private `HOME` reads nothing from the real home, and only the backend holds the channel descriptors, close-on-exec. The first run found the `state-profiles` bug fixed in #827. One warm start failed once inside Lima (`[hostagent] vsock forward`) and didn't recur in about eight more; the backend log now keeps Lima's full output. Lima was its own ad hoc build there, not the release's signed copy.

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

- **Packaged run.** Boot a VM profile from a released macOS arm64 build: the Developer ID copy of `limactl` under hardened runtime, and the backend downloaded from that release. This rechecks the gate's signing caveat with the shipped binary.
- **Sharing and network.** Folders are exported only through the picker and only as separate clones, never a host repo's `.git`. Guest egress is internet-only. Main owns every port forward on `127.0.0.1`. The installation-wide login lease is held through the channel. VM-profile backends can't mutate installation state.
- **UI.** Visible provisioning states (downloading, provisioning, booting, installing, ready, failed), a removal flow that stops the VM and trashes its LIMA_HOME, and stopping VMs on quit. "Linux VM (preview)" appears only on darwin-arm64, macOS 13+, in builds with guest assets.

The paid benchmark is a separate follow-up plan that depends on certification.
