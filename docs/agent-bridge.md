# F5 Agent Bridge

Internal reference for a hidden feature. Bots and Agent Bridge are no longer exposed in the
user interface. Their implementation, existing configuration, APIs, and stored data are retained.

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

## Retained configuration and listener

The listener is suspended while the feature is shelved, including for profiles with
`agentBridge.enabled: true` already saved. Startup and settings changes cannot open it.
Enablement, shared-project settings, and task data remain persisted for future work.

The retained listener implementation uses `127.0.0.1` with a random port, separate from the
app port. When active, its port and a 32-byte token, rotated on every start, are written to
`<state dir>/agent-bridge/local.json` (mode 0600). The file is removed when the bridge stops.

## Internal STDIO connection reference

Local clients connect through a STDIO shim that reads `local.json` for every request, so a
restart needs no reconfiguration. These formats document the retained implementation for
maintainers; they are not user setup instructions and cannot connect while the listener is
suspended. Placeholder paths and profile values previously came from the hidden settings card:

- **Desktop app:** command = the F5 executable, environment `ELECTRON_RUN_AS_NODE=1`,
  arguments `[<backend entry>, "agent-bridge-stdio", "--state-dir", <dir>, "--profile", <id>]`.
- **CLI install:** `f5 agent-bridge-stdio` (add `--profile <id>` for a non-default profile).
  The `t3` alias that **Install CLI commands** also links runs the same command.

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

The retained task board implementation supports assigning work to a connected agent, but its
page and thread-menu action are hidden. The task tools show the agent only the title,
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
