- Codex read-only workflow stages (reviews, investigations, documents) now run in Codex's
  read-only sandbox with no network for shell commands. They used to run with the thread's access
  mode, so only the prompt kept them from writing. A stage fails to start if Codex reports any
  other sandbox.
