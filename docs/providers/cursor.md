# Cursor (Early Access)

Use the Cursor Agent CLI (`agent`) as an F5 provider over the Agent Client Protocol (ACP).

## How to

1. Install the Cursor CLI so `agent` is on the server's `PATH`, or set **Binary path** on the
   instance in **Settings → Providers**.
2. Sign in from a terminal:

   ```bash
   agent login
   ```

3. Open **Settings → Providers**, enable Cursor, and confirm the status shows **Authenticated**.
4. Pick Cursor and a model in the composer.

## Configuration

In **Settings → Providers**, each Cursor instance accepts:

| Field         | Default   | Purpose                                                                 |
| ------------- | --------- | ----------------------------------------------------------------------- |
| Binary path   | `agent`   | Path to the Cursor Agent executable                                     |
| API endpoint  | _(empty)_ | Optional custom Cursor API endpoint                                     |
| Custom models | `[]`      | Additional model slugs to expose alongside discovered account models    |
| Environment   | `{}`      | Per-instance environment variables merged into the spawned `agent` proc |

You can add multiple Cursor instances with separate environment variables or custom endpoints.

## Access modes and interaction

Cursor supports **Supervised** and **Full access** runtime modes, plus the **Plan** interaction mode
toggle in the composer. **Auto-accept edits** and **Auto** are unavailable for Cursor.

| F5 mode     | Behavior                                    |
| ----------- | ------------------------------------------- |
| Supervised  | Asks before edits and shell commands        |
| Full access | Runs tools and edits without manual prompts |

F5 exposes its preview browser MCP server and computer-use broker to Cursor ACP sessions when
enabled, and discovers user and workspace Cursor skills automatically.

## Model discovery and status checks

- Status refreshes run `agent about` only, so background health checks never open Cursor's browser
  login flow.
- Available models are discovered in the background through ACP `initialize` and
  `cursor/list_available_models` without starting a session.
- On current Cursor CLIs, parameterized model options (reasoning effort, context window, fast mode)
  and **Auto** are reported directly from the CLI catalog and cached across server restarts in
  `provider-status-cache`.

## Good to know

- Cursor is **Early Access** and runs in the default F5 profile (not in isolated profiles).
- This build ships the ACP harness (`agent acp`); the SDK harness is unavailable and never silently
  falls back to ACP.
- Thread titles and commit messages use ACP-backed text generation (`makeCursorTextGeneration`) in
  a dedicated scratch directory.

## Related

- [Provider prerequisites](../provider-prerequisites.md)
- [Runtime modes](../runtime-modes.md)
- [Provider architecture](../provider-architecture.md)
