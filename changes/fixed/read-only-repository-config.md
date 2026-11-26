- Read-only workflow stages no longer let a repository's own provider config run commands or skip
  F5's checks. Claude runs them with hooks off and only F5's MCP servers, and refuses a trusted
  folder whose committed settings allow writes. OpenCode starts them without the repository's
  config. Pi refuses a workspace with its own extensions, and Antigravity one with workspace hooks.
