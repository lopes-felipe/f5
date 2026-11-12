# Remote access

Run the F5 server on one machine and open it from another device, such as a phone, tablet or
another laptop.

> [!WARNING]
> F5 doesn't provide TLS. Over plain HTTP, the token and session cookie travel in cleartext, and
> anyone holding them controls agents that can run commands on this machine. Bind to a trusted,
> encrypted interface such as Tailscale, or put an HTTPS/WSS reverse proxy in front. Don't bind to
> `0.0.0.0` on an untrusted network.

## How to

1. Build the web app: `bun run build`. Remote access needs the built app, not Vite dev mode.
2. Generate a token: `TOKEN="$(openssl rand -hex 24)"`.
3. Start the server on a trusted interface, here your Tailnet address:

   ```bash
   bun run --cwd apps/server start -- --host "$(tailscale ip -4)" --port 3773 --auth-token "$TOKEN" --no-browser
   ```

4. On the other device, open `http://<tailnet-ip>:3773/#token=<token>`. Get the token with
   `printf '%s\n' "$TOKEN"`.
5. Make sure your firewall allows inbound TCP on that port.

> [!IMPORTANT]
> F5 listens on `127.0.0.1` by default and refuses any other address without `--auth-token`.
> Older setups that relied on binding to every interface must now set `--host` and a token.

## Other interfaces

To use a LAN address instead, pass that address (for example `--host 192.168.1.42`) and open
`http://<that-address>:3773/#token=<token>`. `--host 0.0.0.0` listens on every IPv4 interface;
use it only behind a TLS reverse proxy or on a network you fully trust.

## Multiple profiles

Each [profile](docs/profiles.md) runs on its own port and browser origin. Expose each port, pass the
same `--auth-token` to each server, and open the `#token=` link once per origin. If you override
ports, keeping origins separate is up to you.

## Good to know

- Tokens must be at least 24 bytes. Generate one; don't use a password.
- Reverse proxies should keep the original `Host` header, set `X-Forwarded-Proto: https` so F5
  marks the session cookie `Secure`, and append the client address to `X-Forwarded-For` so login
  limits apply per client and not to everyone behind the proxy.
- F5 believes `X-Forwarded-*` headers only from a proxy on the same machine. For a proxy on
  another host, list its address with `--trusted-proxy`. Without that its `X-Forwarded-Proto` is
  ignored and the browser's WebSocket connection is refused with a 403 that names the proxy.
- Without `--auth-token`, F5 answers only requests addressed to `localhost`, a `.localhost` name or
  a loopback address, and rejects any other `Host` with 403. This stops a web page from reaching
  the server by re-pointing its own hostname at your machine (DNS rebinding). A proxy or tunnel
  that presents another hostname needs a token.

<details>
<summary>Details and limits</summary>

**Options.** Every option can be set as a CLI flag or an environment variable. Run with `--help`
for the full list.

| CLI flag                 | Env var               | Notes                                                                        |
| ------------------------ | --------------------- | ---------------------------------------------------------------------------- |
| `--mode <web\|desktop>`  | `T3CODE_MODE`         | Runtime mode.                                                                |
| `--port <number>`        | `T3CODE_PORT`         | HTTP/WebSocket port.                                                         |
| `--host <address>`       | `T3CODE_HOST`         | Bind interface/address.                                                      |
| `--home-dir <path>`      | `F5_HOME`             | Base directory for F5 state.                                                 |
| `--state-dir <path>`     | `F5_STATE_DIR`        | State directory.                                                             |
| `--dev-url <url>`        | `VITE_DEV_SERVER_URL` | Dev web URL redirect/proxy target.                                           |
| `--no-browser`           | `T3CODE_NO_BROWSER`   | Disable auto-open browser.                                                   |
| `--auth-token <token>`   | `T3CODE_AUTH_TOKEN`   | Remote HTTP and WebSocket token.                                             |
| `--trusted-proxy <list>` | `F5_TRUSTED_PROXIES`  | Reverse proxies on other hosts: comma-separated IP addresses or CIDR ranges. |

The older `T3CODE_HOME` and `T3CODE_STATE_DIR` still work, but `F5_HOME` and `F5_STATE_DIR` win
when both are set.

**Token exchange.** The token is passed once in the URL fragment, which is never sent in HTTP
requests or WebSocket URLs. The browser trades it for a short-lived HttpOnly session cookie and
removes it from the address bar.

**Other clients.** Non-browser WebSocket clients authenticate with
`Authorization: Bearer <token>`. The older `?token=` form is accepted only from loopback, for the
desktop app, and not from a client that a local proxy forwards for.

**Failed attempts.** Five wrong tokens from one address within a minute lock that address out of
token checks for a minute, and 100 from all addresses together lock out everyone. Wrong logins
and wrong bearer tokens count alike. Signed-in browsers keep working during a lockout, and
clients on the same machine are never locked out of bearer checks.

</details>

## Related

- [Environment variables](docs/environment.md)
- [Profiles](docs/profiles.md)
- [Standalone CLI](docs/user/standalone-cli.md)
