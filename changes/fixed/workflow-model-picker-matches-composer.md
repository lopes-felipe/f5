- The workflow model pickers (New Workflow, Implement and upstream port review) now use the same
  model picker and effort controls as the chat composer. Antigravity models are listed instead of
  "No models found": in New Workflow and port review they stay disabled with "Read-only workflow
  turns are not certified for this Antigravity version" until a version is certified, and the
  Implement dialog can pick them. Codex Fast Mode stays available in workflow slots. Workflow slots
  leave out traits a workflow turn can't use: Claude Ultrathink and Ultracode, and OpenCode and
  Muse traits, which workflow turns never apply.
- The model picker's search moves through results with the arrow keys and skips models that can't
  be picked, so Enter picks the highlighted model rather than always the first result.
