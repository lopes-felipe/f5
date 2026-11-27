- A refused command no longer ends a read-only workflow stage so easily. The stage now fails only
  when the model asks for the same refused operation three times, or is refused fifteen times in
  one turn, instead of after any three refusals.
- Read-only workflow stages on Cursor and Antigravity no longer refuse a shell command just
  because its text mentions `mcp_`, `mcp/` or `mcp.`, such as a path under `src/mcp/`.
- Refused commands on Cursor and Antigravity now show F5's reason in the thread, as they do on
  Codex.
- Read-only workflow stages that F5 enforces command by command now tell the model up front which
  shell commands run and which don't.
- An Antigravity read-only stage no longer finishes without a reply when a command is refused: F5
  explains the refusal and asks the agent to finish.
