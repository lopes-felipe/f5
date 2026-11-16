- Upstream queue jobs no longer wait on files changed by an archived port thread that has no
  PR; a port with an open PR still holds its files until it merges.
- A blocking port that needs you now says why ("Thread archived", "Turn failed", "Finished
  without a PR" or "Outcome not readable") instead of "Blocker needs attention".
- **Start all anyway (N)** beside **Clear queued** starts every job waiting on files in one click.
