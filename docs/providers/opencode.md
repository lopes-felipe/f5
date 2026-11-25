# OpenCode

Use [OpenCode](https://opencode.ai/) as an F5 provider through a managed local `opencode serve`
process or an external OpenCode server.

## How to

1. Install OpenCode CLI `1.14.19` or newer (below `2.0.0`) so `opencode` is on the server's `PATH`,
   **or** run an external OpenCode server and copy its URL (always use `https://` for remote
   servers; use plain `http://` only for loopback `localhost` URLs, because F5 sends **Server
   password** in an HTTP Basic `Authorization` header).
2. Configure your model providers in OpenCode's own settings/environment.
3. Open **Settings → Providers**, enable OpenCode, and optionally set **Binary path**, **Server
   URL**, or **Server password**.
4. Pick OpenCode and a model in the composer.

## Configuration

| Field           | Default    | Purpose                                                                    |
| --------------- | ---------- | -------------------------------------------------------------------------- |
| Binary path     | `opencode` | Path to the `opencode` executable for local managed servers                |
| Server URL      | _(empty)_  | Connect to an already-running external OpenCode server instead of spawning |
| Server password | _(empty)_  | Authentication password for an external OpenCode server                    |
| Custom models   | `[]`       | Additional model slugs to expose in the model picker                       |
| Environment     | `{}`       | Per-instance environment variables for local managed OpenCode processes    |

You can add multiple OpenCode instances. Instances with distinct **Server URL** values talk to
independent external servers; instances without a **Server URL** start one scoped child server
process per session, owned by that session and shut down when the session closes.

## Access modes

OpenCode supports **Supervised**, **Auto-accept edits**, and **Full access** runtime modes. **Auto**
and the Plan interaction mode toggle are unavailable for OpenCode.

| F5 mode           | Behavior                                              |
| ----------------- | ----------------------------------------------------- |
| Supervised        | Asks before file edits and commands                   |
| Auto-accept edits | Edits files freely and asks before other tool actions |
| Full access       | Runs tools and edits without manual prompts           |

## Updates and macOS quarantine

- Local OpenCode installations update via OpenCode's built-in updater from **Settings → Providers**.
  External servers must be updated on the host running them.
- On macOS, a downloaded `opencode` binary with the quarantine attribute will fail to start. Clear
  it once with:

  ```bash
  xattr -d com.apple.quarantine $(which opencode)
  ```

## Good to know

> [!NOTE]
> An external OpenCode server's **Server password** is stored unencrypted in F5's separate
> file-backed secret store on disk (`settings.json` keeps only a redacted reference, and the
> password is redacted before settings are sent back to the browser). If you restore only
> `settings.json`, you will need to enter the password again.

- F5 communicates with OpenCode via `@opencode-ai/sdk/v2` and shares an owning-session abort signal
  across SDK fetches so a server exit cancels pending HTTP calls immediately.
- On POSIX systems, shutting down an F5-managed OpenCode server reaps the process group and
  descendants within the shutdown deadline.
- OpenCode runs in the default F5 profile (isolated profiles support managed Codex and bundled
  Claude).

## Related

- [Provider prerequisites](../provider-prerequisites.md)
- [Runtime modes](../runtime-modes.md)
- [Provider architecture](../provider-architecture.md)
