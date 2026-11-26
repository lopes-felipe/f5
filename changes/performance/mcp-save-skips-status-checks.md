- Saving MCP settings no longer re-checks live server status, which could start a Codex process
  that launched every configured server. Use Refresh status or Apply to check again.
- MCP status requests reuse the resolved configuration instead of re-reading stored secrets several
  times per request.
