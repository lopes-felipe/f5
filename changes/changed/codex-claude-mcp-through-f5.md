- Codex and Claude now reach your MCP servers through F5, like the other agents. Claude's stdio
  servers start in the conversation's folder, and Apply sends edits and removals to running Codex
  and Claude sessions without a restart; Claude also picks up newly added servers.
- Remote servers that Codex or Claude were signed in to ask for one sign-in in F5, since their
  saved sign-ins are not carried over. The server's Sign-in tab and Runtime details say so.
- Servers F5 could not pass to Codex or Claude (for example a server with an unset `${env:…}`
  variable) are named in a warning in the conversation and in Apply results.
- A server asking for a sign-in page (URL-mode elicitation) reaches agents that support it, and
  questions wait for the tool call's own timeout instead of one minute.
