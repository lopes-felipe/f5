- MCP servers from a repository's `.mcp.json` never start in F5 until you approve their exact
  definition for the project. A changed definition is never started again until approved; F5
  does not watch the file, so running conversations stop reaching it the next time settings
  change. Symlinked files and stored-secret references in the file are refused. Review shows
  every field and names each environment value the server would receive or send to a host, and
  revoking an approval cuts the server off from running conversations at once.
