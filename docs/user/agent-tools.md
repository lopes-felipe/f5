# Agent tools

This guide covers the tools F5 hands to the agents it runs: MCP servers, skills, native provider inventories and project memory.

## How to

1. Open **Settings → Tools → MCP servers** and click **Add server**.
2. Choose a transport and fill in the command or URL.
3. If the server shows **Login required**, click **Connect**.
4. Start a new thread; the agent receives the effective config for its project.

## MCP servers

Configure MCP servers under **Settings → Tools → MCP servers**.

### Scopes

- **Common servers** are shared by every project.
- **Project servers** belong to one project. Switch the settings scope to the project (the **Global › Project** selector at the top of Settings) to edit them.

When the server resolves the effective config for a thread, a project entry overrides a common entry with the same name. The common entry is then marked **Overridden**, and live status and login actions apply to the project's server instead.

### Adding a server

Click **Add server** and choose a transport:

| Transport       | What you provide                                   |
| --------------- | -------------------------------------------------- |
| stdio           | Command, arguments, environment, working directory |
| SSE             | URL and optional headers                           |
| Streamable HTTP | URL and optional headers                           |

For stdio, enter one argument per line. Each server can be enabled or disabled, limit which tools are enabled or disabled, and set startup and tool timeouts. **Import configuration** reads an existing MCP config.

### OAuth and status

Servers that need OAuth show **Login required** with a **Connect** action; you can set a client ID, callback port or URL, and resource for providers that need them. The live status pane follows the provider you select there, and switching providers only changes that pane, not the stored config. Claude uses the same shared config; if Claude reports **Login required**, run `claude auth login` in a terminal and refresh the page.

In project scope, **Effective JSON export** shows the merged config a thread in that project will receive, in `{ "mcpServers": { ... } }` format, and **Copy JSON** copies it.

## F5 browser and computer tools

F5 also provides a thread catalog with `thread_status`, `html_render`, `html_preview`,
`pull_request_review_guide_read` and `pull_request_review_guide_write`. Guide tools accept
a PR URL or F5 PR key; omit it only when the thread has exactly one linked PR. Writing a
guide starts generation with the model chosen under **Settings → Git**. Reading reports
the saved guide and its running or failed state. See [HTML renders](html-renders.md) and
[PR Hub](pr-hub-forges.md).

Computer control is opt-in on macOS. See **Settings → Browser & Computer → Agent support**
for each enabled provider and a readable readiness reason.

| Agent                     | F5 preview                                                            | F5 computer control                                                           |
| ------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Claude, Codex             | Available in desktop sessions                                         | Native macOS preview; per-app consent required                                |
| Cursor, Grok, Antigravity | Awaiting per-harness preview startup verification                     | Awaiting per-harness live verification                                        |
| OpenCode                  | Unavailable: session attribution cannot be confirmed before execution | Same attribution gate; external servers have a separate connection limitation |
| Muse                      | Unavailable: the pinned SDK cannot configure MCP per session          | Same SDK limitation                                                           |

Provider built-in computer tools and the Codex Chrome plugin await certification.
Claude in Chrome is off by default and awaits native-host discovery and a signed
macOS arm64 certification run. Windows computer control remains unavailable.

Approve apps in F5's native dialog. Pending requests show their thread, project and
expiry, and raise the existing attention badge/notification. **⌃⌘Esc** stops the Mac
host; Pause all always pauses every target, and Retry Stop remains available for an
unconfirmed stop. Resume on the computer running F5. If an action's outcome is unknown,
check the app before resuming and observe before retrying.

Agents can use `computer_wait` to settle or wait for an element, optionally capturing
afterwards. The live card's Actions popover shows up to 30 recent tool outcomes;
access-request history and actions are transient and reset on reconnect.

## Skills and native inventories

Providers bring their own skills, plugins, connectors, subagents and memory, and these vary by provider. Each provider instance card under **Settings → Providers** lists what that instance found, grouped by kind, with the scope each entry came from (instance or project). **Reload inventory** rescans after you change files on disk.

Skills appear in the composer's `/` menu for providers that support them. Project skills are read from the repository; if one cannot be parsed, project settings show a diagnostic with the path and error, and the skill is left out of the catalog. Details are in [project settings](project-settings.md).

## Project memory

Project settings include **Project memory**: short notes about the project that F5 provides to agents. Use **Add memory** to write one, give it a type and a short description shown in the memory list, and **Save memory**.

## Agents panel

The **Agents** panel in a thread follows subagents and background workflows that the thread started, so you can watch delegated work without leaving the conversation. Claude subagents are controlled under **Settings → Threads** (**Enable Claude sub-agents** and **Claude sub-agent model**).

## Related

- [Threads and workspaces](threads-and-workspaces.md)
- [Provider prerequisites](../provider-prerequisites.md)
- [Agent browser and computer use](agent-browser-and-computer-use.md)
