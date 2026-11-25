# MCP servers

Open **Settings → Tools → MCP servers** for common configuration, or choose a project in Settings and open its MCP section. MCP connects coding agents to tools and context supplied by servers you configure.

## Scopes and editing

MCP settings store server definitions in a common scope and a project scope. Common entries are inherited by every project. In project settings, **Use in this project** opts out of an inherited common server without changing other projects. **Override** opens a project draft using the common definition.

New and renamed servers may use letters, numbers, `_` and `-` (up to 128 characters), and must not start with `f5_` or `__f5`; tool names are built from the server name, and providers rewrite other characters. Saved servers with older names keep working and show a rename warning. Names are trimmed and compared without case. An exact-name project entry replaces the entire common definition; a differently cased alias is a conflict. Each scope accepts 16 entries, with at most 32 effective entries and four reserved slots for F5's built-in servers. An oversized legacy layer stays intact while you repair or remove entries; it cannot accept new names.

Opt-outs compare names without case and remain recorded when a common server is removed. Reusing that name keeps the project opted out; explicitly enable it in that project if desired.

Arguments are separate, ordered rows. Use the arrows to reorder them; empty arguments, spaces, newlines, and `=` in values are preserved. Environment variables and HTTP headers use key/value rows. Duplicate keys block saving and are marked inline. Removing a server asks you to confirm its name and scope. Switching scope, project, provider account, or server with an unsaved draft asks whether to discard it; **Keep editing** preserves the draft.

## Provider support

Common and project configuration is shared by Codex and Claude. Support labels in Advanced identify provider-specific fields.

| Field or capability                         | Codex                                                   | Claude                                                           |
| ------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| stdio command, ordered args, environment    | Supported                                               | Supported                                                        |
| stdio working directory                     | Supported                                               | Ignored; servers start in the conversation's directory           |
| HTTP URL and literal headers                | Supported                                               | Supported                                                        |
| SSE URL                                     | Connects using streamable HTTP; SSE-only endpoints fail | Supported                                                        |
| Tool timeout, enabled tools, disabled tools | Supported                                               | Supported                                                        |
| Bearer token environment variable           | Supported                                               | Sent as an `Authorization` header from the account's environment |
| OAuth client ID and callback port           | Supported                                               | Supported                                                        |
| Startup timeout, parallel tool calls        | Supported                                               | Ignored                                                          |
| Scopes, OAuth callback URL, OAuth resource  | Supported                                               | Ignored                                                          |
| Inspector tools                             | Names, descriptions, annotations, input schemas         | Names, descriptions, annotations; input schemas unavailable      |
| Inspector resources and templates           | Metadata available                                      | Unavailable from Claude                                          |

Selecting SSE shows the transport warning. If the endpoint supports streamable HTTP, choose HTTP. Authentication is provider-owned: tokens are stored by the provider for the selected account, so later sessions connect without asking. When a server needs sign-in, click **Sign in** in the conversation's sign-in row above the composer, in **Runtime details**, or on its row in a project-scoped MCP settings view (see [Sign in](#sign-in)). F5 never opens the browser on its own.

### Other agents

Cursor, Grok, Antigravity, custom ACP agents, OpenCode, Muse Code, and Pi reach your MCP servers through F5. F5 connects to each server and gives every session its own local endpoint with its own credential, so stdio servers work for agents that only accept HTTP, and enabled tools and disabled tools apply the same way everywhere. Tools keep the server's name (`mcp__<server>__<tool>` where the agent uses that form).

- A session gets the servers saved when it starts; **Apply** does not reach these agents yet, so start a new session after saving.
- stdio servers start once per session. HTTP and SSE servers share one connection per account, which closes five minutes after the last session leaves.
- A server that stops is retried after 1, 2, 4, 8, and 16 seconds; after that it shows **Failed** until you click **Reconnect**. Tool calls made while it reconnects fail at once with a short explanation.
- Headers, stored secrets, and bearer token environment variables work. A server that needs OAuth shows **Needs sign-in** until you sign in from MCP settings (see [Sign in for other agents](#sign-in-for-other-agents)).
- A name the agent already uses for its own server (for example in Cursor's or OpenCode's own MCP configuration) keeps the agent's server.
- OpenCode gets servers only when F5 starts its OpenCode server; a configured external OpenCode server is shared with other clients and gets none. Muse Code needs a host that grants per-session MCP servers. Pi tools from these servers always ask for approval unless the session runs with full access.

In a project's MCP settings, **Other agents** lists the connections in use, the agents and session counts using them, and any error, with **Reconnect** for a failed server.

## Saved configuration and live status

**Saved: Enabled/Disabled** is the desired state. The adjacent observed badge describes the selected running conversation or configuration check. A saved disabled server can still be connected in a conversation until changes are applied. **Ready**, **Starting**, **Failed**, **Login required**, and **Unknown** describe readiness; applying a version does not guarantee readiness.

Settings labels live results **Observed in <conversation> at <time>** and lets you choose another running conversation for the project and account. Only that conversation receives a live read. Without a running conversation, Codex performs a labeled **Configuration check**. Claude shows **Configured** and explains that live status appears when a session runs. F5 never starts a conversation just to observe status. **External** entries belong to the provider, plugins, or managed configuration; **Built-in** entries are registered by F5. Neither is assigned to a same-name configured row.

Rows show tool and resource counts when known. Expand **Connection details** to read or copy an error with supplemental redaction. Open **Inspect** for Overview, Tools, Resources, and Diagnostics. Unsupported capabilities and incomplete listings are marked explicitly. Inspection never runs tools or fetches resource contents. The chat's MCP chip summarizes the latest session generation for Codex and Claude; click it or focus it and press Enter for each server's name, state, error, and a keyboard-accessible **Open MCP settings** link.

## Sign in

OAuth needs your approval in the browser, so F5 never signs in automatically. **Sign in** appears when a server reports that it needs sign-in, in these places:

- **In a conversation**, while its session is live: a row above the composer lists the servers that need sign-in in the current session, and **Sign in…** expands one button per server. **Runtime details** lists the same servers with Sign in.
- **In the chat's MCP chip**, which shows how many servers need sign-in; open it for a **Sign in** button per server.
- **In MCP settings**, when a project scope is selected. Without a selected project there is no live status, so no provider status is shown. A **Test** that reports **Sign-in required** points you to a project scope or the conversation prompt.

The conversation row, Runtime details, and chip cover Codex servers from F5 or the profile's `config.toml`, and Claude servers configured in F5. Claude's **External** servers (plugins, Claude settings, claude.ai connectors) are not reported to the conversation; sign in to them from project-scoped MCP settings while a Claude conversation is running.

How sign-in works per provider:

- **Claude** signs in through a running Claude conversation in the project: the one you click from in chat, or the conversation settings is observing. Start a conversation first if none is running. Claude Code completes the browser flow itself; F5 waits up to five minutes for the server to connect, then reconnects it in the account's other running conversations. claude.ai connectors authorize on claude.ai, and F5 retries the connection with increasing delays for up to five minutes, skipping retries while a turn is running. If you deny or abandon consent in the browser, the attempt stays pending until those five minutes pass; use **Reopen sign-in** to return to it, or start a new attempt afterwards.
- **Codex** signs in through the account's Codex app server, also for servers defined in the profile's `config.toml`, then reloads live Codex sessions. Codex startup failures that ask you to run `codex mcp login` (an expired or missing OAuth token) are shown as needing sign-in. Servers that do not support OAuth report the provider's error.

### Sign in for other agents

The agents under [Other agents](#other-agents) use F5's own sign-in. **Sign-in for other agents** in MCP settings lists every enabled HTTP and SSE server in the selected scope. It works in either scope, with no conversation running.

- **Sign in** registers F5 with the server if it has no `oauthClientId`, then opens the server's sign-in page in your browser. F5 opens the browser only when you click.
- F5 listens on `127.0.0.1` for the browser's return, on the server's OAuth callback port if one is set and otherwise on a free port. An OAuth callback URL, if set, is used as the redirect address instead. The sign-in finishes on its own when the browser returns. If your browser runs on another machine, copy the address it ends on (it starts with the shown callback address) and paste it into the row, then click **Finish sign-in**.
- An attempt expires after ten minutes. Starting a new attempt replaces the pending one, and an address from another attempt is refused.
- A sign-in is shared by every project and agent that uses the same server URL and client ID. F5 renews access tokens with the refresh token when the server issues one, so the row shows **Renews automatically**. Otherwise it shows when access expires.
- **Sign out** forgets the tokens but keeps F5's registration with the server, and reconnects the agents using it.
- OAuth scopes and the OAuth resource are sent as configured.

Claude and Codex sessions keep using their own sign-in.

## Apply, Reconnect, and Test

After saving, the banner says: **Saved. Running sessions pick up MCP changes on their next message, restarting if needed.** Saving does not re-check live status; use **Refresh status** or Apply. Use **Apply to all live sessions** to apply now across all eligible Codex and Claude accounts in the selected scope: this project for project scope, or every project for common scope. Sessions already on that version are skipped unless they need a retry. Active-turn protections still apply. Per-session outcomes and targeted Retry appear in the inspector. The banner clears after Apply or a scope change.

**Reconnect** appears on failed, login-required, and unknown rows. It recovers connections used by running sessions for the selected project and account. Claude reconnects the selected owned server; Codex reloads its settings connection and applies through the normal session path, which can reload every MCP server in the affected sessions. The result distinguishes reconnected sessions, no running session using the server, and failures. Reconnect does not perform sign-in; use **Sign in** instead. A pending sign-in can be reopened without cancelling it if the browser fails to open.

## Import

**Import configuration** opens a preview for pasted F5/Claude JSON, Codex JSON, Codex TOML, VS Code JSON (`servers`), or OpenCode JSON (`mcp`). JSON with comments and trailing commas is accepted. **Detected → Detect configurations** explicitly reads:

- the selected account's Claude state (including project entries), the project's `.mcp.json`, and Codex's `config.toml`, selected by default;
- Cursor (`~/.cursor/mcp.json` and the project's `.cursor/mcp.json`), VS Code (the project's `.vscode/mcp.json`), Claude Desktop, and OpenCode (`opencode.json(c)` in `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`, and the project's `opencode.json(c)`), shown but not selected by default.

Files must be regular files of at most 1 MiB, and symbolic links are not followed. Detection never applies configuration. Names outside the allowed characters are imported under a proposed name (for example `my.server` becomes `my_server`), with a warning. Claude-style `${VAR}` and `${VAR:-default}` references, and OpenCode's `{env:VAR}`, are converted to `${env:VAR}` (see [Environment variables](#environment-variables)), with a warning. Editor variables such as `${workspaceFolder}` and other unknown `${...}` forms are flagged and kept literally, so replace them with a value. Choose entries, review warnings, and explicitly choose **Replace** for any conflict; existing entries are kept by default. A version conflict refreshes the preview without discarding your text or choices, and requires confirmation again.

## Connection test results

**Test** checks either the saved server or the editor draft. A stdio test executes the configured command with the selected account's environment and the draft's environment overrides. Remote tests use the configured headers and bearer environment variable. Tests initialize the connection and list advertised tools, resources, and prompts; they never invoke tools or fetch resource contents. Tests have a 60-second deadline and clean up their child processes. Results show latency, server information, bounded tool summaries, and sanitized errors and stderr. Sign-in requirements remain owned by the provider; a test does not start OAuth.

## Tools

The inspector's **Tools** tab lets you disable individual tools. Switches change the disabled-tools list. Leave enabled tools empty to allow all tools. A disabled-tools entry takes precedence when a tool is listed in both lists. A non-empty enabled-tools list still restricts availability and cannot be broadened by a switch; edit that list under Advanced. Live tool data is preferred, with the last connection test as a fallback. Saving does not prove that a running conversation has applied the configuration. Apply to all live sessions to reconcile immediately, or let sessions pick up the saved version at their next message. Readiness and the applied configuration version are separate observations.

## Environment variables

The command, arguments, environment values, working directory, URL, and header values can reference environment variables as `${env:NAME}`, or `${env:NAME:-default}` to fall back to a default. F5 resolves them from the provider account's environment when the server starts, for every provider, so the stored configuration keeps the reference. An empty variable counts as unset. A server that needs an unset variable with no default is skipped. Settings shows an issue that names the variable, and **Test** reports it. Use stored secrets rather than environment variables for credentials you want F5 to keep.

## Stored secrets

Environment and header values can be marked **Secret**, then stored explicitly. F5 replaces each value with a whole-value `${f5-secret:<uuid>}` reference. Replacing a secret creates a new UUID. Stored values are masked in the editor and omitted from MCP JSON exports. Imports reject these references because they cannot transfer the underlying secret.

Secrets live in permission-restricted files in the profile's secrets directory (directory mode 0700, file mode 0600). The backup system includes that directory only when you explicitly choose password-encrypted secret backups. MCP secrets and OAuth tokens are encrypted at rest with AES-256-GCM under a profile key. In the desktop app, the key is protected by the operating system's keychain and handed to the backend when it starts. A headless server keeps the key in a `secret-store-key.bin` file (mode 0600) in the same directory, which protects against copies of individual secret files but not against someone who can read the whole directory. Values written by older versions are re-encrypted the first time they are read. Encryption is not a full credential vault: the running backend can decrypt every value. Plaintext values in the configuration stay unchanged until you store them as secrets.

Resolved values still reach providers through their process arguments and may be visible to software with access to those processes. Mapping Codex header secrets to `env_http_headers` remains a follow-up. Diagnostics and test results scrub configured values of at least eight characters and credential-like fields, and remove URL credentials, queries, and fragments; transformed secrets cannot be guaranteed to be caught.

If a referenced secret is missing, F5 skips that server, reports a warning, and continues the session with other servers. Replace the missing value in settings. Startup cleanup removes only unreferenced MCP secrets older than 24 hours; saving never deletes secrets.

Secret masking prevents accidental display and export of values; it is not access control against an authenticated F5 client. Clients can use stored references in unsaved probes and provider configuration, including commands or endpoints they control. Only connect clients you trust with the profile's credentials. MCP secret storage is bounded to 4,096 files (at most 64 MiB of values), including unsaved writes; startup collection frees unreferenced entries older than 24 hours.

Error redaction is supplemental, not a guarantee. Settings scrubs values from the available effective configuration as well as generic credential patterns and URL credentials, queries, and fragments. The chat details fetch the current project configuration on explicit open and withhold errors if it cannot load. Values from older configurations, external servers, resolved stored secrets unavailable to the browser, or transformed credentials may not match the available values. Do not share copied errors without reviewing them.
