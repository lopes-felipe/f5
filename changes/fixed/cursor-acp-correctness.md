- Cursor questions now send the answers you picked instead of an empty reply, and skipping or
  stopping tells Cursor the question was skipped or cancelled.
- Cursor questions that arrive as permission prompts are no longer approved automatically in
  full-access threads.
- Cursor no longer leaves an abandoned session in `~/.cursor` for every commit message, PR text or
  title F5 generates with it. That text is now generated in a private scratch folder, so project
  rules do not apply to it.
- Cursor shell commands that exit with an error now show as failed, and tools still running when a
  turn is stopped or fails show as interrupted. Backgrounded commands stay open across turns until
  Cursor reports them, and their updates stay with the turn that started them.
- Cursor threads refuse runtime modes Cursor cannot enforce instead of silently running with
  different permissions.
