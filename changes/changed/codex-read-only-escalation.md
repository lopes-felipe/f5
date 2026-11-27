- Codex read-only workflow stages can run read-only shell commands again in the macOS desktop app
  when your organisation's Codex requirements forbid the `untrusted` approval policy but allow
  `on-request`. Codex asks to run a command outside its sandbox, and F5 approves only read-only
  ones. Only an organisation that allows nothing but `never` still gets the forge-tools-only
  fallback, now recorded on the thread as sandboxed.
