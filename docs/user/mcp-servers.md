# MCP servers

Open **Settings → Tools → MCP servers** for common configuration, or choose a project in Settings and open its MCP section. MCP connects coding agents to tools and context supplied by servers you configure.

## The MCP page

The page follows the settings scope switcher: **Global** edits common servers, and a project edits that project's servers. Each server is a row with its transport, description, live status (with its tool count or failure reason), an on/off switch, and a menu:

- **Edit** opens the server's panel on Configuration.
- **Duplicate** saves a copy named `<name>_copy`.
- **Move to common** (in a project) or **Move to project…** (in Global) saves the server in the other scope, then removes it here. If the second step fails, the message names the copy that was already saved.
- **Reconnect** appears for a failed or signed-out server (see [Apply, Reconnect, and Test](#apply-reconnect-and-test)).
- **Export JSON** copies the server's saved JSON.
- **Remove** asks you to confirm the server's name and scope.

Select a server to open its panel:

- **Overview**: live status for F5's connections and for the observed Codex or Claude account, a connection **Test**, the [provider matrix](#provider-support), and the sessions using the server, with **Apply to live sessions**.
- **Tools**: Allow, Ask or Block per tool, the default for the rest, and tools to review (see [Tools](#tools)).
- **Activity**: recent calls through F5, the last day's error rate and latency, and the server's stderr (see [Activity](#activity)).
- **Prompts and resources**: prompt and resource counts from the last connection test and from F5's own connection, and resource metadata from the observed account.
- **Sign-in**: F5's sign-in (see [Sign in with F5](#sign-in-with-f5)), and, with [native passthrough](#native-passthrough), sign-in for the observed Codex or Claude account.
- **Configuration**: the form, and the saved JSON with **Copy JSON**.

**Add server** opens a dialog with four tabs: **Form**, **Catalog** (see [Catalog](#catalog)), **Paste JSON or TOML**, and **Import** (see [Import](#import)). Adding a server from the form opens its panel.

In a project, servers listed in the repository's `.mcp.json` appear under **From this repository** (see [Repository servers](#repository-servers)).

Above the server list, **Codex and Claude connect through F5** explains how Codex and Claude reach your servers and has the [native passthrough](#native-passthrough) switch. When a remote server is configured, it also says that sign-ins Codex and Claude saved earlier are not carried over.

**Codex and Claude status from** (in a project) chooses the account whose live Codex or Claude status the page shows. F5's connection status always comes from F5 itself.

Servers Codex or Claude configure themselves, F5's built-in servers, and servers waiting to be removed are under **Provider-managed servers**, collapsed and read-only, with the observed conversation and **Refresh status**.

## Scopes and editing

MCP settings store server definitions in a common scope and a project scope. Common entries are inherited by every project and appear in a project under **Inherited from common**. There, the switch (**Use <name> in this project**) opts out of an inherited server without changing other projects, and **Override** opens the Add dialog with the common definition so you can save a project version.

New and renamed servers may use letters, numbers, `_` and `-` (up to 128 characters), and must not start with `f5_` or `__f5`; tool names are built from the server name, and providers rewrite other characters. Saved servers with older names keep working and show a rename warning. Names are trimmed and compared without case. An exact-name project entry replaces the entire common definition; a differently cased alias is a conflict. Each scope accepts 16 entries, with at most 32 effective entries and four reserved slots for F5's built-in servers. An oversized legacy layer stays intact while you repair or remove entries; it cannot accept new names.

### Repository servers

A project can list servers in `.mcp.json` at its root folder (the same file Claude Code reads). F5 reads it from the project root only, not from each conversation's worktree, so there is one decision per project. These servers sit between common and project servers: a repository server replaces a common one of the same name, and a project server replaces a repository one. **Use <name> in this project** opt-outs apply to them too.

A repository server never starts until you approve it. **From this repository** lists each server as **Needs approval**, **Approved** or **Changed**. **Review** shows exactly what it runs or reaches (command, arguments, environment, or URL and headers), and **Approve** approves that definition for this project. If the file later changes a server's definition, it is marked **Changed** and stops being used until you review and approve it again. **Revoke** withdraws an approval. Approved servers count toward the 32-server limit. Entries F5 cannot use are listed with the reason: invalid entries, entries with stored-secret references, and a `.mcp.json` that is a symbolic link. Like any added server, a newly approved one reaches running Codex and Claude conversations after [Apply](#apply-reconnect-and-test).

Opt-outs compare names without case and remain recorded when a common server is removed. Reusing that name keeps the project opted out; explicitly enable it in that project if desired.

Arguments are separate, ordered rows. Use the arrows to reorder them; empty arguments, spaces, newlines, and `=` in values are preserved. Environment variables and HTTP headers use key/value rows. Duplicate keys block saving and are marked inline. Closing a panel or the Add dialog, or switching the settings scope, with an unsaved draft asks whether to discard it; **Keep editing** preserves the draft. Switching tabs in a panel, or to another settings page, keeps the draft. If someone removes the server you are editing, the panel stays open with your draft, saving is blocked, and **Create from this draft** moves it into the Add dialog.

## Provider support

Every agent gets the same servers. A server's Overview has a **Providers** list that marks each agent **Supported**, **Limited** (with the options that agent ignores), or **Off**. Turn a switch off to keep the server from that agent; it is saved with the server and applies in every project that uses it.

Every agent reaches servers through F5 (see [How agents connect](#how-agents-connect)), so the list mostly shows **Supported**. A server that sets parallel tool calls is **Limited** for every agent but Codex, which honors the setting.

### With native passthrough

With [native passthrough](#native-passthrough) on, Codex and Claude start servers with their own clients, and the table lists their differences.

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

Selecting SSE shows the transport warning. If the endpoint supports streamable HTTP, choose HTTP. With native passthrough, authentication is provider-owned: tokens are stored by the provider for the selected account, so later sessions connect without asking. When a server needs sign-in, click **Sign in** in the conversation's sign-in row above the composer, in **Runtime details**, or on the server's **Sign-in** tab in a project's MCP settings (see [Sign in](#sign-in)). F5 never opens the browser on its own.

## How agents connect

Codex, Claude, Cursor, Grok, Antigravity, custom ACP agents, OpenCode, Muse Code, and Pi reach your MCP servers through F5. F5 connects to each server and gives every session its own local endpoint with its own credential. stdio servers work for agents that only accept HTTP and start in the conversation's directory. Enabled tools and disabled tools apply the same way everywhere. Tools keep the server's name (`mcp__<server>__<tool>` where the agent uses that form).

- **Apply** sends saved changes to running Codex and Claude sessions without restarting them. An edited server moves to a new connection behind the same endpoint, and a removed one stops listing tools. Claude also picks up a newly added server; Codex gets it in its next session, and so does a raised tool timeout. Calls already running finish on the connection they started on. Apply always reloads Codex, so sign-ins and edits for servers in its own `config.toml` reach the session too. Other agents get the servers saved when a session starts, so start a new session after saving.
- Codex reads each endpoint's credential from an environment variable, so its command line holds only local addresses. Claude receives the credential as a header over its control channel, never on its command line. Either credential opens only that session's local endpoints and is revoked when the session ends. Server secrets and sign-ins stay in F5.
- F5 enforces the server's tool timeout; Codex and Claude wait five seconds longer.
- When a server asks a question during a tool call (MCP elicitation), F5 passes it to the agent whose call is waiting if that agent's client accepts questions. Questions that send you to a page (URL mode) reach agents that support them, and F5 passes on the server's notice when you finish there. A question may take as long as the tool call's timeout. If the agent cannot answer, the call came from an MCP App, or calls from more than one conversation are waiting on that connection, F5 declines the question.
- MCP Apps in Codex and Claude conversations read their pages and call their tools through F5's connection. An Apply that moves a server to a new connection asks you to review a pending app tool call again. A name Claude keeps for one of its own settings or plugin servers is never reached through F5.
- stdio servers start once per session. HTTP and SSE servers share one connection per account and workspace folder, so each project's server sees its own folder as the root; the connection closes five minutes after the last session leaves. A remote server that loses its session (for example after a restart) or rejects the credential is reconnected or marked **Needs sign-in** on the next failed request; the failed tool call is not repeated.
- A server that stops is retried after 1, 2, 4, 8, and 16 seconds; after that it shows **Failed** until you click **Reconnect**. Tool calls made while it reconnects fail at once with a short explanation.
- Headers, stored secrets, and bearer token environment variables work. A server that needs OAuth shows **Needs sign-in** until you sign in with F5 (see [Sign in with F5](#sign-in-with-f5)). This includes Cursor servers that used Cursor's own sign-in before.
- A name the agent already uses for its own server (for example in Cursor's or OpenCode's own MCP configuration) keeps the agent's server. Codex and Claude keep the servers they configure themselves, listed under **Provider-managed servers**.
- OpenCode gets servers only when F5 starts its OpenCode server; a configured external OpenCode server is shared with other clients and gets none. Muse Code needs a host that grants per-session MCP servers. Pi tools from these servers always ask for approval unless the session runs with full access. Pi waits for a slow server up to its startup timeout and retries a failed server once when the session starts.
- Agents without HTTP MCP support reach these servers through F5's stdio relay, which carries requests and responses but not server notifications: a server whose tool list changes during the session shows the new tools in the next session.
- A server an agent does not get (for example because the agent lacks the transport it needs, or a `${env:…}` variable is unset) is listed in a warning in the conversation, for every agent, and in Apply results for Codex and Claude.

A server's Overview lists F5's connections in use, the agents and session counts using them, and any error, with **Reconnect** for any connection that is not connecting. In common scope the status covers every project's connections for that name, project overrides included, and is labeled **F5, all projects**; Reconnect there restarts them all.

### Native passthrough

**Let Codex and Claude connect to servers themselves**, the switch in **Codex and Claude connect through F5** (the `mcpNativePassthrough` server setting, off by default), restores the earlier behavior for this release. Codex and Claude then start your servers with their own clients, settings, and sign-ins, as described in [With native passthrough](#with-native-passthrough), and resolved secrets reach them on their command lines. New sessions use the change. The switch will be removed in a later release.

## Saved configuration and live status

A row's status combines F5's connections (**F5**) with the observed Codex or Claude account. The worst state wins: **Failed**, then **Needs sign-in**, then **Connecting**, then **Ready** with the tool count. When several sources report, the badge names the one it shows. A disabled server shows **Disabled**; a server nothing has connected to yet shows **Not connected**. A saved disabled server can still be connected in a conversation until changes are applied, and applying a version does not guarantee readiness.

F5's connection status is pushed as connections change. Codex and Claude status comes from the running conversation the page observes, **Observed in <conversation> at <time>**; choose another one under **Provider-managed servers**. Only that conversation receives a live read. Without a running conversation, Codex performs a labeled **Configuration check** of the servers it configures itself, which F5 re-checks while a server is starting. It starts none of the servers F5 serves, and one check process is reused across saves; with native passthrough it checks your servers too. Claude explains that live status appears when a session runs. F5 never starts a conversation just to observe status. **External** entries belong to the provider, plugins, or managed configuration; **Built-in** entries are registered by F5. Neither is assigned to a same-name configured row.

Failure reasons are shown with supplemental redaction. In a panel's Overview, expand **Connection details** to read or copy the error. Unsupported capabilities and incomplete listings are marked explicitly. Reading status never runs tools or fetches resource contents.

The chat's MCP chip summarizes the session's servers: F5's connections for this agent and project, and, for Codex and Claude, the latest session generation of the servers they configure themselves (and of every server with native passthrough). Click it, or focus it and press Enter, for each server's name, state, error, a **Sign in** button when one is needed, and, for servers saved in F5, a link to the server's panel in MCP settings. F5's connection counts cover every conversation of that agent in the project.

## Sign in

OAuth needs your approval in the browser, so F5 never signs in automatically. **Sign in** appears when a server reports that it needs sign-in, in these places:

- **In a conversation**, while its session is live: a row above the composer lists the servers that need sign-in in the current session, and **Sign in…** expands one button per server. **Runtime details** lists the same servers with Sign in.
- **In the chat's MCP chip**, which shows how many servers need sign-in; open it for a **Sign in** button per server.
- **In MCP settings**, on the server's **Sign-in** tab. F5's sign-in works in either scope with no conversation running. With native passthrough, Codex and Claude sign-in needs a project scope; without one there is no live status for those agents. A **Test** that reports **Sign-in required** points you to a project scope or the conversation prompt.

Servers F5 serves use [F5's sign-in](#sign-in-with-f5), for every agent. Sign-ins Codex and Claude saved for those servers before F5 served them are not carried over, so a remote server that needed one asks once more in F5. The MCP page, the server's **Sign-in** tab, and the chip say so.

### Codex and Claude sign-in

Codex's and Claude's own sign-in covers the servers they configure themselves, and every server with native passthrough. The conversation row, Runtime details, and chip cover Codex servers from the profile's `config.toml` (and from F5 with native passthrough), and, with native passthrough, Claude servers configured in F5. Claude's **External** servers (plugins, Claude settings, claude.ai connectors) are not reported to the conversation; sign in to them from project-scoped MCP settings while a Claude conversation is running.

- **Claude** signs in through a running Claude conversation in the project: the one you click from in chat, or the conversation settings is observing. Start a conversation first if none is running. Claude Code completes the browser flow itself; F5 waits up to five minutes for the server to connect, then reconnects it in the account's other running conversations. claude.ai connectors authorize on claude.ai, and F5 retries the connection with increasing delays for up to five minutes, skipping retries while a turn is running. If you deny or abandon consent in the browser, the attempt stays pending until those five minutes pass; use **Reopen sign-in** to return to it, or start a new attempt afterwards.
- **Codex** signs in through the account's Codex app server, also for servers defined in the profile's `config.toml`, then reloads live Codex sessions. Codex startup failures that ask you to run `codex mcp login` (an expired or missing OAuth token) are shown as needing sign-in. Servers that do not support OAuth report the provider's error.

### Sign in with F5

Servers F5 serves use F5's own sign-in. An enabled HTTP or SSE server's **Sign-in** tab has an **F5 sign-in** section for it (**Other agents** with native passthrough), which also appears in the chat's MCP chip. Servers that send their own `Authorization` (a header or a bearer token environment variable) never use F5 sign-in. It works in either scope, with no conversation running. `${env:…}` references resolve against the account environment of a running session that uses the server, or F5's own environment when none is running.

- **Sign in** registers F5 with the server if it has no `oauthClientId`, then opens the server's sign-in page in your browser. F5 opens the browser only when you click.
- F5 listens on `127.0.0.1` for the browser's return: on the server's OAuth callback port, or the port of a loopback OAuth callback URL, if either is set; otherwise on the port of the previous sign-in, so servers that match redirect addresses exactly keep accepting F5's registration, or on a free port, in which case F5 registers again. An OAuth callback URL, if set, is used as the redirect address. The sign-in finishes on its own when the browser returns. If your browser runs on another machine, copy the address it ends on (it starts with the shown callback address) and paste it into the row, then click **Finish sign-in**.
- An attempt expires after ten minutes, including time spent reaching the server's sign-in endpoints. Starting a new attempt replaces the pending one, and an address from another attempt is refused. F5 reads the server's sign-in metadata address from its `401` response when the server provides one.
- A sign-in is shared by every project and agent that uses the same server URL and client ID. F5 renews access tokens with the refresh token when the server issues one, so the row shows **Renews automatically**. Otherwise it shows when access expires. Connections that need a new token at the same time share one renewal, and a renewal that fails because the server is briefly unreachable is retried instead of asking you to sign in again. A server's own headers are sent only to the server, not to separate sign-in hosts.
- **Sign out** forgets the tokens but keeps F5's registration with the server, and reconnects the agents using it. A sign-in or renewal that was still finishing cannot bring the tokens back.
- OAuth scopes and the OAuth resource are sent as configured.

With native passthrough, Claude and Codex sessions use their own sign-in.

## Apply, Reconnect, and Test

After saving, the banner says: **Saved. Codex and Claude sessions pick up MCP changes on their next message, restarting if needed; other agents in their next session.** Saving does not re-check live status; use **Refresh status** or Apply. Use **Apply to all live sessions** to apply now across all eligible Codex and Claude accounts in the selected scope: this project for project scope, or every project for common scope. Sessions already on that version are skipped unless they need a retry. Active-turn protections still apply. A server's Overview lists the conversations that did not pick up the last Apply or Reconnect, each with **Retry in this conversation**. The banner clears after Apply or a scope change.

**Reconnect** is in a row's menu, and on a panel's Overview, for a failed, signed-out, or unknown server. A failed F5 connection is reconnected first. For a server F5 serves, Reconnect reconnects F5's connections to it. Otherwise (a server Codex or Claude configures itself, or native passthrough) it recovers connections used by running sessions for the selected project and account. Claude reconnects the selected owned server; Codex reloads its settings connection and applies through the normal session path, which can reload every MCP server in the affected sessions. The result distinguishes reconnected sessions, no running session using the server, and failures. Reconnect does not perform sign-in; use **Sign in** instead. A pending sign-in can be reopened without cancelling it if the browser fails to open.

## Catalog

The **Catalog** tab searches the official [MCP Registry](https://registry.modelcontextprotocol.io). F5 asks the registry only when you open the tab or search, and reuses results for an hour. Anyone can publish to the registry, so check a server (its **Source** link) before adding it. Results list the ways each server can be added: **Remote (HTTP)** or **Remote (SSE)**, **npm package** (`npx -y <package>@<version>`), **PyPI package** (`uvx <package>==<version>`), or **Container image** (`docker run -i --rm`). Other package types are not listed.

Choosing one fills the form and switches to it; nothing is saved or started until you save. Declared arguments and environment variables are filled in where the registry gives a value, and required ones without a value are left for you to complete (arguments show a `<placeholder>`). Secret environment variables and headers become secret rows, so the form asks you to store each secret before it can save. If the scope already has the server's name, a suffix such as `-2` is added.

## Import

In the Add server dialog, **Paste JSON or TOML** previews pasted F5/Claude JSON, Codex JSON, Codex TOML, VS Code JSON (`servers`), or OpenCode JSON (`mcp`). JSON with comments and trailing commas is accepted. **Import → Detect configurations** explicitly reads:

- the selected account's Claude state (including project entries), the project's `.mcp.json`, and Codex's `config.toml`, selected by default;
- Cursor (`~/.cursor/mcp.json` and the project's `.cursor/mcp.json`), VS Code (the project's `.vscode/mcp.json`), Claude Desktop, and OpenCode (`opencode.json(c)` in `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`, and the project's `opencode.json(c)`), shown but not selected by default.

Files must be regular files of at most 1 MiB, and symbolic links are not followed. A detected file lists servers only from its server section (`mcpServers`, `mcp_servers`, `servers`, or OpenCode's `mcp`), so settings files without one add nothing. Detection never applies configuration. Names outside the allowed characters are imported under a proposed name (for example `my.server` becomes `my_server`), with a warning. Claude-style `${VAR}` and `${VAR:-default}` references, and OpenCode's `{env:VAR}`, are converted to `${env:VAR}` (see [Environment variables](#environment-variables)), with a warning that names the destination host when the reference is in a remote server's URL or headers. Editor variables such as `${workspaceFolder}` and other unknown `${...}` forms are flagged and kept literally, so replace them with a value. Choose entries, review warnings, and explicitly choose **Replace** for any conflict; existing entries are kept by default. A version conflict refreshes the preview without discarding your text or choices, and requires confirmation again.

## Connection test results

**Test** checks either the saved server or the editor draft. A stdio test executes the configured command with the selected account's environment and the draft's environment overrides. Remote tests use the configured headers and bearer environment variable, with the same rule as every agent: a literal `Authorization` header wins over the variable, and variables reserved for F5 and provider credentials (`F5_*`, `ANTHROPIC_*`, `CLAUDE_*`, `AWS_*`, `OPENAI_*`, `CODEX_*`) are never sent. Tests initialize the connection and list advertised tools, resources, and prompts; they never invoke tools or fetch resource contents. Tests have a 60-second deadline and clean up their child processes. Results show latency, server information, bounded tool summaries, and sanitized errors and stderr. Sign-in requirements remain owned by the provider; a test does not start OAuth.

## Tools

A server's **Tools** tab sets each tool to **Allow**, **Ask** or **Block**:

- **Allow** runs the tool when the agent calls it (the agent's own approval rules still apply).
- **Ask** shows an approval in the conversation before every call, for every agent and in every mode, including Full access. Choose **Allow once**, **Allow in this conversation**, or **Deny**. When Codex or Claude would ask about the same call, F5 answers their prompt for you, so you are asked once, except in read-only workflow stages and plan mode without approvals, which still refuse the call. An approval waits up to ten minutes; Codex and Claude wait that much longer for hub tools, so the time you take does not count against the tool's timeout. The server is started or connected only after you allow the call. If you turn the server off, block the tool or remove the server while the approval is open, the call is refused even if you then allow it. Saving a policy change ends **Allow in this conversation** for that server, and so does a change of its URL or command.
- **Block** hides the tool from agents and refuses its calls, in running conversations too. It is stored in the disabled-tools list.

**Tools without their own setting** sets the default, Allow or Ask, for every tool you have not set yourself. A non-empty enabled-tools list still restricts availability and cannot be broadened here; edit that list under Advanced. A disabled-tools entry takes precedence when a tool is in both lists. Live tool data is preferred, with the last connection test as a fallback.

Policy is enforced by F5's hub, so it covers every agent that reaches the server through F5 (see [How agents connect](#how-agents-connect)). With [native passthrough](#native-passthrough), Codex and Claude reach servers themselves and only Block applies to them. Saving a policy change reaches running conversations at once, without Apply or reconnecting the server; other changes still follow [Apply](#apply-reconnect-and-test).

### Tool review

The first time F5 lists a server's tools, it records each tool's name, description and input schema. If a server later changes any of them, the tool is marked **Changed** and F5 asks before every call to it, even if it is set to Allow, until you review it. **Tools to review** shows what was accepted next to what the server reports now; **Accept change** records the new definition. Until a change is accepted, agents see the tool with its accepted description. Tools that appear after the first listing are marked **New**, and F5 asks before every call to them until you mark them reviewed. F5 checks a call against the tools the server reports now, so a tool redefined after the agent last listed tools still asks. Accepting records the definition you reviewed; if the tool changed again before you clicked, F5 keeps asking and you review it again. A server whose URL or command changes starts a new record; a stored secret in that URL or command is not part of the record, so rotating it keeps your reviews and is never shown.

## Activity

The **Activity** tab lists calls that went through F5 (in a project scope, only that project's): time, agent, tool, outcome, duration, how the call was approved, and a short, redacted error summary. Arguments and results are never stored. It also shows, for the last 24 hours, the number of calls that reached the server, their error rate, and median and 95th-percentile latency (refused and declined calls are not counted), and the server's recent stderr output (redacted). F5 keeps 30 days of calls, and at most 50,000. **Refresh** reads the latest calls.

## Turning a server off for one conversation

In the chat's MCP details, each server F5 serves has an **On in this conversation** switch. Turning it off hides the server's tools, prompts and resources from that conversation and refuses its calls at once, without restarting the agent. Other conversations are not affected, and the choice is kept for the conversation.

## Prompts and resources in the composer

In a conversation, the composer offers prompts and resources from the servers F5 serves to it. They come from the conversation's running session, so start or resume the conversation first.

- **Prompts**: type `/` to see **MCP prompts** as `/<server>:<prompt>`. A prompt with arguments opens a short form, with suggestions from the server where it offers them. The prompt's text is inserted into the composer for you to review and edit; it is not sent. Images, audio and binary parts of a prompt are left out with a notice.
- **Resources**: type `@` to see each server's resources (up to 200 per server) next to files and folders; typing filters them. A chosen text resource becomes a chip, and its current contents are read when you send and added after your message as fenced blocks. All resources in one message share 256 KiB of text; the rest is cut, with a note. Choosing an image resource attaches the image like a pasted one. Other binary content is left out with a notice.

## Environment variables

The command, arguments, environment values, working directory, URL, and header values can reference environment variables as `${env:NAME}`, or `${env:NAME:-default}` to fall back to a default. F5 resolves them from the provider account's environment when the server starts, for every provider, so the stored configuration keeps the reference. An empty variable counts as unset. A server that needs an unset variable with no default is skipped. Settings shows an issue that names the variable, and **Test** reports it. Use stored secrets rather than environment variables for credentials you want F5 to keep.

## Stored secrets

Environment and header values can be marked **Secret**, then stored explicitly. F5 replaces each value with a `${f5-secret:<uuid>}` reference. Replacing a secret creates a new UUID. Stored values are masked in the editor and omitted from MCP JSON exports. Imports reject these references because they cannot transfer the underlying secret.

A reference can also sit inside a longer value, such as `Bearer ${f5-secret:<uuid>}`, and in arguments and the URL. **Store a secret for an argument or URL**, under the arguments or the URL, stores a value and gives you its reference to paste. References are allowed only in environment and header values, arguments and URLs. Secrets in arguments and URLs are redacted from F5's own error messages and stderr.

Secrets live in permission-restricted files in the profile's secrets directory (directory mode 0700, file mode 0600). The backup system includes that directory only when you explicitly choose password-encrypted secret backups. MCP secrets and OAuth tokens are encrypted at rest with AES-256-GCM under a profile key. In the desktop app, the key is protected by the operating system's keychain and handed to the backend when it starts. A headless server keeps the key in a `secret-store-key.bin` file (mode 0600) in the same directory, which protects against copies of individual secret files but not against someone who can read the whole directory. Values written by older versions are re-encrypted the first time they are read. Encryption is not a full credential vault: the running backend can decrypt every value. Plaintext values in the configuration stay unchanged until you store them as secrets. On Linux, the desktop app hands the key to the backend in its environment, which the backend clears at startup but which other processes of the same user can still read from `/proc/<pid>/environ`, as with the backend's auth token. A password-encrypted backup holds secret values decrypted, so a restore on another machine re-encrypts them with that machine's key. Codex receives MCP servers on its command line, which other local users can see with `ps`: a header or environment value that uses a stored secret or `${env:…}` appears there expanded, so put header tokens in a bearer token environment variable instead. Stored secrets are substituted before `${env:…}` references are expanded, so a secret value that itself contains `${env:NAME}` is expanded too.

Resolved values stay in F5, which starts and connects to the servers: Codex's and Claude's command lines hold only local addresses. With native passthrough, resolved values reach Codex and Claude through their process arguments and may be visible to software with access to those processes. Diagnostics and test results scrub configured values of at least eight characters and credential-like fields, and remove URL credentials, queries, and fragments; transformed secrets cannot be guaranteed to be caught.

If a referenced secret is missing, F5 skips that server, reports a warning, and continues the session with other servers. Replace the missing value in settings. Startup cleanup removes only unreferenced MCP secrets older than 24 hours; saving never deletes secrets.

Secret masking prevents accidental display and export of values; it is not access control against an authenticated F5 client. Clients can use stored references in unsaved probes and provider configuration, including commands or endpoints they control. Only connect clients you trust with the profile's credentials. MCP secret storage is bounded to 4,096 files (at most 64 MiB of values), including unsaved writes; startup collection frees unreferenced entries older than 24 hours.

Error redaction is supplemental, not a guarantee. Settings scrubs values from the available effective configuration as well as generic credential patterns and URL credentials, queries, and fragments. The chat details fetch the current project configuration on explicit open and withhold errors if it cannot load. Values from older configurations, external servers, resolved stored secrets unavailable to the browser, or transformed credentials may not match the available values. Do not share copied errors without reviewing them.
