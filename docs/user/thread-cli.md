# Threads from a terminal

Run these commands on the machine running F5:

    id=$(f5 thread start . "Find why the tests are slow")
    f5 thread send "$id" "Now fix it" --wait
    f5 thread show "$id"
    f5 thread list

A project id or a path inside the project works for `start` and `list --project`.
New threads use the project's model, permission and workspace defaults. If the
default provider is unavailable or no model is saved, F5 selects a ready provider.
Override the model with `--provider <instance-id> --model <slug>`.
Use `--worktree <base-ref>` and optionally `--branch <name>` for a new worktree.
A worktree preparation failure does not fall back to running in the project folder.

Pass `-` as the message to read stdin. `send` queues behind running work without
interrupting it. `show --messages <count>` prints up to 1000 recent messages
(10 by default, 0 for status only). Listing returns the newest 100 threads; use
`list --limit <count>` to request fewer. Only those threads' activities are loaded.

Both `start` and `send` support `--wait`. It prints the reply for that submission,
exits 1 on failure or interruption, and exits 2 when you must answer in F5 or
resume a paused queue.
`--json` prints structured output, including the thread id even when a waited
submission fails or needs an answer.

Messages are limited to 128 KiB; returned replies and transcripts retain their full text.

Use the parent command's `--profile`, `--state-dir` or `--home-dir` options to
select an instance, as with `agent-bridge-stdio`. The `t3` alias works too.
The server must be running; these commands do not launch a second server.

## Local access

The CLI acts as the machine owner and can access all local projects and threads,
including ones not shared with the external Agent Bridge. It uses a separate
loopback-only MCP catalog and a temporary credential revoked when the command
ends. Abandoned credentials expire after five minutes without requests; a
server restart invalidates them all. The bootstrap connection file is readable
only by your OS user.

External Agent Bridge clients keep their shared-project and supervised-turn
restrictions. The CLI is available in F5's integrated terminal. Like any process
running as your OS user, an agent with local filesystem and command access can
also invoke it; the bridge's best-effort process guard does not apply to owner commands.
