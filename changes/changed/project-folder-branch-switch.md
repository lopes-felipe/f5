- Switching the project folder's branch from F5 is no longer refused because other local
  threads, including archived ones, reference the folder. Only live use blocks it: a running or
  queued turn, worktree setup, an open terminal or another profile. When it is blocked, the error
  names the conversation and what it is doing instead of a generic message.
