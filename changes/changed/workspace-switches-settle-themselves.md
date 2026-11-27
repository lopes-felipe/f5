- A workspace switch that fails, is cancelled or is cut off by a restart now settles itself
  instead of blocking the thread. The "Workspace switching needs attention" banner and its
  **Inspect workspace** → Accept / Keep / Continue / Retry flow are gone, and so is the
  "A workspace transition already owns this conversation" refusal that left the other recovery
  buttons dead: the thread stays in its old workspace or moves to the new one, sending is never
  held afterwards, and you can start another switch straight away.
- When a switch was cut off, or a move had to keep a copied folder, the thread's timeline says
  so (for example "Switching to `topic` did not finish.") instead of a banner. A worktree that
  was restored before a later step failed is kept and used, and so is a branch switch that Git
  finished: the timeline says which later step failed. A restore is recorded only for the
  worktree it asked for; anything else found at that path is left alone.
- A move that fails and cannot be cleaned up now reports why it stopped and why the cleanup
  failed, instead of a general "The move did not finish".
- Threads left waiting for inspection by an earlier version are settled the same way on the
  next start.
