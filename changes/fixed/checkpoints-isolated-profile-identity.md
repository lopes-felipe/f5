- Turn checkpoints work in a separate profile that has no Git author set. They failed with
  "Checkpoint capture failed … Author identity unknown", which removed per-turn diffs and undo.
  Your own commits still need the profile's Git author in Settings → Integrations.
