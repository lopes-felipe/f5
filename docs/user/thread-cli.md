# Threads from a terminal

Run these commands on the machine running F5:

    id=$(f5 thread start . "Find why the tests are slow")
    f5 thread send "$id" "Now fix it" --wait
    f5 thread show "$id"
    f5 thread list

A project id or a path inside the project works for `start` and `list --project`.
New threads use the project's default model and permission mode and run in the
project folder. Override the model with `--provider <instance-id> --model <slug>`.
Use `--worktree <base-ref>` and optionally `--branch <name>` for a new worktree.
A worktree preparation failure does not fall back to running in the project folder.

Pass `-` as the message to read stdin. `send` queues behind running work without
interrupting it. `show --messages <count>` prints up to 1000 recent messages
(10 by default, 0 for status only).

Both `start` and `send` support `--wait`. It prints the reply for that submission,
exits 1 on failure or interruption, and exits 2 when you must answer in F5.
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

This owner access was explicitly selected for the thread CLI port. External
Agent Bridge clients keep their existing shared-project and supervised-turn
restrictions. No external OAuth support or dependencies were added.
