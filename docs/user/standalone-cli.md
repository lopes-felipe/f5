# Standalone F5 CLI

Run the F5 server without the desktop app, for example on a home server you reach through
[remote access](../../REMOTE.md). The archive includes everything it needs, so you don't need
Node, npm or a compiler.

## Install from the desktop app

On macOS and Linux, open **Settings → About → Command-line tools** and select
**Install CLI commands**. F5 links the bundled server as `f5` and `t3` in
`/usr/local/bin`, falling back to `~/.local/bin` without administrator prompts.
The installed launcher uses the desktop app's bundled runtime; Node is not required.
Keep the application installed at that location for these commands to work.

Existing files and symlinks are preserved. If another `f5` or `t3` runs first on
PATH, installation reports its location and stops. If the chosen directory is
not on PATH, Settings shows the paths to add. The separate archive installer
below remains available for servers without the desktop app.

## How to

1. Download the archive for your system from an
   [F5 release](https://github.com/lopes-felipe/f5/releases/latest) and unpack it.
2. Install it and add `~/.f5/cli/bin` to your PATH:

   ```sh
   ./f5 install
   ```

3. Start the server:

   ```sh
   f5 serve --state-dir ~/.f5/cli-state
   ```

Git and provider sign-in are still needed for agents. See
[Provider prerequisites](../provider-prerequisites.md).

## Run as a service

```sh
f5 service install --state-dir ~/.f5/cli-state
f5 service status
f5 service restart
f5 service stop
f5 service start
f5 service uninstall
```

Linux uses a user systemd unit and macOS a user launchd agent. On macOS, logs go to the state
directory's `logs` folder. Installing fails rather than replacing an existing service definition.
Uninstalling removes only the service, never your data.

## Update

```sh
f5 update
f5 update-status
```

Start the server or service before updating. F5 downloads and verifies the new version, backs up
the database, and switches over. If the new version fails before it's committed, F5 restores the
backup and restarts the old version.

## Good to know

> [!NOTE]
> Windows supports `f5 serve` in the foreground, but not service registration. Intel Macs should
> use the desktop app. WSL and SSH remote launch aren't supported.

- One supervised profile per state directory. For another profile, use a separate install and
  state directory.
- `f5` with no subcommand runs the server directly, like the older `t3` command.
- F5 refuses downgrades, and skips the download when you're already up to date.

<details>
<summary>Details and limits</summary>

| Topic             | Detail                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Targets           | `darwin-arm64`, `linux-x64`, `linux-arm64` (glibc), `win32-x64`, `win32-arm64`                                                              |
| Installer options | `--manifest HTTPS_URL` for a specific release manifest; `--install-dir PATH` for a separate install                                         |
| Default manifest  | `https://github.com/lopes-felipe/f5/releases/latest/download/f5-cli-release.json`                                                           |
| Verification      | Exact size and SHA-256, archive path checks, native module, version and architecture checks; installed versions are never replaced in place |
| Retained data     | Runtime versions and the 3 newest completed database backups                                                                                |
| Disk space        | Checked before the running server is stopped                                                                                                |
| `--profile`       | Rejected by `serve`; the launcher owns the state directory's default profile                                                                |

**Recovery.** `current.json`, `pending.json`, `handoff.json` and `outcome.json` record each update.
An interrupted trial restores the backup. Once the update is committed, recovery always moves
forward and keeps the new database. If activation then fails, check the logs and restart the
supervisor. The UI reports success or rollback from the update result, not just from
reconnecting.

**Locks.** If an installer was interrupted, make sure no installer is running before deleting its
`.install-lock`. An interrupted recovery lock also needs a manual check.

**Windows desktop updates** relaunch through NSIS after the profile shuts down. Download progress
is shown in whole percentages.

</details>

## Related

- [Remote access](../../REMOTE.md)
- [Install F5](../install.md) (desktop app)
- [Build and validate CLI archives](../release.md#build-and-validate-cli-archives) (maintainers)
