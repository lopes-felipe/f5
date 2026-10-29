# Install F5

Install the F5 desktop app. It bundles its own backend, so you don't need Node, Bun or a source
checkout. To run F5 in a browser instead, use the [standalone CLI](user/standalone-cli.md); to
build from source, see [Quick start](quick-start.md).

## How to

1. Download the installer from [GitHub Releases](https://github.com/lopes-felipe/f5/releases)
   (see [Availability](#availability) for which release to pick).
2. Install it (see your platform below).
3. Install Git and at least one provider, then sign in. See
   [Provider prerequisites](provider-prerequisites.md).
4. Open F5 and follow [Getting started](user/getting-started.md).

F5 still opens if Git or a provider is missing, and shows what needs fixing.

## Availability

| Platform                     | Status                                    |
| ---------------------------- | ----------------------------------------- |
| macOS (Apple Silicon, Intel) | Signed and notarized, with in-app updates |
| Windows x64                  | Unsigned installer, with in-app updates   |
| Linux x64                    | AppImage, with in-app updates             |
| `f5` CLI                     | All five targets in every release         |

Desktop builds start with the `v0.1.1` betas, published as prereleases; `v0.1.1` is the first
stable release. Until it is published, download a `v0.1.1-beta.N` release from the
[releases page](https://github.com/lopes-felipe/f5/releases).

## Windows

Run `F5-<version>-x64.exe`. It installs for your user without administrator rights and adds a
Start-menu shortcut. Windows on ARM has no native build.

> [!WARNING]
> The installer isn't code-signed yet. SmartScreen may show "Windows protected your PC"; choose
> **More info → Run anyway** only after checking the download. Smart App Control in enforcement
> mode, and some organization policies, block unsigned apps entirely.

Check the download before running it: compare
`Get-FileHash F5-<version>-x64.exe -Algorithm SHA256` with the matching line in the release's
`SHA256SUMS`.

## macOS

Open `F5-<version>-arm64.dmg` (Apple Silicon) or `F5-<version>-x64.dmg` (Intel) and drag F5 to
Applications. Builds are signed with Developer ID and notarized, so Gatekeeper opens them after
the usual first-launch confirmation. The older `v0.0.11-computer-use-preview.1` preview is unsigned and doesn't update; see
"Upgrade from F5 (Alpha)" below.

## Linux

Download `F5-<version>-x86_64.AppImage`, make it executable (`chmod +x`) and run it from a folder
you can write to, so updates can replace it. Some distributions need FUSE.

## Updates

Open **Settings → About** to check for an update, download it, and restart to install. Restarting
stops all windows and running agents, so F5 asks first. Beta updates are opt-in (on by default for
beta installs), and the beta preference survives installing a stable build. Turning beta off keeps
your version until a newer stable release; F5 never downgrades.

## Good to know

- Moving from F5 (Alpha) doesn't touch your data under `~/.f5`. Regular updates do: they migrate
  the database on first launch.
- Screen Recording and Accessibility are only needed for the opt-in macOS
  [computer use preview](user/agent-browser-and-computer-use.md).
- F5 and upstream T3 Code can run side by side.

<details>
<summary>Details and limits</summary>

**Signing.** A later signed Windows release updates unsigned installs normally; from then on, F5
checks that each update is signed by the same publisher. Signing alone doesn't guarantee immediate
SmartScreen reputation ([Microsoft guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)).
macOS releases use Developer ID signing and notarization; launched from a mounted disk, choose
**Move to Applications** so updates work. AppImages need a writable folder for updates, and
some distributions need FUSE.

**Upgrade from F5 (Alpha).** The `v0.0.11-computer-use-preview.1` preview can't update in place.
Quit F5 (Alpha) and T3 Code, delete `F5 (Alpha).app` on macOS (on Windows the new app installs
alongside), then install and open F5. Check your data before removing the old app (on Windows:
**Settings → Apps → Installed apps**), and use the new Start-menu entry afterwards. If you use
computer use, grant Screen Recording and Accessibility again.

**Settings import.** The first launch copies Chromium settings from `T3 Code (Alpha)` (or
`t3code`) into the new `f5` directory and keeps the old one. CacheStorage, service-worker caches
and blob caches are skipped. A large import runs before the window opens and needs room for another
copy plus 64 MiB. If the import fails, quit the legacy app and retry. Chromium Safe Storage keys aren't copied, so preview-browser sign-ins may need
redoing on macOS and Linux; localStorage and IndexedDB are kept. Windows also copies `Local State`.

**Existing profiles.** A non-empty `f5` Chromium profile is never replaced. An empty folder, or one
holding only `.DS_Store`, `Thumbs.db` or `desktop.ini`, can still receive the import. Launch once
with `F5_SKIP_USERDATA_IMPORT=1` to start empty instead; this writes a `skipped` marker and removes
nothing.

**Import lock.** The lock lives at `<appDataBase>/f5.migration.lock` (`f5-dev.migration.lock` in
development), where `<appDataBase>` is `~/Library/Application Support`, `%APPDATA%` or
`$XDG_CONFIG_HOME` (`~/.config`). F5 reclaims locks from dead processes, from before the current
boot, and incomplete records after 5 seconds; a live owner never expires. If a lock still blocks
launch, quit every F5 instance first and remove only a lock you've confirmed is abandoned. The
`F5_SKIP_USERDATA_IMPORT` escape hatch also respects an active import lock.

</details>

## Related

- [Provider prerequisites](provider-prerequisites.md)
- [Getting started](user/getting-started.md)
- [Standalone CLI](user/standalone-cli.md)
- [Build from source](quick-start.md)
