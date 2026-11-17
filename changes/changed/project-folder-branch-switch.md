- Switching the project folder's branch from F5 is no longer refused because other local
  threads, including archived ones, reference the folder. Only live use blocks it: a running,
  pending or queued turn, worktree setup, an agent session that is starting or running, an open
  terminal or another profile. A new turn waits for a switch that is already under way. When the
  switch is blocked, the error names the conversation and what it is doing instead of a generic
  message, for started conversations too.
