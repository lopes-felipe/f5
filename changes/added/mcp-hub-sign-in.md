- MCP settings can sign in to remote MCP servers used by Cursor, OpenCode, Muse Code, Pi, and ACP
  agents, from either scope and with no conversation running. F5 opens the browser only when you
  click Sign in, and you can paste the redirected address when the browser runs on another
  machine. A sign-in is shared by every project that uses the same server, and access tokens
  renew automatically. An abandoned or failed sign-in leaves the existing sign-in in place. Servers that send their own
  Authorization never use this sign-in, and their headers never reach separate sign-in hosts.
