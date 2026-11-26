- Codex and Claude now reach your MCP servers through F5, like the other agents. Claude's stdio
  servers start in the conversation's folder, and Apply sends edits and removals to running Codex
  and Claude sessions without a restart; Claude also picks up newly added servers.
- Remote servers that Codex or Claude were signed in to ask for one sign-in in F5, since their
  saved sign-ins are not carried over. The server's Sign-in tab and Runtime details say so.
