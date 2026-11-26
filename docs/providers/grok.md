# Grok (Early Access)

Use the xAI Grok CLI (`grok`) as an F5 provider over the Agent Client Protocol (ACP) via
`grok agent stdio`.

## How to

1. Install the Grok CLI `1.0.13` or newer so `grok` is on the server's `PATH`, or set **Binary
   path** on the instance in **Settings → Providers**.
2. Sign in from a terminal:

   ```bash
   grok login
   ```

3. Open **Settings → Providers**, enable Grok, and confirm the status shows **Authenticated**.
4. Pick Grok and a model in the composer.

## Configuration

| Field         | Default | Purpose                                                                |
| ------------- | ------- | ---------------------------------------------------------------------- |
| Binary path   | `grok`  | Path to the Grok CLI executable                                        |
| Custom models | `[]`    | Additional model slugs to expose alongside discovered Grok CLI models  |
| Environment   | `{}`    | Per-instance environment variables merged into the spawned `grok` proc |

You can add multiple Grok instances with separate environment variables or binary paths.

## Access modes and capabilities

Grok supports **Supervised** and **Full access** runtime modes. **Auto-accept edits**, **Auto**, and
the Plan interaction mode toggle are unavailable for Grok.

| F5 mode     | Behavior                                    |
| ----------- | ------------------------------------------- |
| Supervised  | Asks before edits and shell commands        |
| Full access | Runs tools and edits without manual prompts |

- **Built-in & discovered models:** F5 discovers live models from your signed-in CLI during status
  checks and uses that catalog when non-empty. `grok-build` (**Grok Build**) is shown as a fallback
  only when F5 cannot fetch models from the CLI.
- **Skills:** F5 discovers both global and workspace Grok skills and exposes enabled skills as slash
  commands.
- **Tools:** Preview browser MCP and computer-use automation brokers are passed to Grok ACP sessions
  when enabled.
- **Text generation:** Thread titles and commit messages run through Grok's text-generation adapter.

## Good to know

- Grok is **Early Access** and requires CLI version `1.0.13` or newer for F5's ACP integration.
- Background status and skill probes run with `GROK_DISABLE_AUTOUPDATER=1` so silent probes never
  trigger hidden self-updates (or console windows on Windows) and never open ACP sessions or
  workspace MCP servers. Interactive sessions keep your normal environment.
- Grok runs in the default F5 profile (not in isolated profiles).

## Related

- [Provider prerequisites](../provider-prerequisites.md)
- [Runtime modes](../runtime-modes.md)
- [Provider architecture](../provider-architecture.md)
