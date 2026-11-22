# Linux VM profiles

> Contributors: the opt-in Linux VM execution environment for profiles on Apple Silicon. Status, invariants that already hold, and the feasibility gate that must pass before the VM runtime is built.

**Contents:** [Status](#status) · [Invariants](#invariants) · [Phase 0 feasibility gate](#phase-0-feasibility-gate) · [Remaining delivery](#remaining-delivery)

A Linux VM profile runs its backend, providers, terminals, Git and local MCP processes inside a Lima VZ guest (Apple Virtualization.framework), instead of on the host. Host profiles are unchanged.

## Status

| Step                                                 | State                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| Phase 0 feasibility gate                             | **Passed** 2026-11-22, with two caveats ([result](#gate-result-2026-11-22)) |
| Profile model, lazy registry v2, fail-closed refusal | Done                                                                        |
| Backend channel and launcher abstraction             | Done (host implementation only)                                             |
| Guest image pipeline, VM launcher, lifecycle         | Not started; unblocked                                                      |
| Exports, clones, network, forwards, login            | Not started; unblocked                                                      |
| UI, certification run, opt-in preview                | Not started                                                                 |

This build can't create or start a Linux VM profile. `ProfileRegistryStore.create` refuses `executionEnvironment: "linux-vm"`, because the provisioning lifecycle a VM record needs doesn't exist yet. A VM record can still show up, for example after rolling back from a VM-capable build, so everything below handles one.

## Invariants

These already hold and must keep holding as the runtime lands.

- **Never on the host.** `executionEnvironment` is fixed at creation; absent means `host`. Desktop resolves a launcher for the recorded environment with no fallback (`apps/desktop/src/profileBackendLauncher.ts`), before it reserves a port or counts the profile against the backend cap. Server startup and CLI profile selection refuse a `linux-vm` record. A refused profile reports its reason once.
- **Lazy registry v2.** `profiles.json` is written as version 2 only while at least one `linux-vm` record exists, and as version 1 otherwise, including after the last VM profile is removed. Builds without VM profiles ignore unknown record fields and would run a VM profile on the host, so the bump makes them refuse the registry instead. Installations that never create a VM profile stay readable by older builds. Every reader rejects a version 1 file containing a VM record and a VM Default. Version 2 is reserved for this meaning: any other registry format change must use version 3 or later.
- **No host state for the guest.** A VM profile's host directory holds only main-owned VM metadata. Provider homes, settings and SQLite live on the guest's data disk. Cross-profile host readers (checkout ownership, managed worktree roots, repository-sharing warnings) skip VM profiles instead of looking for host state that isn't there.
- **An unforgeable channel.** `ComputerHostChannel` depends on `BackendChannel`, not on `ChildProcess`. Main creates every channel and registers it with the profile and incarnation it launched. Host backends use inherited IPC. Guest backends will use length-prefixed JSON frames (`@t3tools/shared/backendFrames`) over the stdio of the `limactl shell` process main spawns. There is no listener, malformed frames close the channel, and end of stream disconnects it. The decoder copies each byte once, however a frame is split. Main queues at most two maximum-size frames for a guest that stops reading, then disconnects it.
- **No host-process integrations for guests.** A channel without `hostPid` is refused Chrome leases, validation, restore, process registration and adoption, and Sky's foreground lease, whatever capabilities it advertises. Its browser-open requests always show the prompt; a guest's `preapproved` flag is ignored. F5-mediated computer tools stay available.

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

- **Guest image and VM lifecycle.** CI builds a digest-pinned Debian 13 arm64 image with Git, bubblewrap, socat, ripgrep, nftables, the root-owned launcher `/opt/f5/bin/f5-guest-launch`, users `f5` (no sudo) and admin, and the organization policy files. It downloads on first use. A persistent data disk at `/var/lib/f5` survives root-image replacement. `LIMA_HOME=<profile-state>/vm/lima`, and instance config comes only from F5's typed builder. The backend is installed from the bundled linux-arm64 CLI archive whenever its version differs. A `VmBackendLauncher` registers a `streamBackendChannel` with the computer channel.
- **Sharing and network.** Folders are exported only through the picker and only as separate clones, never a host repo's `.git`. Guest egress is internet-only. Main owns every port forward on `127.0.0.1`. The installation-wide login lease is held through the channel. VM-profile backends can't mutate installation state.
- **Resources and UI.** At most 2 running VMs within the 6-backend cap. Visible provisioning states. "Linux VM (preview)" appears only on darwin-arm64, macOS 13+, in builds with guest assets.

The paid benchmark is a separate follow-up plan that depends on certification.
