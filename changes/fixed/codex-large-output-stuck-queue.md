- A Codex command with large output no longer stops the turn with "notification admission was
  exhausted" when the next command starts. If that error still happens, the turn now finishes
  instead of leaving the conversation stuck on "Waiting for the active turn to finish". Stop works
  on such a conversation too, and on the next app start F5 clears a stuck turn it can still
  identify from its saved session state.
