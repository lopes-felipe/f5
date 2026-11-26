- Read-only workflow stages on Antigravity and Codex work in the macOS desktop app again. Their
  sandboxes can't start inside the app's own sandbox, so every command failed with
  `sandbox_apply: Operation not permitted`. F5 now checks once and, where the sandbox can't start,
  runs these stages without it and approves only commands on its read-only allowlist. The stage
  shows **Read-only stage: policy-enforced**.
- Read-only stages on Cursor and Antigravity no longer refuse scripts that set a variable to a
  literal and use it later, such as `HEAD_SHA=abc123` followed by `git show "$HEAD_SHA"`.
  Variables like `PATH`, `HOME`, `PAGER` or `GIT_DIR` still can't be set.
