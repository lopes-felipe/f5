# Remote Access Setup

Use this when you want to open F5 from another device (phone, tablet, another laptop).

## CLI ↔ Env option map

The F5 CLI accepts the following configuration options, available either as CLI flags or environment variables:

| CLI flag                | Env var               | Notes                              |
| ----------------------- | --------------------- | ---------------------------------- |
| `--mode <web\|desktop>` | `T3CODE_MODE`         | Runtime mode.                      |
| `--port <number>`       | `T3CODE_PORT`         | HTTP/WebSocket port.               |
| `--host <address>`      | `T3CODE_HOST`         | Bind interface/address.            |
| `--home-dir <path>`     | `F5_HOME`             | Base directory for F5 state.       |
| `--state-dir <path>`    | `F5_STATE_DIR`        | State directory.                   |
| `--dev-url <url>`       | `VITE_DEV_SERVER_URL` | Dev web URL redirect/proxy target. |
| `--no-browser`          | `T3CODE_NO_BROWSER`   | Disable auto-open browser.         |
| `--auth-token <token>`  | `T3CODE_AUTH_TOKEN`   | Remote HTTP and WebSocket token.   |

> TIP: Use the `--help` flag to see all available options and their descriptions.

Legacy `T3CODE_HOME` and `T3CODE_STATE_DIR` are still honored, but `F5_HOME` and `F5_STATE_DIR` take precedence when both are set.

> [!IMPORTANT]
> Remote binding is now opt-in. The default host changed to `127.0.0.1`; deployments that
> previously relied on an implicit bind-all must explicitly set `--host 0.0.0.0` (or a specific
> private address) and configure an authentication token as shown below.

## Security First

- F5 refuses to bind to a non-loopback address unless `--auth-token` is set.
- Remote tokens must contain at least 24 bytes. Generate a high-entropy token instead of choosing a password.
- Prefer binding to trusted interfaces (LAN IP or Tailnet IP) instead of opening all interfaces unless needed.
- F5 does not terminate TLS. Use an encrypted network such as Tailscale or an HTTPS/WSS reverse proxy; direct LAN HTTP/WS sends the launch token and session cookie in cleartext.
- Reverse proxies should preserve the original `Host` header and set `X-Forwarded-Proto: https` so F5 marks the session cookie `Secure`.

The launch token is supplied once in the URL fragment. The browser exchanges it for a short-lived,
HttpOnly session cookie and removes the fragment from its address bar. The fragment is not sent in HTTP
requests or WebSocket URLs.

Non-browser WebSocket clients should authenticate with `Authorization: Bearer <token>`. The legacy
`?token=` WebSocket form is accepted only from loopback connections for desktop compatibility.

## 1) Build + run server for remote access

Remote access should use the built web app (not local Vite redirect mode).

```bash
bun run build
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --host 0.0.0.0 --port 3773 --auth-token "$TOKEN" --no-browser
```

Then open on your phone, replacing `<token>` with the value printed by `printf '%s\n' "$TOKEN"`:

`http://<your-machine-ip>:3773/#token=<token>`

Example:

`http://192.168.1.42:3773/#token=0123456789abcdef...`

Notes:

- `--host 0.0.0.0` listens on all IPv4 interfaces.
- `--no-browser` prevents local auto-open, which is usually better for headless/remote sessions.
- Ensure your OS firewall allows inbound TCP on the selected port.

## 2) Tailnet / Tailscale access

If you use Tailscale, you can bind directly to your Tailnet address.

```bash
TAILNET_IP="$(tailscale ip -4)"
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --host "$(tailscale ip -4)" --port 3773 --auth-token "$TOKEN" --no-browser
```

Open from any device in your tailnet:

`http://<tailnet-ip>:3773/#token=<token>`

You can also bind `--host 0.0.0.0` and connect through the Tailnet IP, but binding directly to the Tailnet IP limits exposure.
