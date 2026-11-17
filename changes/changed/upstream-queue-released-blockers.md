- Upstream queue jobs no longer wait on files changed by an archived, idle port thread that has
  no PR; a port with a PR still holds its files until the PR merges.
- A blocking port that needs you now says why ("Thread archived", "Turn failed", "Finished
  without a PR" or "Outcome not readable") instead of "Blocker needs attention".
- **Start all anyway (N)** beside **Clear queued** lets every job waiting on files skip its file
  wait in one click; they still start under the queue's pause and concurrency limits.
