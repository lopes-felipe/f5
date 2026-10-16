# F5 Agent Bridge

The Agent Bridge is a vendor-neutral MCP server inside F5. A ChatGPT Dot, the ChatGPT desktop
app, or any MCP client can connect to it to read the projects you share and start supervised
coding threads.

OpenAI Dots and Meta's Muse personal agent have no public APIs, so F5 integrates through the
surfaces that exist: MCP for Dots and other agents, and the [Muse Code](providers/muse.md)
provider for Meta's coding CLI. The Muse personal agent is pending a public Meta API; F5 does
not imitate it.

## What a connected agent can and cannot do

Agents can:

- list the projects you share, their threads, and enabled providers
- read a thread (recent messages, the latest turn, its proposed plan, and a read-only summary of
  pending approvals) and its diff
- create a thread or queue a message, and wait for that turn's progress

Every bridge turn runs with **Supervised** (`approval-required`) permissions. F5 asks you before
the agent's actions, exactly as for your own turns, and keeps the turn supervised even if you later change
the thread's mode. Providers that cannot run supervised turns (such as Muse Code) are not
offered. `send_message` is refused for threads that are not supervised.

Agents can never answer approvals or questions, interrupt or stop work, change modes or
settings, delete anything, or reach files, terminals, the browser, computer control, or secrets.

A connection is whoever holds its credential, not a verified bot. In particular, other ChatGPT
conversations that use the same connected plugin can use a ChatGPT / Dots connection.

## Turning it on

1. Open **Settings > Integrations > Agent Bridge**.
2. Turn on **Enable Agent Bridge**. It is off by default.
3. Tick the projects to share. No project is visible to any agent until you share it.

F5 starts a local listener on `127.0.0.1` with a random port, separate from the app port. The
port and a 32-byte token, rotated on every start, are written to
`<state dir>/agent-bridge/local.json` (mode 0600). The file is removed when the bridge stops.

## Connecting a local MCP client (STDIO)

Local clients connect through a STDIO shim that reads `local.json` for every request, so a
restart needs no reconfiguration. Add a STDIO MCP server to your client with the values the
settings card shows:

- **Desktop app:** command = the F5 executable, environment `ELECTRON_RUN_AS_NODE=1`,
  arguments `[<backend entry>, "agent-bridge-stdio", "--state-dir", <dir>, "--profile", <id>]`.
- **CLI install:** `t3 agent-bridge-stdio` (add `--profile <id>` for a non-default profile).

F5 never writes ChatGPT or Codex configuration. When F5 or the bridge is not running, the shim
answers each request with JSON-RPC error `-32002`.

The ChatGPT desktop app shares `~/.codex/config.toml` with the Codex CLI, so F5's own Codex
agents may load the same shim. The shim serves an empty tool list and refuses every call when it
runs under F5: either its environment carries `F5_AGENT_PROCESS=1` (set on every process F5
launches for agents and terminals), or the F5 server that wrote `local.json` is one of its
parent processes. The process check covers launchers that clear the environment, such as Codex;
on Windows only the environment marker applies.

This guard is best effort, not a security boundary. An agent with shell access runs as your user
and can read `local.json` and call the listener directly.

## Remote access (hosted agents such as a ChatGPT Dot)

> **Status:** remote access is implemented to this specification but has not yet been certified
> against a live ChatGPT Dot. Treat it as preview until that check is recorded here.

A hosted agent reaches F5 through your own HTTPS tunnel to a second listener that accepts only
OAuth access tokens. The local token is never accepted there.

1. In **Agent Bridge**, turn on **Remote access**, choose a local port (1024–65535), and enter
   the tunnel's public URL (for example `https://f5.example.com`). F5 stores it canonically:
   https, lowercase host, no path. Changing it signs every remote client out.
2. Tunnel **only that port**, for example
   `cloudflared tunnel --url http://127.0.0.1:<port>`. Never tunnel the app port.
3. In ChatGPT: **Plugins → Add custom MCP server**, URL `<public URL>/mcp`, then **Create as
   plugin** and enable it for the Dot.
4. In F5, choose **Connect a client** (the window stays open for 10 minutes), then connect from
   ChatGPT. F5 shows the client, where it returns, a 6-character code that also appears in the
   browser, and the permissions and projects to grant. Check the codes match before approving.

How it works: F5 is a minimal OAuth 2.1 authorization server (authorization code with PKCE S256
and refresh; opaque tokens stored hashed; no OIDC). The issuer is exactly your public URL —
nothing is taken from request headers. Clients are either client-metadata documents (an https
`client_id` on a trusted host, default `chatgpt.com`) or dynamically registered with redirect
URIs that exactly match the allowlist (default
`https://chatgpt.com/connector_platform_oauth_redirect`; at most 20 clients and 10 registrations
per hour). Outside the pairing window the browser sees "Open F5 first". At most one request
waits at a time, and at most 10 authorization requests are accepted per hour.

Access tokens last 15 minutes; refresh tokens rotate, with a 30-day family limit. Reusing a
rotated refresh token revokes the family and fences the client's tasks. **Permissions** changes
a client's scopes or projects and fences its in-progress task writes; **Revoke** deletes its
tokens and pauses its tasks. F5 cannot check the mTLS client certificate ChatGPT presents,
because TLS ends at your tunnel.

F5's own outbound requests (fetching client metadata documents) go only to public addresses over
https on port 443, resolve DNS on every request, never follow redirects or use proxy
variables, and are limited to 10 seconds and 64 KiB.

## Event notifications (MCP Events)

> **Status:** implemented to this specification; not yet certified against a live ChatGPT Dot.

Remote clients granted **Receive event notifications** (`f5.events`) can subscribe to webhooks.
`server/discover` (protocol `2026-07-28`) advertises `events` only on the remote listener and
only to such clients.

| Event                       | Payload                                                     |
| --------------------------- | ----------------------------------------------------------- |
| `thread.turn_completed`     | `{threadId, turnId, status, summary≤500}`                   |
| `thread.approval_requested` | `{threadId, kind, summary}` (agents still cannot answer)    |
| `thread.input_requested`    | `{threadId}`                                                |
| `tasks.available`           | `{tasks: [{taskId, title, status, project}]}` (and backlog) |
| `task.updated`              | `{taskId, status, questionId?}`                             |

- `events/subscribe {name, arguments, delivery: {mode: "webhook", url, secret}, cursor?, ttlSeconds?}`.
  Thread events take `{threadIds?≤50}` and default to threads the client created; task events
  cover only the client's tasks. `secret` is `whsec_` plus 24–64 base64 bytes. At most 8
  subscriptions per client; the lifetime is at most 7 days and `refreshBefore` is an hour early.
- Before activating, F5 POSTs a signed `{"type":"verification","challenge"}` and requires the
  challenge echoed back (`-32015` with `data.reason` otherwise). A verified URL is remembered for
  24 hours. Re-subscribing refreshes; a new secret is accepted and F5 signs with both for 24 hours.
- Deliveries are Standard Webhooks requests (`webhook-id`, `webhook-timestamp`,
  `webhook-signature`, plus `X-MCP-Subscription-Id`), one event per request, at least once, with
  a stable id. Retries back off 1 s, 4 s, 16 s, 64 s (honoring `Retry-After` up to 5 minutes);
  `410` deletes the subscription; `413` or five failures skip the event and mark the client
  **Delivery failed** until the next success, which sends a backlog event.
- A new subscription, a renewal after a gap, or a truncated cursor (older than 500 events or 24
  hours) starts with one backlog `tasks.available`. **Notify again** in settings re-sends it.
- An acknowledgment only means the notification arrived. Tasks change only through task tools.

Client readiness in settings: **Linked** (no events permission), **Awaiting subscription**,
**Ready**, **Subscription expired**, or **Delivery failed**. After connecting a Dot, ask it to
monitor F5 events. Tasks queued before a subscription exists show "awaiting notification".

## Tools

| Tool                  | Scope      | Behavior                                                                                                                |
| --------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| `list_projects`       | `f5.read`  | Shared projects: id, title, workspace root                                                                              |
| `list_providers`      | `f5.read`  | Enabled instances and models, with `supportsSupervised`                                                                 |
| `list_threads`        | `f5.read`  | `{projectId?, createdByMe?, limit≤50}`, newest first                                                                    |
| `get_thread`          | `f5.read`  | Up to 50 recent messages (32 KB each, with a truncated flag), latest turn, proposed plan, pending approvals (read-only) |
| `get_thread_diff`     | `f5.read`  | Whole thread or one `turnId`, capped at 200 KB                                                                          |
| `create_thread`       | `f5.turns` | `{projectId, prompt≤32KB, title?, providerInstanceId?, model?, useWorktree=true, interactionMode?, clientRequestId?}`   |
| `send_message`        | `f5.turns` | `{threadId, prompt≤32KB, clientRequestId?}`, queued at the tail                                                         |
| `wait_for_submission` | `f5.turns` | `{submissionId, timeoutSeconds≤45}`                                                                                     |

`create_thread` uses a new git worktree from the project's current branch by default and the
checkout for non-git projects. If the project has a setup script, F5 runs it in the new worktree
without asking, as it does for worktree threads you create. Without `providerInstanceId` it uses
F5's text-generation default provider, or the first ready provider that supports supervised
turns, with that provider's default model.

`wait_for_submission` returns `queued`, `preparing-worktree`, `blocked` (with a reason),
`running`, `awaiting-approval`, `awaiting-input`, `completed`, `failed`, `interrupted`, or
`rejected`, and sets `timedOut` when it expires. Closing the request cancels the wait.

### Retries

Writes take an optional `clientRequestId`; F5 generates one when it is missing and returns it.
Retrying with the same id returns the original result, even after a crash between admission and
the response, and never creates a second thread or turn. Reusing an id with different arguments
fails. The stored command is replayed verbatim, so a changed default provider does not alter a
retry. A retry of a request that never reached the queue is checked again first: if the project
is no longer shared or the thread is no longer supervised, it is rejected. Completed receipts
are kept for 30 days; after that, the id and its submission are forgotten.

### Limits

Each limit is checked before anything is admitted, one request at a time, so concurrent requests
cannot overshoot it; errors include `retryAfterSeconds`.

- per client: 2 concurrent waits, 10 `create_thread` per hour, 30 `send_message` per hour, and 3
  of its messages waiting in one thread's queue
- globally: at most 4 bridge-created threads running, queued, or preparing a worktree at once;
  above that `create_thread` reports that F5 is busy

## Task board

F5 can also assign work to a connected agent. Open **Bots** in the sidebar, choose **New task**,
and pick the client, a shared project, a title, and instructions. The thread menu's **Assign task
to bot…** pre-fills the task from that thread. The task tools show the agent only the title,
instructions, the project's display name, and its own activity — never paths, files,
transcripts, or settings. (The thread tools above are separate: `list_projects` returns each
shared project's workspace root.)

| Tool                   | What it does                                                    |
| ---------------------- | --------------------------------------------------------------- |
| `list_tasks`           | Tasks assigned to the caller, newest first, 50 per page         |
| `get_task`             | Instructions, your replies, progress, the open question, result |
| `claim_task`           | `queued` → `running`; returns a new `executionEpoch`            |
| `report_task_progress` | A progress summary (1 KB) with optional detail (32 KB)          |
| `request_task_input`   | Ask one question; the task waits for your reply                 |
| `complete_task`        | Finish with a result; finished tasks never change               |
| `fail_task`            | Finish as failed with a reason                                  |

Every task write carries an `operationId` (a retry with the same id returns the saved result)
and, after claiming, the task's `executionEpoch`. Pause and cancel advance the epoch, so a write
from before them is rejected; resume puts the task back in the queue for a fresh claim. Pause and
cancel change only the F5 task — they don't stop the agent itself.

Bot-written text renders with a restricted policy: no HTML, images shown as text, no local file
links or previews, and only HTTPS links. Last contact is a freshness hint only; it never changes a
task's status. Progress entries are removed after 30 days; questions, replies, controls, and
results are kept. Deleting a project pauses its tasks; deleting a thread unlinks tasks created
from it.

Limits per client: task writes 1 per second (burst 10), progress once per task every 5 seconds
(retries of a saved write are free), and 100 open tasks. Instructions are capped at the provider
input limit; progress, questions, replies, and results at 32 KB.

## Protocol

The bridge speaks MCP over HTTP POST with a 1 MiB body cap. It supports `2025-06-18`
(`initialize`, then `tools/*`) and `2026-07-28` (`server/discover`). A request whose
`MCP-Protocol-Version` header names another version gets HTTP 400. Unknown routes return 404, a
missing or invalid credential returns 401, and any browser `Origin` is refused. F5 cookies and
the server's master token are never accepted.

Each bridge-created thread shows a "Sent by … via F5 Agent Bridge" row, and the turn is recorded
as automation (not human) provenance.
